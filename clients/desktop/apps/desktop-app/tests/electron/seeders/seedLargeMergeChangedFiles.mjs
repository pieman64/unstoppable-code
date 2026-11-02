import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DEFAULT_GENERATED_FILE_COUNT = 10_200;
const DEFAULT_COMMITTED_BASE_FILE_COUNT = 20;
const PORTAL_CHANGED_FILES_ENTITY_SAFE_CEILING_BYTES = 900_000;
const PORTAL_EVENT_BATCH_MAX_BYTES = 1_048_576;
const SIDE_BRANCH = 'e2e/changed-files-large-merge-side';
const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CONTENT_CONFLICT_PATHS = ['g/00000-cf1', 'g/00199-cf2', 'g/05000-cf3'];
const ADD_ADD_CONFLICT_PATH = 'g/10100-aa';
const GENERATED_FILE_PREFIX = 'g/';
const LONG_GENERATED_FILE_PREFIX =
  'generated/component-library/src/widgets/file-';
const LONG_GENERATED_DIRECTORY = 'generated/component-library/src/widgets';
const LONG_CONTENT_CONFLICT_PATHS = [
  `${LONG_GENERATED_FILE_PREFIX}00000-cf1.tsx`,
  `${LONG_GENERATED_FILE_PREFIX}00199-cf2.tsx`,
  `${LONG_GENERATED_FILE_PREFIX}05000-cf3.tsx`,
];
const LONG_ADD_ADD_CONFLICT_PATH = `${LONG_GENERATED_FILE_PREFIX}10100-aa.tsx`;
const COMMITTED_FILE_PREFIX = 'c/';
const EFFECTIVE_BASE_REF = 'origin/main';

// Keep every Git write deterministic and isolated to the fixture repository.
// In particular, never consult or mutate the user's global Git config.
const FIXTURE_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Canopy UI Automation',
  GIT_AUTHOR_EMAIL: 'canopy-ui-automation@example.invalid',
  GIT_AUTHOR_DATE: '2026-10-23T00:00:00Z',
  GIT_COMMITTER_NAME: 'Canopy UI Automation',
  GIT_COMMITTER_EMAIL: 'canopy-ui-automation@example.invalid',
  GIT_COMMITTER_DATE: '2026-10-23T00:00:00Z',
};

/**
 * Put a freshly seeded demo-main worktree into a deterministic mid-merge
 * state. The side branch contributes generated files; demo-main has a local
 * origin/main base ref and an ahead commit so the Committed group is non-empty
 * before the conflicting merge is applied. Long paths exercise Portal's
 * entity-size limit; the default short paths remain the phase 05 fixture.
 */
