import * as vscode from 'vscode';
import { existsSync } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';

const EXT_ID = 'stm32cubemxpio';
const TERMINAL_NAME = 'STM32CubeMXPio';
const SCRIPT_RELATIVE_PATH = path.join('.vscode', 'generate_script.mx');

/** Debounce for *.ioc change events (CubeMX writes the file in several steps). */
const CHANGE_DEBOUNCE_MS = 500;
/** Ignore *.ioc changes for a while after we generated: CubeMX rewrites the file itself. */
const SELF_CHANGE_COOLDOWN_MS = 5000;

const IOC_GLOB = '**/*.ioc';
const IOC_SEARCH_EXCLUDE = '**/{node_modules,.git,.pio,.pio_build,build,cmake-build-*}/**';

type ProjectType = 'C' | 'C++';
type BuildSystem = 'PlatformIO' | 'Makefile';

interface ProjectSettings {
	iocSetting: string;
	cubeExec: string;
	projectType: ProjectType;
	buildSystem: BuildSystem;
	cleanUnnecessaryFiles: boolean;
	autoGenerate: boolean;
}

/** A single workspace folder that has a usable *.ioc file. */
interface CubeProject {
	folder: vscode.WorkspaceFolder;
	/** Absolute path of the resolved *.ioc file. */
	iocPath: string;
	/** Directory the code is generated into (the folder holding the *.ioc). */
	projectRoot: string;
	settings: ProjectSettings;
}

/** Projects of *this* window only, keyed by workspace folder URI. */
const projects = new Map<string, CubeProject>();
/** Folders with a generation currently running, keyed the same way. */
const running = new Set<string>();
/** Timestamp until which *.ioc changes of a folder are treated as our own. */
const cooldownUntil = new Map<string, number>();
/** Pending debounce timers for auto generation. */
const pendingChanges = new Map<string, NodeJS.Timeout>();
/** Guards against overlapping refreshes publishing stale results. */
let refreshToken = 0;

let log: vscode.LogOutputChannel;
let output: GenerationTerminal;

/** Lazily created read-only terminal — never created in windows that do not generate. */
class GenerationTerminal implements vscode.Disposable {
	private readonly writeEmitter = new vscode.EventEmitter<string>();
	private readonly closeEmitter = new vscode.EventEmitter<number | void>();
	private terminal: vscode.Terminal | undefined;
	private opened = false;
	private buffer = '';

	private ensureTerminal(): vscode.Terminal {
		if (this.terminal && vscode.window.terminals.includes(this.terminal)) {
			return this.terminal;
		}
		this.opened = false;
		const pty: vscode.Pseudoterminal = {
			onDidWrite: this.writeEmitter.event,
			onDidClose: this.closeEmitter.event,
			open: () => {
				this.opened = true;
				if (this.buffer) {
					this.writeEmitter.fire(this.buffer);
					this.buffer = '';
				}
			},
			close: () => {
				this.opened = false;
				this.terminal = undefined;
			},
			handleInput: () => { /* read-only terminal */ }
		};
		this.terminal = vscode.window.createTerminal({
			name: TERMINAL_NAME,
			pty,
			iconPath: new vscode.ThemeIcon('circuit-board')
		});
		return this.terminal;
	}

	write(text: string): void {
		this.ensureTerminal();
		const data = text.replace(/\r?\n/g, '\r\n');
		if (this.opened) {
			this.writeEmitter.fire(data);
		} else {
			this.buffer += data;
		}
	}

	line(text = ''): void {
		this.write(text + '\n');
	}

	banner(project: CubeProject): void {
		this.line();
		this.line('=====================================');
		this.line('=========== STM32CubeMXPIO ==========');
		this.line('=====================================');
		this.line(`Workspace : ${project.folder.name}`);
		this.line(`IOC file  : ${project.iocPath}`);
	}

	show(): void {
		this.ensureTerminal().show(true);
	}

	dispose(): void {
		this.terminal?.dispose();
		this.writeEmitter.dispose();
		this.closeEmitter.dispose();
	}
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	log = vscode.window.createOutputChannel('STM32CubeMXPIO', { log: true });
	output = new GenerationTerminal();
	context.subscriptions.push(log, output);

	context.subscriptions.push(
		vscode.commands.registerCommand(`${EXT_ID}.generate`, () => runGenerateCommand())
	);

