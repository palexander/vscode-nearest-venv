# Nearest Venv Interpreter

Automatically keeps VS Code and Cursor pointed at the closest Python virtual environment (e.g. `.venv`) for the active file and optionally configures Pyright for workspace-wide analysis.

## Requirements

- [Python extension for VS Code](https://marketplace.visualstudio.com/items?itemName=ms-python.python) (also bundled in Cursor)

## Features

- Detects Python editors and only reacts when the active file needs a virtual environment.
- Walks parent directories to locate the nearest virtual environment (`.venv` by default).
- Sets `python.defaultInterpreterPath` at the workspace-folder scope so terminals and tasks inherit it.
- Works on macOS, Linux, and Windows.
- When Pyright integration is enabled, keeps VS Code and Cursor analysis pointed at the project rooted by the active venv, adds the venv's `site-packages`, and prunes stale `analysis.extraPaths` entries.
- When Pyright integration is enabled, skips hidden directories (dot-folders) from analysis to avoid noisy diagnostics.
- Logs actions to the `Nearest Venv` output channel and exposes a `Nearest Venv: Refresh Interpreter` command for manual refreshes.

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

- `nearestVenv.folderNames` (array, default `[".venv"]`): folder names used while walking up from the file's directory; the first match wins.
- `nearestVenv.limitToWorkspace` (boolean, default `true`): stop walking once the workspace folder boundary is reached, keeping lookups scoped to the project.
- `nearestVenv.configurePyrightVirtualWorkspace` (boolean, default `false`): when enabled the extension keeps `python.analysis.*` and `cursorpyright.analysis.*` pointed at the project root, ensures workspace diagnostic mode, manages sensible excludes (including hidden directories), and keeps `analysis.extraPaths` in sync with the active venv's `site-packages`.

## How it works

When a Python editor becomes active, the extension walks up from the file directory toward the workspace root to find the first matching virtual environment folder. It then updates the workspace-folder interpreter using the official Python extension APIs. If Pyright virtual workspace support is enabled, it keeps `python.analysis.*` and `cursorpyright.analysis.*` pointed at the project root, enables workspace diagnostic mode, maintains reasonable excludes (including hidden directories), and synchronizes `analysis.extraPaths` with the active venv's `site-packages`.

If no interpreter is located, the extension logs a miss and leaves the existing interpreter untouched.

## Development

- `npm install`
- `npm run compile`
- Launch VS Code and use the `Launch Extension` debug configuration (F5) to test inside the Extension Host.

## Changelog

See `CHANGELOG.md` for version-by-version details.