export function seedLargeMergeChangedFiles(
  worktreePath,
  {
    generatedFileCount = DEFAULT_GENERATED_FILE_COUNT,
    committedBaseFileCount = DEFAULT_COMMITTED_BASE_FILE_COUNT,
    pathStyle = 'short',
    overCap = false,
  } = {},
) {
  if (!Number.isInteger(generatedFileCount) || generatedFileCount < 10_001) {
    throw new Error(
      'generatedFileCount must be an integer greater than 10,000',
    );
  }
  if (!Number.isInteger(committedBaseFileCount) || committedBaseFileCount < 1) {
    throw new Error('committedBaseFileCount must be a positive integer');
  }
  if (pathStyle !== 'short' && pathStyle !== 'long') {
    throw new Error(
      `pathStyle must be 'short' or 'long', received ${pathStyle}`,
    );
  }
  if (typeof overCap !== 'boolean') {
    throw new Error('overCap must be a boolean');
  }

  const contentConflictPaths =
    pathStyle === 'long' ? LONG_CONTENT_CONFLICT_PATHS : CONTENT_CONFLICT_PATHS;
  const addAddConflictPath =
    pathStyle === 'long' ? LONG_ADD_ADD_CONFLICT_PATH : ADD_ADD_CONFLICT_PATH;
  const generatedDirectoryRelative =
    pathStyle === 'long' ? LONG_GENERATED_DIRECTORY : 'g';

  const baseBranch = runGit(worktreePath, 'branch', '--show-current').trim();
  if (baseBranch !== WORKTREE_ID) {
    throw new Error(
      `Expected the demo-main worktree branch, received ${baseBranch || '(detached HEAD)'}`,
    );
  }
  if (runGit(worktreePath, 'status', '--porcelain').length > 0) {
    throw new Error(
      'Large Changed files fixture requires a clean demo worktree',
    );
  }
  if (
    runGit(worktreePath, 'show-ref', '--verify', `refs/heads/${SIDE_BRANCH}`, {
      allowFailure: true,
    }).status === 0
  ) {
    throw new Error(`Fixture branch already exists: ${SIDE_BRANCH}`);
  }

  const baseCommit = runGit(worktreePath, 'rev-parse', 'HEAD').trim();
  // The demo worktree's effective base is `main`; publish its local remote
  // ref before advancing demo-main. The diff service prefers origin/<base>
  // when it exists and computes committed rows against the merge-base.
  runGit(worktreePath, 'update-ref', 'refs/remotes/origin/main', baseCommit);

  const generatedDirectory = path.join(
    worktreePath,
    generatedDirectoryRelative,
  );
  const committedDirectory = path.join(worktreePath, 'c');
  ensureEmptyOrMissingDirectory(generatedDirectory, generatedDirectoryRelative);
  ensureEmptyOrMissingDirectory(committedDirectory, 'c');
  mkdirSync(generatedDirectory, { recursive: true });
  mkdirSync(committedDirectory, { recursive: true });

  const committedBasePaths = Array.from(
    { length: committedBaseFileCount },
    (_, index) => `${COMMITTED_FILE_PREFIX}${String(index).padStart(5, '0')}`,
  );
  for (const filePath of [...contentConflictPaths, ...committedBasePaths]) {
    if (existsSync(path.join(worktreePath, filePath))) {
      throw new Error(`Fixture path already exists: ${filePath}`);
    }
  }
  if (existsSync(path.join(worktreePath, addAddConflictPath))) {
    throw new Error(`Fixture path already exists: ${addAddConflictPath}`);
  }

  for (const filePath of contentConflictPaths) {
    writeFileSync(
      path.join(worktreePath, filePath),
      `base ${path.basename(filePath)}\nshared line\n`,
      'utf8',
    );
  }
  for (let index = 0; index < committedBaseFileCount; index += 1) {
    const filePath = committedBasePaths[index];
    writeFileSync(
      path.join(worktreePath, filePath),
      `base ${String(index).padStart(5, '0')}\nshared line\n`,
      'utf8',
    );
  }
  runGit(worktreePath, 'add', '--all');
  runGit(
    worktreePath,
    'commit',
    '-m',
    'Seed base for large Changed files merge',
  );

  runGit(worktreePath, 'checkout', '-b', SIDE_BRANCH);
  for (const filePath of contentConflictPaths) {
    writeFileSync(
      path.join(worktreePath, filePath),
      `side ${path.basename(filePath)}\nshared line\n`,
      'utf8',
    );
  }
  writeFileSync(
    path.join(worktreePath, addAddConflictPath),
    'side add/add version\n',
    'utf8',
  );

  for (let index = 0; index < generatedFileCount; index += 1) {
    const filePath = generatedFilePath(index, pathStyle);
    writeFileSync(path.join(worktreePath, filePath), `file ${index}\n`, 'utf8');
  }
  // One staging operation covers the complete generated page and conflicts.
  runGit(worktreePath, 'add', '--all');
  runGit(worktreePath, 'commit', '-m', 'Seed large Changed files merge side');

  runGit(worktreePath, 'checkout', baseBranch);
  for (const filePath of contentConflictPaths) {
    writeFileSync(
      path.join(worktreePath, filePath),
      `target ${path.basename(filePath)}\nshared line\n`,
      'utf8',
    );
  }
  writeFileSync(
    path.join(worktreePath, addAddConflictPath),
    'target add/add version\n',
    'utf8',
  );
  for (let index = 0; index < committedBaseFileCount; index += 1) {
    const filePath = committedBasePaths[index];
    writeFileSync(
      path.join(worktreePath, filePath),
      `target ${String(index).padStart(5, '0')}\nshared line\n`,
      'utf8',
    );
  }
  runGit(worktreePath, 'add', '--all');
  runGit(worktreePath, 'commit', '-m', 'Seed target-side committed changes');

  const merge = runGit(
    worktreePath,
    'merge',
    '--no-commit',
    '--no-ff',
    SIDE_BRANCH,
    {
      allowFailure: true,
    },
  );
  if (merge.status !== 1) {
    throw new Error(
      `Expected a conflicted merge (exit 1), received ${String(merge.status)}: ${merge.stderr.trim()}`,
    );
  }

  const unmergedPaths = new Set(
    runGit(worktreePath, 'ls-files', '--unmerged', '-z')
      .split('\0')
      .filter(Boolean)
      .map((entry) => entry.slice(entry.indexOf('\t') + 1)),
  );
  const expectedConflicts = [...contentConflictPaths, addAddConflictPath];
  for (const filePath of expectedConflicts) {
    if (!unmergedPaths.has(filePath)) {
      throw new Error(
        `Expected an unmerged path after fixture merge: ${filePath}`,
      );
    }
  }

  const stagedGeneratedCount = runGit(
    worktreePath,
    'diff',
    '--cached',
    '--name-only',
    '-z',
  )
    .split('\0')
    .filter((filePath) =>
      pathStyle === 'long'
        ? /^generated\/component-library\/src\/widgets\/file-\d{5}\.tsx$/.test(
            filePath,
          )
        : /^g\/\d{5}$/.test(filePath),
    ).length;
  if (stagedGeneratedCount !== generatedFileCount) {
    throw new Error(
      `Expected ${generatedFileCount} staged generated files, received ${stagedGeneratedCount}`,
    );
  }

  const statusEntries = runGit(
    worktreePath,
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
    '-z',
  )
    .split('\0')
    .filter(Boolean);
  const uncommittedChangedFileCount = statusEntries.length;
  const expectedUncommittedTotal =
    generatedFileCount + expectedConflicts.length;
  if (uncommittedChangedFileCount !== expectedUncommittedTotal) {
    throw new Error(
      `Expected ${expectedUncommittedTotal} uncommitted changed files (generated + conflicts), received ${uncommittedChangedFileCount}`,
    );
  }

  const committedPaths = runGit(
    worktreePath,
    'diff',
    '--name-only',
    '-z',
    `${EFFECTIVE_BASE_REF}..HEAD`,
  )
    .split('\0')
    .filter(Boolean);
  const expectedCommittedTotal =
    committedBaseFileCount + expectedConflicts.length;
  if (committedPaths.length !== expectedCommittedTotal) {
    throw new Error(
      `Expected ${expectedCommittedTotal} committed changed files against ${EFFECTIVE_BASE_REF}, received ${committedPaths.length}`,
    );
  }

  const totalChangedFileCount =
    uncommittedChangedFileCount + committedPaths.length;
  const portalEntityByteEstimate = estimatePortalChangedFilesEntityBytes({
    generatedFileCount,
    conflictedPaths: expectedConflicts,
    committedPaths,
    pathStyle,
  });
  if (overCap) {
    if (portalEntityByteEstimate <= PORTAL_EVENT_BATCH_MAX_BYTES) {
      throw new Error(
        `Expected an over-cap Portal changed_files event above ${PORTAL_EVENT_BATCH_MAX_BYTES} bytes, received ${portalEntityByteEstimate} UTF-8 bytes`,
      );
    }
  } else if (
    portalEntityByteEstimate > PORTAL_CHANGED_FILES_ENTITY_SAFE_CEILING_BYTES
  ) {
    throw new Error(
      `Estimated Portal changed_files event is ${portalEntityByteEstimate} UTF-8 bytes, above the ${PORTAL_CHANGED_FILES_ENTITY_SAFE_CEILING_BYTES}-byte fixture safety ceiling`,
    );
  }

  const sortedCommittedPaths = [...committedPaths].sort((left, right) =>
    left.localeCompare(right),
  );

  return {
    baseBranch,
    effectiveBaseRef: EFFECTIVE_BASE_REF,
    effectiveBaseCommit: baseCommit,
    sideBranch: SIDE_BRANCH,
    generatedFileCount,
    stagedGeneratedCount,
    committedBaseFileCount,
    contentConflictPaths,
    addAddConflictPath,
    conflictedPaths: expectedConflicts,
    firstPageConflictPath: contentConflictPaths[0],
    laterPageConflictPath: contentConflictPaths[1],
    unmergedPathCount: unmergedPaths.size,
    uncommittedChangedFileCount,
    uncommittedGroupTotal: uncommittedChangedFileCount,
    committedChangedFileCount: committedPaths.length,
    committedGroupTotal: committedPaths.length,
    totalChangedFileCount,
    secondPagePath: generatedFilePath(200, pathStyle),
    lastCommittedBasePath: committedBasePaths.at(-1),
    committedLastPath: sortedCommittedPaths.at(-1),
    portalEntityByteEstimate,
    portalEntityByteSafeCeiling: PORTAL_CHANGED_FILES_ENTITY_SAFE_CEILING_BYTES,
  };
}

