import * as atomicFile from '../lib/atomic-file';
import { execFileSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  rename,
  mkdtemp,
  realpath,
  readFile,
  stat,
  readdir,
  rm,
  writeFile,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  OrgProjectSetupProgress,
  OrgProjectSummary,
} from '@canopy/protocol/org-projects';
import type {
  DesktopOrgProjectCatalogSnapshot,
  OrgProjectOwnershipChangedEvent,
  SidebarItem,
  WorkspaceOwnerBinding,
  WorkspaceOwnershipTransfer,
  WorkspaceType,
} from '@canopy/desktop-shared/types';
import {
  createOrgProjectMaterialization,
  type OrgProjectMaterializationDeps,
} from '../lib/org-project-materialization';
import { cloneRepoWithProgress, parseCloneProgress } from '../lib/git';
import { CanopyCloudClientError } from '../canopy-cloud/client';
import { WorkspaceIdentityInUseError } from '../lib/workspace-service';
import { createActivityRepairLedger } from '../lib/activity-scope-repair';
import {
  DEFAULT_COWORK_WORKSPACE_ID,
  orgDefaultCoworkWorkspaceId,
} from '@canopy/protocol/ui-labels';

jest.mock('../lib/git-executable', () => ({
  getResolvedGitExecutableForSpawn: (): Promise<string> =>
    Promise.resolve('git'),
}));
const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const projectId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const instanceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const operationId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const project: OrgProjectSummary = {
  id: projectId,
  organizationId,
  name: 'Repo',
  description: null,
  kind: 'CODE',
  purpose: 'project',
  visibility: 'organization',
  memberOwned: false,
  location: 'LOCAL',
  repository: {
    provider: 'github',
    host: 'github.com',
    owner: 'owner',
    name: 'repo',
    providerRepoId: null,
    defaultBranch: 'main',
    verification: 'VERIFIED',
  },
  state: 'ACTIVE',
  revision: 1,
  authorizationVersion: 1,
  defaultListed: true,
  preference: 'FOLLOW_DEFAULTS',
  listed: true,
  capabilities: { administer: false, manageCloud: false, use: true },
  instance: null,
};
function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  });
}
function configureHermeticGit(repo: string): void {
  git(repo, ['config', 'user.name', 'Setup Test']);
  git(repo, ['config', 'user.email', 'setup@example.test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  git(repo, ['config', 'tag.gpgsign', 'false']);
}
let root: string;
let destination: string;
let origin: string;
let deps: OrgProjectMaterializationDeps;
let rebindBackgroundExecution: jest.MockedFunction<
  OrgProjectMaterializationDeps['backgroundExecution']['ownershipChanged']
>;
let reports: OrgProjectSetupProgress[];
let sidebarItems: { id: string; owner?: WorkspaceOwnerBinding }[];
let indexAuthority: 'ok' | 'absent' | 'unreadable' | 'partial';
/** `workspace.json` ownership by workspace id, as the injected writer sees it. */
let ownership: Map<
  string,
  | {
      type: WorkspaceType;
      owner?: WorkspaceOwnerBinding;
      ownershipTransfer?: WorkspaceOwnershipTransfer;
    }
  | 'unreadable'
>;
let remoteUrl: jest.MockedFunction<
  OrgProjectMaterializationDeps['workspace']['readRemoteUrl']
>;
let snapshot: DesktopOrgProjectCatalogSnapshot;
let phases: string[];
let journalPhases: string[];
/** Every journal file a write landed in. */
let journalFiles: Set<string>;
const writeAtomic = atomicFile.writeFileAtomically;
/**
 * Makes the nonce store genuinely unreadable — a directory where the file
 * belongs, so `readFile` fails with EISDIR. Corrupt *content* is a different
 * case with a different answer (an empty store), so it cannot be used here.
 */
async function replaceNonceStoreWithDirectory(): Promise<void> {
  const path = join(root, 'journals', 'attempt-nonces.json');
  await rm(path, { force: true });
  await mkdir(path, { recursive: true });
}
const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    (): boolean => true,
    (): boolean => false,
  );
/** Lets a test act in the window a journal write sits in. */
let journalWritten: jest.Mock<Promise<void>, [string]>;
let refresh: jest.MockedFunction<
  OrgProjectMaterializationDeps['catalog']['refresh']
>;
let claim: jest.MockedFunction<OrgProjectMaterializationDeps['cloud']['claim']>;
let complete: jest.MockedFunction<
  OrgProjectMaterializationDeps['cloud']['complete']
>;
let detach: jest.MockedFunction<
  OrgProjectMaterializationDeps['cloud']['detach']
>;
let reportActivityMove: jest.MockedFunction<
  OrgProjectMaterializationDeps['reportActivityMove']
>;
/** The error message of the last reported failed move, if any. */
function lastActivityMoveError(): string | undefined {
  const last = reportActivityMove.mock.lastCall?.[0];
  return last?.result === 'failed' ? last.error : undefined;
}
let moveActivity: jest.MockedFunction<
  OrgProjectMaterializationDeps['cloud']['moveActivity']
>;
let returnActivity: jest.MockedFunction<
  OrgProjectMaterializationDeps['cloud']['returnActivity']
>;
let returnPersonalActivity: jest.MockedFunction<
  OrgProjectMaterializationDeps['cloud']['returnPersonalActivity']
>;
let sharingFor: jest.MockedFunction<
  OrgProjectMaterializationDeps['activityRepair']['sharingFor']
>;
let clone: jest.MockedFunction<OrgProjectMaterializationDeps['git']['clone']>;
let bind: jest.MockedFunction<
  OrgProjectMaterializationDeps['workspace']['createBoundWorkspace']
>;
let applyManagedPrivateMemory: jest.MockedFunction<
  OrgProjectMaterializationDeps['workspace']['applyManagedPrivateMemory']
>;
let removeBound: jest.MockedFunction<
  OrgProjectMaterializationDeps['workspace']['removeBoundWorkspace']
>;
let coworkSetUp: jest.MockedFunction<
  OrgProjectMaterializationDeps['cowork']['setUp']
>;
let createMultiRepoProject: jest.MockedFunction<
  OrgProjectMaterializationDeps['cloud']['createMemberMultiRepoProject']
>;
let createCoworkProject: jest.MockedFunction<
  OrgProjectMaterializationDeps['cloud']['createMemberCoworkProject']
>;
let service: ReturnType<typeof createOrgProjectMaterialization>;
async function terminal(): Promise<OrgProjectSetupProgress> {
  for (let i = 0; i < 500; i += 1) {
    const report = reports.at(-1);
    if (report && ['ready', 'failed', 'cancelled'].includes(report.state))
      return report;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Setup did not settle');
}
/**
 * The one setup journal on disk. Journals are named by their own id
 * (CAN-3129), which a reclaim never changes, rather than by an operation id.
 */
async function listJournalFiles(): Promise<string[]> {
  return (await readdir(join(root, 'journals')))
    .filter(
      (file): boolean =>
        file.endsWith('.json') && file !== 'attempt-nonces.json',
    )
    .map((file): string => join(root, 'journals', file));
}
/** The current attempt's journal: the one still in flight, else the newest. */
async function journalFile(): Promise<string> {
  const candidates: { path: string; live: boolean; modified: number }[] = [];
  for (const path of await listJournalFiles()) {
    const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
    const phase =
      typeof raw === 'object' && raw !== null && 'phase' in raw
        ? raw.phase
        : undefined;
    candidates.push({
      path,
      live: phase !== 'failed' && phase !== 'cancelled',
      modified: (await stat(path)).mtimeMs,
    });
  }
  const [current] = candidates.sort(
    (left, right): number =>
      Number(right.live) - Number(left.live) || right.modified - left.modified,
  );
  if (current === undefined) throw new Error('No setup journal');
  return current.path;
}
async function journal(): Promise<Record<string, unknown>> {
  const raw: unknown = JSON.parse(await readFile(await journalFile(), 'utf8'));
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new Error('Invalid journal');
  return Object.fromEntries(Object.entries(raw));
}
beforeEach(async (): Promise<void> => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'org-project-setup-')));
  destination = join(root, 'destination');
  origin = join(root, 'repo.git');
  await mkdir(destination);
  git(root, ['init', '--bare', '-b', 'main', origin]);
  git(root, ['clone', origin, 'seed']);
  configureHermeticGit(join(root, 'seed'));
  await writeFile(join(root, 'seed', 'README.md'), 'fixture');
  git(join(root, 'seed'), ['add', '.']);
  git(join(root, 'seed'), ['commit', '-m', 'initial']);
  git(join(root, 'seed'), ['push', 'origin', 'main']);
  snapshot = {
    context: `org:${organizationId}`,
    projects: [project],
    revision: '1',
    fetchedAt: '',
    stale: false,
    error: null,
  };
  phases = [];
  sidebarItems = [];
  indexAuthority = 'ok';
  ownership = new Map();
  remoteUrl = jest.fn(
    (): Promise<string | null> =>
      Promise.resolve('git@github.com:owner/repo.git'),
  );
  journalPhases = [];
  journalFiles = new Set();
  journalWritten = jest.fn((): Promise<void> => Promise.resolve());
  jest
    .spyOn(atomicFile, 'writeFileAtomically')
    .mockImplementation(async (path, data, options): Promise<void> => {
      if (
        path.startsWith(join(root, 'journals')) &&
        !path.endsWith('attempt-nonces.json') &&
        typeof data === 'string'
      ) {
        journalFiles.add(path);
        const value: unknown = JSON.parse(data);
        if (
          typeof value === 'object' &&
          value !== null &&
          'phase' in value &&
          typeof value.phase === 'string'
        ) {
          journalPhases.push(value.phase);
          await journalWritten(value.phase);
        }
      }
      await writeAtomic(path, data, options);
    });
  refresh = jest.fn(
    (): Promise<DesktopOrgProjectCatalogSnapshot> => Promise.resolve(snapshot),
  );
  coworkSetUp = jest.fn(() =>
    Promise.resolve({ instanceId: 'cowork-instance' }),
  );
  claim = jest.fn(
    (): ReturnType<OrgProjectMaterializationDeps['cloud']['claim']> =>
      Promise.resolve({
        instanceId,
        operationId,
        fencingGeneration: 7,
        state: 'CLAIMED',
      }),
  );
  reports = [];
  createMultiRepoProject = jest.fn(
    (): Promise<OrgProjectSummary> =>
      Promise.reject(new Error('no multi-repo project in this test')),
  );
  createCoworkProject = jest.fn(
    (): Promise<OrgProjectSummary> =>
      Promise.reject(new Error('no Cowork project in this test')),
  );
  complete = jest.fn(async (): Promise<void> => {});
  detach = jest.fn(async (): Promise<void> => {});
  moveActivity = jest.fn(async (): Promise<void> => {});
  reportActivityMove = jest.fn();
  returnActivity = jest.fn(async (): Promise<void> => {});
  returnPersonalActivity = jest.fn(async (): Promise<void> => {});
  // Just me by default: bound work keeps its private rows private (CAN-3517).
  sharingFor = jest.fn(
    (): ReturnType<
      OrgProjectMaterializationDeps['activityRepair']['sharingFor']
    > =>
      Promise.resolve({
        metadata: 'private',
        transcripts: 'private',
        plans: 'private',
        summaries: 'private',
      }),
  );
  clone = jest.fn(
    async (
      _url: string,
      dest: string,
      options: { signal: AbortSignal; onProgress: (percent: number) => void },
    ): Promise<void> => {
      phases.push(String((await journal()).phase));
      await cloneRepoWithProgress(origin, dest, {
        ...options,
        nonInteractive: true,
      });
    },
  );
  bind = jest.fn(
    async (
      path: string,
      id: string,
      owner: WorkspaceOwnerBinding,
    ): Promise<void> => {
      phases.push(String((await journal()).phase));
      await mkdir(join(root, 'workspaces', id), { recursive: true });
      await writeFile(
        join(root, 'workspaces', id, 'workspace.json'),
        JSON.stringify({ repoPath: path, owner }),
      );
    },
  );
  removeBound = jest.fn((): Promise<boolean> => Promise.resolve(true));
  applyManagedPrivateMemory = jest.fn(async (): Promise<void> => {});
  rebindBackgroundExecution = jest.fn(async (): Promise<void> => {});
  deps = {
    catalog: {
      list: (): Promise<DesktopOrgProjectCatalogSnapshot> =>
        Promise.resolve(snapshot),
      refresh,
    },
    cowork: { setUp: coworkSetUp },
    cloud: {
      claim,
      complete,
      detach,
      createMemberMultiRepoProject: createMultiRepoProject,
      createMemberCoworkProject: createCoworkProject,
      moveActivity,
      returnActivity,
      returnPersonalActivity,
    },
    activityRepair: {
      sharingFor,
      ledger: createActivityRepairLedger((): string =>
        join(root, 'activity-scope-repair.json'),
      ),
    },
    git: { clone },
    workspace: {
      // Mirrors `buildWorkspaceId`: slug-or-suffix against the ids in use.
      buildLocalWorkspaceId: (
        repoName: string,
        items: ReadonlyArray<{ id: string }>,
      ): string =>
        items.some((item) => item.id === repoName) ? `${repoName}-2` : repoName,
      createBoundWorkspace: bind,
      applyManagedPrivateMemory,
      removeBoundWorkspace: removeBound,
      readOwnership: (
        workspaceId,
      ): ReturnType<
        OrgProjectMaterializationDeps['workspace']['readOwnership']
      > => {
        const current = ownership.get(workspaceId);
        if (current === undefined)
          return Promise.resolve({ authority: 'absent' });
        if (current === 'unreadable')
          return Promise.resolve({ authority: 'unreadable' });
        return Promise.resolve({ authority: 'ok', ...current });
      },
      updateOwnership: (
        workspaceId,
        update,
      ): ReturnType<
        OrgProjectMaterializationDeps['workspace']['updateOwnership']
      > => {
        const current = ownership.get(workspaceId);
        if (current === undefined || current === 'unreadable')
          return Promise.resolve('unreadable');
        const next = update({ authority: 'ok', ...current });
        if (next === null) return Promise.resolve('declined');
        ownership.set(workspaceId, {
          type: current.type,
          owner: next.owner,
          ownershipTransfer: next.ownershipTransfer,
        });
        return Promise.resolve('written');
      },
      readRemoteUrl: remoteUrl,
    },
    backgroundExecution: {
      ownershipChanged: rebindBackgroundExecution,
    },
    reportActivityMove,
    resolveDeviceId: (): Promise<string> => Promise.resolve('device'),
    readInstallationGeneration: (): Promise<number> => Promise.resolve(0),
    now: (): string => new Date().toISOString(),
    paths: {
      setupsDir: (): string => join(root, 'journals'),
      coworkRootDir: (id: string, externalPath: string | undefined): string =>
        externalPath ?? join(root, 'workspaces', id, 'home'),
    },
    access: (): ReturnType<OrgProjectMaterializationDeps['access']> =>
      Promise.resolve({
        context: { kind: 'organization', organizationId },
        accountId: 'account',
        enabled: true,
        capabilities: ['org-projects-v1'],
      }),
    preferences: (): ReturnType<OrgProjectMaterializationDeps['preferences']> =>
      Promise.resolve({ orgProjectCloneProtocol: 'https' }),
    readItems: (): ReturnType<OrgProjectMaterializationDeps['readItems']> =>
      Promise.resolve(
        sidebarItems.map((item) => ({
          ...item,
          name: item.id,
          type: 'single-repo',
          repoPath: '/repo',
          color: '',
          collapsed: false,
          order: 0,
          worktrees: [],
        })),
      ),
    readItemsSnapshot: async (): ReturnType<
      OrgProjectMaterializationDeps['readItemsSnapshot']
    > => ({ items: await deps.readItems(), authority: indexAuthority }),
    hasPersonalRelationship: (): Promise<boolean> => Promise.resolve(false),
    resolveTokenSource: (): Promise<'none'> => Promise.resolve('none'),
  };
  service = createOrgProjectMaterialization(deps);
  service.subscribe((progress): void => {
    reports.push(progress);
  });
});
afterEach(async (): Promise<void> => {
  jest.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
// These tests do real filesystem and git work. Under a loaded multi-worker
// Jest run they have exceeded Jest's default 5 s, so leave headroom here.
jest.setTimeout(60_000);

it('sets up a local Cowork project without a destination or clone', async (): Promise<void> => {
  snapshot = {
    ...snapshot,
    projects: [
      {
        ...project,
        kind: 'COWORK',
        visibility: 'private',
        memberOwned: true,
        repository: null,
      },
    ],
  };

  expect((await service.startSetup(projectId, '')).state).toBe('claiming');
  expect(await terminal()).toMatchObject({
    state: 'ready',
    instanceId: 'cowork-instance',
  });

  expect(coworkSetUp).toHaveBeenCalledWith({
    organizationId,
    projectId,
    name: 'Repo',
  });
  expect(clone).not.toHaveBeenCalled();
  expect(claim).not.toHaveBeenCalled();
  expect(reports).toContainEqual(
    expect.objectContaining({
      state: 'materializing',
      message: 'Creating the project on this computer',
    }),
  );
});
it('stamps a private Cowork definition before reporting it ready', async (): Promise<void> => {
  snapshot = {
    ...snapshot,
    projects: [
      { ...project, kind: 'COWORK', location: 'LOCAL', privateMemory: true },
    ],
  };
  coworkSetUp.mockImplementation(() => {
    sidebarItems.push({
      id: 'cowork-private',
      owner: {
        type: 'organization',
        organizationId,
        projectId,
        instanceId,
        bindingGeneration: 1,
      },
    });
    return Promise.resolve({ instanceId });
  });
  await service.startSetup(projectId, '');
  expect(await terminal()).toMatchObject({ state: 'ready' });
  expect(applyManagedPrivateMemory).toHaveBeenCalledWith({
    workspaceId: 'cowork-private',
    organizationId,
    projectId,
    privateMemory: true,
  });
});
it('replays Cowork setup when the cloud instance is ready but the workspace is not indexed', async (): Promise<void> => {
  snapshot = {
    ...snapshot,
    projects: [
      {
        ...project,
        kind: 'COWORK',
        visibility: 'private',
        memberOwned: true,
        repository: null,
        instance: { id: 'ready-cowork-instance', state: 'READY' },
      },
    ],
  };

  expect((await service.startSetup(projectId, '')).state).toBe('claiming');
  await expect(terminal()).resolves.toMatchObject({
    state: 'ready',
    instanceId: 'cowork-instance',
  });

  expect(coworkSetUp).toHaveBeenCalledWith({
    organizationId,
    projectId,
    name: 'Repo',
  });
});
it('accepts a ready Cowork instance when its workspace is already indexed', async (): Promise<void> => {
  const readyInstanceId = 'ready-cowork-instance';
  snapshot = {
    ...snapshot,
    projects: [
      {
        ...project,
        kind: 'COWORK',
        visibility: 'private',
        memberOwned: true,
        repository: null,
        instance: { id: readyInstanceId, state: 'READY' },
      },
    ],
  };
  sidebarItems.push({
    id: 'cowork-project',
    owner: {
      type: 'organization',
      organizationId,
      projectId,
      instanceId: readyInstanceId,
      bindingGeneration: 1,
    },
  });

  expect((await service.startSetup(projectId, '')).state).toBe('claiming');
  await expect(terminal()).resolves.toMatchObject({
    state: 'ready',
    instanceId: readyInstanceId,
  });

  expect(coworkSetUp).not.toHaveBeenCalled();
});
it('clones a real bare repository, binds outside the checkout, and completes the fenced claim', async (): Promise<void> => {
  expect((await service.startSetup(projectId, destination)).state).toBe(
    'claiming',
  );
  expect((await terminal()).state).toBe('ready');
  expect(await readFile(join(destination, 'repo', 'README.md'), 'utf8')).toBe(
    'fixture',
  );
  expect(await readdir(join(root, 'journals'))).toEqual([]);
  expect(phases).toEqual(['cloning', 'bound']);
  expect(journalPhases).toEqual([
    'claimed',
    'cloning',
    'validated',
    'promoted',
    'bound',
    'completing',
    'done',
  ]);
  const config: unknown = JSON.parse(
    await readFile(join(root, 'workspaces', 'repo', 'workspace.json'), 'utf8'),
  );
  expect(config).toMatchObject({
    owner: {
      type: 'organization',
      organizationId,
      projectId,
      instanceId,
      bindingGeneration: 7,
    },
  });
  expect(bind).toHaveBeenCalledWith(join(destination, 'repo'), 'repo', {
    type: 'organization',
    organizationId,
    projectId,
    instanceId,
    bindingGeneration: 7,
  });
  expect(complete).toHaveBeenCalledWith(instanceId, {
    operationId,
    fencingGeneration: 7,
    outcome: 'ready',
  });
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(reports[0]?.state).toBe('claiming');
  expect(reports.some((report) => report.state === 'materializing')).toBe(true);
  expect(await readdir(join(destination, 'repo'))).not.toContain(
    'workspace.json',
  );
});
it('stamps a private code definition before completing setup', async (): Promise<void> => {
  snapshot = {
    ...snapshot,
    projects: [{ ...project, privateMemory: true }],
  };
  await service.startSetup(projectId, destination);
  expect(await terminal()).toMatchObject({ state: 'ready' });
  expect(applyManagedPrivateMemory).toHaveBeenCalledWith({
    workspaceId: 'repo',
    organizationId,
    projectId,
    privateMemory: true,
  });
  expect(applyManagedPrivateMemory.mock.invocationCallOrder[0]).toBeLessThan(
    complete.mock.invocationCallOrder[0] ?? Infinity,
  );
});
it('binds consent to the passed root when the preference changes after start', async (): Promise<void> => {
  const other = join(root, 'other-destination');
  await mkdir(other);
  let remembered = destination;
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  deps.catalog.list = async (): Promise<DesktopOrgProjectCatalogSnapshot> => {
    await held;
    return snapshot;
  };
  deps.preferences = (): ReturnType<
    OrgProjectMaterializationDeps['preferences']
  > =>
    Promise.resolve({
      orgProjectDefaultDestinationRoot: remembered,
    });
  await service.startSetup(projectId, destination);
  remembered = other;
  release();
  expect((await terminal()).state).toBe('ready');
  expect(await readdir(other)).toEqual([]);
  expect(await readFile(join(destination, 'repo', 'README.md'), 'utf8')).toBe(
    'fixture',
  );
});

it('puts back attributes the clone arrived with', async (): Promise<void> => {
  // `init.templateDir` seeds `.git/info/attributes` at clone time. That file is
  // the user's; the safety rule written over it is ours and only for the
  // checkout, so what was there has to survive.
  const template = join(root, 'git-template', 'info');
  await mkdir(template, { recursive: true });
  await writeFile(join(template, 'attributes'), '*.bin binary\n');
  const config = join(root, 'global-git-config');
  await writeFile(
    config,
    `[init]\n\ttemplateDir = ${join(root, 'git-template')}\n`,
  );
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = config;
  try {
    await service.startSetup(projectId, destination);
    expect((await terminal()).state).toBe('ready');
  } finally {
    if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previous;
  }
  expect(
    await readFile(
      join(destination, 'repo', '.git', 'info', 'attributes'),
      'utf8',
    ),
  ).toBe('*.bin binary\n');
});

it('does not run a hook the repository ships, and leaves no attributes behind', async (): Promise<void> => {
  // The clone disables hooks for itself, but populating the tree is a second
  // Git invocation. A global relative `core.hooksPath` resolves inside the new
  // checkout, so a committed hook would run there.
  const config = join(root, 'global-git-config');
  await writeFile(config, '[core]\n\thooksPath = .githooks\n');
  await mkdir(join(root, 'seed', '.githooks'), { recursive: true });
  await writeFile(
    join(root, 'seed', '.githooks', 'post-checkout'),
    `#!/bin/sh\ntouch ${join(root, 'HOOK_RAN')}\n`,
    { mode: 0o755 },
  );
  git(join(root, 'seed'), ['add', '.']);
  git(join(root, 'seed'), ['commit', '-m', 'hooks']);
  git(join(root, 'seed'), ['push', 'origin', 'main']);
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = config;
  try {
    await service.startSetup(projectId, destination);
    expect((await terminal()).state).toBe('ready');
  } finally {
    if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previous;
  }
  expect(await exists(join(root, 'HOOK_RAN'))).toBe(false);
  // The attributes file made this checkout safe; leaving it would disable LFS,
  // diff and merge drivers for every later operation in the user's repository.
  expect(
    await exists(join(destination, 'repo', '.git', 'info', 'attributes')),
  ).toBe(false);
});

it('does not run a filter driver the repository asks for', async (): Promise<void> => {
  // A committed `.gitattributes` can name any driver the user has configured
  // globally, and checkout is where it would run — before anything has looked
  // at this repository. Nothing here gets that turn.
  const config = join(root, 'global-git-config');
  await writeFile(
    config,
    '[filter "boom"]\n\tsmudge = sed s/fixture/pwned/\n\tclean = cat\n',
  );
  await writeFile(join(root, 'seed', '.gitattributes'), '* filter=boom\n');
  git(join(root, 'seed'), ['add', '.']);
  git(join(root, 'seed'), ['commit', '-m', 'attributes']);
  git(join(root, 'seed'), ['push', 'origin', 'main']);
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = config;
  try {
    await service.startSetup(projectId, destination);
    expect((await terminal()).state).toBe('ready');
  } finally {
    if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previous;
  }
  expect(await readFile(join(destination, 'repo', 'README.md'), 'utf8')).toBe(
    'fixture',
  );
});

it('suffixes an occupied destination without altering it', async (): Promise<void> => {
  await mkdir(join(destination, 'repo'));
  await service.startSetup(projectId, destination);
  await terminal();
  expect(bind.mock.calls[0]?.[0]).toBe(join(destination, 'repo-cccccc'));
});
it('joins concurrent starts', async (): Promise<void> => {
  const [a, b] = await Promise.all([
    service.startSetup(projectId, destination),
    service.startSetup(projectId, destination),
  ]);
  expect(a).toEqual(b);
  await terminal();
  expect(claim).toHaveBeenCalledTimes(1);
  expect(clone).toHaveBeenCalledTimes(1);
});
it('cancels the clone, removes staging, and detaches', async (): Promise<void> => {
  clone.mockImplementation(
    async (
      _url: string,
      _dest: string,
      options: { signal: AbortSignal },
    ): Promise<void> => {
      await new Promise<void>((_resolve, reject) =>
        options.signal.addEventListener(
          'abort',
          () => reject(new Error('aborted')),
          { once: true },
        ),
      );
    },
  );
  await service.startSetup(projectId, destination);
  while (!clone.mock.calls.length)
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  await service.cancelSetup(projectId);
  expect((await terminal()).state).toBe('cancelled');
  expect((await journal()).phase).toBe('cancelled');
  expect(await readdir(destination)).toEqual([]);
  expect(detach).toHaveBeenCalledWith(instanceId);
});
it('refuses revoked access before promoting', async (): Promise<void> => {
  deps.catalog.refresh = (): Promise<DesktopOrgProjectCatalogSnapshot> =>
    Promise.resolve({ ...snapshot, projects: [] });
  await service.startSetup(projectId, destination);
  expect(await terminal()).toMatchObject({
    state: 'failed',
    errorCode: 'access-removed',
  });
  expect(await readdir(destination)).toEqual([]);
  expect(detach).toHaveBeenCalledWith(instanceId);
});
it('rejects multi-repo manifests without running or promoting them', async (): Promise<void> => {
  await writeFile(
    join(root, 'seed', 'canopy.json'),
    JSON.stringify({
      version: 1,
      repos: [
        {
          id: 'child',
          name: 'child',
          url: 'https://github.com/owner/child.git',
        },
      ],
    }),
  );
  git(join(root, 'seed'), ['add', '.']);
  git(join(root, 'seed'), ['commit', '-m', 'topology']);
  git(join(root, 'seed'), ['push', 'origin', 'main']);
  await service.startSetup(projectId, destination);
  expect(await terminal()).toMatchObject({
    state: 'failed',
    errorCode: 'unsupported-topology',
  });
  expect(await readdir(destination)).toEqual([]);
});
it('claims under a fresh idempotency key after a terminal attempt', async (): Promise<void> => {
  // The server refuses to reuse an idempotency key whose operation is failed,
  // cancelled or detached ("The original claim is no longer valid; start a new
  // claim"). A key derived only from account, device and project would make
  // Retry permanently impossible for that project on this device.
  clone.mockRejectedValueOnce(new Error('clone exploded'));
  await service.startSetup(projectId, destination);
  expect(await terminal()).toMatchObject({ state: 'failed' });
  const first = claim.mock.calls[0]?.[1].idempotencyKey;
  reports = [];
  await service.startSetup(projectId, destination);
  expect(await terminal()).toMatchObject({ state: 'ready' });
  const second = claim.mock.calls[1]?.[1].idempotencyKey;
  expect(typeof first).toBe('string');
  expect(second).not.toBe(first);
});

it('refuses a symlinked project manifest in the cloned checkout', async (): Promise<void> => {
  // The clone is repository-controlled content. A committed `canopy.json`
  // symlink pointing at an endless device would otherwise be read into the
  // main process unbounded.
  clone.mockImplementationOnce(
    async (
      _url: string,
      dest: string,
      options: { signal: AbortSignal; onProgress: (percent: number) => void },
    ): Promise<void> => {
      await cloneRepoWithProgress(origin, dest, {
        ...options,
        nonInteractive: true,
      });
      await symlink('/dev/zero', join(dest, 'canopy.json'));
    },
  );
  await service.startSetup(projectId, destination);
  expect(await terminal()).toMatchObject({
    state: 'failed',
    errorCode: 'unsupported-project-file',
  });
  expect(await readdir(destination)).toEqual([]);
});

it('refuses to promote after a cancellation was accepted', async (): Promise<void> => {
  // The promotion boundary re-reads the abort signal in the same turn as it
  // sets `promoted`, because the destination checks before it await the
  // filesystem and a Cancel can be accepted inside them. That exact window has
  // no injected seam, so this pins the behaviour either side of it.
  clone.mockImplementationOnce(
    async (
      _url: string,
      dest: string,
      options: { signal: AbortSignal; onProgress: (percent: number) => void },
    ): Promise<void> => {
      await cloneRepoWithProgress(origin, dest, {
        ...options,
        nonInteractive: true,
      });
      void service.cancelSetup(projectId).catch((): void => {});
    },
  );
  await service.startSetup(projectId, destination);
  expect(await terminal()).toMatchObject({ state: 'cancelled' });
  expect(bind).not.toHaveBeenCalled();
  expect(complete).not.toHaveBeenCalled();
  expect(await readdir(destination)).toEqual([]);
});

it('retires an interrupted claim on the next launch', async (): Promise<void> => {
  // The sweep detaches the instance the interrupted attempt claimed, which
  // spends that claim exactly like an ordinary terminal failure does: the next
  // Set up needs a new key.
  complete.mockRejectedValueOnce(
    new CanopyCloudClientError('network-error', 'offline'),
  );
  await service.startSetup(projectId, destination);
  await terminal();
  const first = claim.mock.calls[0]?.[1].idempotencyKey;
  const saved = await journal();
  await rm(join(destination, 'repo'), { recursive: true, force: true });
  await writeFile(
    await journalFile(),
    JSON.stringify({ ...saved, phase: 'cloning' }),
  );
  await createOrgProjectMaterialization(deps).sweepInterruptedSetups();
  expect(detach).toHaveBeenCalled();
  reports = [];
  await service.startSetup(projectId, destination);
  await terminal();
  const second = claim.mock.calls[1]?.[1].idempotencyKey;
  expect(typeof first).toBe('string');
  expect(second).not.toBe(first);
});

it('leaves the final path alone when the promotion never renamed', async (): Promise<void> => {
  // `promoted` is the intent to rename, recorded before it happens so Cancel
  // can be refused. Something else taking the final path between the pre-flight
  // check and the rename makes that rename fail — and what is sitting there is
  // not this attempt's to delete.
  // The window is between the pre-flight existence check and the rename. The
  // `promoted` journal write is the one thing that happens inside it, so it is
  // where the squatter can be made to appear deterministically.
  journalWritten.mockImplementation(async (phase): Promise<void> => {
    if (phase !== 'promoted') return;
    await mkdir(join(destination, 'repo'), { recursive: true });
    await writeFile(join(destination, 'repo', 'SQUATTER.md'), 'not mine');
  });
  await service.startSetup(projectId, destination);
  expect(await terminal()).toMatchObject({ state: 'failed' });
  expect(await readFile(join(destination, 'repo', 'SQUATTER.md'), 'utf8')).toBe(
    'not mine',
  );
});

it('removes a promoted checkout nothing else knows about yet', async (): Promise<void> => {
  // Between the rename and the binding, the checkout exists and no durable
  // state refers to it. The run that made it is the run unwinding it, so it
  // goes with the attempt rather than sitting in the destination folder as
  // unexplained files.
  journalWritten.mockImplementation((phase): Promise<void> => {
    if (phase === 'bound')
      return Promise.reject(new Error('journal write failed'));
    return Promise.resolve();
  });
  await service.startSetup(projectId, destination);
  expect(await terminal()).toMatchObject({ state: 'failed' });
  expect(
    await stat(join(destination, 'repo')).then(
      (): boolean => true,
      (): boolean => false,
    ),
  ).toBe(false);
});

it('never detaches a completed setup, from either cleanup path', async (): Promise<void> => {
  // A `done` journal is a crash between the completion the server accepted and
  // the local cleanup. Both the startup sweep and the next Set up reach the
  // same leftover journal, so neither may hand that instance back.
  complete.mockRejectedValueOnce(
    new CanopyCloudClientError('network-error', 'offline'),
  );
  await service.startSetup(projectId, destination);
  await terminal();
  const saved = await journal();
  const leftover = JSON.stringify({ ...saved, phase: 'done' });
  const path = await journalFile();

  await writeFile(path, leftover);
  detach.mockClear();
  await createOrgProjectMaterialization(deps).sweepInterruptedSetups();
  expect(detach).not.toHaveBeenCalled();

  await writeFile(path, leftover);
  detach.mockClear();
  reports = [];
  await service.startSetup(projectId, destination);
  await terminal();
  expect(detach).not.toHaveBeenCalled();
});

it('takes the checkout with it when the workspace id was taken', async (): Promise<void> => {
  // Binding is marked started before the call so that a half-written workspace
  // is never deleted. An id claimed by something else while this attempt was
  // cloning is the one failure that wrote nothing, so the checkout is still
  // this attempt's and must not be left behind for the user to find.
  bind.mockImplementationOnce(
    (): Promise<never> => Promise.reject(new WorkspaceIdentityInUseError()),
  );
  await service.startSetup(projectId, destination);
  expect(await terminal()).toMatchObject({ state: 'failed' });
  expect(
    await stat(join(destination, 'repo')).then(
      (): boolean => true,
      (): boolean => false,
    ),
  ).toBe(false);
});

it('keeps a checkout the workspace index already knows about', async (): Promise<void> => {
  // `createBoundWorkspace` persists the index entry before the rest of a
  // workspace's metadata. A failure after that point leaves durable state
  // pointing at the checkout, so deleting it would strand that state.
  bind.mockImplementationOnce((): Promise<never> => {
    sidebarItems.push({
      id: 'repo',
      name: 'repo',
      type: 'single-repo',
      repoPath: join(destination, 'repo'),
      color: '',
      collapsed: false,
      order: 0,
      worktrees: [],
    });
    return Promise.reject(new Error('worktrees.json write failed'));
  });
  await service.startSetup(projectId, destination);
  expect(await terminal()).toMatchObject({ state: 'failed' });
  expect(await readFile(join(destination, 'repo', 'README.md'), 'utf8')).toBe(
    'fixture',
  );
});

it('does not detach an instance whose completion may have landed', async (): Promise<void> => {
  // The `done` checkpoint is a separate write from the completion itself, so a
  // journal can still read `completing` while the server has the instance
  // READY. Detaching on the next launch would undo a completion the server
  // accepted; the claim's own lease is the safe way to lose an unfinished one.
  complete.mockRejectedValueOnce(
    new CanopyCloudClientError('network-error', 'offline'),
  );
  await service.startSetup(projectId, destination);
  await terminal();
  const saved = await journal();
  await writeFile(
    await journalFile(),
    JSON.stringify({ ...saved, phase: 'completing' }),
  );
  detach.mockClear();
  await createOrgProjectMaterialization(deps).sweepInterruptedSetups();
  expect(detach).not.toHaveBeenCalled();
  expect(await readdir(join(root, 'journals'))).toEqual([]);
});

it('detaches an interrupted claim that never reached a checkout', async (): Promise<void> => {
  // Before promotion there is nothing a completion could have committed, so
  // freeing the claim now beats waiting out its lease.
  complete.mockRejectedValueOnce(
    new CanopyCloudClientError('network-error', 'offline'),
  );
  await service.startSetup(projectId, destination);
  await terminal();
  const saved = await journal();
  await writeFile(
    await journalFile(),
    JSON.stringify({ ...saved, phase: 'cloning' }),
  );
  detach.mockClear();
  await createOrgProjectMaterialization(deps).sweepInterruptedSetups();
  expect(detach).toHaveBeenCalledTimes(1);
});

it('detaches when the failure landed before any completion went out', async (): Promise<void> => {
  // A bind failure never asked the server to complete anything, so the claim
  // is safe to hand back immediately rather than leaving the user waiting out
  // its lease before they can retry.
  bind.mockRejectedValueOnce(new Error('workspace index busy'));
  await service.startSetup(projectId, destination);
  expect(await terminal()).toMatchObject({ state: 'failed' });
  expect(detach).toHaveBeenCalledTimes(1);
});

it('does not detach a promoted attempt that failed to complete', async (): Promise<void> => {
  // Same rule inside a live attempt: an offline completion may still have been
  // accepted, so the instance is not ours to detach.
  complete.mockRejectedValueOnce(
    new CanopyCloudClientError('network-error', 'offline'),
  );
  await service.startSetup(projectId, destination);
  expect(await terminal()).toMatchObject({ state: 'failed' });
  expect(detach).not.toHaveBeenCalled();
});

it('reports nothing while retiring an interrupted setup', async (): Promise<void> => {
  // The sweep runs at startup, before any window exists to hear it. It must
  // not depend on being heard: the row's state comes from the catalog when the
  // renderer subscribes, not from progress emitted into an empty room.
  complete.mockRejectedValueOnce(
    new CanopyCloudClientError('network-error', 'offline'),
  );
  await service.startSetup(projectId, destination);
  await terminal();
  const saved = await journal();
  await writeFile(
    await journalFile(),
    JSON.stringify({ ...saved, phase: 'cloning' }),
  );
  reports = [];
  await createOrgProjectMaterialization(deps).sweepInterruptedSetups();
  expect(reports).toEqual([]);
  expect(await readdir(join(root, 'journals'))).toEqual([]);
});

it('hands back the claim even when the cleanup cannot finish', async (): Promise<void> => {
  // Terminalizing the journal is last on purpose. If an earlier step throws —
  // here, an unreadable nonce store — the claim is still handed back and the
  // journal stays readable as in-flight, so the next launch's sweep finishes
  // the job instead of skipping a journal already marked failed.
  journalWritten.mockImplementation(async (phase): Promise<void> => {
    if (phase === 'cloning') await replaceNonceStoreWithDirectory();
  });
  clone.mockRejectedValueOnce(new Error('clone exploded'));
  await service.startSetup(projectId, destination);
  expect(await terminal()).toMatchObject({ state: 'failed' });
  expect(detach).toHaveBeenCalledWith(instanceId);
  const saved = await journal();
  expect(['failed', 'cancelled']).not.toContain(saved.phase);
});

it('does not terminalize a leftover journal whose key it could not spend', async (): Promise<void> => {
  // Same rule as the failure path: a journal marked terminal is one the sweep
  // skips, so recording that before the key is actually spent would strand the
  // key and the setup it belongs to for good.
  complete.mockRejectedValueOnce(
    new CanopyCloudClientError('network-error', 'offline'),
  );
  await service.startSetup(projectId, destination);
  await terminal();
  const saved = await journal();
  await writeFile(
    await journalFile(),
    JSON.stringify({ ...saved, phase: 'cloning' }),
  );
  await replaceNonceStoreWithDirectory();
  // The sweep reports what it could not retire rather than reporting success.
  await expect(
    createOrgProjectMaterialization(deps).sweepInterruptedSetups(),
  ).rejects.toThrow('could not be retired');
  expect((await journal()).phase).toBe('cloning');
});

it('starts fresh when the nonce store is corrupt', async (): Promise<void> => {
  // Unreadable and unusable are different answers. Content that cannot be
  // parsed says nothing about what keys were spent, and one corrupt
  // bookkeeping file must not make the project impossible to set up — so it
  // takes the empty default every persisted file here takes.
  await mkdir(join(root, 'journals'), { recursive: true });
  await writeFile(join(root, 'journals', 'attempt-nonces.json'), '{ not json');
  await service.startSetup(projectId, destination);
  expect((await terminal()).state).toBe('ready');
});

it('does not mistake an unreadable nonce store for an empty one', async (): Promise<void> => {
  // Answering "no nonces" for a store that could not be read lets retirement
  // report success while the spent key is still on disk — and the journal that
  // would have said otherwise is deleted on the strength of it. Unreadable is
  // not empty, so the retirement fails and the journal stays for the sweep.
  journalWritten.mockImplementation(async (phase): Promise<void> => {
    if (phase === 'completing') await replaceNonceStoreWithDirectory();
  });
  await service.startSetup(projectId, destination);
  expect((await terminal()).state).toBe('ready');
  expect(await journal()).toMatchObject({ operationId });
});

it('keeps the journal when the key could not be retired', async (): Promise<void> => {
  // The journal is what tells the sweep the key still needs spending. Removing
  // it after a failed rotation would leave a live key with no record of it,
  // and the next setup would present one the server has already retired.
  // A second project's nonce keeps the store non-empty, so retiring this one
  // rewrites the file rather than removing it — the path that can fail.
  await mkdir(join(root, 'journals'), { recursive: true });
  await writeFile(
    join(root, 'journals', 'attempt-nonces.json'),
    JSON.stringify({
      version: 2,
      nonces: {
        other: {
          nonce: '11111111-1111-4111-8111-111111111111',
          localWorkspaceId: 'other',
        },
      },
    }),
  );
  const write = jest.spyOn(atomicFile, 'writeFileAtomically');
  const real = write.getMockImplementation();
  write.mockImplementation(async (path, data, options): Promise<void> => {
    // Only the write that *retires* this project's nonce fails; the one that
    // mints it has to succeed for the attempt to reach completion at all.
    if (
      path.endsWith('attempt-nonces.json') &&
      typeof data === 'string' &&
      !data.includes(projectId)
    )
      throw new Error('nonce store unwritable');
    await real?.(path, data, options);
  });
  try {
    await service.startSetup(projectId, destination);
    await terminal();
  } finally {
    write.mockImplementation(real ?? writeAtomic);
  }
  expect(await journal()).toMatchObject({ operationId });
});

it('clears a journal left behind by a completed setup', async (): Promise<void> => {
  // Completion deletes the journal and retires the nonce together. If a crash
  // lands between them, the next launch finds a `done` journal — and must
  // retire the key there too, or the next legitimate setup presents a spent
  // one and is refused.
  complete.mockRejectedValueOnce(
    new CanopyCloudClientError('network-error', 'offline'),
  );
  await service.startSetup(projectId, destination);
  await terminal();
  const first = claim.mock.calls[0]?.[1].idempotencyKey;
  const saved = await journal();
  await writeFile(
    await journalFile(),
    JSON.stringify({ ...saved, phase: 'done' }),
  );
  await createOrgProjectMaterialization(deps).sweepInterruptedSetups();
  expect(await readdir(join(root, 'journals'))).toEqual([]);
  await rm(join(destination, 'repo'), { recursive: true, force: true });
  reports = [];
  await service.startSetup(projectId, destination);
  await terminal();
  expect(typeof first).toBe('string');
  expect(claim.mock.calls[1]?.[1].idempotencyKey).not.toBe(first);
});

it('retries a pre-promotion failure even when something occupies the destination', async (): Promise<void> => {
  // A failed attempt keeps a prospective final path it never promoted. An
  // unrelated directory appearing there must not make Retry answer "already a
  // workspace"; collision-suffix allocation handles it.
  clone.mockRejectedValueOnce(new Error('clone exploded'));
  await service.startSetup(projectId, destination);
  expect(await terminal()).toMatchObject({ state: 'failed' });
  await mkdir(join(destination, 'repo'), { recursive: true });
  await writeFile(join(destination, 'repo', 'SOMEONE_ELSE.md'), 'unrelated');
  reports = [];
  await service.startSetup(projectId, destination);
  expect(await terminal()).toMatchObject({ state: 'ready' });
  expect(clone).toHaveBeenCalledTimes(2);
});

it('keeps both nonces when two setups start at once', async (): Promise<void> => {
  // Both attempts read-modify-write the same store. Unserialized, the second
  // write lands on a snapshot taken before the first and erases its entry, so
  // that project's next start claims under a key its pending operation never
  // used. Holding both inside `claim` keeps this to the store itself: no
  // clone, no checkout, nothing to clean up.
  const second = {
    ...project,
    id: `${projectId.slice(0, -1)}c`,
    name: 'Other',
  };
  snapshot.projects = [project, second];
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let claiming = 0;
  claim.mockImplementation(async (): Promise<never> => {
    claiming += 1;
    await held;
    throw new Error('claim abandoned');
  });
  await Promise.all([
    service.startSetup(projectId, destination),
    service.startSetup(second.id, destination),
  ]);
  for (let i = 0; i < 200 && claiming < 2; i += 1)
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  expect(claiming).toBe(2);
  const raw: unknown = JSON.parse(
    await readFile(join(root, 'journals', 'attempt-nonces.json'), 'utf8'),
  );
  expect(typeof raw).toBe('object');
  const store: Record<string, unknown> =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? Object.fromEntries(Object.entries(raw))
      : {};
  expect(store.version).toBe(2);
  const nonces: Record<string, unknown> =
    typeof store.nonces === 'object' &&
    store.nonces !== null &&
    !Array.isArray(store.nonces)
      ? Object.fromEntries(Object.entries(store.nonces))
      : {};
  // Each entry carries the workspace id its key was computed over, so a retry
  // presents the same key with the same body.
  const identity = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value))
      : {};
  expect(typeof identity(nonces[projectId]).nonce).toBe('string');
  expect(typeof identity(nonces[projectId]).localWorkspaceId).toBe('string');
  expect(typeof identity(nonces[second.id]).nonce).toBe('string');
  expect(typeof identity(nonces[second.id]).localWorkspaceId).toBe('string');
  release();
  for (let i = 0; i < 200 && reports.length < 4; i += 1)
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
});

