/**
 * Deterministic seed + Cloud helpers shared by the CAN-2546 durable spec and
 * capture spec. Kept outside `*.spec.*` so importing it never registers tests.
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  ENTRY_ID,
  WORKSPACE_ID as COWORK_WORKSPACE_ID,
  seedDeliveryCoworkWorkspace,
} from './coworkWorkEntryDoneFixture.mjs';
import { writeJson } from './seeders/index.mjs';
import { sharedContainersCloudApiKeyForWorker } from './sharedContainersCloudFixtureKey.mjs';

export const SHARED_CONTAINERS_CLOUD_API_KEY =
  sharedContainersCloudApiKeyForWorker();
export const SHARED_CONTAINERS_ORGANIZATION_ID =
  '77777777-7777-4777-8777-777777777777';
export const OTHER_SHARED_CONTAINERS_ORGANIZATION_ID =
  '88888888-8888-4888-8888-888888888888';
export const CODE_SERVER_WORKTREE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const COWORK_SERVER_WORKTREE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const ADA_USER_ID = '11111111-1111-4111-8111-111111111111';
export const GRACE_USER_ID = '22222222-2222-4222-8222-222222222222';
export const CODE_NOTE_ID = 'release-note';
export const CODE_PROMPT_ID = 'reviewer-prompt';

const CLOUD_ACCOUNT_CHANGED_EVENT = 'canopy:cloud-account-changed';

/**
 * Build the E2E environment for a shared-container run.
 *
 * The default shim answers `ls-remote`/`fetch` from the local repository so
 * readiness probes never touch the network.
 */
export function buildSharedContainerE2eEnv(userDataDir, baseEnv = {}) {
  const shimPath = path.join(userDataDir, 'shared-container-git-shim.sh');
  const pinnedRemoteSha = baseEnv.CANOPY_E2E_GIT_REMOTE_SHA;
  const resolveRemoteSha =
    typeof pinnedRemoteSha === 'string' &&
    /^[0-9a-f]{40}$/i.test(pinnedRemoteSha)
      ? `sha="${pinnedRemoteSha}"\n`
      : 'sha=$(/usr/bin/git rev-parse HEAD) || exit $?\n';
  writeFileSync(
    shimPath,
    '#!/bin/sh\n' +
      'case "$1 $2 $3" in\n' +
      '  "ls-remote --heads origin")\n' +
      '    ref="$4"\n' +
      `    ${resolveRemoteSha}` +
      '    printf "%s\\t%s\\n" "$sha" "$ref"\n' +
      '    exit 0\n' +
      '    ;;\n' +
      '  "fetch --no-tags origin")\n' +
      '    ref="$4"\n' +
      `    ${resolveRemoteSha}` +
      '    fetch_head=$(/usr/bin/git rev-parse --git-path FETCH_HEAD) || exit $?\n' +
      '    printf "%s\\t\\t%s\\n" "$sha" "$ref" > "$fetch_head"\n' +
      '    exit 0\n' +
      '    ;;\n' +
      'esac\n' +
      'exec /usr/bin/git "$@"\n',
  );
  chmodSync(shimPath, 0o755);
  return {
    GH_TOKEN: SHARED_CONTAINERS_CLOUD_API_KEY,
    ...baseEnv,
    CANOPY_GIT_EXECUTABLE: shimPath,
  };
}

function seedPreferences(userDataDir, metadata) {
  const filePath = path.join(userDataDir, 'preferences.json');
  const current = existsSync(filePath)
    ? JSON.parse(readFileSync(filePath, 'utf8'))
    : { version: 1, preferences: {} };
  writeJson(filePath, {
    ...current,
    version: 1,
    preferences: {
      ...(current.preferences ?? {}),
      onboardingCompleted: ['v1'],
      telemetrySharing: {
        metadata,
        transcripts: 'off',
        plans: 'off',
        summaries: 'off',
      },
    },
  });
}

function configureShareableRepository(repoPath, remoteUrl) {
  try {
    execFileSync('git', ['remote', 'set-url', 'origin', remoteUrl], {
      cwd: repoPath,
      stdio: 'ignore',
    });
  } catch {
    execFileSync('git', ['remote', 'add', 'origin', remoteUrl], {
      cwd: repoPath,
      stdio: 'ignore',
    });
  }
  const branchName = execFileSync(
    'git',
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    { cwd: repoPath, encoding: 'utf8' },
  ).trim();
  execFileSync(
    'git',
    ['update-ref', `refs/remotes/origin/${branchName}`, 'HEAD'],
    { cwd: repoPath, stdio: 'ignore' },
  );
}

export function seedSharedContainerSyncMap({
  userDataDir,
  projectId,
  worktreeId,
  serverWorktreeId,
  anchorOrganizationId,
}) {
  writeJson(
    path.join(
      userDataDir,
      'agent-observability',
      'telemetry-sync',
      'sync-map.json',
    ),
    {
      version: 2,
      workspaces: {
        [projectId]: {
          externalIds: { private: `workspace-${serverWorktreeId}` },
          worktrees: {
            [worktreeId]: {
              ...(anchorOrganizationId
                ? {
                    sharedContainerAnchors: {
                      [anchorOrganizationId]: serverWorktreeId,
                    },
                  }
                : {}),
              targets: {
                private: {
                  externalId: serverWorktreeId,
                  turns: {},
                  plans: {},
                  pullRequests: {},
                  pipelineRuns: {},
                  summaries: {},
                },
              },
            },
          },
        },
      },
    },
  );
}

