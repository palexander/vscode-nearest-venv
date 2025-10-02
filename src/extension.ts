import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

const MANAGED_INCLUDE_STATE_KEY = "nearestVenv.managedIncludes";

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
): { pythonPath: string; venvPath: string; projectRoot: string } | undefined {
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
          return { pythonPath: candidate, venvPath: venvDir, projectRoot: currentDir };
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

interface ManagedIncludeEntry {
  managed: string[];
}

type ManagedIncludeState = Record<string, ManagedIncludeEntry>;

function getManagedIncludeKey(
  section: string,
  folder: vscode.WorkspaceFolder
): string {
  return `${section}:${folder.uri.toString()}`;
}

function toManagedArray(value: unknown): string[] {
  if (typeof value === "string") {
    return value ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return [];
}

function normalizeManagedIncludeEntry(
  raw: unknown
): ManagedIncludeEntry | undefined {
  if (!raw) {
    return undefined;
  }
  if (typeof raw === "string" || Array.isArray(raw)) {
    return { managed: dedupeStrings(toManagedArray(raw)) };
  }
  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const managedCandidate = obj.managed ?? obj.history ?? obj.baseline;
    return {
      managed: dedupeStrings(toManagedArray(managedCandidate)),
    };
  }
  return undefined;
}

function getManagedIncludeEntry(
  context: vscode.ExtensionContext,
  section: string,
  folder: vscode.WorkspaceFolder
): ManagedIncludeEntry | undefined {
  const state = context.workspaceState.get<Record<string, unknown>>(
    MANAGED_INCLUDE_STATE_KEY,
    {}
  );
  const raw = state[getManagedIncludeKey(section, folder)];
  return normalizeManagedIncludeEntry(raw);
}

async function setManagedIncludeEntry(
  context: vscode.ExtensionContext,
  section: string,
  folder: vscode.WorkspaceFolder,
  entry: ManagedIncludeEntry
): Promise<void> {
  const state = {
    ...context.workspaceState.get<Record<string, unknown>>(
      MANAGED_INCLUDE_STATE_KEY,
      {}
    ),
  };
  const key = getManagedIncludeKey(section, folder);
  const managed = dedupeStrings(entry.managed.filter((value) => !!value));
  if (managed.length === 0) {
    delete state[key];
    getOutput().appendLine(
      `[pyright] [include:${section}:${folder.name}] cleared managed state`
    );
  } else {
    state[key] = { managed };
    getOutput().appendLine(
      `[pyright] [include:${section}:${folder.name}] set managed=${JSON.stringify(
        managed
      )}`
    );
  }
  await context.workspaceState.update(MANAGED_INCLUDE_STATE_KEY, state);
}

function dedupeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

function arraysEqual(
  a: readonly string[],
  b: readonly string[]
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((value, index) => value === b[index]);
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

function getSettingArray(
  config: vscode.WorkspaceConfiguration,
  key: string
): string[] {
  const existingRaw = config.get<unknown>(key);
  if (Array.isArray(existingRaw)) {
    return existingRaw.filter((value): value is string => typeof value === "string");
  }
  if (typeof existingRaw === "string") {
    return [existingRaw];
  }
  return [];
}

function normalizeAbsolutePath(value: string): string {
  return path.normalize(value).replace(/\\/g, "/");
}

function toAbsoluteNormalized(
  folder: vscode.WorkspaceFolder,
  value: string
): string {
  const absolute = path.isAbsolute(value)
    ? value
    : path.join(folder.uri.fsPath, value);
  return normalizeAbsolutePath(absolute);
}

function pruneManagedExtraPaths(
  existing: string[],
  folder: vscode.WorkspaceFolder,
  folderNames: readonly string[],
  currentSitePackages: string
): { retained: string[]; removed: string[] } {
  const normalizedCurrent = normalizeAbsolutePath(currentSitePackages);
  const managedNames = folderNames
    .map((name) => normalizeAbsolutePath(name).replace(/^\/+|\/+$/g, ""))
    .filter((name) => name.length > 0);

  if (managedNames.length === 0) {
    return { retained: [...existing], removed: [] };
  }

  const retained: string[] = [];
  const removed: string[] = [];

  for (const value of existing) {
    const normalizedValue = toAbsoluteNormalized(folder, value);
    const matchesManagedName =
      managedNames.some((name) => normalizedValue.includes(`/${name}/`)) &&
      (normalizedValue.includes("/site-packages/") ||
        normalizedValue.endsWith("/site-packages"));

    if (matchesManagedName) {
      if (normalizedValue === normalizedCurrent) {
        retained.push(value);
      } else {
        removed.push(value);
      }
      continue;
    }

    retained.push(value);
  }

  return { retained, removed };
}

async function ensureSettingArrayContains(
  config: vscode.WorkspaceConfiguration,
  key: string,
  values: readonly string[],
  target: vscode.ConfigurationTarget
): Promise<boolean> {
  const current = getSettingArray(config, key);
  const next = [...current];
  let changed = false;

  for (const value of values) {
    if (!value) continue;
    if (!next.includes(value)) {
      next.push(value);
      changed = true;
    }
  }

  if (!changed) {
    return false;
  }

  await config.update(key, next, target);
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

async function updateManagedExtraPaths(
  config: vscode.WorkspaceConfiguration,
  folder: vscode.WorkspaceFolder,
  additions: readonly string[],
  managed: { folderNames: string[]; sitePackages?: string } | undefined,
  target: vscode.ConfigurationTarget
): Promise<boolean> {
  let current = [...getSettingArray(config, "analysis.extraPaths")];
  let changed = false;

  if (managed?.sitePackages && managed.folderNames.length > 0) {
    const { retained, removed } = pruneManagedExtraPaths(
      current,
      folder,
      managed.folderNames,
      managed.sitePackages
    );
    if (removed.length > 0) {
      changed = true;
      for (const entry of removed) {
        getOutput().appendLine(`[pyright] extraPaths - ${entry}`);
      }
    }
    current = retained;
  }

  for (const value of additions) {
    if (!value) continue;
    const normalizedAddition = toAbsoluteNormalized(folder, value);
    const alreadyExists = current.some(
      (existing) => toAbsoluteNormalized(folder, existing) === normalizedAddition
    );
    if (!alreadyExists) {
      current.push(value);
      changed = true;
      getOutput().appendLine(`[pyright] extraPaths += ${value}`);
    }
  }

  if (!changed) {
    return false;
  }

  await config.update("analysis.extraPaths", current, target);
  return true;
}

async function updateManagedAnalysisInclude(
  context: vscode.ExtensionContext,
  section: string,
  folder: vscode.WorkspaceFolder,
  config: vscode.WorkspaceConfiguration,
  target: vscode.ConfigurationTarget,
  analysisRoot: string
): Promise<boolean> {
  const logPrefix = `[include:${section}:${folder.name}]`;
  const inspect = config.inspect<unknown>("analysis.include");
  if (!inspect) {
    getOutput().appendLine(
      `[pyright] ${logPrefix} analysis.include unsupported; skipping`
    );
    if (getManagedIncludeEntry(context, section, folder)) {
      await setManagedIncludeEntry(context, section, folder, { managed: [] });
    }
    return false;
  }

  const current = getSettingArray(config, "analysis.include");
  const existingEntry = getManagedIncludeEntry(context, section, folder);
  const managedValues = existingEntry?.managed ?? [];
  const managedSet = new Set(managedValues);

  getOutput().appendLine(
    `[pyright] ${logPrefix} current=${JSON.stringify(current)} managed=${JSON.stringify(
      managedValues
    )}`
  );

  const filtered = dedupeStrings(
    current.filter((value) => !managedSet.has(value))
  );

  const additions = analysisRoot ? [analysisRoot] : [];
  const finalValues = dedupeStrings([...filtered, ...additions]);
  const configChanged = !arraysEqual(current, finalValues);

  getOutput().appendLine(
    `[pyright] ${logPrefix} filtered=${JSON.stringify(filtered)} additions=${JSON.stringify(
      additions
    )} final=${JSON.stringify(finalValues)}`
  );

  if (configChanged) {
    await config.update("analysis.include", finalValues, target);
    getOutput().appendLine(`[pyright] ${logPrefix} updated configuration`);
  }

  const nextManaged = dedupeStrings(additions);
  const managedChanged = !arraysEqual(managedValues, nextManaged);
  if (managedChanged || existingEntry === undefined) {
    await setManagedIncludeEntry(context, section, folder, {
      managed: nextManaged,
    });
    getOutput().appendLine(
      `[pyright] ${logPrefix} stored managed=${JSON.stringify(nextManaged)}`
    );
  }

  return configChanged;
}

async function configureAnalysisSection(
  section: string,
  analysisRoot: string,
  defaultExcludes: string[],
  folder: vscode.WorkspaceFolder,
  extraPaths: readonly string[],
  managedExtraPaths:
    | { folderNames: string[]; sitePackages?: string }
    | undefined,
  context: vscode.ExtensionContext
): Promise<boolean> {
  try {
    const config = vscode.workspace.getConfiguration(section, folder);
    const target = vscode.ConfigurationTarget.WorkspaceFolder;
    const updatedKeys: string[] = [];
    const includeUpdated = await updateManagedAnalysisInclude(
      context,
      section,
      folder,
      config,
      target,
      analysisRoot
    );
    if (includeUpdated) {
      updatedKeys.push("include");
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

    const needsExtraPathsUpdate =
      extraPaths.length > 0 ||
      (managedExtraPaths?.sitePackages && managedExtraPaths.folderNames.length > 0);
    if (needsExtraPathsUpdate) {
      const extraPathsChanged = await updateManagedExtraPaths(
        config,
        folder,
        extraPaths,
        managedExtraPaths,
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
  context: vscode.ExtensionContext,
  projectRoot: string,
  venvPath: string,
  folder: vscode.WorkspaceFolder,
  folderNames: string[]
): Promise<void> {
  // Make projectRoot relative to workspace folder for cleaner configuration
  const relativePath = path.relative(folder.uri.fsPath, projectRoot);
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
  let managedExtraPaths: { folderNames: string[]; sitePackages?: string } | undefined;
  const sitePackages = findSitePackagesPath(venvPath);

  if (sitePackages) {
    const configPath = toWorkspaceRelativePath(folder, sitePackages);
    extraPaths.push(configPath);
    managedExtraPaths = { folderNames: [...folderNames], sitePackages };
  } else {
    managedExtraPaths = { folderNames: [...folderNames] };
    getOutput().appendLine(
      `[pyright] ! Unable to locate site-packages under ${venvPath}`
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
    extraPaths,
    managedExtraPaths,
    context
  );

  // Try to configure Cursor pyright extension
  const cursorSuccess = await configureAnalysisSection(
    "cursorpyright",
    analysisRoot,
    defaultExcludes,
    folder,
    extraPaths,
    managedExtraPaths,
    context
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

async function maybeUpdateInterpreter(
  editor: vscode.TextEditor | undefined,
  context: vscode.ExtensionContext
) {
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

  const { pythonPath, venvPath, projectRoot } = result;
  await setInterpreterForWorkspaceFolder(pythonPath, folder);

  // Configure pyright virtual workspace if enabled
  if (configurePyright) {
    await configurePyrightVirtualWorkspace(
      context,
      projectRoot,
      venvPath,
      folder,
      folderNames
    );
  }
}

export function activate(context: vscode.ExtensionContext) {
  const disposables: vscode.Disposable[] = [];

  const onEditorChange = vscode.window.onDidChangeActiveTextEditor(
    async (editor) => {
      try {
        await maybeUpdateInterpreter(editor, context);
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
      await maybeUpdateInterpreter(vscode.window.activeTextEditor, context);
      vscode.window.showInformationMessage(
        "Nearest Venv: Refresh complete. See output for details."
      );
    }
  );
  disposables.push(refreshCmd);

  // Also check on activation for currently active editor
  if (vscode.window.activeTextEditor) {
    void maybeUpdateInterpreter(vscode.window.activeTextEditor, context);
  }

  context.subscriptions.push(...disposables);
}

export function deactivate() {}