it('refuses to materialize a project that is not a local code project', async (): Promise<void> => {
  // A cloud-hosted project has no local checkout to make. It must be rejected
  // before anything is claimed or cloned, not at a server boundary later.
  snapshot.projects = [{ ...project, location: 'CLOUD' }];
  await service.startSetup(projectId, destination);
  expect(await terminal()).toMatchObject({
    state: 'failed',
    errorCode: 'unsupported-location',
  });
  expect(claim).not.toHaveBeenCalled();
  expect(clone).not.toHaveBeenCalled();
});

it('never sets up a multi-repository project from the catalog (CAN-3532)', async (): Promise<void> => {
  // A member's converted multi-repo project exists only on the device that
  // converted it; cloning its first repository elsewhere would be a different
  // project.
  snapshot.projects = [{ ...project, topology: 'multi-repo' }];
  await service.startSetup(projectId, destination);
  expect(await terminal()).toMatchObject({
    state: 'failed',
    errorCode: 'unsupported-multi-repo',
  });
  expect(claim).not.toHaveBeenCalled();
  expect(clone).not.toHaveBeenCalled();
});

it('binds under the id the server was told, even as the list moves', async (): Promise<void> => {
  // The id travels to the server with the claim. Naming around a project that
  // appeared mid-clone would bind under a name the server does not know, and
  // nothing reconciles that afterwards, so the claimed id stands.
  clone.mockImplementationOnce(
    async (
      _url: string,
      dest: string,
      options: { signal: AbortSignal; onProgress: (percent: number) => void },
    ): Promise<void> => {
      await cloneRepoWithProgress(origin, dest, {
        ...options,
        nonInteractive: true,
      });
      sidebarItems.push({ id: 'repo' });
    },
  );
  await service.startSetup(projectId, destination);
  expect(await terminal()).toMatchObject({ state: 'ready' });
  expect(bind.mock.calls[0]?.[1]).toBe('repo');
});