/**
 * An untracked path deeper than the `max-w-md` invite dialog is wide. Real
 * repository paths reach this length routinely, so the approval row has to wrap
 * rather than size the dialog body.
 */
export const DEEP_UNTRACKED_PATH =
  'src/renderer/components/shared/loading/progress/indicators/CircularProgressIndicatorWithLabel.tsx';

export function seedCodeSharedContainer(
  userDataDir,
  {
    metadata = 'private',
    anchorOrganizationId,
    seedPlanVisibility = false,
    seedDeepUntrackedPath = false,
  } = {},
) {
  const result = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
  });
  const workspace = result.workspaces[0];
  const projectId = workspace.id;
  const worktreeId = 'demo-main';
  const worktreePath = workspace.worktreePath;
  configureShareableRepository(worktreePath, 'https://github.com/acme/app.git');
  writeFileSync(
    path.join(worktreePath, 'share-note.txt'),
    'Owner-approved shared-container fixture.\n',
    'utf8',
  );
  if (seedDeepUntrackedPath) {
    const deepFile = path.join(worktreePath, ...DEEP_UNTRACKED_PATH.split('/'));
    mkdirSync(path.dirname(deepFile), { recursive: true });
    writeFileSync(deepFile, 'export const Placeholder = null;\n', 'utf8');
  }
  const timestamp = '2026-01-01T00:00:00.000Z';
  if (seedPlanVisibility) {
    const plan = (id, hidden) => ({
      id,
      projectId,
      worktreeId,
      source: 'claude',
      title: id,
      content: id,
      reviewStatus: 'pending',
      createdAt: timestamp,
      updatedAt: timestamp,
      latestRevisionNumber: 1,
      revisions: [
        {
          revisionNumber: 1,
          content: id,
          source: 'claude',
          reviewStatus: 'pending',
          createdAt: timestamp,
        },
      ],
      linkedExecutionIds: [],
      hidden,
    });
    writeJson(
      path.join(
        userDataDir,
        'workspaces',
        projectId,
        'plans',
        `${worktreeId}.json`,
      ),
      {
        version: 1,
        plans: [plan('visible-plan', false), plan('hidden-plan', true)],
      },
    );
  }
  for (const item of [
    {
      kind: 'notes',
      id: CODE_NOTE_ID,
      title: 'Release note',
      content: '# Release note\n\nOwner-selected code-worktree note.\n',
    },
    {
      kind: 'prompts',
      id: CODE_PROMPT_ID,
      title: 'Reviewer prompt',
      content: '# Reviewer prompt\n\nReview the shared code worktree.\n',
    },
  ]) {
    const dir = path.join(userDataDir, 'workspaces', projectId, item.kind);
    writeJson(path.join(dir, 'index.json'), {
      version: 1,
      items: {
        [item.id]: {
          id: item.id,
          filename: `${item.id}.md`,
          title: item.title,
          createdAt: timestamp,
          updatedAt: timestamp,
          originWorktreeId: worktreeId,
          originBranchName: 'demo-main',
        },
      },
    });
    writeFileSync(path.join(dir, `${item.id}.md`), item.content, 'utf8');
  }
  seedPreferences(userDataDir, metadata);
  seedSharedContainerSyncMap({
    userDataDir,
    projectId,
    worktreeId,
    serverWorktreeId: CODE_SERVER_WORKTREE_ID,
    anchorOrganizationId,
  });
  return { result, projectId, worktreeId, worktreePath };
}

export function seedMultiRepoCodeSharedContainer(
  userDataDir,
  { metadata = 'private' } = {},
) {
  const result = seedDemoWorkspaces({
    userDataDir,
    apps: ['multi-repo-fullstack'],
  });
  const workspace = result.workspaces[0];
  const projectId = workspace.id;
  const worktreeId = 'demo-main';
  const worktreePath = workspace.worktreePath;
  configureShareableRepository(
    worktreePath,
    'https://github.com/acme/fullstack.git',
  );
  configureShareableRepository(
    path.join(worktreePath, 'repos', 'web'),
    'https://github.com/acme/web.git',
  );
  configureShareableRepository(
    path.join(worktreePath, 'repos', 'api'),
    'https://github.com/acme/api.git',
  );
  writeFileSync(
    path.join(worktreePath, 'repos', 'web', 'share-web-note.txt'),
    'Owner-approved multi-repository fixture.\n',
    'utf8',
  );
  seedPreferences(userDataDir, metadata);
  seedSharedContainerSyncMap({
    userDataDir,
    projectId,
    worktreeId,
    serverWorktreeId: CODE_SERVER_WORKTREE_ID,
  });
  return { result, projectId, worktreeId, worktreePath };
}

