import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

function isPythonEditor(editor: vscode.TextEditor | undefined): boolean {
  if (!editor) return false;
  const doc = editor.document;
  return doc.languageId === "python";
}

function getExecutableCandidates(venvDir: string): string[] {
  if (process.platform === "win32") {
    return [
      path.join(venvDir, "Scripts", "python.exe"),
      path.join(venvDir, "Scripts", "python3.exe"),
    ];
  }
  return [
    path.join(venvDir, "bin", "python"),
    path.join(venvDir, "bin", "python3"),
  ];
}

function fileExists(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    try {
      // If not executable, still consider existence
      fs.accessSync(p, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}

function findNearestVenvPython(
  fileUri: vscode.Uri,
  folderNames: string[],
  limitToWorkspace: boolean
): { pythonPath: string; venvDir: string } | undefined {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUri);
  const workspaceRoot = workspaceFolder?.uri.fsPath;

  let currentDir = path.dirname(fileUri.fsPath);

  while (true) {
    if (
      limitToWorkspace &&
      workspaceRoot &&
      !currentDir.startsWith(workspaceRoot)
    ) {
      break;
    }

    for (const name of folderNames) {
      const venvDir = path.join(currentDir, name);
      const candidates = getExecutableCandidates(venvDir);
      for (const candidate of candidates) {
        if (fileExists(candidate)) {
          return { pythonPath: candidate, venvDir: currentDir };
        }
      }
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  return undefined;
}

let output: vscode.OutputChannel | undefined;

function getOutput(): vscode.OutputChannel {
  if (!output) {
    output = vscode.window.createOutputChannel("Nearest Venv");
  }
  return output;
}

async function setInterpreterForWorkspaceFolder(
  pythonPath: string,
  folder: vscode.WorkspaceFolder
): Promise<void> {
  const config = vscode.workspace.getConfiguration("python", folder);
  const current = config.get<string>("defaultInterpreterPath");
  if (current === pythonPath) {
    getOutput().appendLine(
      `[skip] Already set for '${folder.name}' -> ${pythonPath}`
    );
    return;
  }

  await config.update(
    "defaultInterpreterPath",
    pythonPath,
    vscode.ConfigurationTarget.WorkspaceFolder
  );
  getOutput().appendLine(
    `[set] ${folder.name}: python.defaultInterpreterPath = ${pythonPath}`
  );
}

async function ensureSettingArrayContains(
  config: vscode.WorkspaceConfiguration,
  key: string,
  values: string[],
  target: vscode.ConfigurationTarget
): Promise<boolean> {
  const existingRaw = config.get<unknown>(key);
  let current: string[] = [];
  if (Array.isArray(existingRaw)) {
    current = [...existingRaw];
  } else if (typeof existingRaw === "string") {
    current = [existingRaw];
  }
  let changed = false;
  for (const value of values) {
    if (!value) continue;
    if (!current.includes(value)) {
      current.push(value);
      changed = true;
    }
  }
  if (!changed) {
    return false;
  }
  await config.update(key, current, target);
  return true;
}
function findSitePackagesPath(venvDir: string): string | undefined {
  if (process.platform === "win32") {
    const candidate = path.join(venvDir, "Lib", "site-packages");
    return fs.existsSync(candidate) ? candidate : undefined;
  }
  const libFolders = ["lib", "lib64"];
  for (const folderName of libFolders) {
    const libDir = path.join(venvDir, folderName);
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(libDir, { withFileTypes: true });
    } catch {
      continue;
    }
    const pythonDirs = entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("python"))
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const dirName of pythonDirs) {
      const candidate = path.join(libDir, dirName, "site-packages");
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    const fallback = path.join(libDir, "site-packages");
    if (fs.existsSync(fallback)) {
      return fallback;
    }
  }
  return undefined;
}
function toWorkspaceRelativePath(
  folder: vscode.WorkspaceFolder,
  absolutePath: string
): string {
  const relative = path.relative(folder.uri.fsPath, absolutePath);
  if (!relative || relative.startsWith("..")) {
    return absolutePath;
  }
  return relative || ".";
}
async function configureAnalysisSection(
  section: string,
  analysisRoot: string,
  defaultExcludes: string[],
  folder: vscode.WorkspaceFolder,
  extraPaths: string[]
): Promise<boolean> {
  try {
    const config = vscode.workspace.getConfiguration(section, folder);
    const target = vscode.ConfigurationTarget.WorkspaceFolder;
    const updatedKeys: string[] = [];
    if (analysisRoot) {
      const includeChanged = await ensureSettingArrayContains(
        config,
        "analysis.include",
        [analysisRoot],
        target
      );
      if (includeChanged) {
        updatedKeys.push("include");
      }
    }
    const diagnosticMode = config.get<string>("analysis.diagnosticMode");
    if (diagnosticMode !== "workspace") {
      await config.update("analysis.diagnosticMode", "workspace", target);
      updatedKeys.push("diagnosticMode");
    }
    const currentTypeCheckingMode = config.get<string>(
      "analysis.typeCheckingMode"
    );
    if (!currentTypeCheckingMode || currentTypeCheckingMode === "off") {
      await config.update("analysis.typeCheckingMode", "basic", target);
      updatedKeys.push("typeCheckingMode");
    }
    const excludeChanged = await ensureSettingArrayContains(
      config,
      "analysis.exclude",
      defaultExcludes,
      target
    );
    if (excludeChanged) {
      updatedKeys.push("exclude");
    }
    if (extraPaths.length > 0) {
      const extraPathsChanged = await ensureSettingArrayContains(
        config,
        "analysis.extraPaths",
        extraPaths,
        target
      );
      if (extraPathsChanged) {
        updatedKeys.push("extraPaths");
      }
    }
    const summary =
      updatedKeys.length > 0
        ? `updates: ${updatedKeys.join(", ")}`
        : "already up to date";
    getOutput().appendLine(
      `[pyright] ✓ Configured ${section}.analysis for '${folder.name}' (${summary}) -> analysis root: ${analysisRoot}`
    );
    return true;
  } catch (error) {
    getOutput().appendLine(
      `[pyright] ✗ Failed to configure ${section}.analysis: ${String(error)}`
    );
    return false;
  }
}

async function configurePyrightVirtualWorkspace(
  venvDir: string,
  folder: vscode.WorkspaceFolder
): Promise<void> {
  // Make venvDir relative to workspace folder for cleaner configuration
  const relativePath = path.relative(folder.uri.fsPath, venvDir);
  const analysisRoot = relativePath || ".";

  // Exclude common directories that shouldn't be analyzed
  const defaultExcludes = [
    "**/node_modules",
    "**/__pycache__",
    "**/build",
    "**/dist",
    "**/.git",
    "**/.*/**",
  ];

  const extraPaths: string[] = [];
  const sitePackages = findSitePackagesPath(venvDir);

  if (sitePackages) {
    const configPath = toWorkspaceRelativePath(folder, sitePackages);
    extraPaths.push(configPath);
    getOutput().appendLine(`[pyright] extraPaths += ${configPath}`);
  } else {
    getOutput().appendLine(
      `[pyright] ! Unable to locate site-packages under ${venvDir}`
    );
  }

  getOutput().appendLine(
    `[pyright] Configuring virtual workspace for analysis root: ${analysisRoot}`
  );

  // Try to configure VS Code Python extension
  const vscodeSuccess = await configureAnalysisSection(
    "python",
    analysisRoot,
    defaultExcludes,
    folder,
    extraPaths
  );

  // Try to configure Cursor pyright extension
  const cursorSuccess = await configureAnalysisSection(
    "cursorpyright",
    analysisRoot,
    defaultExcludes,
    folder,
    extraPaths
  );

  // Summary
  if (vscodeSuccess && cursorSuccess) {
    getOutput().appendLine(
      `[pyright] ✓ Successfully configured both VS Code and Cursor pyright settings`
    );
  } else if (vscodeSuccess) {
    getOutput().appendLine(
      `[pyright] ✓ Successfully configured VS Code pyright settings (Cursor failed)`
    );
  } else if (cursorSuccess) {
    getOutput().appendLine(
      `[pyright] ✓ Successfully configured Cursor pyright settings (VS Code failed)`
    );
  } else {
    getOutput().appendLine(
      `[pyright] ✗ Failed to configure both VS Code and Cursor pyright settings`
    );
  }
}

async function maybeUpdateInterpreter(editor: vscode.TextEditor | undefined) {
  if (!isPythonEditor(editor)) return;

  const doc = editor!.document;
  const fileUri = doc.uri;
  const folder = vscode.workspace.getWorkspaceFolder(fileUri);
  if (!folder) return; // only act for files within a workspace folder

  const cfg = vscode.workspace.getConfiguration("nearestVenv");
  const folderNames = cfg.get<string[]>("folderNames", [".venv"]);
  const limitToWorkspace = cfg.get<boolean>("limitToWorkspace", true);
  const configurePyright = cfg.get<boolean>(
    "configurePyrightVirtualWorkspace",
    false
  );

  const result = findNearestVenvPython(fileUri, folderNames, limitToWorkspace);
  if (!result) {
    getOutput().appendLine(`[miss] No venv found for ${fileUri.fsPath}`);
    return;
  }

  const { pythonPath, venvDir } = result;
  await setInterpreterForWorkspaceFolder(pythonPath, folder);

  // Configure pyright virtual workspace if enabled
  if (configurePyright) {
    await configurePyrightVirtualWorkspace(venvDir, folder);
  }
}

export function activate(context: vscode.ExtensionContext) {
  const disposables: vscode.Disposable[] = [];

  const onEditorChange = vscode.window.onDidChangeActiveTextEditor(
    async (editor) => {
      try {
        await maybeUpdateInterpreter(editor);
      } catch (err) {
        getOutput().appendLine(`[error] ${String(err)}`);
      }
    }
  );

  disposables.push(onEditorChange);

  // Refresh command
  const refreshCmd = vscode.commands.registerCommand(
    "nearestVenv.refreshInterpreter",
    async () => {
      await maybeUpdateInterpreter(vscode.window.activeTextEditor);
      vscode.window.showInformationMessage(
        "Nearest Venv: Refresh complete. See output for details."
      );
    }
  );
  disposables.push(refreshCmd);

  // Also check on activation for currently active editor
  if (vscode.window.activeTextEditor) {
    void maybeUpdateInterpreter(vscode.window.activeTextEditor);
  }

  context.subscriptions.push(...disposables);
}

export function deactivate() {}