it('hands back a claim it could not write down', async (): Promise<void> => {
  // Between the claim response and the journal that records it, the
  // destination checks touch the filesystem. A broken symlink there makes
  // `realpath` throw, and a claim nobody wrote down is still one the server
  // holds — so it is detached and its key spent rather than stranded.
  await symlink(join(root, 'nowhere'), join(destination, 'repo'));
  await service.startSetup(projectId, destination);
  expect(await terminal()).toMatchObject({ state: 'failed' });
  expect(detach).toHaveBeenCalledWith(instanceId);
  const first = claim.mock.calls[0]?.[1].idempotencyKey;

  await rm(join(destination, 'repo'));
  reports = [];
  await service.startSetup(projectId, destination);
  await terminal();
  expect(claim.mock.calls[1]?.[1].idempotencyKey).not.toBe(first);
});

it('replays the workspace id the retained key was computed over', async (): Promise<void> => {
  // The key is an idempotency key over a *request*. If the sidebar moves
  // between an ambiguous claim and the retry, recomputing the id would present
  // the same key with a different body, which the server rejects.
  claim.mockRejectedValueOnce(
    new CanopyCloudClientError('network-error', 'offline'),
  );
  await service.startSetup(projectId, destination);
  expect(await terminal()).toMatchObject({ state: 'failed' });
  const first = claim.mock.calls[0]?.[1];

  // Something else takes the obvious name before the retry.
  sidebarItems.push({
    id: 'repo',
    name: 'repo',
    type: 'single-repo',
    repoPath: join(root, 'elsewhere'),
    color: '',
    collapsed: false,
    order: 1,
    worktrees: [],
  });
  reports = [];
  await service.startSetup(projectId, destination);
  await terminal();
  const second = claim.mock.calls[1]?.[1];
  expect(second?.idempotencyKey).toBe(first?.idempotencyKey);
  expect(second?.localWorkspaceId).toBe(first?.localWorkspaceId);
  expect(typeof first?.localWorkspaceId).toBe('string');
});

it('reports a journal it could not read instead of sweeping past it', async (): Promise<void> => {
  // An unreadable journal may still be authorizing a live claim. Answering
  // "nothing to do" would leave that claim, its key and its journal behind
  // while the sweep reported success.
  await mkdir(join(root, 'journals'), { recursive: true });
  const path = join(root, 'journals', 'unreadable.json');
  await writeFile(path, '{}');
  await chmod(path, 0o000);
  try {
    // Precondition: this really is unreadable for the user running the test.
    await expect(readFile(path, 'utf8')).rejects.toThrow();
    await expect(
      createOrgProjectMaterialization(deps).sweepInterruptedSetups(),
    ).rejects.toThrow('could not be read');
  } finally {
    await chmod(path, 0o600);
  }
});

it('keeps the claim key when a claim goes out and no answer comes back', async (): Promise<void> => {
  // The claim may well have committed. Retrying under a new key mints alias
  // receipts against the same operation instead of replaying it, and the
  // server caps those.
  claim.mockRejectedValueOnce(
    new CanopyCloudClientError('network-error', 'offline'),
  );
  await service.startSetup(projectId, destination);
  expect(await terminal()).toMatchObject({ state: 'failed' });
  reports = [];
  await service.startSetup(projectId, destination);
  await terminal();
  expect(claim.mock.calls[1]?.[1].idempotencyKey).toBe(
    claim.mock.calls[0]?.[1].idempotencyKey,
  );
});

it('never shows an internal error as the row reason', async (): Promise<void> => {
  // A Node errno or "Unsafe staging path" is for the log, not the sidebar.
  bind.mockRejectedValueOnce(new Error('EACCES: permission denied, mkdir'));
  await service.startSetup(projectId, destination);
  const report = await terminal();
  expect(report.message).not.toContain('EACCES');
  expect(report.message).toBe('Project setup failed');
});

it('retires the key when the server rejects the claim outright', async (): Promise<void> => {
  // A lost response keeps its key so the retry replays the original operation.
  // A definitive rejection is the opposite: reusing that key only replays the
  // rejection.
  claim.mockRejectedValueOnce(
    new CanopyCloudClientError('http-error', 'conflict', 409, 'conflict'),
  );
  await service.startSetup(projectId, destination);
  expect(await terminal()).toMatchObject({ state: 'failed' });
  reports = [];
  await service.startSetup(projectId, destination);
  await terminal();
  expect(claim.mock.calls[1]?.[1].idempotencyKey).not.toBe(
    claim.mock.calls[0]?.[1].idempotencyKey,
  );
});

it.each(['relative', 'inside', 'symlink', 'missing', 'file', 'empty'])(
  'rejects an unsafe %s destination',
  async (mode): Promise<void> => {
    if (mode === 'relative') destination = 'relative';
    if (mode === 'missing') destination = join(root, 'missing');
    if (mode === 'file') destination = join(root, 'seed', 'README.md');
    if (mode === 'empty') destination = '';
    if (mode === 'inside')
      deps.readItems = (): ReturnType<
        OrgProjectMaterializationDeps['readItems']
      > =>
        Promise.resolve([
          {
            id: 'existing',
            name: 'Existing',
            type: 'single-repo',
            repoPath: root,
            color: '',
            collapsed: false,
            order: 0,
            worktrees: [],
          },
        ]);
    if (mode === 'symlink') {
      await symlink(root, join(destination, 'repo'));
    }
    await service.startSetup(projectId, destination);
    expect(await terminal()).toMatchObject({
      state: 'failed',
      errorCode: 'invalid-destination',
    });
    expect(clone).not.toHaveBeenCalled();
  },
);
it.each<[string, number | null]>([
  ['Receiving objects:  42% (5/12)\r', 42],
  ['Resolving deltas: 100% (1/1)', 100],
  ['other output', null],
])('parses progress %s', (line, expected): void => {
  expect(parseCloneProgress(line)).toBe(expected);
});

