#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/migrate-workspaces-to-unified-schema.sh [--data-dir PATH | --dev | --prod] [--dry-run] [--copy | --move]

Migrates legacy Canopy single-repo and multi-repo persistence into the unified:

  {dataDir}/workspaces/
    index.json
    {workspaceId}/workspace.json
    {workspaceId}/worktrees.json
    {workspaceId}/chats/{worktreeId}.json
    {workspaceId}/summaries/{worktreeId}.json
    {workspaceId}/worktrees/{worktreeId}/...

Notes:
  - Close Canopy before running this script.
  - A timestamped backup is created under {dataDir}/migration-backups/.
  - Legacy multi-repo workspaces without a root git repo get a new local-only
    root git repo under {dataDir}/repos/.
EOF
}

data_dir=""
mode="copy"
dry_run="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --data-dir)
      data_dir="${2:-}"
      shift 2
      ;;
    --dev)
      data_dir="$HOME/.canopy-dev"
      shift
      ;;
    --prod)
      data_dir="$HOME/.canopy"
      shift
      ;;
    --dry-run)
      dry_run="1"
      shift
      ;;
    --copy)
      mode="copy"
      shift
      ;;
    --move)
      mode="move"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$data_dir" ]]; then
  echo "Choose --data-dir, --dev, or --prod." >&2
  exit 1
fi

if [[ ! -d "$data_dir" ]]; then
  echo "Data directory does not exist: $data_dir" >&2
  exit 1
fi

legacy_projects_json="$data_dir/projects.json"
legacy_projects_dir="$data_dir/projects"
legacy_multi_dir="$data_dir/multi-repo-workspaces"
legacy_multi_index="$legacy_multi_dir/workspaces.json"

if [[ ! -e "$legacy_projects_json" && ! -e "$legacy_multi_index" ]]; then
  echo "No legacy workspace data found in $data_dir" >&2
  exit 1
fi

timestamp="$(date +%Y%m%d-%H%M%S)"
backup_dir="$data_dir/migration-backups/unified-workspaces-$timestamp"

echo "Data dir: $data_dir"
echo "Mode: $mode"
echo "Dry run: $dry_run"
echo "Backup dir: $backup_dir"

if [[ "$dry_run" != "1" ]]; then
  mkdir -p "$backup_dir"
  [[ -e "$legacy_projects_json" ]] && cp -R "$legacy_projects_json" "$backup_dir/"
  [[ -d "$legacy_projects_dir" ]] && cp -R "$legacy_projects_dir" "$backup_dir/"
  [[ -d "$legacy_multi_dir" ]] && cp -R "$legacy_multi_dir" "$backup_dir/"
fi

DATA_DIR="$data_dir" DRY_RUN="$dry_run" MIGRATION_MODE="$mode" node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const dataDir = process.env.DATA_DIR;
const dryRun = process.env.DRY_RUN === '1';

function log(message) {
  process.stdout.write(`${message}\n`);
}

function run(message, fn) {
  if (dryRun) {
    log(`[dry-run] ${message}`);
    return;
  }
  log(message);
  fn();
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readWorkspaceIndex(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const parsed = readJson(filePath);
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.workspaces)) {
    throw new Error(`Existing unified workspace index is invalid: ${filePath}`);
  }

  return parsed.workspaces.map((entry, index) => {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof entry.id !== 'string' ||
      typeof entry.name !== 'string' ||
      (entry.type !== 'single-repo' && entry.type !== 'multi-repo') ||
      typeof entry.color !== 'string'
    ) {
      throw new Error(`Existing unified workspace index contains an invalid entry at ${filePath}#${index}`);
    }

    return {
      id: entry.id,
      name: entry.name,
      type: entry.type,
      color: entry.color,
      collapsed: Boolean(entry.collapsed),
      order: typeof entry.order === 'number' ? entry.order : index,
      activitySectionOrder: Array.isArray(entry.activitySectionOrder)
        ? entry.activitySectionOrder
        : undefined,
    };
  });
}

function ensureDir(dirPath) {
  if (dryRun) {
    log(`[dry-run] mkdir -p ${dirPath}`);
    return;
  }
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, value) {
  run(`write ${filePath}`, () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  });
}

function copyEntry(srcPath, destPath) {
  if (!fs.existsSync(srcPath)) {
    return;
  }
  run(`copy ${srcPath} -> ${destPath}`, () => {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.cpSync(srcPath, destPath, { recursive: true });
  });
}

function removeEntry(targetPath) {
  run(`remove ${targetPath}`, () => {
    fs.rmSync(targetPath, { recursive: true, force: true });
  });
}