function ensureEmptyOrMissingDirectory(directoryPath, relativePath) {
  if (!existsSync(directoryPath)) return;
  const entries = readdirSync(directoryPath);
  if (entries.length > 0) {
    throw new Error(
      `Large Changed files fixture expects ${relativePath}/ to be empty; found ${entries[0]}`,
    );
  }
}

/**
 * Measure a representative single-entity snapshot event using the Portal
 * wire shape. The file records mirror PortalChangedFile from diff-service:
 * filePath/status/staged plus optional insertion/deletion counts. The event
 * byte measurement mirrors portalEventByteLength's UTF-8 JSON envelope.
 */
function estimatePortalChangedFilesEntityBytes({
  generatedFileCount,
  conflictedPaths,
  committedPaths,
  pathStyle,
}) {
  const uncommitted = [];
  for (let index = 0; index < generatedFileCount; index += 1) {
    uncommitted.push({
      filePath: generatedFilePath(index, pathStyle),
      status: 'added',
      staged: true,
      insertions: 1,
      deletions: 0,
    });
  }
  for (const filePath of conflictedPaths) {
    uncommitted.push({
      filePath,
      status: 'unmerged',
      staged: true,
    });
  }

  const committed = committedPaths.map((filePath) => ({
    filePath,
    status: 'added',
    staged: true,
    insertions: 2,
    deletions: 0,
  }));
  const entity = {
    entityType: 'changed_files',
    localId: WORKTREE_ID,
    parentLocalId: `${WORKSPACE_ID}:${WORKTREE_ID}`,
    payload: {
      workspaceLocalId: WORKSPACE_ID,
      worktreeLocalId: WORKTREE_ID,
      uncommitted,
      committed,
    },
  };
  const occurredAt = '2026-10-23T00:00:00.000Z';
  const event = {
    type: 'portal.state.snapshot',
    commandId: 'changed-files-large-merge',
    eventId: '00000000-0000-4000-8000-000000000000',
    clientEventId: '00000000-0000-4000-8000-000000000000',
    occurredAt,
    payload: {
      scope: 'worktree',
      target: {
        workspaceLocalId: WORKSPACE_ID,
        worktreeLocalId: WORKTREE_ID,
      },
      entities: [entity],
      generatedAt: occurredAt,
    },
  };
  return Buffer.byteLength(JSON.stringify({ events: [event] }), 'utf8');
}

function generatedFilePath(index, pathStyle) {
  const paddedIndex = String(index).padStart(5, '0');
  return pathStyle === 'long'
    ? `${LONG_GENERATED_FILE_PREFIX}${paddedIndex}.tsx`
    : `${GENERATED_FILE_PREFIX}${paddedIndex}`;
}

function runGit(worktreePath, ...args) {
  const options =
    args.at(-1) &&
    typeof args.at(-1) === 'object' &&
    !Array.isArray(args.at(-1))
      ? args.pop()
      : {};
  const result = spawnSync(
    'git',
    [
      '-C',
      worktreePath,
      '-c',
      `core.hooksPath=${os.devNull}`,
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.quotePath=false',
      ...args,
    ],
    {
      env: FIXTURE_ENV,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  if (result.error) throw result.error;
  if (result.status !== 0 && options.allowFailure !== true) {
    throw new Error(
      `git ${args.join(' ')} failed (${String(result.status)}): ${result.stderr.trim()}`,
    );
  }
  return options.allowFailure === true ? result : result.stdout;
}