it.each([
  ['http-error', 409, 'conflict', 'claim-conflict'],
  ['http-error', 404, 'not_found', 'access-removed'],
])(
  'classifies claim %s %s by status and code',
  async (_transport, status, serverCode, errorCode): Promise<void> => {
    deps.cloud.claim = (): Promise<never> => {
      return Promise.reject(
        new CanopyCloudClientError(
          'http-error',
          'server copy',
          Number(status),
          String(serverCode),
        ),
      );
    };
    await service.startSetup(projectId, destination);
    expect(await terminal()).toMatchObject({ state: 'failed', errorCode });
    expect(clone).not.toHaveBeenCalled();
  },
);
it.each([
  "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
  "fatal: Authentication failed for 'https://github.com/acme/repo.git/'",
])(
  'offers GitHub sign-in for an HTTPS credential failure: %s',
  async (stderr): Promise<void> => {
    clone.mockRejectedValue(new Error(stderr));
    await service.startSetup(projectId, destination);
    expect(await terminal()).toMatchObject({
      state: 'failed',
      errorCode: 'github-not-authenticated',
      message: 'GitHub access is needed to clone this repository',
    });
    expect(await readdir(destination)).toEqual([]);
  },
);
it.each(['Permission denied', 'Repository not found', '403', '401'])(
  'classifies clone authentication: %s',
  async (stderr): Promise<void> => {
    clone.mockRejectedValue(new Error(stderr));
    await service.startSetup(projectId, destination);
    expect(await terminal()).toMatchObject({
      state: 'failed',
      errorCode: 'needs-credentials',
    });
    expect(await readdir(destination)).toEqual([]);
  },
);
it('keeps SSH credential failures on needs-credentials', async (): Promise<void> => {
  deps.preferences = (): ReturnType<
    OrgProjectMaterializationDeps['preferences']
  > => Promise.resolve({ orgProjectCloneProtocol: 'ssh' });
  service = createOrgProjectMaterialization(deps);
  service.subscribe((progress): void => {
    reports.push(progress);
  });
  clone.mockRejectedValue(
    new Error("fatal: could not read Username for 'https://github.com'"),
  );
  await service.startSetup(projectId, destination);
  expect(await terminal()).toMatchObject({
    state: 'failed',
    errorCode: 'needs-credentials',
  });
  expect(clone.mock.calls[0]?.[0]).toMatch(/^git@github\.com:/);
});
it('keeps other clone errors distinct', async (): Promise<void> => {
  clone.mockRejectedValue(new Error('disk full'));
  await service.startSetup(projectId, destination);
  expect(await terminal()).toMatchObject({
    state: 'failed',
    errorCode: 'clone-failed',
  });
});

it('refuses cancellation while completing a promoted workspace', async (): Promise<void> => {
  let release: () => void = (): void => {};
  complete.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await service.startSetup(projectId, destination);
  while (!complete.mock.calls.length)
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  await expect(service.cancelSetup(projectId)).rejects.toThrow(
    'already a workspace',
  );
  release();
  expect((await terminal()).state).toBe('ready');
  expect(detach).not.toHaveBeenCalled();
});

it('does not clone an instance that is already ready on this device', async (): Promise<void> => {
  snapshot = {
    ...snapshot,
    projects: [{ ...project, instance: { id: instanceId, state: 'READY' } }],
  };
  sidebarItems.push({
    id: 'repo',
    owner: {
      type: 'organization',
      organizationId,
      projectId,
      instanceId,
      bindingGeneration: 1,
    },
  });
  await service.startSetup(projectId, destination);
  expect(await terminal()).toMatchObject({ state: 'ready', instanceId });
  expect(clone).not.toHaveBeenCalled();
  expect(claim).not.toHaveBeenCalled();
  expect(detach).not.toHaveBeenCalled();
});

it('releases a ready instance whose workspace is gone and sets the project up again (CAN-3592)', async (): Promise<void> => {
  // Removing a bound workspace leaves its instance READY on the server. With
  // nothing bound here, reporting ready would hide the project for good: no
  // sidebar row and an Add that says it is already added.
  snapshot = {
    ...snapshot,
    projects: [
      { ...project, instance: { id: 'stale-instance', state: 'READY' } },
    ],
  };
  await service.startSetup(projectId, destination);
  expect(await terminal()).toMatchObject({ state: 'ready', instanceId });
  expect(detach).toHaveBeenCalledWith('stale-instance');
  expect(detach.mock.invocationCallOrder[0]).toBeLessThan(
    claim.mock.invocationCallOrder[0] ?? 0,
  );
  expect(claim).toHaveBeenCalledTimes(1);
});

it('keeps a ready instance when the index read cannot prove nothing is bound', async (): Promise<void> => {
  // An unreadable workspace.json could be the bound workspace: releasing the
  // instance would clone a second checkout beside it.
  indexAuthority = 'partial';
  snapshot = {
    ...snapshot,
    projects: [
      { ...project, instance: { id: 'maybe-bound-instance', state: 'READY' } },
    ],
  };
  await service.startSetup(projectId, destination);
  expect(await terminal()).toMatchObject({
    state: 'ready',
    instanceId: 'maybe-bound-instance',
  });
  expect(detach).not.toHaveBeenCalled();
  expect(claim).not.toHaveBeenCalled();
  expect(clone).not.toHaveBeenCalled();
});

it('sets up again when the server no longer holds the stale ready instance', async (): Promise<void> => {
  snapshot = {
    ...snapshot,
    projects: [
      { ...project, instance: { id: 'stale-instance', state: 'READY' } },
    ],
  };
  detach.mockRejectedValueOnce(
    new CanopyCloudClientError('http-error', 'Not found', 404, 'not_found'),
  );
  await service.startSetup(projectId, destination);
  expect(await terminal()).toMatchObject({ state: 'ready', instanceId });
  expect(detach).toHaveBeenCalledWith('stale-instance');
  expect(claim).toHaveBeenCalledTimes(1);
});

it('sets up again when the server no longer lets this member hold the stale instance', async (): Promise<void> => {
  snapshot = {
    ...snapshot,
    projects: [
      { ...project, instance: { id: 'stale-instance', state: 'READY' } },
    ],
  };
  detach.mockRejectedValueOnce(
    new CanopyCloudClientError('http-error', 'Forbidden', 403, 'forbidden'),
  );
  await service.startSetup(projectId, destination);
  expect(await terminal()).toMatchObject({ state: 'ready', instanceId });
  expect(claim).toHaveBeenCalledTimes(1);
});

it('refreshes the catalog after releasing the stale instance and before claiming', async (): Promise<void> => {
  // The catalog still says READY until it is re-read, which hides the
  // setup row in the sidebar.
  snapshot = {
    ...snapshot,
    projects: [
      { ...project, instance: { id: 'stale-instance', state: 'READY' } },
    ],
  };
  const refresh = jest.spyOn(deps.catalog, 'refresh');
  await service.startSetup(projectId, destination);
  expect(await terminal()).toMatchObject({ state: 'ready', instanceId });
  const refreshAfterDetach = refresh.mock.invocationCallOrder.find(
    (order) => order > (detach.mock.invocationCallOrder[0] ?? Infinity),
  );
  expect(refreshAfterDetach).toBeDefined();
  expect(refreshAfterDetach ?? Infinity).toBeLessThan(
    claim.mock.invocationCallOrder[0] ?? 0,
  );
  expect(refresh).toHaveBeenCalledWith(expect.anything(), { force: true });
});

it('keeps the stale instance when setup stops before the claim', async (): Promise<void> => {
  // Released only once every other precondition held: a destination that
  // cannot be used leaves the instance and nothing is claimed.
  snapshot = {
    ...snapshot,
    projects: [
      { ...project, instance: { id: 'stale-instance', state: 'READY' } },
    ],
  };
  await service.startSetup(projectId, join(root, 'missing-destination'));
  expect(await terminal()).toMatchObject({ state: 'failed' });
  expect(detach).not.toHaveBeenCalled();
  expect(claim).not.toHaveBeenCalled();
});

it('keeps the stale instance when a workspace is bound before the release', async (): Promise<void> => {
  snapshot = {
    ...snapshot,
    projects: [
      { ...project, instance: { id: 'stale-instance', state: 'READY' } },
    ],
  };
  // Bound by another path between the first check and the release.
  const read = deps.readItemsSnapshot.bind(deps);
  let reads = 0;
  deps.readItemsSnapshot = async (): ReturnType<typeof read> => {
    reads += 1;
    if (reads === 2)
      sidebarItems.push({
        id: 'repo',
        owner: {
          type: 'organization',
          organizationId,
          projectId,
          instanceId: 'stale-instance',
          bindingGeneration: 1,
        },
      });
    return read();
  };
  await service.startSetup(projectId, destination);
  expect(await terminal()).toMatchObject({
    state: 'ready',
    instanceId: 'stale-instance',
  });
  expect(detach).not.toHaveBeenCalled();
  expect(claim).not.toHaveBeenCalled();
});

it('fails without claiming when releasing the stale ready instance fails', async (): Promise<void> => {
  snapshot = {
    ...snapshot,
    projects: [
      { ...project, instance: { id: 'stale-instance', state: 'READY' } },
    ],
  };
  detach.mockRejectedValueOnce(
    new CanopyCloudClientError('http-error', 'Server error', 500),
  );
  await service.startSetup(projectId, destination);
  expect(await terminal()).toMatchObject({ state: 'failed' });
  expect(claim).not.toHaveBeenCalled();
  expect(clone).not.toHaveBeenCalled();
});

it('uses a separate id-suffixed directory for a matching Personal repository even in an empty destination', async (): Promise<void> => {
  deps.hasPersonalRelationship = (): Promise<boolean> => Promise.resolve(true);
  await service.startSetup(projectId, destination);
  expect((await terminal()).state).toBe('ready');
  expect(await exists(join(destination, 'repo'))).toBe(false);
  expect(
    await exists(
      join(destination, `repo-${instanceId.replace(/-/g, '').slice(0, 6)}`),
    ),
  ).toBe(true);
});

