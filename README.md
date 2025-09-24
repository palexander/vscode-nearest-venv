# Nearest Venv Interpreter

Automatically keeps VS Code and Cursor pointed at the closest Python virtual environment (e.g. `.venv`) for the active file and optionally configures Pyright for workspace-wide analysis.

## Requirements

- [Python extension for VS Code](https://marketplace.visualstudio.com/items?itemName=ms-python.python) (also bundled in Cursor)

## Features

- Watches editor changes and reacts only for Python files.
- Walks up parent directories to locate the nearest virtual environment (`.venv` by default).
- Sets `python.defaultInterpreterPath` at the workspace-folder scope so terminals/tasks inherit it.
- Works on macOS, Linux, and Windows.
- Optionally configures both VS Code and Cursor Pyright settings to analyse the whole project defined by the venv folder.
- Provides a `Nearest Venv: Refresh Interpreter` command for manual refreshes.

## Installation

### Visual Studio Code / Cursor (VSIX)

1. Download the latest release `.vsix` from the Releases page (or build it locally with `npm run compile` followed by `npx vsce package`).
2. VS Code: run `Extensions: Install from VSIX...` and select the file.
3. Cursor: drag the `.vsix` onto the Cursor window or use the same command palette entry.

### Local build

1. `npm install`
2. `npm run compile`
3. `npx vsce package` to produce `nearest-venv-<version>.vsix`

## Configuration

- `nearestVenv.folderNames` (array, default `[".venv"]`): folder names to search while walking up the tree.
- `nearestVenv.limitToWorkspace` (boolean, default `true`): stop searching once the workspace root is reached.
- `nearestVenv.configurePyrightVirtualWorkspace` (boolean, default `false`): when enabled, configures both VS Code and Cursor Pyright settings to analyse the venv directory as a virtual workspace.

## How it works

When a Python editor becomes active, the extension walks up from the file directory toward the workspace root to find the first matching virtual environment folder. It then updates the workspace-folder interpreter using the official Python extension APIs. If Pyright virtual workspace support is enabled, it also updates `python.analysis.*` and `cursorpyright.analysis.*` to use the venv directory as the analysis root with sensible defaults for diagnostics and excludes.

If no interpreter is located, the extension logs a miss and leaves the existing interpreter untouched.

## Development

- `npm install`
- `npm run compile`
- Launch VS Code and use the `Launch Extension` debug configuration (F5) to test inside the Extension Host.

## Release Notes

### 1.0.0

- First public release packaged for VS Code and Cursor.
- Automatic Pyright virtual workspace configuration (optional).
- Output channel logging for interpreter updates and diagnostics.