	// One watcher for the whole window. It is scoped to the open workspace folders,
	// so a window without folders (or without *.ioc files) never receives an event.
	const watcher = vscode.workspace.createFileSystemWatcher(IOC_GLOB);
	context.subscriptions.push(
		watcher,
		watcher.onDidChange(uri => onIocChanged(uri)),
		watcher.onDidCreate(() => void refreshProjects()),
		watcher.onDidDelete(() => void refreshProjects())
	);

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(EXT_ID)) {
				void refreshProjects();
			}
		}),
		vscode.workspace.onDidChangeWorkspaceFolders(() => void refreshProjects())
	);

	await refreshProjects();
}

export function deactivate(): void {
	for (const timer of pendingChanges.values()) {
		clearTimeout(timer);
	}
	pendingChanges.clear();
}

function folderKey(folder: vscode.WorkspaceFolder): string {
	return folder.uri.toString();
}

function readSettings(folder: vscode.WorkspaceFolder): ProjectSettings {
	// Reading with the folder URI picks up folder-level settings in multi-root workspaces.
	const cfg = vscode.workspace.getConfiguration(EXT_ID, folder.uri);
	return {
		iocSetting: (cfg.get<string>('ProjectIOCFile') ?? '').trim(),
		cubeExec: (cfg.get<string>('STM32CubeMxExec') ?? 'STM32CubeMX').trim(),
		projectType: cfg.get<ProjectType>('ProjectType') ?? 'C',
		buildSystem: cfg.get<BuildSystem>('ProjectBuildSystem') ?? 'PlatformIO',
		cleanUnnecessaryFiles: cfg.get<boolean>('CleanUnnecessaryFiles') ?? false,
		autoGenerate: cfg.get<boolean>('AutoGenerateProject') ?? true
	};
}

/** Rebuilds the project list of this window from the currently open folders. */
async function refreshProjects(): Promise<void> {
	const token = ++refreshToken;
	const found = new Map<string, CubeProject>();

	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		const settings = readSettings(folder);
		const iocPath = await resolveIocFile(folder, settings.iocSetting);
		if (!iocPath) {
			continue;
		}
		found.set(folderKey(folder), {
			folder,
			iocPath,
			projectRoot: path.dirname(iocPath),
			settings
		});
	}

	if (token !== refreshToken) {
		return; // a newer refresh already ran
	}

	projects.clear();
	for (const [key, project] of found) {
		projects.set(key, project);
	}

	log.info(
		found.size > 0
			? `Tracking ${found.size} STM32CubeMX project(s): ${[...found.values()].map(p => p.iocPath).join(', ')}`
			: 'No STM32CubeMX project found in this window.'
	);
}

/**
 * Resolves the *.ioc file of a folder. An explicit setting wins; an empty setting
 * auto-detects a single *.ioc so the extension stays quiet in unrelated projects.
 */
async function resolveIocFile(folder: vscode.WorkspaceFolder, iocSetting: string): Promise<string | undefined> {
	const root = folder.uri.fsPath;

	if (iocSetting) {
		const configured = path.resolve(root, iocSetting);
		if (existsSync(configured)) {
			return configured;
		}
		// The setting may hold just a file name of a nested project.
		const byName = await vscode.workspace.findFiles(
			new vscode.RelativePattern(folder, `**/${path.basename(iocSetting)}`),
			IOC_SEARCH_EXCLUDE,
			1
		);
		if (byName.length > 0) {
			return byName[0].fsPath;
		}
		log.warn(
			`[${folder.name}] Configured *.ioc file not found: ${iocSetting}. ` +
			'Falling back to auto-detection.'
		);
	}

	const candidates = await vscode.workspace.findFiles(
		new vscode.RelativePattern(folder, IOC_GLOB),
		IOC_SEARCH_EXCLUDE,
		10
	);
	if (candidates.length === 0) {
		return undefined;
	}
	if (candidates.length === 1) {
		return candidates[0].fsPath;
	}

	const atRoot = candidates.filter(uri => path.dirname(uri.fsPath) === root);
	if (atRoot.length === 1) {
		return atRoot[0].fsPath;
	}

	log.warn(
		`[${folder.name}] Found ${candidates.length} *.ioc files. ` +
		`Set "${EXT_ID}.ProjectIOCFile" to choose one.`
	);
	return undefined;
}