function migrateLegacyWorktreeSummaries(legacyWorkspaceDir, workspaceDir) {
  const legacyWorktreesDir = path.join(legacyWorkspaceDir, 'worktrees');
  if (!fs.existsSync(legacyWorktreesDir)) {
    return;
  }

  const entries = fs.readdirSync(legacyWorktreesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const sourceSummaryPath = path.join(
      legacyWorktreesDir,
      entry.name,
      'summary.json',
    );
    if (!fs.existsSync(sourceSummaryPath)) {
      continue;
    }

    copyEntry(
      sourceSummaryPath,
      path.join(workspaceDir, 'summaries', `${entry.name}.json`),
    );
    removeEntry(path.join(workspaceDir, 'worktrees', entry.name, 'summary.json'));
  }
}

function pathExists(targetPath) {
  return fs.existsSync(targetPath);
}

function sanitizeName(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || 'workspace';
}

function ensureUniquePath(baseDir, preferredName) {
  let attempt = 1;
  let candidate = path.join(baseDir, preferredName);
  while (fs.existsSync(candidate)) {
    attempt += 1;
    candidate = path.join(baseDir, `${preferredName}-${attempt}`);
  }
  return candidate;
}

function ensureUniqueId(existingIds, preferredId) {
  if (!existingIds.has(preferredId)) {
    return preferredId;
  }
  let suffix = 2;
  while (existingIds.has(`${preferredId}-${suffix}`)) {
    suffix += 1;
  }
  return `${preferredId}-${suffix}`;
}

function defaultWorkspaceClaudeMd(workspaceName) {
  return `# ${workspaceName} - Multi-Repository Workspace

This workspace contains multiple individual git repositories. Each repository has its own detailed CLAUDE.md file with specific guidance. The individual repos exist within the repos/ subdirectory.

**Working across repos:** Start by identifying the relevant repo(s) with lightweight, read-only discovery at the workspace level — for example, reading the task, checking file paths and imports, reviewing ticket context, and consulting repo CLAUDE.md files. If you're still unsure after that and there are multiple plausible repos, ask the user to confirm. Do not do deeper workspace exploration or run repo-specific commands yourself at the top level.

**Important:** For any non-trivial task, deeper exploration, file changes, or command execution, always use Agent Teams or Sub Agents isolated to individual repos. Always instruct sub agents to work within the designated repo only and to review the CLAUDE.md for the repo before beginning work. Agents should set their working directory to the individual repo directory and execute git commands within that context.

**Important:** Handling git branches:
- Git branches/repos only exist in the individual nested repos, not top level. When the user is asking for a git related change or command, they mean within the individual nested repos.
- When renaming git branches, always ensure branch names stay in sync across all repos within the workspace. If any branches have been pushed to a remote, warn the user and allow them to confirm the rename for each repo before proceeding.
`;
}

