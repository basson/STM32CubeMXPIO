import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from "child_process";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const execShell = (cmd: string) =>
	new Promise<string>((resolve, reject) => {
		cp.exec(cmd, (err, out) => {
			if (err) {
				return reject(err);
			}
			return resolve(out);
		});
	});

let isTerminal: boolean = true;
let isProgress = false;
let isError = false;
let isCleanUnnecessaryFiles = false;
const writeEmitter = new vscode.EventEmitter<string>();
const pty = {
	onDidWrite: writeEmitter.event,
	open: () => { isTerminal = true; },
	close: () => { isTerminal = false; },
	handleInput: (data: string) => {
		// writeEmitter.fire(data);
	}
};
let terminal = vscode.window.createTerminal({ name: `STM32CubeMXPio`, pty });

let workspacePath: string;
let workspaceUri: vscode.Uri;
let iocFile: string;
let execCubeMXPath: string;
let projectType = 'C';
let autoGenerateProject = false;


export function activate(context: vscode.ExtensionContext) {

	if (!vscode.workspace) {
		console.log("project folder not open");
		return;
		/// vscode.window.showErrorMessage('Please open a project folder first!');
	}

	loadConfiguration();

	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {loadConfiguration();}));

	// let wf = vscode.workspace.workspaceFolders[0].uri.path ;
	// let f = vscode.workspace.workspaceFolders[0].uri.fsPath ; 

	// let message = `YOUR-EXTENSION: folder: ${wf} - ${f}` ;

	// vscode.window.showInformationMessage(message);



	if (!fs.existsSync(path.join(workspacePath, iocFile))) {
		return vscode.window.showErrorMessage('Please configure extension and set file *.ioc at workspace!');
	}
	if (autoGenerateProject) {
		setFileWatcher();
	}
	let disposable = vscode.commands.registerCommand('stm32cubemxpio.generate', () => {
		generateCode();
	});

	context.subscriptions.push(disposable);
}

function loadConfiguration(){
	let cfg = vscode.workspace.getConfiguration("stm32cubemxpio", workspaceUri);

	workspaceUri = vscode.workspace.workspaceFolders![0].uri;
	workspacePath = workspaceUri.fsPath;
	iocFile = cfg.get('ProjectIOCFile')!;
	execCubeMXPath = cfg.get('STM32CubeMxExec')!;
	isCleanUnnecessaryFiles = cfg.get('CleanUnnecessaryFiles')!;
	projectType = cfg.get('ProjectType')!;
	autoGenerateProject = cfg.get("AutoGenerateProject")!;
}

function setFileWatcher() {
	var watcher = vscode.workspace.createFileSystemWatcher("**/" + iocFile);
	watcher.onDidChange(() => {
		if (!isProgress) {
			writeEmitter.fire('File ' + iocFile + ' change!');
			generateCode();
		}
	});
}

async function createTerminalIsNone() {
	let isExist = vscode.window.terminals.find((term) => {
		if (term.name === 'STM32CubeMXPio') {
			writeEmitter.fire('\n\r=====================================\n\r============STM32CubeMXPIO===========\n\r=====================================\n\r');
			return true;
		}
	});

	if (!isExist) {
		terminal = vscode.window.createTerminal({ name: `STM32CubeMXPio`, pty });
	}
	terminal.show();
	await sleep(10);
	
}

async function generateCode() {
	if (isProgress) {
		return;
	}
	isProgress = true;
	createTerminalIsNone();
	await sleep(10);
	writeEmitter.fire("Generate scripts...\n\r");
	let ret = generateScriptFile();
	if (ret) {
		writeEmitter.fire("Start generate source code.\n\r");
		if (projectType === 'C++') {
			try {
				fs.renameSync(path.join(workspacePath, 'Src/main.cpp'), path.join(workspacePath, 'Src/main.c'));
			} catch (error) {
				writeEmitter.fire('Not found Src/main.cpp!\n\r');
			}

		}
		writeEmitter.fire("Please  wait");
		executeCubeMX(execCubeMXPath, workspacePath + '/.vscode/generate_script.mx');
		while (true) {
			if (!isProgress) {
				writeEmitter.fire("\n\r");
				break;
			}
			writeEmitter.fire(".");
			await sleep(700);
		}
		if (!isError) {
			writeEmitter.fire("Source code generate done!\n\r");
			if (isCleanUnnecessaryFiles) {
				writeEmitter.fire("Clear unused files.\n\r");
				if (projectType === 'C++') {
					try {
						fs.renameSync(path.join(workspacePath, 'Src/main.c'), path.join(workspacePath, 'Src/main.cpp'));
					} catch (error) {
						writeEmitter.fire('Not found Src/main.c!\n\r');
					}

				}
				clearAfterGenerate();
			}
		} else {
			writeEmitter.fire("Source code generate error!\n\r");
		}
	} else {
		writeEmitter.fire("Error generate script file!\n\r");
	}
}

function generateScriptFile(): boolean {
	var isGenerate = true;
	const generateScript = `
config load ` + workspacePath + `/` + iocFile + `
project generate ` + workspacePath + `
exit
		`;

	if (!fs.existsSync(path.join(workspacePath, '.vscode'))) {
		fs.mkdir(path.join(workspacePath, '.vscode'), (err) => {
			if (err) {
				isGenerate = false;
				return vscode.window.showErrorMessage('Failed to create .vscode dir!');
			}
		});
	}

	fs.writeFile(path.join(workspacePath, '.vscode/generate_script.mx'), generateScript, (err) => {
		if (err) {
			isGenerate = false;
			return vscode.window.showErrorMessage('Failed to create temp files in .vscode folder!');
		}
		vscode.window.showInformationMessage('Start generate project');
	});

	return isGenerate;
}


async function executeCubeMX(cubeMXPath: string, scriptPath: string) {

	let ret = await execShell(cubeMXPath + " -q " + scriptPath);
	if (ret.includes("OK", ret.length - 20)) {
		isError = false;
	} else {
		isError = true;
	}
	isProgress = false;
}

function clearAfterGenerate() {
	fs.rmSync(path.join(workspacePath, '.mxproject'));
	fs.rmSync(path.join(workspacePath, "Drivers"), { recursive: true, force: true });
}


export function deactivate() { }