function onIocChanged(uri: vscode.Uri): void {
	// getWorkspaceFolder maps the event back to the folder that really owns the file,
	// so multi-root workspaces never generate into the wrong project.
	const folder = vscode.workspace.getWorkspaceFolder(uri);
	if (!folder) {
		return;
	}
	const key = folderKey(folder);
	const project = projects.get(key);
	if (!project || !project.settings.autoGenerate) {
		return;
	}
	if (path.resolve(project.iocPath) !== path.resolve(uri.fsPath)) {
		return;
	}
	if (running.has(key) || Date.now() < (cooldownUntil.get(key) ?? 0)) {
		return; // our own generation touched the file
	}

	clearTimeout(pendingChanges.get(key));
	pendingChanges.set(key, setTimeout(() => {
		pendingChanges.delete(key);
		const current = projects.get(key);
		if (current) {
			void generate(current, 'auto');
		}
	}, CHANGE_DEBOUNCE_MS));
}

async function runGenerateCommand(): Promise<void> {
	await refreshProjects();
	const list = [...projects.values()];

	if (list.length === 0) {
		const pick = await vscode.window.showErrorMessage(
			'STM32CubeMXPIO: no *.ioc file found in this window. Add one to the workspace or set it in the settings.',
			'Open Settings'
		);
		if (pick === 'Open Settings') {
			await vscode.commands.executeCommand('workbench.action.openSettings', EXT_ID);
		}
		return;
	}

	if (list.length === 1) {
		await generate(list[0], 'manual');
		return;
	}

	// Multi-root workspace: let the user say which project to generate,
	// with the project of the active editor offered first.
	const activeUri = vscode.window.activeTextEditor?.document.uri;
	const activeFolder = activeUri ? vscode.workspace.getWorkspaceFolder(activeUri) : undefined;
	const ordered = [...list].sort((a, b) =>
		Number(b.folder === activeFolder) - Number(a.folder === activeFolder)
	);

	const choice = await vscode.window.showQuickPick(
		ordered.map(project => ({
			label: project.folder.name,
			description: path.basename(project.iocPath),
			detail: project.iocPath,
			project
		})),
		{ title: 'STM32CubeMXPIO: select the project to generate', matchOnDetail: true }
	);
	if (choice) {
		await generate(choice.project, 'manual');
	}
}

async function generate(project: CubeProject, trigger: 'auto' | 'manual'): Promise<void> {
	const key = folderKey(project.folder);
	if (running.has(key)) {
		if (trigger === 'manual') {
			vscode.window.showInformationMessage(
				`STM32CubeMXPIO: generation for "${project.folder.name}" is already running.`
			);
		}
		return;
	}

	if (!existsSync(project.iocPath)) {
		vscode.window.showErrorMessage(`STM32CubeMXPIO: *.ioc file not found: ${project.iocPath}`);
		return;
	}

	running.add(key);
	output.show();
	output.banner(project);
	output.line(trigger === 'auto' ? 'Change detected, starting generation.' : 'Manual generation requested.');

	try {
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `STM32CubeMX: generating "${project.folder.name}"`,
				cancellable: true
			},
			(_progress, token) => runGeneration(project, token)
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		output.line(`Generation failed: ${message}`);
		log.error(`[${project.folder.name}] ${message}`);
		vscode.window.showErrorMessage(`STM32CubeMXPIO: ${message}`);
	} finally {
		running.delete(key);
		cooldownUntil.set(key, Date.now() + SELF_CHANGE_COOLDOWN_MS);
	}
}

async function runGeneration(project: CubeProject, token: vscode.CancellationToken): Promise<void> {
	const scriptPath = path.join(project.folder.uri.fsPath, SCRIPT_RELATIVE_PATH);
	await writeGenerateScript(project, scriptPath);
	output.line(`Script written: ${scriptPath}`);

	// CubeMX always generates main.c; keep a C++ project from ending up with two mains.
	if (project.settings.projectType === 'C++') {
		await renameMain(project, 'main.cpp', 'main.c');
	}

	output.line(`Running: ${project.settings.cubeExec} -q ${scriptPath}`);
	const result = await executeCubeMX(project, scriptPath, token);

	if (token.isCancellationRequested) {
		output.line('Generation cancelled.');
		return;
	}
	if (!result.ok) {
		throw new Error(result.message);
	}

	output.line('Source code generated.');

	if (project.settings.projectType === 'C++') {
		await renameMain(project, 'main.c', 'main.cpp');
	}
	if (project.settings.cleanUnnecessaryFiles) {
		output.line('Cleaning unnecessary files.');
		await cleanGeneratedFiles(project);
	}

	output.line('Done.');
	vscode.window.setStatusBarMessage(`$(check) STM32CubeMX: "${project.folder.name}" generated`, 5000);
}