function gitRemoteUrl(repoPath) {
  try {
    return cp
      .execFileSync('git', ['-C', repoPath, 'remote', 'get-url', 'origin'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      .trim();
  } catch {
    return null;
  }
}

function isGitRepo(repoPath) {
  try {
    cp.execFileSync('git', ['-C', repoPath, 'rev-parse', '--git-dir'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

function ensureAgentsSymlink(repoPath) {
  const agentsPath = path.join(repoPath, 'AGENTS.md');
  if (dryRun) {
    log(`[dry-run] symlink ${agentsPath} -> CLAUDE.md`);
    return;
  }
  try {
    fs.rmSync(agentsPath, { recursive: true, force: true });
  } catch {}
  fs.symlinkSync('CLAUDE.md', agentsPath);
}

function createLocalWorkspaceSourceRepo(workspaceId, workspaceName, legacyWorkspaceDir, legacyConfig) {
  const reposDir = path.join(dataDir, 'repos');
  ensureDir(reposDir);
  const rootRepoPath = ensureUniquePath(reposDir, sanitizeName(workspaceName));

  const manifestRepos = [];
  for (const repo of legacyConfig.repos ?? []) {
    const manifestUrl =
      typeof repo.manifestUrl === 'string' && repo.manifestUrl.trim()
        ? repo.manifestUrl.trim()
        : typeof repo.repoPath === 'string'
          ? gitRemoteUrl(repo.repoPath)
          : null;
    if (!manifestUrl) {
      continue;
    }
    manifestRepos.push({
      id: repo.id,
      name: repo.name,
      url: manifestUrl,
    });
  }

  run(`initialize local workspace source repo ${rootRepoPath}`, () => {
    fs.mkdirSync(rootRepoPath, { recursive: true });
    cp.execFileSync('git', ['init'], { cwd: rootRepoPath, stdio: 'ignore' });
    fs.writeFileSync(
      path.join(rootRepoPath, '.gitignore'),
      '# Canopy multi-repo child repositories\nrepos/\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(rootRepoPath, 'canopy.json'),
      `${JSON.stringify({ version: 1, repos: manifestRepos }, null, 2)}\n`,
      'utf8',
    );

    const legacyClaudeMdPath = path.join(legacyWorkspaceDir, 'CLAUDE.md');
    const claudeMdContent = fs.existsSync(legacyClaudeMdPath)
      ? fs.readFileSync(legacyClaudeMdPath, 'utf8')
      : defaultWorkspaceClaudeMd(workspaceName);
    fs.writeFileSync(path.join(rootRepoPath, 'CLAUDE.md'), claudeMdContent, 'utf8');
    ensureAgentsSymlink(rootRepoPath);

    cp.execFileSync('git', ['add', '.'], { cwd: rootRepoPath, stdio: 'ignore' });
    cp.execFileSync(
      'git',
      [
        '-c',
        'user.name=Canopy',
        '-c',
        'user.email=canopy@local.invalid',
        'commit',
        '-m',
        'Initialize workspace source repo',
      ],
      { cwd: rootRepoPath, stdio: 'ignore' },
    );
  });

  return rootRepoPath;
}

function validateWorkspaceRoot(workspaceConfig) {
  if (workspaceConfig.type !== 'multi-repo') {
    return;
  }
  if (!workspaceConfig.sourceRepoPath || !isGitRepo(workspaceConfig.sourceRepoPath)) {
    throw new Error(`Multi-repo workspace is missing a valid source repo: ${workspaceConfig.sourceRepoPath ?? 'none'}`);
  }
  const canopyJsonPath = path.join(workspaceConfig.sourceRepoPath, 'canopy.json');
  if (!fs.existsSync(canopyJsonPath)) {
    throw new Error(`Missing canopy.json in ${workspaceConfig.sourceRepoPath}`);
  }
}

const legacyProjectsJsonPath = path.join(dataDir, 'projects.json');
const legacyProjectsDir = path.join(dataDir, 'projects');
const legacyMultiDir = path.join(dataDir, 'multi-repo-workspaces');
const legacyMultiIndexPath = path.join(legacyMultiDir, 'workspaces.json');
const targetRoot = path.join(dataDir, 'workspaces');
const targetIndexPath = path.join(targetRoot, 'index.json');

const legacyProjectsFile = readJson(legacyProjectsJsonPath);
const legacyWorkspaceIndex = readJson(legacyMultiIndexPath);
const legacyProjects = Array.isArray(legacyProjectsFile?.projects)
  ? legacyProjectsFile.projects
  : [];
const legacyWorkspaces = Array.isArray(legacyWorkspaceIndex?.workspaces)
  ? legacyWorkspaceIndex.workspaces
  : [];

const existingIndexEntries = readWorkspaceIndex(targetIndexPath).sort(
  (left, right) => left.order - right.order,
);
const indexEntries = [...existingIndexEntries];
const seenIds = new Set(indexEntries.map((entry) => entry.id));
const existingIds = new Set(existingIndexEntries.map((entry) => entry.id));
const existingNames = new Set(existingIndexEntries.map((entry) => entry.name));

ensureDir(targetRoot);

for (const project of legacyProjects) {
  if (
    existingIds.has(String(project.id)) ||
    existingNames.has(String(project.name))
  ) {
    log(
      `skip legacy single-repo workspace ${String(project.id)} (${String(project.name)}) because it clashes with an existing unified entry`,
    );
    continue;
  }

  const workspaceId = ensureUniqueId(seenIds, String(project.id));
  seenIds.add(workspaceId);

  const workspaceDir = path.join(targetRoot, workspaceId);
  const legacyProjectDir = path.join(legacyProjectsDir, String(project.id));
  const worktreesFile = readJson(path.join(legacyProjectDir, 'worktrees.json')) ?? {
    version: 1,
    worktrees: [],
  };
  const workspaceConfig = {
    version: 1,
    type: 'single-repo',
    repoPath: project.repoPath,
    repos: [],
    defaultPluginSelections: project.defaultPluginSelections,
    scripts: project.scripts,
  };

  writeJson(path.join(workspaceDir, 'workspace.json'), workspaceConfig);
  writeJson(path.join(workspaceDir, 'worktrees.json'), worktreesFile);
  copyEntry(path.join(legacyProjectDir, 'chats'), path.join(workspaceDir, 'chats'));
  copyEntry(path.join(legacyProjectDir, 'worktrees'), path.join(workspaceDir, 'worktrees'));
  migrateLegacyWorktreeSummaries(legacyProjectDir, workspaceDir);

  indexEntries.push({
    id: workspaceId,
    name: project.name,
    type: 'single-repo',
    color: project.color,
    collapsed: Boolean(project.collapsed),
    order: typeof project.order === 'number' ? project.order : indexEntries.length,
    activitySectionOrder: Array.isArray(project.activitySectionOrder)
      ? project.activitySectionOrder
      : undefined,
  });
}

for (const workspace of legacyWorkspaces) {
  if (
    existingIds.has(String(workspace.id)) ||
    existingNames.has(String(workspace.name))
  ) {
    log(
      `skip legacy multi-repo workspace ${String(workspace.id)} (${String(workspace.name)}) because it clashes with an existing unified entry`,
    );
    continue;
  }

  const workspaceId = ensureUniqueId(seenIds, String(workspace.id));
  seenIds.add(workspaceId);

  const workspaceDir = path.join(targetRoot, workspaceId);
  const legacyWorkspaceDir = path.join(legacyMultiDir, String(workspace.id));
  const legacyConfig =
    readJson(path.join(legacyWorkspaceDir, 'workspace.json')) ?? {
      version: 1,
      repos: [],
    };
  const worktreesFile = readJson(path.join(legacyWorkspaceDir, 'worktrees.json')) ?? {
    version: 1,
    worktrees: [],
  };

  let sourceRepoPath =
    typeof legacyConfig.sourceRepoPath === 'string' &&
    isGitRepo(legacyConfig.sourceRepoPath)
      ? legacyConfig.sourceRepoPath
      : null;
  if (!sourceRepoPath) {
    sourceRepoPath = createLocalWorkspaceSourceRepo(
      workspaceId,
      workspace.name,
      legacyWorkspaceDir,
      legacyConfig,
    );
  }

  const workspaceConfig = {
    version: 1,
    type: 'multi-repo',
    repos: Array.isArray(legacyConfig.repos) ? legacyConfig.repos : [],
    defaultPluginSelections: legacyConfig.defaultPluginSelections,
    scripts: legacyConfig.scripts,
    suppressedRepoIds: legacyConfig.suppressedRepoIds,
    sourceRepoPath,
  };

  validateWorkspaceRoot(workspaceConfig);
  writeJson(path.join(workspaceDir, 'workspace.json'), workspaceConfig);
  writeJson(path.join(workspaceDir, 'worktrees.json'), worktreesFile);
  copyEntry(path.join(legacyWorkspaceDir, 'chats'), path.join(workspaceDir, 'chats'));
  copyEntry(path.join(legacyWorkspaceDir, 'worktrees'), path.join(workspaceDir, 'worktrees'));
  migrateLegacyWorktreeSummaries(legacyWorkspaceDir, workspaceDir);

  indexEntries.push({
    id: workspaceId,
    name: workspace.name,
    type: 'multi-repo',
    color: workspace.color,
    collapsed: Boolean(workspace.collapsed),
    order: typeof workspace.order === 'number' ? workspace.order : indexEntries.length,
    activitySectionOrder: Array.isArray(workspace.activitySectionOrder)
      ? workspace.activitySectionOrder
      : undefined,
  });
}

indexEntries.sort((left, right) => left.order - right.order);
indexEntries.forEach((entry, index) => {
  entry.order = index;
});

writeJson(targetIndexPath, {
  version: 1,
  workspaces: indexEntries,
});

for (const entry of indexEntries) {
  const workspaceDir = path.join(targetRoot, entry.id);
  const configPath = path.join(workspaceDir, 'workspace.json');
  const worktreesPath = path.join(workspaceDir, 'worktrees.json');
  if (!fs.existsSync(configPath) && !dryRun) {
    throw new Error(`Missing workspace.json for ${entry.id}`);
  }
  if (!fs.existsSync(worktreesPath) && !dryRun) {
    throw new Error(`Missing worktrees.json for ${entry.id}`);
  }
}

log('Unified workspace migration complete.');
NODE

if [[ "$mode" == "move" && "$dry_run" != "1" ]]; then
  rm -rf "$legacy_projects_dir" "$legacy_multi_dir"
  rm -f "$legacy_projects_json"
fi

echo "Done."
echo "Review: $data_dir/workspaces"
echo "Backup: $backup_dir"
