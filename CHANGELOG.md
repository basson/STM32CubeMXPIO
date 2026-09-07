# Change Log

## [Unreleased]

## [0.0.5] - 2026-09-07

### Added

- Automatic detection of the `*.ioc` file. `ProjectIOCFile` is now empty by
  default and only needed when a folder contains several `*.ioc` files.
- Multi-root workspace support: every folder with an `*.ioc` file is tracked
  separately, and all settings are `resource` scoped, so each folder can have
  its own STM32CubeMX configuration.
- A project picker when a multi-root workspace holds more than one project.
- Cancellable progress notification while STM32CubeMX runs.
- `STM32CubeMXPIO` output channel with diagnostic logs.

### Fixed

- The extension no longer activates in every VS Code window. It starts only when
  the workspace contains an `*.ioc` file (or when the command is invoked), and
  the `STM32CubeMXPio` terminal is created on the first generation instead of on
  startup.
- Generation now always targets the folder that owns the changed `*.ioc` file.
  Previously the first workspace folder was used, which generated into the wrong
  project in multi-root workspaces.
- The file watcher is created once and disposed with the extension. It used to be
  recreated on every configuration change, so a single save triggered several
  generations.
- A missing `*.ioc` file, a failing STM32CubeMX run or a wrong executable path no
  longer leaves the extension stuck: the "in progress" flag is always released and
  the error is reported.
- A wrong `STM32CubeMxExec` path is reported as a clear error instead of an
  endless progress indicator.
- The generation script is fully written to disk before STM32CubeMX is started.
- C++ projects get `main.c` renamed back to `main.cpp` even when
  `CleanUnnecessaryFiles` is disabled.
- `CleanUnnecessaryFiles` no longer deletes `Drivers`, `Makefile`, `*.ld` and
  `*.s` in Makefile projects, which are needed to build them. Missing files are
  skipped instead of raising an error.

### Changed

- Minimum VS Code version is 1.85.
- Updated the toolchain: TypeScript 5.9, ESLint 9 (flat config), webpack 5.

## [0.0.4] - 2025-11-21

### Fixed

- Error on startup when no project folder is open
- Search for `main.cpp` / `main.c` in `Core/Src` as well as `Src`

## [0.0.3] - 2024-02-04

### Added

- Detal of readme how run and configure extension

### Fixed

- Clean unnecessary files after work STM32CubeMX
- Check for exists *.ioc file on startup