async function writeGenerateScript(project: CubeProject, scriptPath: string): Promise<void> {
	const script = [
		`config load ${project.iocPath}`,
		`project generate ${project.projectRoot}`,
		'exit',
		''
	].join('\n');

	await fs.mkdir(path.dirname(scriptPath), { recursive: true });
	await fs.writeFile(scriptPath, script, 'utf8');
}

interface CubeResult {
	ok: boolean;
	message: string;
}

function executeCubeMX(
	project: CubeProject,
	scriptPath: string,
	token: vscode.CancellationToken
): Promise<CubeResult> {
	return new Promise<CubeResult>(resolve => {
		const exec = project.settings.cubeExec;
		// Values like "java -jar /path/STM32CubeMX.exe" need a shell; a plain
		// executable (even one with spaces in its path) is spawned directly.
		const useShell = !existsSync(exec) && /\s/.test(exec);
		const child: ChildProcess = useShell
			? spawn(`${exec} -q "${scriptPath}"`, { cwd: project.projectRoot, shell: true })
			: spawn(exec, ['-q', scriptPath], { cwd: project.projectRoot });

		let out = '';
		let settled = false;
		const finish = (result: CubeResult) => {
			if (!settled) {
				settled = true;
				subscription.dispose();
				resolve(result);
			}
		};

		const subscription = token.onCancellationRequested(() => {
			output.line('Cancelling STM32CubeMX...');
			child.kill('SIGTERM');
		});

		const collect = (chunk: Buffer) => {
			const text = chunk.toString();
			out += text;
			output.write(text);
		};
		child.stdout?.on('data', collect);
		child.stderr?.on('data', collect);

		child.on('error', (error: NodeJS.ErrnoException) => {
			const message = error.code === 'ENOENT'
				? `STM32CubeMX executable not found: "${exec}". Set "${EXT_ID}.STM32CubeMxExec" to its full path.`
				: `Failed to start STM32CubeMX: ${error.message}`;
			finish({ ok: false, message });
		});

		child.on('close', (code, signal) => {
			if (token.isCancellationRequested) {
				finish({ ok: false, message: 'Generation cancelled.' });
				return;
			}
			if (signal) {
				finish({ ok: false, message: `STM32CubeMX was terminated by signal ${signal}.` });
				return;
			}
			// CubeMX reports every scripted command as OK/KO and can exit 0 after a KO.
			if (code !== 0) {
				finish({ ok: false, message: `STM32CubeMX exited with code ${code}. See the ${TERMINAL_NAME} terminal.` });
				return;
			}
			if (/\bKO\b/.test(out)) {
				finish({ ok: false, message: `STM32CubeMX reported an error. See the ${TERMINAL_NAME} terminal.` });
				return;
			}
			finish({ ok: true, message: 'OK' });
		});
	});
}

async function renameMain(project: CubeProject, from: string, to: string): Promise<void> {
	for (const dir of ['Src', path.join('Core', 'Src')]) {
		const source = path.join(project.projectRoot, dir, from);
		const target = path.join(project.projectRoot, dir, to);
		if (!existsSync(source)) {
			continue;
		}
		try {
			await fs.rename(source, target);
			output.line(`Renamed ${path.join(dir, from)} -> ${to}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			output.line(`Could not rename ${path.join(dir, from)}: ${message}`);
		}
	}
}

async function cleanGeneratedFiles(project: CubeProject): Promise<void> {
	const root = project.projectRoot;
	const remove = async (target: string) => {
		await fs.rm(target, { recursive: true, force: true });
		output.line(`Removed ${path.relative(root, target) || target}`);
	};

	// PlatformIO ships the linker script, startup code, HAL drivers and its own
	// build system, so the CubeMX copies only get in the way. A Makefile project
	// needs all of them — never delete those there.
	if (project.settings.buildSystem === 'PlatformIO') {
		const entries = await fs.readdir(root, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isFile() && (entry.name.endsWith('.ld') || entry.name.endsWith('.s'))) {
				await remove(path.join(root, entry.name));
			}
		}
		await remove(path.join(root, 'Makefile'));
		await remove(path.join(root, 'Drivers'));
	}

	await remove(path.join(root, '.mxproject'));
	await remove(path.join(root, path.basename(project.iocPath, '.ioc')));
}