describe('reclaim of an expired claim (CAN-3129)', (): void => {
  const reclaimedOperationId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  /** The answer `complete` gives a lapsed lease and a supersede alike. */
  const claimGone = (): CanopyCloudClientError =>
    new CanopyCloudClientError(
      'http-error',
      'A newer setup of this project superseded this attempt',
      409,
      'conflict',
    );
  const reclaimed = {
    instanceId,
    operationId: reclaimedOperationId,
    fencingGeneration: 8,
    state: 'CLAIMED' as const,
  };
  const owner = (bindingGeneration: number): WorkspaceOwnerBinding => ({
    type: 'organization',
    organizationId,
    projectId,
    instanceId,
    bindingGeneration,
  });
  /** The rollout and account as the suite has them, with these capabilities. */
  const withCapabilities = (capabilities: string[]): void => {
    deps.access = (): ReturnType<OrgProjectMaterializationDeps['access']> =>
      Promise.resolve({
        context: { kind: 'organization', organizationId },
        accountId: 'account',
        enabled: true,
        capabilities,
      });
  };
  beforeEach((): void => {
    withCapabilities(['org-projects-v1', 'org-project-reclaim-v1']);
    // The real binding persists the workspace index, so a later Set up and
    // the next launch both see the checkout as this project's workspace.
    const persist = bind.getMockImplementation();
    bind.mockImplementation(async (path, id, binding): Promise<void> => {
      await persist?.(path, id, binding);
      sidebarItems = [
        ...sidebarItems.filter((item): boolean => item.id !== id),
        { id, owner: binding },
      ];
    });
    service = createOrgProjectMaterialization(deps);
    service.subscribe((progress): void => {
      reports.push(progress);
    });
  });
  async function lapse(): Promise<string> {
    complete.mockRejectedValueOnce(claimGone());
    await service.startSetup(projectId, destination);
    expect(await terminal()).toMatchObject({
      state: 'failed',
      errorCode: 'claim-expired',
    });
    return journalFile();
  }

  it('keeps the checkout bound and the instance held once the lease lapsed', async (): Promise<void> => {
    await lapse();
    expect(await journal()).toMatchObject({
      phase: 'reclaiming',
      errorCode: 'claim-expired',
      operationId,
      fencingGeneration: 7,
    });
    // The instance is still this checkout's: handing it back would leave the
    // server nothing to reclaim and the row nothing to finish.
    expect(detach).not.toHaveBeenCalled();
    expect(await exists(join(destination, 'repo', 'README.md'))).toBe(true);
    const nonces: unknown = JSON.parse(
      await readFile(join(root, 'journals', 'attempt-nonces.json'), 'utf8'),
    );
    expect(nonces).toMatchObject({ nonces: { [projectId]: {} } });
  });

  it('Retry reclaims exactly the lapsed claim, re-binds under the new fence and completes without recloning', async (): Promise<void> => {
    const file = await lapse();
    const firstKey = claim.mock.calls[0]?.[1].idempotencyKey;
    claim.mockResolvedValueOnce(reclaimed);
    reports = [];
    await service.startSetup(projectId, destination);
    expect(await terminal()).toMatchObject({ state: 'ready' });
    expect(claim).toHaveBeenCalledTimes(2);
    const request = claim.mock.calls[1]?.[1];
    expect(request).toEqual({
      deviceId: 'device',
      installationGeneration: 0,
      localWorkspaceId: 'repo',
      idempotencyKey: request?.idempotencyKey,
      reclaim: { instanceId, operationId, fencingGeneration: 7 },
    });
    expect(request?.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    expect(request?.idempotencyKey).not.toBe(firstKey);
    expect(clone).toHaveBeenCalledTimes(1);
    expect(bind).toHaveBeenLastCalledWith(
      join(destination, 'repo'),
      'repo',
      owner(8),
    );
    expect(complete).toHaveBeenLastCalledWith(instanceId, {
      operationId: reclaimedOperationId,
      fencingGeneration: 8,
      outcome: 'ready',
    });
    expect(detach).not.toHaveBeenCalled();
    // One journal, under one name, from the claim through the reclaim.
    expect([...journalFiles]).toEqual([file]);
    expect(await readdir(join(root, 'journals'))).toEqual([]);
  });

  it("fails with the server's own answer when the claim was superseded, without taking the project back", async (): Promise<void> => {
    await lapse();
    claim.mockRejectedValueOnce(claimGone());
    reports = [];
    await service.startSetup(projectId, destination);
    expect(await terminal()).toMatchObject({
      state: 'failed',
      errorCode: 'superseded',
      message: 'A newer setup of this project superseded this attempt',
    });
    expect(complete).toHaveBeenCalledTimes(1);
    // A superseded instance belongs to the newer claim now.
    expect(detach).not.toHaveBeenCalled();
    expect(await journal()).toMatchObject({
      phase: 'failed',
      errorCode: 'superseded',
    });
    // The checkout is a workspace the user can see, so it stays.
    expect(await exists(join(destination, 'repo', 'README.md'))).toBe(true);
    reports = [];
    await service.startSetup(projectId, destination);
    expect(await terminal()).toMatchObject({
      state: 'failed',
      errorCode: 'superseded',
    });
    expect(claim).toHaveBeenCalledTimes(2);
  });

  it('presents the same reclaim key again after an answer was lost', async (): Promise<void> => {
    await lapse();
    claim.mockRejectedValueOnce(
      new CanopyCloudClientError('network-error', 'offline'),
    );
    reports = [];
    await service.startSetup(projectId, destination);
    expect(await terminal()).toMatchObject({
      state: 'failed',
      errorCode: 'claim-expired',
    });
    expect(await journal()).toMatchObject({ phase: 'reclaiming' });
    expect(detach).not.toHaveBeenCalled();
    claim.mockResolvedValueOnce(reclaimed);
    reports = [];
    await service.startSetup(projectId, destination);
    expect(await terminal()).toMatchObject({ state: 'ready' });
    expect(claim.mock.calls[2]?.[1]).toEqual(claim.mock.calls[1]?.[1]);
  });

  it('reclaims on the next launch to the same outcome as Retry, without reporting progress', async (): Promise<void> => {
    await lapse();
    claim.mockResolvedValueOnce(reclaimed);
    const relaunched = createOrgProjectMaterialization(deps);
    const heard: OrgProjectSetupProgress[] = [];
    relaunched.subscribe((progress): void => {
      heard.push(progress);
    });
    await relaunched.sweepInterruptedSetups();
    // No window exists to hear it yet; the catalog refresh is what the row
    // follows.
    expect(heard).toEqual([]);
    expect(claim.mock.calls[1]?.[1].reclaim).toEqual({
      instanceId,
      operationId,
      fencingGeneration: 7,
    });
    expect(bind).toHaveBeenLastCalledWith(
      join(destination, 'repo'),
      'repo',
      owner(8),
    );
    expect(complete).toHaveBeenLastCalledWith(instanceId, {
      operationId: reclaimedOperationId,
      fencingGeneration: 8,
      outcome: 'ready',
    });
    expect(detach).not.toHaveBeenCalled();
    expect(clone).toHaveBeenCalledTimes(1);
    expect(await readdir(join(root, 'journals'))).toEqual([]);
  });

  it('reports a quiet reclaim once a start from the renderer joins it', async (): Promise<void> => {
    await lapse();
    let answer: (value: typeof reclaimed) => void = (): void => {};
    claim.mockImplementationOnce(
      (): Promise<typeof reclaimed> =>
        new Promise((resolve): void => {
          answer = resolve;
        }),
    );
    const relaunched = createOrgProjectMaterialization(deps);
    const heard: OrgProjectSetupProgress[] = [];
    relaunched.subscribe((progress): void => {
      heard.push(progress);
    });
    const sweep = relaunched.sweepInterruptedSetups();
    await new Promise<void>((resolve): void => {
      const wait = (): void => {
        if (claim.mock.calls.length === 2) resolve();
        else setTimeout(wait, 5);
      };
      wait();
    });
    expect(heard).toEqual([]);
    const joined = await relaunched.startSetup(projectId, destination);
    expect(joined.state).toBe('materializing');
    expect(heard.map((progress) => progress.state)).toEqual(['materializing']);
    answer(reclaimed);
    await sweep;
    expect(heard.at(-1)).toMatchObject({ state: 'ready' });
    expect(clone).toHaveBeenCalledTimes(1);
  });

  it('keeps a lapsed claim for a later launch while it cannot be reclaimed', async (): Promise<void> => {
    await lapse();
    withCapabilities(['org-projects-v1']);
    await createOrgProjectMaterialization(deps).sweepInterruptedSetups();
    expect(claim).toHaveBeenCalledTimes(1);
    expect(detach).not.toHaveBeenCalled();
    expect(await journal()).toMatchObject({ phase: 'reclaiming' });
  });

  it('retires a lapsed claim whose workspace the user removed, then sets up afresh', async (): Promise<void> => {
    await lapse();
    sidebarItems = [];
    await rm(join(destination, 'repo'), { recursive: true, force: true });
    reports = [];
    await service.startSetup(projectId, destination);
    expect(await terminal()).toMatchObject({ state: 'ready' });
    expect(detach).toHaveBeenCalledWith(instanceId);
    expect(claim.mock.calls[1]?.[1].reclaim).toBeUndefined();
  });

  it('never re-points the claimed workspace id at another workspace bound to the project', async (): Promise<void> => {
    // The id is what the server recorded at claim time and what a reclaim
    // must present again. Binding under some other id that appeared bound to
    // the project mid-clone would leave the two out of step for good.
    clone.mockImplementationOnce(
      async (
        _url: string,
        dest: string,
        options: { signal: AbortSignal; onProgress: (percent: number) => void },
      ): Promise<void> => {
        await cloneRepoWithProgress(origin, dest, {
          ...options,
          nonInteractive: true,
        });
        sidebarItems.push({ id: 'elsewhere', owner: owner(3) });
      },
    );
    await service.startSetup(projectId, destination);
    expect(await terminal()).toMatchObject({
      state: 'failed',
      errorCode: 'project-already-bound',
    });
    expect(bind).not.toHaveBeenCalled();
    expect(await exists(join(destination, 'repo'))).toBe(false);
  });

  it("keeps today's answer against a server that cannot reclaim", async (): Promise<void> => {
    withCapabilities(['org-projects-v1']);
    await lapse();
    expect(await journal()).toMatchObject({
      phase: 'failed',
      errorCode: 'claim-expired',
    });
    // Nothing can finish it here, so a later start says why without carrying
    // the lapsed claim's code, which is the one the row offers Retry for.
    reports = [];
    await service.startSetup(projectId, destination);
    expect(await terminal()).toMatchObject({
      state: 'failed',
      errorCode: 'project-already-bound',
    });
  });
});

describe('resuming an interrupted setup (CAN-3130)', (): void => {
  const reclaimedOperationId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const owner = (bindingGeneration: number): WorkspaceOwnerBinding => ({
    type: 'organization',
    organizationId,
    projectId,
    instanceId,
    bindingGeneration,
  });
  const offline = (): CanopyCloudClientError =>
    new CanopyCloudClientError('network-error', 'offline');
  let ownershipEvents: OrgProjectOwnershipChangedEvent[];
  beforeEach((): void => {
    deps.access = (): ReturnType<OrgProjectMaterializationDeps['access']> =>
      Promise.resolve({
        context: { kind: 'organization', organizationId },
        accountId: 'account',
        enabled: true,
        capabilities: ['org-projects-v1', 'org-project-reclaim-v1'],
      });
    // The real binding persists the workspace index.
    const persist = bind.getMockImplementation();
    bind.mockImplementation(async (path, id, binding): Promise<void> => {
      await persist?.(path, id, binding);
      sidebarItems = [
        ...sidebarItems.filter((item): boolean => item.id !== id),
        { id, owner: binding },
      ];
    });
    service = createOrgProjectMaterialization(deps);
    service.subscribe((progress): void => {
      reports.push(progress);
    });
    ownershipEvents = [];
  });
  /** A setup the app exited during, left at `phase` with its disk to match. */
  async function interruptedAt(phase: string): Promise<{
    file: string;
    finalPath: string;
    stagingPath: string;
  }> {
    complete.mockRejectedValueOnce(offline());
    await service.startSetup(projectId, destination);
    await terminal();
    const file = await journalFile();
    const saved = await journal();
    const finalPath = String(saved.finalPath);
    const stagingPath = String(saved.stagingPath);
    await writeFile(
      file,
      JSON.stringify({ ...saved, phase, errorCode: undefined }),
    );
    // What the run had done by the time it wrote `phase`.
    if (['claimed', 'cloning', 'validated'].includes(phase)) {
      await rm(finalPath, { recursive: true, force: true });
      sidebarItems = [];
    } else if (phase === 'promoted-staged') {
      await rename(finalPath, stagingPath);
      sidebarItems = [];
    } else if (phase === 'promoted' || phase === 'bound') {
      sidebarItems = [];
    }
    bind.mockClear();
    complete.mockClear();
    detach.mockClear();
    claim.mockClear();
    return { file, finalPath, stagingPath };
  }
  async function relaunch(): Promise<OrgProjectSetupProgress[]> {
    const relaunched = createOrgProjectMaterialization(deps);
    const heard: OrgProjectSetupProgress[] = [];
    relaunched.subscribe((progress): void => {
      heard.push(progress);
    });
    relaunched.onOwnershipChanged((event): void => {
      ownershipEvents.push(event);
    });
    await relaunched.sweepInterruptedSetups();
    return heard;
  }

  it.each([
    ['claimed', 'retired'],
    ['cloning', 'retired'],
    ['validated', 'retired'],
    ['promoted-staged', 'resumed'],
    ['promoted', 'resumed'],
    ['bound', 'resumed'],
    ['completing', 'resumed'],
    ['reclaiming', 'resumed'],
    ['done', 'cleared'],
  ])(
    'a crash at %s is %s on the next launch, without recloning',
    async (phase, outcome): Promise<void> => {
      const recorded = phase === 'promoted-staged' ? 'promoted' : phase;
      const { finalPath, stagingPath } = await interruptedAt(recorded);
      if (phase === 'promoted-staged') await rename(finalPath, stagingPath);
      if (phase === 'reclaiming')
        claim.mockResolvedValueOnce({
          instanceId,
          operationId: reclaimedOperationId,
          fencingGeneration: 8,
          state: 'CLAIMED',
        });
      const heard = await relaunch();
      // The sweep runs before any window exists: it reports nothing.
      expect(heard).toEqual([]);
      expect(clone).toHaveBeenCalledTimes(1);
      expect(
        (await readdir(join(root, 'journals'))).filter(
          (file): boolean => file !== 'attempt-nonces.json',
        ),
      ).toEqual([]);
      if (outcome === 'retired') {
        expect(detach).toHaveBeenCalledWith(instanceId);
        expect(complete).not.toHaveBeenCalled();
        expect(bind).not.toHaveBeenCalled();
        return;
      }
      expect(detach).not.toHaveBeenCalled();
      if (outcome === 'cleared') {
        expect(complete).not.toHaveBeenCalled();
        return;
      }
      expect(await readFile(join(finalPath, 'README.md'), 'utf8')).toBe(
        'fixture',
      );
      expect(await exists(stagingPath)).toBe(false);
      expect(complete).toHaveBeenCalledTimes(1);
      expect(complete).toHaveBeenCalledWith(
        instanceId,
        phase === 'reclaiming'
          ? {
              operationId: reclaimedOperationId,
              fencingGeneration: 8,
              outcome: 'ready',
            }
          : { operationId, fencingGeneration: 7, outcome: 'ready' },
      );
      if (['promoted-staged', 'promoted', 'bound'].includes(phase)) {
        expect(bind).toHaveBeenCalledWith(finalPath, 'repo', owner(7));
        // The workspace is new to the index: the renderer reloads projects.
        expect(ownershipEvents).toEqual([
          {
            workspaceId: 'repo',
            organizationId,
            projectId,
            owner: 'organization',
          },
        ]);
      }
    },
  );

  it.each(['both', 'neither'])(
    'never adopts a promoted checkout it cannot prove it made (%s paths present)',
    async (present): Promise<void> => {
      const { finalPath, stagingPath } = await interruptedAt('promoted');
      if (present === 'both') await mkdir(stagingPath);
      else await rm(finalPath, { recursive: true, force: true });
      await relaunch();
      expect(bind).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
      expect(detach).toHaveBeenCalledWith(instanceId);
      // Retirement leaves the disk exactly as it found it.
      expect(await exists(finalPath)).toBe(present === 'both');
      expect(await exists(stagingPath)).toBe(present === 'both');
    },
  );

  it('keeps an offline completion resumable instead of retiring it', async (): Promise<void> => {
    complete.mockRejectedValueOnce(offline());
    await service.startSetup(projectId, destination);
    expect(await terminal()).toMatchObject({
      state: 'failed',
      errorCode: 'completion-pending',
    });
    expect(await journal()).toMatchObject({ phase: 'completing' });
    expect(detach).not.toHaveBeenCalled();
    const nonces: unknown = JSON.parse(
      await readFile(join(root, 'journals', 'attempt-nonces.json'), 'utf8'),
    );
    expect(nonces).toMatchObject({ nonces: { [projectId]: {} } });
    complete.mockClear();
    await relaunch();
    expect(complete).toHaveBeenCalledWith(instanceId, {
      operationId,
      fencingGeneration: 7,
      outcome: 'ready',
    });
    expect(
      (await readdir(join(root, 'journals'))).filter(
        (file): boolean => file !== 'attempt-nonces.json',
      ),
    ).toEqual([]);
  });

  it('reclaims within the resume when the lease lapsed while the app was closed', async (): Promise<void> => {
    await interruptedAt('bound');
    complete.mockRejectedValueOnce(
      new CanopyCloudClientError('http-error', 'gone', 409, 'conflict'),
    );
    claim.mockResolvedValueOnce({
      instanceId,
      operationId: reclaimedOperationId,
      fencingGeneration: 8,
      state: 'CLAIMED',
    });
    await relaunch();
    expect(claim.mock.calls[0]?.[1].reclaim).toEqual({
      instanceId,
      operationId,
      fencingGeneration: 7,
    });
    expect(complete).toHaveBeenLastCalledWith(instanceId, {
      operationId: reclaimedOperationId,
      fencingGeneration: 8,
      outcome: 'ready',
    });
    expect(bind).toHaveBeenLastCalledWith(
      join(destination, 'repo'),
      'repo',
      owner(8),
    );
    expect(detach).not.toHaveBeenCalled();
  });

  it('finishes a pending setup on Set up instead of refusing it as already a workspace', async (): Promise<void> => {
    await interruptedAt('bound');
    sidebarItems = [{ id: 'repo', owner: owner(7) }];
    reports = [];
    await service.startSetup(projectId, destination);
    expect(await terminal()).toMatchObject({ state: 'ready' });
    expect(clone).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('keeps an interrupted setup for a later launch while its account is not signed in', async (): Promise<void> => {
    await interruptedAt('bound');
    deps.access = (): ReturnType<OrgProjectMaterializationDeps['access']> =>
      Promise.resolve({
        context: { kind: 'personal' },
        accountId: '',
        enabled: true,
        capabilities: [],
      });
    await relaunch();
    expect(detach).not.toHaveBeenCalled();
    expect(bind).not.toHaveBeenCalled();
    expect(await journal()).toMatchObject({ phase: 'bound' });
  });
});

describe('existing-checkout adoption (CAN-3534)', (): void => {
  beforeEach((): void => {
    deps.access = (): ReturnType<OrgProjectMaterializationDeps['access']> =>
      Promise.resolve({
        context: { kind: 'organization', organizationId },
        accountId: 'account',
        enabled: true,
        capabilities: ['org-projects-v1', 'org-member-code-projects-v1'],
      });
  });

  it('claims and binds an existing checkout in place with the project name', async (): Promise<void> => {
    const checkout = await realpath(join(root, 'seed'));

    await expect(
      service.adoptCheckout({
        projectId,
        organizationId,
        path: checkout,
        preferredName: 'Payments',
      }),
    ).resolves.toEqual({ localWorkspaceId: 'repo' });

    expect(clone).not.toHaveBeenCalled();
    expect(bind).toHaveBeenCalledWith(
      checkout,
      'repo',
      expect.objectContaining({ projectId, instanceId }),
      'Payments',
    );
    expect(complete).toHaveBeenCalledTimes(1);
    expect(removeBound).not.toHaveBeenCalled();
  });

  it('keeps the adopted binding and journal after an ambiguous completion', async (): Promise<void> => {
    const checkout = await realpath(join(root, 'seed'));
    complete.mockRejectedValueOnce(new Error('completion failed'));

    await expect(
      service.adoptCheckout({
        projectId,
        organizationId,
        path: checkout,
        preferredName: 'Payments',
      }),
    ).rejects.toMatchObject({ completionSent: true });

    expect(removeBound).not.toHaveBeenCalled();
    await expect(journal()).resolves.toMatchObject({ phase: 'completing' });
    await service.sweepInterruptedSetups();
    expect(removeBound).not.toHaveBeenCalled();
    expect(detach).not.toHaveBeenCalled();
    expect(await exists(checkout)).toBe(true);
    await expect(journal()).resolves.toMatchObject({ phase: 'completing' });
  });

  it('rolls adoption back after a definitive completion rejection', async (): Promise<void> => {
    const checkout = await realpath(join(root, 'seed'));
    complete.mockRejectedValueOnce(
      new CanopyCloudClientError('http-error', 'conflict', 409, 'conflict'),
    );

    await expect(
      service.adoptCheckout(
        {
          projectId,
          organizationId,
          path: checkout,
          preferredName: 'Payments',
        },
        { createdRepo: true },
      ),
    ).rejects.toMatchObject({ completionSent: false });

    expect(removeBound).toHaveBeenCalledWith('repo', instanceId);
    expect(detach).toHaveBeenCalledWith(instanceId);
    await expect(journal()).resolves.toMatchObject({ phase: 'failed' });
    expect(await exists(checkout)).toBe(true);
  });

  it('sets up a repository-less member project from a folder', async (): Promise<void> => {
    const checkout = await realpath(join(root, 'seed'));
    snapshot = {
      ...snapshot,
      projects: [
        {
          ...project,
          visibility: 'private',
          memberOwned: true,
          repository: null,
          capabilities: { use: true, administer: true, manageCloud: false },
        },
      ],
    };
    remoteUrl.mockResolvedValue(null);

    await expect(
      service.setupFromFolder(projectId, checkout),
    ).resolves.toMatchObject({
      projectId,
      state: 'claiming',
    });
    expect((await terminal()).state).toBe('ready');
    expect(bind).toHaveBeenCalledWith(
      checkout,
      'Repo',
      expect.anything(),
      'Repo',
    );
  });
});

describe('Personal workspace conversion (CAN-3415)', (): void => {
  const workspaceId = 'personal-repo';
  const request = { workspaceId, organizationId, projectId };
  let ownershipEvents: OrgProjectOwnershipChangedEvent[];
  beforeEach((): void => {
    sidebarItems = [{ id: workspaceId }];
    ownership.set(workspaceId, { type: 'single-repo' });
    ownershipEvents = [];
    service.onOwnershipChanged((event): void => {
      ownershipEvents.push(event);
    });
  });
  const bound: WorkspaceOwnerBinding = {
    type: 'organization',
    organizationId,
    projectId,
    instanceId,
    bindingGeneration: 7,
  };

  it('binds the existing checkout in place, under its own id, exactly like a set-up project', async (): Promise<void> => {
    const result = await service.convertWorkspace(request);

    if (!result.ok) throw new Error(`conversion refused: ${result.code}`);
    expect(result).toMatchObject({ workspaceId, owner: bound });
    const { convertedAt, ...transfer } = result.ownershipTransfer;
    expect(transfer).toEqual({
      version: 1,
      previousOwner: { type: 'personal' },
      organizationId,
      projectId,
    });
    expect(Number.isFinite(Date.parse(convertedAt))).toBe(true);
    expect(ownership.get(workspaceId)).toEqual({
      type: 'single-repo',
      owner: bound,
      ownershipTransfer: result.ownershipTransfer,
    });
    // The same claim, fenced completion and catalog refresh as setup, with the
    // local workspace id the checkout already has. Nothing is cloned or moved.
    expect(claim).toHaveBeenCalledTimes(1);
    expect(claim.mock.calls[0]?.[0]).toBe(projectId);
    expect(claim.mock.calls[0]?.[1]).toMatchObject({
      deviceId: 'device',
      installationGeneration: 0,
      localWorkspaceId: workspaceId,
    });
    expect(claim.mock.calls[0]?.[1].idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    expect(complete).toHaveBeenCalledWith(instanceId, {
      operationId,
      fencingGeneration: 7,
      outcome: 'ready',
    });
    expect(clone).not.toHaveBeenCalled();
    expect(bind).not.toHaveBeenCalled();
    expect(detach).not.toHaveBeenCalled();
    expect(journalPhases).toEqual(['claimed', 'bound', 'completing', 'done']);
    expect(await readdir(join(root, 'journals'))).toEqual([]);
    // No setup row flashes on the organization project: only the terminal
    // report that tells the sidebar to reload its workspaces.
    expect(reports.map((report) => report.state)).toEqual(['ready']);
    expect(ownershipEvents).toEqual([
      { workspaceId, organizationId, projectId, owner: 'organization' },
    ]);
    expect(rebindBackgroundExecution).toHaveBeenCalledWith({
      workspaceId,
      from: { kind: 'personal' },
      to: { kind: 'organization', organizationId },
    });
  });

  it("converts the member's fresh repository-less private project in place", async (): Promise<void> => {
    snapshot = {
      ...snapshot,
      projects: [
        {
          ...project,
          visibility: 'private',
          memberOwned: true,
          repository: null,
          capabilities: { use: true, administer: true, manageCloud: false },
        },
      ],
    };
    remoteUrl.mockResolvedValue(null);
    deps.access = (): ReturnType<OrgProjectMaterializationDeps['access']> =>
      Promise.resolve({
        context: { kind: 'organization', organizationId },
        accountId: 'account',
        enabled: true,
        capabilities: ['org-projects-v1', 'org-member-code-projects-v1'],
      });

    await expect(
      service.convertWorkspace(request, { memberCreated: true }),
    ).resolves.toMatchObject({ ok: true, workspaceId });
  });

  it('moves a converted workspace back to Personal, releases the instance, and remembers it', async (): Promise<void> => {
    const converted = await service.convertWorkspace(request);
    if (!converted.ok) throw new Error('conversion failed');

    const result = await service.moveBackToPersonal({ workspaceId });

    if (!result.ok) throw new Error(`move back refused: ${result.code}`);
    const { movedBackAt, ...ownershipTransfer } = result.ownershipTransfer;
    expect(ownershipTransfer).toEqual(converted.ownershipTransfer);
    expect(Number.isFinite(Date.parse(movedBackAt ?? ''))).toBe(true);
    expect(ownership.get(workspaceId)).toEqual({
      type: 'single-repo',
      owner: undefined,
      ownershipTransfer: result.ownershipTransfer,
    });
    expect(detach).toHaveBeenCalledWith(instanceId);
    expect(ownershipEvents.at(-1)).toEqual({
      workspaceId,
      organizationId,
      projectId,
      owner: 'personal',
    });
    expect(rebindBackgroundExecution).toHaveBeenLastCalledWith({
      workspaceId,
      from: { kind: 'organization', organizationId },
      to: { kind: 'personal' },
    });
    // Moving back twice has nothing left to undo.
    await expect(service.moveBackToPersonal({ workspaceId })).resolves.toEqual({
      ok: false,
      code: 'not-converted',
    });
  });

  it('never converts a moved-back workspace automatically, while an explicit conversion still may (CAN-3416)', async (): Promise<void> => {
    const converted = await service.convertWorkspace(request);
    if (!converted.ok) throw new Error('conversion failed');
    const movedBack = await service.moveBackToPersonal({ workspaceId });
    if (!movedBack.ok) throw new Error('move back failed');
    claim.mockClear();

    await expect(
      service.convertWorkspace(request, { automatic: true }),
    ).resolves.toEqual({ ok: false, code: 'previously-converted' });
    expect(claim).not.toHaveBeenCalled();
    expect(ownership.get(workspaceId)).toEqual({
      type: 'single-repo',
      owner: undefined,
      ownershipTransfer: movedBack.ownershipTransfer,
    });

    const explicit = await service.convertWorkspace(request);
    expect(explicit.ok).toBe(true);
  });

  it('refuses a repository that is not the organization project', async (): Promise<void> => {
    remoteUrl.mockResolvedValue('git@github.com:someone-else/repo.git');
    await expect(service.convertWorkspace(request)).resolves.toEqual({
      ok: false,
      code: 'repository-mismatch',
    });
    remoteUrl.mockResolvedValue(null);
    await expect(service.convertWorkspace(request)).resolves.toEqual({
      ok: false,
      code: 'repository-mismatch',
    });
    remoteUrl.mockRejectedValue(new Error('git failed'));
    await expect(service.convertWorkspace(request)).resolves.toEqual({
      ok: false,
      code: 'repository-unavailable',
    });
    expect(claim).not.toHaveBeenCalled();
    expect(ownership.get(workspaceId)).toEqual({ type: 'single-repo' });
  });

  it('refuses a workspace that is already bound, or a project already bound here', async (): Promise<void> => {
    ownership.set(workspaceId, { type: 'single-repo', owner: bound });
    await expect(service.convertWorkspace(request)).resolves.toEqual({
      ok: false,
      code: 'not-personal',
    });
    ownership.set(workspaceId, 'unreadable');
    await expect(service.convertWorkspace(request)).resolves.toEqual({
      ok: false,
      code: 'workspace-unreadable',
    });
    ownership.set(workspaceId, { type: 'single-repo' });
    sidebarItems = [{ id: workspaceId }, { id: 'set-up', owner: bound }];
    await expect(service.convertWorkspace(request)).resolves.toEqual({
      ok: false,
      code: 'project-already-bound',
    });
    expect(claim).not.toHaveBeenCalled();
  });

  it('refuses while the organization-projects flag is off', async (): Promise<void> => {
    deps.access = (): ReturnType<OrgProjectMaterializationDeps['access']> =>
      Promise.resolve({
        context: { kind: 'personal' },
        accountId: 'account',
        enabled: false,
        capabilities: ['org-projects-v1'],
      });
    await expect(service.convertWorkspace(request)).resolves.toEqual({
      ok: false,
      code: 'disabled',
    });
    expect(claim).not.toHaveBeenCalled();
    expect(ownership.get(workspaceId)).toEqual({ type: 'single-repo' });
  });

  it('refuses anything but a Personal single-repository project', async (): Promise<void> => {
    await expect(
      service.convertWorkspace({ ...request, workspaceId: 'missing' }),
    ).resolves.toEqual({ ok: false, code: 'workspace-not-found' });
    const multiRepo: SidebarItem = {
      type: 'multi-repo',
      id: workspaceId,
      name: 'Multi',
      color: '',
      collapsed: false,
      order: 0,
      repos: [],
      worktrees: [],
    };
    deps.readItems = (): Promise<SidebarItem[]> => Promise.resolve([multiRepo]);
    await expect(service.convertWorkspace(request)).resolves.toEqual({
      ok: false,
      code: 'unsupported-workspace',
    });
    expect(claim).not.toHaveBeenCalled();
  });

  it('refuses a project the member cannot use', async (): Promise<void> => {
    snapshot = {
      ...snapshot,
      projects: [
        { ...project, capabilities: { ...project.capabilities, use: false } },
      ],
    };
    await expect(service.convertWorkspace(request)).resolves.toEqual({
      ok: false,
      code: 'project-unavailable',
    });
    snapshot = { ...snapshot, projects: [] };
    await expect(service.convertWorkspace(request)).resolves.toEqual({
      ok: false,
      code: 'project-unavailable',
    });
    expect(claim).not.toHaveBeenCalled();
  });

  it('rolls a refused completion back to Personal and releases the claim', async (): Promise<void> => {
    complete.mockRejectedValueOnce(
      new CanopyCloudClientError('http-error', 'gone', 409, 'conflict'),
    );
    await expect(service.convertWorkspace(request)).resolves.toEqual({
      ok: false,
      code: 'conversion-failed',
    });
    expect(ownership.get(workspaceId)).toEqual({
      type: 'single-repo',
      owner: undefined,
      ownershipTransfer: undefined,
    });
    expect(detach).toHaveBeenCalledWith(instanceId);
    expect(reports.some((report) => report.state === 'failed')).toBe(false);
    // Only the rollback is announced; the organization binding never was.
    expect(ownershipEvents).toEqual([
      { workspaceId, organizationId, projectId, owner: 'personal' },
    ]);
    // Nothing was ever bound to the organization, so nothing moves.
    expect(rebindBackgroundExecution).not.toHaveBeenCalled();
  });

  it('keeps a completed conversion when moving its background items fails', async (): Promise<void> => {
    rebindBackgroundExecution.mockRejectedValueOnce(new Error('store busy'));

    const result = await service.convertWorkspace(request);

    expect(result).toMatchObject({ ok: true, workspaceId, owner: bound });
    expect(ownership.get(workspaceId)).toMatchObject({ owner: bound });
  });

  it('rolls an interrupted conversion back to Personal on the next launch', async (): Promise<void> => {
    // The app exits after binding, while the completion is being recorded.
    journalWritten.mockImplementation(
      (phase): Promise<void> =>
        phase === 'completing'
          ? new Promise<void>(() => {})
          : Promise.resolve(),
    );
    void service.convertWorkspace(request);
    while (
      ownership.get(workspaceId) === undefined ||
      !journalPhases.includes('completing')
    )
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(ownership.get(workspaceId)).toMatchObject({ owner: bound });

    await createOrgProjectMaterialization(deps).sweepInterruptedSetups();

    expect(ownership.get(workspaceId)).toEqual({
      type: 'single-repo',
      owner: undefined,
      ownershipTransfer: undefined,
    });
    expect(detach).toHaveBeenCalledWith(instanceId);
    expect(await readdir(join(root, 'journals'))).toEqual([]);
  });

  it('refuses to move back a workspace that was never converted', async (): Promise<void> => {
    await expect(service.moveBackToPersonal({ workspaceId })).resolves.toEqual({
      ok: false,
      code: 'not-converted',
    });
    ownership.set(workspaceId, { type: 'single-repo', owner: bound });
    await expect(service.moveBackToPersonal({ workspaceId })).resolves.toEqual({
      ok: false,
      code: 'not-converted',
    });
    expect(detach).not.toHaveBeenCalled();
  });

  it('keeps the organization owner when the instance cannot be released', async (): Promise<void> => {
    const converted = await service.convertWorkspace(request);
    if (!converted.ok) throw new Error('conversion failed');
    detach.mockRejectedValueOnce(
      new CanopyCloudClientError('network-error', 'offline'),
    );
    await expect(service.moveBackToPersonal({ workspaceId })).resolves.toEqual({
      ok: false,
      code: 'release-failed',
    });
    expect(ownership.get(workspaceId)).toMatchObject({ owner: bound });
    // An instance the server no longer holds for this member is already released.
    detach.mockRejectedValueOnce(
      new CanopyCloudClientError('http-error', 'gone', 404, 'not_found'),
    );
    await expect(
      service.moveBackToPersonal({ workspaceId }),
    ).resolves.toMatchObject({ ok: true });
    expect(ownership.get(workspaceId)).toMatchObject({ owner: undefined });
  });
});

describe('Personal multi-repo conversion (CAN-3532)', (): void => {
  const workspaceId = 'platform';
  const multiProjectId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const rootProjectId = '11111111-1111-4111-8111-111111111111';
  const webProjectId = '22222222-2222-4222-8222-222222222222';
  const apiProjectId = '33333333-3333-4333-8333-333333333333';
  const request = { workspaceId, organizationId };
  const bound: WorkspaceOwnerBinding = {
    type: 'organization',
    organizationId,
    projectId: multiProjectId,
    instanceId,
    bindingGeneration: 7,
  };
  let remotes: Map<string, string | null | Error>;
  let item: Extract<SidebarItem, { type: 'multi-repo' }>;
  function orgProject(id: string, name: string): OrgProjectSummary {
    return {
      ...project,
      id,
      name,
      repository: project.repository && {
        ...project.repository,
        name,
        providerRepoId: id.slice(0, 1),
      },
    };
  }
  const created: OrgProjectSummary = {
    ...project,
    id: multiProjectId,
    name: 'Platform',
    topology: 'multi-repo',
    visibility: 'private',
    memberOwned: true,
    repository: project.repository && { ...project.repository, name: 'root' },
    capabilities: { administer: true, manageCloud: false, use: true },
  };
  beforeEach((): void => {
    item = {
      type: 'multi-repo',
      id: workspaceId,
      name: 'Platform',
      color: '',
      collapsed: false,
      order: 0,
      sourceRepoPath: '/platform',
      repos: [
        { id: 'web', name: 'web', repoPath: '/platform/web' },
        { id: 'api', name: 'api', repoPath: '/platform/api' },
      ],
      worktrees: [],
    };
    deps.readItems = (): Promise<SidebarItem[]> => Promise.resolve([item]);
    ownership.set(workspaceId, { type: 'multi-repo' });
    remotes = new Map<string, string | null | Error>([
      ['/platform', 'git@github.com:owner/root.git'],
      ['/platform/web', 'https://github.com/owner/web.git'],
      ['/platform/api', 'https://github.com/Owner/API'],
    ]);
    remoteUrl.mockImplementation((path): Promise<string | null> => {
      const remote = remotes.get(path) ?? null;
      return remote instanceof Error
        ? Promise.reject(remote)
        : Promise.resolve(remote);
    });
    snapshot = {
      ...snapshot,
      projects: [
        orgProject(rootProjectId, 'root'),
        orgProject(webProjectId, 'web'),
        orgProject(apiProjectId, 'api'),
      ],
    };
    createMultiRepoProject.mockResolvedValue(created);
  });

  it.each([false, undefined])(
    'refuses a freshly retired automatic combination before side effects (Always show %s)',
    async (alwaysShow) => {
      item = {
        ...item,
        temporary: true,
        alwaysShow,
        archivedContainerCount: 0,
      };
      const updateOwnership = jest.spyOn(deps.workspace, 'updateOwnership');
      await expect(
        service.convertMultiRepoWorkspace(request, { automatic: true }),
      ).resolves.toEqual({ ok: false, code: 'unsupported-workspace' });
      expect(remoteUrl).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
      expect(createMultiRepoProject).not.toHaveBeenCalled();
      expect(claim).not.toHaveBeenCalled();
      expect(updateOwnership).not.toHaveBeenCalled();
      expect(ownership.get(workspaceId)).toEqual({ type: 'multi-repo' });
      updateOwnership.mockRestore();
    },
  );

  it.each([
    { alwaysShow: true, archivedContainerCount: 0, worktrees: [] },
    { alwaysShow: false, archivedContainerCount: 1, worktrees: [] },
    {
      alwaysShow: false,
      archivedContainerCount: 0,
      worktrees: [
        { id: 'wt', branchName: 'main', createdAt: '2026-10-08T00:00:00Z' },
      ],
    },
  ])(
    'allows automatic temporary combinations with kept or retained content (%j)',
    async (content) => {
      item = { ...item, temporary: true, ...content };
      await expect(
        service.convertMultiRepoWorkspace(request, { automatic: true }),
      ).resolves.toMatchObject({ ok: true, owner: bound });
      expect(createMultiRepoProject).toHaveBeenCalledTimes(1);
      expect(claim).toHaveBeenCalledTimes(1);
    },
  );

  it.each([undefined, false])(
    'allows manual conversion of retired combinations with automatic %s',
    async (automatic) => {
      item = {
        ...item,
        temporary: true,
        alwaysShow: false,
        archivedContainerCount: 0,
      };
      await expect(
        service.convertMultiRepoWorkspace(
          request,
          automatic === undefined ? {} : { automatic },
        ),
      ).resolves.toMatchObject({ ok: true, owner: bound });
      expect(createMultiRepoProject).toHaveBeenCalledTimes(1);
      expect(claim).toHaveBeenCalledTimes(1);
    },
  );

  it('rechecks retirement against the coordinator read after a selector-eligible snapshot', async () => {
    const eligible = {
      ...item,
      temporary: true,
      alwaysShow: true,
      archivedContainerCount: 0,
    };
    const readItems = jest
      .fn<Promise<SidebarItem[]>, []>()
      .mockResolvedValue([{ ...eligible, alwaysShow: false }]);
    deps.readItems = readItems;
    await expect(
      service.convertMultiRepoWorkspace(request, { automatic: true }),
    ).resolves.toEqual({ ok: false, code: 'unsupported-workspace' });
    expect(readItems).toHaveBeenCalledTimes(1);
    expect(createMultiRepoProject).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(ownership.get(workspaceId)).toEqual({ type: 'multi-repo' });
  });

  it('leaves an already-bound retired combination intact without duplicate creation', async () => {
    item = {
      ...item,
      temporary: true,
      alwaysShow: false,
      archivedContainerCount: 0,
      owner: bound,
    };
    ownership.set(workspaceId, { type: 'multi-repo', owner: bound });
    const result = await service.convertMultiRepoWorkspace(request, {
      automatic: true,
    });
    expect(result.ok).toBe(false);
    expect(createMultiRepoProject).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(ownership.get(workspaceId)).toEqual({
      type: 'multi-repo',
      owner: bound,
    });
  });

  it('binds the project in place when every repository, its root included, is an organization project', async (): Promise<void> => {
    const result = await service.convertMultiRepoWorkspace(request);

    if (!result.ok) throw new Error(`conversion refused: ${result.code}`);
    expect(result.owner).toEqual(bound);
    expect(createMultiRepoProject).toHaveBeenCalledWith({
      organizationId,
      name: 'Platform',
      localWorkspaceId: workspaceId,
      repositoryProjectIds: [rootProjectId, webProjectId, apiProjectId],
    });
    expect(claim).toHaveBeenCalledTimes(1);
    expect(claim.mock.calls[0]?.[0]).toBe(multiProjectId);
    expect(claim.mock.calls[0]?.[1]).toMatchObject({
      localWorkspaceId: workspaceId,
    });
    expect(complete).toHaveBeenCalledWith(instanceId, {
      operationId,
      fencingGeneration: 7,
      outcome: 'ready',
    });
    const { convertedAt, ...transfer } = result.ownershipTransfer;
    expect(transfer).toEqual({
      version: 1,
      previousOwner: { type: 'personal' },
      organizationId,
      projectId: multiProjectId,
    });
    expect(Number.isFinite(Date.parse(convertedAt))).toBe(true);
    expect(ownership.get(workspaceId)).toEqual({
      type: 'multi-repo',
      owner: bound,
      ownershipTransfer: result.ownershipTransfer,
    });
    // Nothing on disk moves, and the uploaded activity follows the project.
    expect(clone).not.toHaveBeenCalled();
    expect(bind).not.toHaveBeenCalled();
    expect(moveActivity).toHaveBeenCalledWith(multiProjectId, {
      localWorkspaceId: workspaceId,
    });
    expect(journalPhases).toEqual(['claimed', 'bound', 'completing', 'done']);
    expect(reports.map((report) => report.state)).toEqual(['ready']);
    expect(rebindBackgroundExecution).toHaveBeenCalledWith({
      workspaceId,
      from: { kind: 'personal' },
      to: { kind: 'organization', organizationId },
    });
  });

  it('ignores a remote-less root and binds the child repositories', async (): Promise<void> => {
    remotes.set('/platform', null);

    const result = await service.convertMultiRepoWorkspace(request);

    expect(result.ok).toBe(true);
    expect(createMultiRepoProject).toHaveBeenCalledWith({
      organizationId,
      name: 'Platform',
      localWorkspaceId: workspaceId,
      repositoryProjectIds: [webProjectId, apiProjectId],
    });
  });

  it('omits an unheld child when the root has no remote', async (): Promise<void> => {
    remotes.set('/platform', null);
    remotes.set('/platform/api', 'https://github.com/someone-else/api.git');

    await expect(
      service.convertMultiRepoWorkspace(request),
    ).resolves.toMatchObject({ ok: true });
    expect(
      createMultiRepoProject.mock.calls[0]?.[0].repositoryProjectIds,
    ).toEqual([webProjectId]);
  });

  it('refuses a project whose checkouts all have no remote', async (): Promise<void> => {
    remotes.set('/platform', null);
    remotes.set('/platform/web', null);
    remotes.set('/platform/api', null);
    snapshot = { ...snapshot, error: 'offline' };

    await expect(service.convertMultiRepoWorkspace(request)).resolves.toEqual({
      ok: false,
      code: 'unsupported-workspace',
    });
    expect(refresh).not.toHaveBeenCalled();
    expect(createMultiRepoProject).not.toHaveBeenCalled();
  });

  it("binds a member's new project that has only its remote-less root (CAN-3546)", async (): Promise<void> => {
    createMultiRepoProject.mockResolvedValue({
      ...created,
      privateMemory: true,
    });
    item = { ...item, repos: [] };
    remotes.set('/platform', null);
    deps.access = (): ReturnType<OrgProjectMaterializationDeps['access']> =>
      Promise.resolve({
        context: { kind: 'organization', organizationId },
        accountId: 'account',
        enabled: true,
        capabilities: ['org-projects-v1', 'org-member-code-projects-v1'],
      });

    const result = await service.convertMultiRepoWorkspace(request, {
      memberCreated: true,
      privateMemory: true,
    });

    if (!result.ok) throw new Error(`conversion refused: ${result.code}`);
    // Nothing to check against the catalog; its settings add repositories.
    expect(createMultiRepoProject).toHaveBeenCalledWith({
      organizationId,
      name: 'Platform',
      localWorkspaceId: workspaceId,
      repositoryProjectIds: [],
      privateMemory: true,
    });
    expect(ownership.get(workspaceId)).toMatchObject({
      type: 'multi-repo',
      owner: { projectId: multiProjectId },
    });
  });

  it('keeps a private-selected multi-repo project Personal if the server omits its value', async (): Promise<void> => {
    item = { ...item, repos: [] };
    remotes.set('/platform', null);
    deps.access = (): ReturnType<OrgProjectMaterializationDeps['access']> =>
      Promise.resolve({
        context: { kind: 'organization', organizationId },
        accountId: 'account',
        enabled: true,
        capabilities: ['org-projects-v1', 'org-member-code-projects-v1'],
      });
    await expect(
      service.convertMultiRepoWorkspace(request, {
        memberCreated: true,
        privateMemory: true,
      }),
    ).resolves.toEqual({ ok: false, code: 'project-unavailable' });
    expect(ownership.get(workspaceId)).toEqual({ type: 'multi-repo' });
  });

  it("still requires the member Code capability for a member's new project", async (): Promise<void> => {
    item = { ...item, repos: [] };
    remotes.set('/platform', null);

    await expect(
      service.convertMultiRepoWorkspace(request, { memberCreated: true }),
    ).resolves.toEqual({ ok: false, code: 'disabled' });
    expect(ownership.get(workspaceId)).toEqual({ type: 'multi-repo' });
  });

  it('keeps Add project conversion strict for an existing mixed folder', async () => {
    remotes.set('/platform/api', 'https://github.com/someone/notes.git');
    deps.access = (): ReturnType<OrgProjectMaterializationDeps['access']> =>
      Promise.resolve({
        context: { kind: 'organization', organizationId },
        accountId: 'account',
        enabled: true,
        capabilities: ['org-projects-v1', 'org-member-code-projects-v1'],
      });
    await expect(
      service.convertMultiRepoWorkspace(request, { memberCreated: true }),
    ).resolves.toEqual({ ok: false, code: 'repository-mismatch' });
    expect(createMultiRepoProject).not.toHaveBeenCalled();
  });

  it('refuses when no held repository remains, and fails closed on unreadable remotes', async () => {
    for (const path of Array.from(remotes.keys()))
      remotes.set(path, 'https://github.com/someone/notes.git');
    await expect(service.convertMultiRepoWorkspace(request)).resolves.toEqual({
      ok: false,
      code: 'repository-mismatch',
    });
    remotes.set('/platform/api', new Error('git failed'));
    await expect(service.convertMultiRepoWorkspace(request)).resolves.toEqual({
      ok: false,
      code: 'repository-unavailable',
    });
    expect(createMultiRepoProject).not.toHaveBeenCalled();
  });

  it.each(['foreign', 'private', 'multi', 'archived', 'unusable'])(
    'omits a %s catalog entry and binds held IDs only',
    async (kind) => {
      const api = orgProject(apiProjectId, 'api');
      if (kind === 'foreign') api.organizationId = 'other';
      if (kind === 'private') api.visibility = 'private';
      if (kind === 'multi') api.topology = 'multi-repo';
      if (kind === 'archived') api.state = 'ARCHIVED';
      if (kind === 'unusable')
        api.capabilities = { ...api.capabilities, use: false };
      snapshot = {
        ...snapshot,
        projects: [
          orgProject(rootProjectId, 'root'),
          orgProject(webProjectId, 'web'),
          api,
        ],
      };
      await expect(
        service.convertMultiRepoWorkspace(request),
      ).resolves.toMatchObject({ ok: true });
      expect(
        createMultiRepoProject.mock.calls[0]?.[0].repositoryProjectIds,
      ).toEqual([rootProjectId, webProjectId]);
    },
  );

  it('binds a temporary mixed combination in place using its first checkout and unique held IDs', async () => {
    let boundPath: unknown;
    journalWritten.mockImplementation(async (phase): Promise<void> => {
      if (phase === 'bound') boundPath = (await journal()).finalPath;
    });
    item = {
      ...item,
      temporary: true,
      sourceRepoPath: undefined,
      repos: [
        { id: 'web', name: 'web', repoPath: '/platform/web' },
        { id: 'personal', name: 'personal', repoPath: '/personal' },
        { id: 'duplicate', name: 'duplicate', repoPath: '/duplicate' },
      ],
    };
    remotes.set('/personal', 'https://github.com/someone/notes.git');
    remotes.set('/duplicate', 'git@github.com:OWNER/WEB.git');
    await expect(
      service.convertMultiRepoWorkspace(request),
    ).resolves.toMatchObject({ ok: true, owner: bound });
    expect(
      createMultiRepoProject.mock.calls[0]?.[0].repositoryProjectIds,
    ).toEqual([webProjectId]);
    expect(boundPath).toBe('/platform/web');
    expect(clone).not.toHaveBeenCalled();
  });

  it('treats a catalog that failed to refresh as unavailable, not as a repository mismatch', async (): Promise<void> => {
    // A mismatch stops automatic conversion for the session; a catalog that
    // could not be read proves nothing about the repositories.
    for (const failed of [
      { stale: true, error: 'unavailable' as const },
      { stale: true, error: 'access-changed' as const },
      { stale: true, error: null },
    ]) {
      snapshot = { ...snapshot, ...failed };
      await expect(service.convertMultiRepoWorkspace(request)).resolves.toEqual(
        { ok: false, code: 'project-unavailable' },
      );
    }
    expect(createMultiRepoProject).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });

  it('counts a project without a root as its child repositories', async (): Promise<void> => {
    item = { ...item, sourceRepoPath: undefined };
    const result = await service.convertMultiRepoWorkspace(request);
    expect(result.ok).toBe(true);
    expect(
      createMultiRepoProject.mock.calls[0]?.[0].repositoryProjectIds,
    ).toEqual([webProjectId, apiProjectId]);
  });

  it('refuses a project with no repositories or one that is not Personal', async (): Promise<void> => {
    item = { ...item, sourceRepoPath: undefined, repos: [] };
    await expect(service.convertMultiRepoWorkspace(request)).resolves.toEqual({
      ok: false,
      code: 'unsupported-workspace',
    });
    item = {
      ...item,
      repos: [{ id: 'web', name: 'web', repoPath: '/platform/web' }],
    };
    ownership.set(workspaceId, { type: 'multi-repo', owner: bound });
    await expect(service.convertMultiRepoWorkspace(request)).resolves.toEqual({
      ok: false,
      code: 'not-personal',
    });
    ownership.set(workspaceId, {
      type: 'multi-repo',
      ownershipTransfer: {
        version: 1,
        previousOwner: { type: 'personal' },
        organizationId,
        projectId: multiProjectId,
        convertedAt: '2026-09-01T00:00:00.000Z',
        movedBackAt: '2026-09-02T00:00:00.000Z',
      },
    });
    await expect(
      service.convertMultiRepoWorkspace(request, { automatic: true }),
    ).resolves.toEqual({ ok: false, code: 'previously-converted' });
    expect(createMultiRepoProject).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });

  it('moves a converted multi-repo project back to Personal, like any other', async (): Promise<void> => {
    const converted = await service.convertMultiRepoWorkspace(request);
    if (!converted.ok) throw new Error('conversion failed');

    const result = await service.moveBackToPersonal({ workspaceId });

    if (!result.ok) throw new Error(`move back refused: ${result.code}`);
    expect(returnActivity).toHaveBeenCalledWith(multiProjectId, {
      localWorkspaceId: workspaceId,
    });
    expect(detach).toHaveBeenCalledWith(instanceId);
    expect(ownership.get(workspaceId)).toEqual({
      type: 'multi-repo',
      owner: undefined,
      ownershipTransfer: result.ownershipTransfer,
    });
    expect(result.ownershipTransfer.movedBackAt).toBeDefined();
    // Moving back is permanent for automatic conversion.
    claim.mockClear();
    await expect(
      service.convertMultiRepoWorkspace(request, { automatic: true }),
    ).resolves.toEqual({ ok: false, code: 'previously-converted' });
    expect(claim).not.toHaveBeenCalled();
  });

  it('rolls a refused completion back to Personal, and a retry reuses the member project', async (): Promise<void> => {
    complete.mockRejectedValueOnce(
      new CanopyCloudClientError('http-error', 'gone', 409, 'conflict'),
    );
    await expect(service.convertMultiRepoWorkspace(request)).resolves.toEqual({
      ok: false,
      code: 'conversion-failed',
    });
    expect(ownership.get(workspaceId)).toEqual({
      type: 'multi-repo',
      owner: undefined,
      ownershipTransfer: undefined,
    });
    expect(detach).toHaveBeenCalledWith(instanceId);

    const retried = await service.convertMultiRepoWorkspace(request);
    expect(retried.ok).toBe(true);
    // The server answers the same local project with the same definition.
    expect(createMultiRepoProject).toHaveBeenCalledTimes(2);
    expect(createMultiRepoProject.mock.calls[1]?.[0]).toEqual(
      createMultiRepoProject.mock.calls[0]?.[0],
    );
  });

  it('claims nothing when the organization refuses the member project', async (): Promise<void> => {
    const refusals: Array<[unknown, string]> = [
      [
        new CanopyCloudClientError(
          'http-error',
          'limit',
          409,
          'member_project_limit',
        ),
        'member-project-limit',
      ],
      [
        new CanopyCloudClientError(
          'http-error',
          'foreign',
          409,
          'repository_mismatch',
        ),
        'repository-mismatch',
      ],
      [
        new CanopyCloudClientError('http-error', 'gone', 404, 'not_found'),
        'project-unavailable',
      ],
      [new CanopyCloudClientError('network-error', 'offline'), 'offline'],
      [new Error('boom'), 'conversion-failed'],
    ];
    for (const [error, code] of refusals) {
      createMultiRepoProject.mockRejectedValueOnce(error);
      await expect(service.convertMultiRepoWorkspace(request)).resolves.toEqual(
        { ok: false, code },
      );
    }
    // A definition that is not this organization's multi-repo project.
    createMultiRepoProject.mockResolvedValueOnce({
      ...created,
      topology: 'single-repo',
    });
    await expect(service.convertMultiRepoWorkspace(request)).resolves.toEqual({
      ok: false,
      code: 'project-unavailable',
    });
    expect(claim).not.toHaveBeenCalled();
    expect(ownership.get(workspaceId)).toEqual({ type: 'multi-repo' });
  });

  it('rolls an interrupted multi-repo conversion back to Personal on the next launch', async (): Promise<void> => {
    journalWritten.mockImplementation(
      (phase): Promise<void> =>
        phase === 'completing'
          ? new Promise<void>(() => {})
          : Promise.resolve(),
    );
    void service.convertMultiRepoWorkspace(request);
    while (!journalPhases.includes('completing'))
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(ownership.get(workspaceId)).toMatchObject({ owner: bound });

    await createOrgProjectMaterialization(deps).sweepInterruptedSetups();

    expect(ownership.get(workspaceId)).toEqual({
      type: 'multi-repo',
      owner: undefined,
      ownershipTransfer: undefined,
    });
    expect(detach).toHaveBeenCalledWith(instanceId);
  });
});

describe("Moving a converted project's uploaded activity (CAN-3418)", (): void => {
  const workspaceId = 'personal-repo';
  const request = { workspaceId, organizationId, projectId };
  const bound: WorkspaceOwnerBinding = {
    type: 'organization',
    organizationId,
    projectId,
    instanceId,
    bindingGeneration: 7,
  };
  beforeEach((): void => {
    sidebarItems = [{ id: workspaceId }];
    ownership.set(workspaceId, { type: 'single-repo' });
  });
  /** The sidebar lists what the conversion bound, as the real one does. */
  function listBound(): void {
    sidebarItems = [{ id: workspaceId, owner: bound }];
  }

  it('moves the checkout activity to the organization once the conversion completed', async (): Promise<void> => {
    const order: string[] = [];
    complete.mockImplementation((): Promise<void> => {
      order.push('complete');
      return Promise.resolve();
    });
    moveActivity.mockImplementation((): Promise<void> => {
      order.push('move-activity');
      return Promise.resolve();
    });

    const result = await service.convertWorkspace(request);

    expect(result.ok).toBe(true);
    expect(moveActivity).toHaveBeenCalledTimes(1);
    expect(moveActivity).toHaveBeenCalledWith(projectId, {
      localWorkspaceId: workspaceId,
    });
    expect(order).toEqual(['complete', 'move-activity']);
  });

  it('never moves activity for a conversion that did not complete', async (): Promise<void> => {
    complete.mockRejectedValueOnce(
      new CanopyCloudClientError('http-error', 'gone', 409, 'conflict'),
    );
    await expect(service.convertWorkspace(request)).resolves.toMatchObject({
      ok: false,
    });
    expect(moveActivity).not.toHaveBeenCalled();
  });

  it('keeps a completed conversion when the move cannot run now, and retries it on the next launch', async (): Promise<void> => {
    moveActivity.mockRejectedValueOnce(
      new CanopyCloudClientError('network-error', 'offline'),
    );
    const result = await service.convertWorkspace(request);
    expect(result).toMatchObject({ ok: true, owner: bound });
    expect(ownership.get(workspaceId)).toMatchObject({ owner: bound });

    listBound();
    await createOrgProjectMaterialization(deps).sweepInterruptedSetups();

    expect(moveActivity).toHaveBeenCalledTimes(2);
    expect(moveActivity).toHaveBeenLastCalledWith(projectId, {
      localWorkspaceId: workspaceId,
    });
  });

  it("reports the server's answer and a refusal, and never fails the sweep over them (CAN-3601)", async (): Promise<void> => {
    const counts = {
      worktrees: 1,
      turns: 3,
      plans: 1,
      pullRequests: 1,
      skippedPullRequests: 0,
      pipelineRuns: 1,
      rekeyedBodies: 0,
    };
    moveActivity.mockResolvedValueOnce({
      outcome: 'moved',
      transferId: 'transfer-1',
      counts,
    });
    await expect(service.convertWorkspace(request)).resolves.toMatchObject({
      ok: true,
    });
    expect(reportActivityMove).toHaveBeenLastCalledWith({
      projectId,
      result: 'answered',
      outcome: 'moved',
      transferId: 'transfer-1',
      counts,
    });

    listBound();
    moveActivity.mockRejectedValueOnce(
      new CanopyCloudClientError(
        'http-error',
        'Only Personal activity can move',
        409,
        'not_personal',
      ),
    );
    await expect(
      createOrgProjectMaterialization(deps).sweepInterruptedSetups(),
    ).resolves.toBeUndefined();
    expect(reportActivityMove).toHaveBeenLastCalledWith(
      expect.objectContaining({
        projectId,
        result: 'failed',
        status: 409,
        serverCode: 'not_personal',
      }),
    );
    expect(lastActivityMoveError()).toContain(
      'Only Personal activity can move',
    );

    // A report that throws is best effort too.
    reportActivityMove.mockImplementationOnce((): void => {
      throw new Error('diagnostics unavailable');
    });
    await expect(
      createOrgProjectMaterialization(deps).sweepInterruptedSetups(),
    ).resolves.toBeUndefined();
    expect(moveActivity).toHaveBeenCalledTimes(3);
  });

  it('only retries for converted, still-bound workspaces while the rollout is on', async (): Promise<void> => {
    // Moved back: Personal again, nothing to move.
    ownership.set(workspaceId, {
      type: 'single-repo',
      ownershipTransfer: {
        version: 1,
        previousOwner: { type: 'personal' },
        organizationId,
        projectId,
        convertedAt: '2026-09-27T00:00:00.000Z',
        movedBackAt: '2026-09-27T01:00:00.000Z',
      },
    });
    await createOrgProjectMaterialization(deps).sweepInterruptedSetups();
    expect(moveActivity).not.toHaveBeenCalled();

    // A project set up by cloning is repaired only with the member's consent
    // (CAN-3517); a Just me member keeps its private rows private.
    listBound();
    ownership.set(workspaceId, { type: 'single-repo', owner: bound });
    await createOrgProjectMaterialization(deps).sweepInterruptedSetups();
    expect(moveActivity).not.toHaveBeenCalled();

    // Converted, but the rollout was turned off since.
    const transfer: WorkspaceOwnershipTransfer = {
      version: 1,
      previousOwner: { type: 'personal' },
      organizationId,
      projectId,
      convertedAt: '2026-09-27T00:00:00.000Z',
    };
    ownership.set(workspaceId, {
      type: 'single-repo',
      owner: bound,
      ownershipTransfer: transfer,
    });
    deps.access = (): ReturnType<OrgProjectMaterializationDeps['access']> =>
      Promise.resolve({
        context: { kind: 'personal' },
        accountId: 'account',
        enabled: false,
        capabilities: ['org-projects-v1'],
      });
    await createOrgProjectMaterialization(deps).sweepInterruptedSetups();
    expect(moveActivity).not.toHaveBeenCalled();
  });

  it('returns the activity to Personal before releasing the instance', async (): Promise<void> => {
    await service.convertWorkspace(request);
    const order: string[] = [];
    returnActivity.mockImplementation((): Promise<void> => {
      order.push('return-activity');
      return Promise.resolve();
    });
    detach.mockImplementation((): Promise<void> => {
      order.push('detach');
      return Promise.resolve();
    });

    await expect(
      service.moveBackToPersonal({ workspaceId }),
    ).resolves.toMatchObject({ ok: true });

    expect(returnActivity).toHaveBeenCalledWith(projectId, {
      localWorkspaceId: workspaceId,
    });
    expect(order).toEqual(['return-activity', 'detach']);
  });

  it('keeps the organization owner when the activity cannot be returned', async (): Promise<void> => {
    await service.convertWorkspace(request);
    returnActivity.mockRejectedValueOnce(
      new CanopyCloudClientError('network-error', 'offline'),
    );
    await expect(service.moveBackToPersonal({ workspaceId })).resolves.toEqual({
      ok: false,
      code: 'activity-return-failed',
    });
    expect(detach).not.toHaveBeenCalled();
    expect(ownership.get(workspaceId)).toMatchObject({ owner: bound });

    // A server without the route answers 404; there is nothing to return.
    returnActivity.mockRejectedValueOnce(
      new CanopyCloudClientError('http-error', 'Not found', 404),
    );
    await expect(
      service.moveBackToPersonal({ workspaceId }),
    ).resolves.toMatchObject({ ok: true });
    expect(detach).toHaveBeenCalledWith(instanceId);
  });
});

describe('Repairing activity filed under the wrong scope (CAN-3517)', (): void => {
  const bound: WorkspaceOwnerBinding = {
    type: 'organization',
    organizationId,
    projectId,
    instanceId,
    bindingGeneration: 0,
  };
  const shared = {
    metadata: 'organization',
    transcripts: 'organization',
    plans: 'private',
    summaries: 'off',
  } as const;
  const sweep = (): Promise<void> =>
    createOrgProjectMaterialization(deps).sweepInterruptedSetups();

  function seedWorkspaces(): void {
    sidebarItems = [{ id: 'org-work', owner: bound }, { id: 'notes' }];
    ownership.set('org-work', { type: 'single-repo', owner: bound });
    ownership.set('notes', { type: 'cowork' });
  }

  it('moves a bound workspace once, withholding what the member does not share, and returns Personal work once', async (): Promise<void> => {
    seedWorkspaces();
    sharingFor.mockResolvedValue(shared);

    await sweep();
    expect(sharingFor).toHaveBeenCalledWith(organizationId);
    expect(moveActivity).toHaveBeenCalledTimes(1);
    expect(moveActivity).toHaveBeenCalledWith(projectId, {
      localWorkspaceId: 'org-work',
      withheldKinds: ['plans', 'summaries'],
    });
    expect(returnPersonalActivity).toHaveBeenCalledTimes(1);
    expect(returnPersonalActivity).toHaveBeenCalledWith({
      localWorkspaceId: 'notes',
    });

    // Once per workspace: a later launch asks for nothing again.
    await sweep();
    expect(moveActivity).toHaveBeenCalledTimes(1);
    expect(returnPersonalActivity).toHaveBeenCalledTimes(1);
  });

  it('respects Just me, and does not revisit it when the choice changes later', async (): Promise<void> => {
    seedWorkspaces();
    await sweep();
    expect(moveActivity).not.toHaveBeenCalled();
    const ledger: unknown = JSON.parse(
      await readFile(join(root, 'activity-scope-repair.json'), 'utf8'),
    );
    expect(ledger).toMatchObject({
      byAccount: {
        account: {
          'org-work': {
            target: `organization:${organizationId}:${projectId}`,
            outcome: 'kept-private',
          },
        },
      },
    });

    sharingFor.mockResolvedValue(shared);
    await sweep();
    expect(moveActivity).not.toHaveBeenCalled();
  });

  it('retries on the next launch until the server answers, and remembers a refusal', async (): Promise<void> => {
    seedWorkspaces();
    sharingFor.mockResolvedValue(shared);
    moveActivity.mockRejectedValueOnce(
      new CanopyCloudClientError('network-error', 'offline'),
    );
    returnPersonalActivity.mockRejectedValueOnce(
      new CanopyCloudClientError('http-error', 'Not found', 404),
    );
    await sweep();
    // Nothing is remembered, so the next launch asks again.
    expect(await deps.activityRepair.ledger.read('account')).toEqual({});

    moveActivity.mockRejectedValueOnce(
      new CanopyCloudClientError(
        'http-error',
        'Withheld',
        403,
        'scope_prohibited',
      ),
    );
    await sweep();
    expect(moveActivity).toHaveBeenCalledTimes(2);
    expect(returnPersonalActivity).toHaveBeenCalledTimes(2);
    // The refusal is visible, not only in the ledger (CAN-3601).
    expect(reportActivityMove).toHaveBeenLastCalledWith(
      expect.objectContaining({
        projectId,
        result: 'failed',
        status: 403,
        serverCode: 'scope_prohibited',
      }),
    );
    expect(lastActivityMoveError()).toContain('Withheld');

    await sweep();
    expect(moveActivity).toHaveBeenCalledTimes(2);
    expect(returnPersonalActivity).toHaveBeenCalledTimes(2);
  });

  it('waits for a readable sharing choice, and for the rollout and a signed-in account', async (): Promise<void> => {
    seedWorkspaces();
    sharingFor.mockResolvedValueOnce(null);
    await sweep();
    expect(moveActivity).not.toHaveBeenCalled();
    sharingFor.mockResolvedValue(shared);
    await sweep();
    expect(moveActivity).toHaveBeenCalledTimes(1);

    const fresh = { ...deps };
    fresh.activityRepair = {
      sharingFor,
      ledger: createActivityRepairLedger((): string =>
        join(root, 'other-ledger.json'),
      ),
    };
    for (const access of [
      { enabled: false, accountId: 'account' },
      { enabled: true, accountId: '' },
    ]) {
      fresh.access = (): ReturnType<OrgProjectMaterializationDeps['access']> =>
        Promise.resolve({
          context: { kind: 'personal' },
          capabilities: ['org-projects-v1'],
          ...access,
        });
      await createOrgProjectMaterialization(fresh).sweepInterruptedSetups();
    }
    expect(moveActivity).toHaveBeenCalledTimes(1);
    expect(returnPersonalActivity).toHaveBeenCalledTimes(1);
  });

  it('never returns the activity of a project moved back, and repairs again for a new owner', async (): Promise<void> => {
    sidebarItems = [{ id: 'moved-back' }, { id: 'notes' }];
    ownership.set('moved-back', {
      type: 'single-repo',
      ownershipTransfer: {
        version: 1,
        previousOwner: { type: 'personal' },
        organizationId,
        projectId,
        convertedAt: '2026-09-27T00:00:00.000Z',
        movedBackAt: '2026-09-27T01:00:00.000Z',
      },
    });
    ownership.set('notes', { type: 'single-repo' });
    sharingFor.mockResolvedValue(shared);
    await sweep();
    expect(returnPersonalActivity).toHaveBeenCalledTimes(1);
    expect(returnPersonalActivity).toHaveBeenCalledWith({
      localWorkspaceId: 'notes',
    });

    // The Personal checkout is later bound to the project.
    sidebarItems = [{ id: 'notes', owner: bound }];
    ownership.set('notes', { type: 'single-repo', owner: bound });
    await sweep();
    expect(moveActivity).toHaveBeenCalledWith(projectId, {
      localWorkspaceId: 'notes',
      withheldKinds: ['plans', 'summaries'],
    });
  });
});

describe('Personal Cowork conversion', (): void => {
  const workspaceId = 'research';
  const coworkProjectId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const request = { workspaceId, organizationId };
  const bound: WorkspaceOwnerBinding = {
    type: 'organization',
    organizationId,
    projectId: coworkProjectId,
    instanceId,
    bindingGeneration: 7,
  };
  const created: OrgProjectSummary = {
    ...project,
    id: coworkProjectId,
    name: 'Research',
    kind: 'COWORK',
    visibility: 'private',
    memberOwned: true,
    repository: null,
    capabilities: { administer: true, manageCloud: false, use: true },
  };
  let item: Extract<SidebarItem, { type: 'cowork' }>;
  let ownershipEvents: OrgProjectOwnershipChangedEvent[];
  beforeEach((): void => {
    item = {
      type: 'cowork',
      id: workspaceId,
      name: ' Research ',
      color: '',
      collapsed: false,
      order: 0,
    };
    deps.readItems = (): Promise<SidebarItem[]> => Promise.resolve([item]);
    ownership.set(workspaceId, { type: 'cowork' });
    createCoworkProject.mockResolvedValue(created);
    ownershipEvents = [];
    service.onOwnershipChanged((event): void => {
      ownershipEvents.push(event);
    });
  });

  it('creates a private Cowork project and binds the workspace in place', async (): Promise<void> => {
    const result = await service.convertCoworkWorkspace(request);

    expect(result).toMatchObject({ ok: true, workspaceId, owner: bound });
    const createRequest = createCoworkProject.mock.calls[0]?.[0];
    expect(createRequest?.creationKey).toMatch(/^[0-9a-f]{64}$/);
    expect({ ...createRequest, creationKey: 'key' }).toEqual({
      organizationId,
      creationKey: 'key',
      kind: 'COWORK',
      name: 'Research',
    });
    expect(createCoworkProject.mock.calls[0]?.[0]).not.toHaveProperty(
      'repository',
    );
    expect(claim).toHaveBeenCalledWith(
      coworkProjectId,
      expect.objectContaining({ localWorkspaceId: workspaceId }),
    );
    expect(ownership.get(workspaceId)).toMatchObject({
      type: 'cowork',
      owner: bound,
    });
    expect(journalPhases).toEqual(['claimed', 'bound', 'completing', 'done']);
    expect(ownershipEvents).toEqual([
      {
        workspaceId,
        organizationId,
        projectId: coworkProjectId,
        owner: 'organization',
      },
    ]);
    expect(rebindBackgroundExecution).toHaveBeenCalledWith({
      workspaceId,
      from: { kind: 'personal' },
      to: { kind: 'organization', organizationId },
    });
    expect(remoteUrl).not.toHaveBeenCalled();
  });

  it.each([
    { externalPath: '/Users/me/Research', finalPath: '/Users/me/Research' },
    { externalPath: undefined, finalPath: 'managed' },
  ])(
    'journals the Cowork folder as the final path ($finalPath)',
    async ({ externalPath, finalPath }): Promise<void> => {
      item = { ...item, externalPath };
      journalWritten.mockImplementation(
        (phase): Promise<void> =>
          phase === 'completing'
            ? new Promise<void>(() => {})
            : Promise.resolve(),
      );
      void service.convertCoworkWorkspace(request);
      while (!journalPhases.includes('completing'))
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      expect((await journal()).finalPath).toBe(
        finalPath === 'managed'
          ? join(root, 'workspaces', workspaceId, 'home')
          : finalPath,
      );
    },
  );

  it('refuses default Chats, other kinds, and owned workspaces before creating anything', async (): Promise<void> => {
    for (const id of [
      DEFAULT_COWORK_WORKSPACE_ID,
      orgDefaultCoworkWorkspaceId(organizationId),
    ]) {
      item = { ...item, id };
      ownership.set(id, { type: 'cowork' });
      await expect(
        service.convertCoworkWorkspace({ workspaceId: id, organizationId }),
      ).resolves.toEqual({ ok: false, code: 'unsupported-workspace' });
    }

    item = { ...item, id: workspaceId };
    deps.readItems = (): Promise<SidebarItem[]> =>
      Promise.resolve([
        {
          type: 'single-repo',
          id: workspaceId,
          name: 'Repo',
          repoPath: '/repo',
          color: '',
          collapsed: false,
          order: 0,
          worktrees: [],
        },
      ]);
    await expect(service.convertCoworkWorkspace(request)).resolves.toEqual({
      ok: false,
      code: 'unsupported-workspace',
    });

    deps.readItems = (): Promise<SidebarItem[]> => Promise.resolve([item]);
    ownership.set(workspaceId, { type: 'cowork', owner: bound });
    await expect(service.convertCoworkWorkspace(request)).resolves.toEqual({
      ok: false,
      code: 'not-personal',
    });
    ownership.delete(workspaceId);
    await expect(service.convertCoworkWorkspace(request)).resolves.toEqual({
      ok: false,
      code: 'workspace-not-found',
    });
    ownership.set(workspaceId, 'unreadable');
    await expect(service.convertCoworkWorkspace(request)).resolves.toEqual({
      ok: false,
      code: 'workspace-unreadable',
    });
    expect(createCoworkProject).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });

  it('maps member project refusals and claims nothing', async (): Promise<void> => {
    const refusals: Array<[unknown, string]> = [
      [
        new CanopyCloudClientError(
          'http-error',
          'limit',
          409,
          'member_project_limit',
        ),
        'member-project-limit',
      ],
      [new CanopyCloudClientError('network-error', 'offline'), 'offline'],
      [new Error('boom'), 'conversion-failed'],
    ];
    for (const [error, code] of refusals) {
      createCoworkProject.mockRejectedValueOnce(error);
      await expect(service.convertCoworkWorkspace(request)).resolves.toEqual({
        ok: false,
        code,
      });
    }
    expect(claim).not.toHaveBeenCalled();
    expect(ownership.get(workspaceId)).toEqual({ type: 'cowork' });
  });

  it('carries the created project on a reply that is not a usable Cowork project', async (): Promise<void> => {
    for (const reply of [
      { ...created, kind: 'CODE' as const },
      { ...created, purpose: 'default-chats' as const },
      { ...created, location: 'CLOUD' as const },
      { ...created, state: 'ARCHIVED' as const },
      { ...created, capabilities: { ...created.capabilities, use: false } },
      { ...created, organizationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' },
    ]) {
      createCoworkProject.mockResolvedValueOnce(reply);
      await expect(service.convertCoworkWorkspace(request)).resolves.toEqual({
        ok: false,
        code: 'project-unavailable',
        organizationProjectId: coworkProjectId,
      });
    }
    expect(claim).not.toHaveBeenCalled();
  });

  it('sends the same creation key on a retry and a new one after a move back', async (): Promise<void> => {
    complete.mockRejectedValueOnce(
      new CanopyCloudClientError('http-error', 'gone', 409, 'conflict'),
    );
    await expect(
      service.convertCoworkWorkspace(request),
    ).resolves.toMatchObject({
      ok: false,
      organizationProjectId: coworkProjectId,
    });
    await expect(
      service.convertCoworkWorkspace(request),
    ).resolves.toMatchObject({ ok: true });
    const keys = createCoworkProject.mock.calls.map(
      ([call]) => call.creationKey,
    );
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);

    ownership.set(workspaceId, {
      type: 'cowork',
      ownershipTransfer: {
        version: 1,
        previousOwner: { type: 'personal' },
        organizationId,
        projectId: coworkProjectId,
        convertedAt: '2026-10-11T00:00:00.000Z',
      },
    });
    await service.convertCoworkWorkspace(request);
    expect(createCoworkProject.mock.calls[2]?.[0].creationKey).not.toBe(
      keys[0],
    );
  });

  it('sends a new creation key when the project was renamed after a failed attempt', async (): Promise<void> => {
    complete.mockRejectedValueOnce(
      new CanopyCloudClientError('http-error', 'gone', 409, 'conflict'),
    );
    await service.convertCoworkWorkspace(request);
    item = { ...item, name: 'Research notes' };
    await service.convertCoworkWorkspace(request);
    const [first, renamed] = createCoworkProject.mock.calls.map(
      ([call]) => call,
    );
    expect(renamed?.name).toBe('Research notes');
    expect(renamed?.creationKey).not.toBe(first?.creationKey);
  });

  it('refuses a project another workspace is already bound to', async (): Promise<void> => {
    deps.readItems = (): Promise<SidebarItem[]> =>
      Promise.resolve([
        item,
        { ...item, id: 'other', owner: bound, name: 'Other' },
      ]);
    await expect(service.convertCoworkWorkspace(request)).resolves.toEqual({
      ok: false,
      code: 'project-already-bound',
      organizationProjectId: coworkProjectId,
    });
    expect(claim).not.toHaveBeenCalled();
  });

  it('rolls a refused completion back to Personal and announces it', async (): Promise<void> => {
    complete.mockRejectedValueOnce(
      new CanopyCloudClientError('http-error', 'gone', 409, 'conflict'),
    );
    await expect(service.convertCoworkWorkspace(request)).resolves.toEqual({
      ok: false,
      code: 'conversion-failed',
      organizationProjectId: coworkProjectId,
    });
    expect(ownership.get(workspaceId)).toEqual({
      type: 'cowork',
      owner: undefined,
      ownershipTransfer: undefined,
    });
    expect(detach).toHaveBeenCalledWith(instanceId);
    expect(ownershipEvents).toEqual([
      {
        workspaceId,
        organizationId,
        projectId: coworkProjectId,
        owner: 'personal',
      },
    ]);
  });

  it('rolls an interrupted Cowork conversion back to Personal on the next launch', async (): Promise<void> => {
    journalWritten.mockImplementation(
      (phase): Promise<void> =>
        phase === 'completing'
          ? new Promise<void>(() => {})
          : Promise.resolve(),
    );
    void service.convertCoworkWorkspace(request);
    while (!journalPhases.includes('completing'))
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(ownership.get(workspaceId)).toMatchObject({ owner: bound });

    await createOrgProjectMaterialization(deps).sweepInterruptedSetups();

    expect(ownership.get(workspaceId)).toEqual({
      type: 'cowork',
      owner: undefined,
      ownershipTransfer: undefined,
    });
    expect(detach).toHaveBeenCalledWith(instanceId);
  });

  it('answers busy while the workspace is changing', async (): Promise<void> => {
    journalWritten.mockImplementation(
      (phase): Promise<void> =>
        phase === 'completing'
          ? new Promise<void>(() => {})
          : Promise.resolve(),
    );
    void service.convertCoworkWorkspace(request);
    while (!journalPhases.includes('completing'))
      await new Promise<void>((resolve) => setTimeout(resolve, 5));

    await expect(service.convertCoworkWorkspace(request)).resolves.toEqual({
      ok: false,
      code: 'busy',
    });
    expect(createCoworkProject).toHaveBeenCalledTimes(1);
  });
});