/**
 * Cowork notes and prompts are workspace-scoped markdown in the managed dir of
 * the workspace home. Both brand candidate directory names are seeded so the
 * fixture does not depend on which brand the E2E build was made with; only the
 * brand's first candidate is ever read.
 */
function seedCoworkWorkspaceItem(userDataDir, subdir, id, body) {
  for (const dirName of ['.canopy', '.unstoppable-code']) {
    const dir = path.join(
      userDataDir,
      'workspaces',
      COWORK_WORKSPACE_ID,
      'home',
      dirName,
      subdir,
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${id}.md`), body, 'utf8');
  }
}

export const COWORK_NOTE_ID = 'refund-runbook';
export const COWORK_NOTE_TITLE = 'Refund runbook';
export const COWORK_PROMPT_ID = 'reviewer-persona';
export const COWORK_PROMPT_TITLE = 'Reviewer persona';
/** A plain file at the workspace root, as the bug reporter created it. */
export const COWORK_ROOT_FILE_PATH = 'hello.md';
export const COWORK_NESTED_FILE_PATHS = [
  'evidence/customer-reply.txt',
  'evidence/refund-log.txt',
];
/** Every file a default Cowork share now carries, in no particular order. */
export const COWORK_CANDIDATE_FILE_PATHS = [
  COWORK_ROOT_FILE_PATH,
  ...COWORK_NESTED_FILE_PATHS,
];

function seedCoworkCandidateFiles(userDataDir) {
  const home = path.join(
    userDataDir,
    'workspaces',
    COWORK_WORKSPACE_ID,
    'home',
  );
  for (const relativePath of COWORK_CANDIDATE_FILE_PATHS) {
    const filePath = path.join(home, ...relativePath.split('/'));
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${relativePath}\n`, 'utf8');
  }
}

/**
 * The crash reproducer, seeded as ordinary chat history.
 *
 * The preview ranks candidate files by whether the transcript mentions them,
 * and it seeded that ranking from every string in the chat file. A message
 * longer than `NAME_MAX` with no `/` in it resolves to a single over-long path
 * segment, so the `lstat` behind the ranking returned `ENAMETOOLONG` — and the
 * preview rethrew it, taking the whole invite modal's file section with it.
 * Messages this long are ordinary, which is why the feature looked absent
 * rather than broken.
 */
function seedCoworkLongChatMessage(userDataDir) {
  const chatPath = path.join(
    userDataDir,
    'workspaces',
    COWORK_WORKSPACE_ID,
    'chats',
    `${ENTRY_ID}.json`,
  );
  const chats = JSON.parse(readFileSync(chatPath, 'utf8'));
  chats.tabs[0].messages.push({
    id: 'chat-refunds-long-message',
    role: 'assistant',
    blocks: [{ type: 'text', text: 'refund'.repeat(60) }],
    timestamp: Date.parse('2026-01-02T00:00:00.000Z'),
  });
  writeJson(chatPath, chats);
}

export function seedCoworkSharedContainer(
  userDataDir,
  { metadata = 'private' } = {},
) {
  seedDeliveryCoworkWorkspace(userDataDir);
  seedCoworkWorkspaceItem(
    userDataDir,
    'notes',
    COWORK_NOTE_ID,
    `# ${COWORK_NOTE_TITLE}\n\nSteps for issuing a refund.\n`,
  );
  seedCoworkWorkspaceItem(
    userDataDir,
    'prompts',
    COWORK_PROMPT_ID,
    `# ${COWORK_PROMPT_TITLE}\n\nReview this like a support lead.\n`,
  );
  seedCoworkCandidateFiles(userDataDir);
  seedCoworkLongChatMessage(userDataDir);
  seedPreferences(userDataDir, metadata);
  seedSharedContainerSyncMap({
    userDataDir,
    projectId: COWORK_WORKSPACE_ID,
    worktreeId: ENTRY_ID,
    serverWorktreeId: COWORK_SERVER_WORKTREE_ID,
  });
  return { projectId: COWORK_WORKSPACE_ID, worktreeId: ENTRY_ID };
}

export async function connectSharedContainersAccount(window) {
  const saveResult = await window.evaluate(
    async (apiKey) => window.api.saveCanopyCloudApiKey({ apiKey }),
    SHARED_CONTAINERS_CLOUD_API_KEY,
  );
  expect(
    saveResult.status,
    saveResult.status.error ??
      'Shared-container fixture account did not connect',
  ).toMatchObject({ authenticated: true });
  await window.evaluate((eventName) => {
    window.dispatchEvent(new Event(eventName));
  }, CLOUD_ACCOUNT_CHANGED_EVENT);
}

export function readPersistedFileScope(userDataDir, projectId, worktreeId) {
  try {
    return JSON.parse(
      readFileSync(
        path.join(
          userDataDir,
          'workspaces',
          projectId,
          'worktree-data',
          worktreeId,
          'share-file-scope.json',
        ),
        'utf8',
      ),
    );
  } catch (error) {
    // Scope writes replace the JSON in place. An `expect.poll` can land after
    // truncation and before the new bytes are complete; return the same
    // not-ready sentinel as ENOENT so the poll retries. A persistently malformed
    // file still fails the caller's eventual shape assertion.
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}
