import { IdentifierValidationError, validateId } from '../../identifiers';
import type { WorkspaceIndexReadEntry } from '../../workspace/read-formats';
import type {
  W5CommitRequest,
  W5ReceiptLookup,
} from '../commit-log/commit-log';
import { W5CommitRefusedError } from '../commit-log/errors';
import { W5RevisionConflictError } from '../commit-log-file-store';
import { runW5Commit, type W5CommitOptions } from '../commit-scope';
import { W5RecordUnservedError } from '../file-store';
import {
  createW5KeyedOperationRunner,
  type W5ReceiptStore,
} from '../keyed-operation';
import type { W5StorageTarget } from '../storage-target';
import {
  WorkspaceIndexUnreadableError,
  type WorkspaceIndexAuthority,
  type WorkspaceIndexRepository,
} from '../workspace-index-repository';
import {
  createWorkspaceMetadataCommands,
  WorkspaceMetadataRefusedError,
  type StagedWorkspaceMetadataUpdate,
  type WorkspaceMetadataCommands,
  type WorkspaceMetadataCommandSource,
  type WorkspaceMetadataPatch,
  type WorkspaceMetadataUpdateOutcome,
  type WorkspaceReorderOutcome,
} from '../workspace-metadata/metadata';
import type {
  W5WorkspaceCommandHost,
  W5WorkspaceManifestChange,
  W5WorkspaceManifestEditor,
  W5WorkspaceManifestView,
} from '../workspace-metadata/ports';
import {
  createWorkspacePrivateMemoryCommand,
  WorkspacePrivateMemoryRefusedError,
  type WorkspacePrivateMemoryUpdateOutcome,
  type WorkspacePrivateMemorySource,
  type WorkspacePrivateMemoryUpdateRequest,
} from '../workspace-metadata/private-memory';
import {
  createWorkspaceRepositoryCommands,
  WorkspaceRepositoryRefusedError,
  type WorkspaceRepositoryAddOutcome,
  type WorkspaceRepositoryCommands,
  type WorkspaceRepositoryCommandSource,
  type WorkspaceRepositoryRemoveOutcome,
} from '../workspace-metadata/repositories';
import {
  createWorkspaceSettingsCommands,
  ScriptHookSettingsRefusedError,
  type ScriptHookSettingsSource,
  type WorkspaceSettingsCommands,
} from '../workspace-metadata/settings';

type Section = 'summary' | 'plans';
type Entry = WorkspaceIndexReadEntry<Section>;
type StoredManifest = W5WorkspaceManifestView & W5WorkspaceManifestChange;
type Receipt = NonNullable<W5CommitRequest['receipt']>;

const INDEX: W5StorageTarget = {
  namespace: 'workspace_index',
  writer: 'electron_main',
};
const MANIFEST: W5StorageTarget = {
  namespace: 'workspace_manifest',
  writer: 'electron_main',
};

function entry(id: string, overrides: Partial<Entry> = {}): Entry {
  return {
    id,
    name: id.toUpperCase(),
    type: 'multi-repo',
    color: '#7C3AED',
    collapsed: false,
    order: 0,
    ...overrides,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Stands in for the host's outcome schema: an object with these fields. */
function parser<T>(...fields: readonly string[]): {
  parse: (outcome: unknown) => T;
} {
  const isOutcome = (value: unknown): value is T =>
    isRecord(value) && fields.every((field) => field in value);
  return {
    parse: (outcome) => {
      if (!isOutcome(outcome)) throw new Error('Unexpected outcome');
      return outcome;
    },
  };
}

/** A patch carrying a value its type rules out, as an untyped payload can. */
function untrustedPatch(
  field: keyof WorkspaceMetadataPatch,
  value: unknown,
): WorkspaceMetadataPatch<Section> {
  const patch: WorkspaceMetadataPatch<Section> = {};
  Reflect.set(patch, field, value);
  return patch;
}

interface HarnessState {
  entries: Entry[];
  indexAuthority: WorkspaceIndexAuthority;
  /** Why an unreadable index could not be read, as the repository names it. */
  indexUnserved?: W5RecordUnservedError;
  manifests: Map<string, StoredManifest | 'unreadable'>;
  memoryMalformed: boolean;
  /** Each written file, in write order. */
  writes: string[];
  admitted: W5StorageTarget[][];
  commits: W5CommitOptions[];
  receipts: Receipt[];
  lookup: W5ReceiptLookup;
  /** How each failed keyed attempt left its reservation. */
  reservations: ('released' | 'recovery-required')[];
  staleRevision: boolean;
}

interface Harness<Source extends string> {
  state: HarnessState;
  index: WorkspaceIndexRepository<Entry>;
  manifest: W5WorkspaceManifestEditor;
  host: W5WorkspaceCommandHost<Source>;
}

/** In-memory index, manifests, receipts and commits for one test. */
function harness<Source extends string>(): Harness<Source> {
  const state: HarnessState = {
    entries: [entry('a'), entry('b'), entry('c'), entry('d')],
    indexAuthority: 'ok',
    manifests: new Map([['a', { type: 'multi-repo', repos: [] }]]),
    memoryMalformed: false,
    writes: [],
    admitted: [],
    commits: [],
    receipts: [],
    lookup: { status: 'none' },
    reservations: [],
    staleRevision: false,
  };
  const unserved = (): { unserved?: W5RecordUnservedError } =>
    state.indexUnserved ? { unserved: state.indexUnserved } : {};
  const index: WorkspaceIndexRepository<Entry> = {
    read: () =>
      Promise.resolve({
        entries: state.entries.map((item) => ({ ...item })),
        authority: state.indexAuthority,
        ...unserved(),
      }),
    update: async (change) => {
      const decided = await change({
        entries: [...state.entries],
        authority: state.indexAuthority,
        ...unserved(),
      });
      if (decided.entries) {
        if (state.indexAuthority === 'unreadable')
          throw new WorkspaceIndexUnreadableError();
        state.entries = decided.entries;
        state.writes.push('index');
      }
      return decided.result;
    },
  };
  const manifest: W5WorkspaceManifestEditor = {
    readAuthority: (workspaceId) => {
      const stored = state.manifests.get(workspaceId);
      return Promise.resolve(
        stored === 'unreadable' ? stored : stored ? 'ok' : 'absent',
      );
    },
    edit: async (workspaceId, apply) => {
      const stored = state.manifests.get(workspaceId);
      if (stored === 'unreadable')
        return { status: 'unreadable', message: 'Unreadable manifest.' };
      const view: StoredManifest = stored ?? { type: 'single-repo', repos: [] };
      const edit = await apply(view, {
        authority: stored ? 'ok' : 'absent',
        memoryMalformed: state.memoryMalformed,
      });
      if (edit.change) {
        state.manifests.set(workspaceId, { ...view, ...edit.change });
        state.writes.push(`manifest:${workspaceId}`);
      }
      return { status: 'edited', result: edit.result };
    },
  };
  const store: W5ReceiptStore = {
    lookupReceipt: (receipt) => {
      state.receipts.push(receipt);
      return Promise.resolve(state.lookup);
    },
    reserve: () => Promise.resolve(),
    releaseReservation: () => {
      state.reservations.push('released');
      return Promise.resolve();
    },
    markReservationRecoveryRequired: () => {
      state.reservations.push('recovery-required');
      return Promise.resolve();
    },
  };
  const runKeyed = createW5KeyedOperationRunner({
    getReceiptStore: () => store,
  });
  const commitStore = {};
  const host: W5WorkspaceCommandHost<Source> = {
    decision: {
      runKeyed: (input, decode, work) => runKeyed(input, decode, work),
      admitStorage: (targets, run) => {
        state.admitted.push([...targets]);
        return run();
      },
      caller: (source) => `test-host:${source}`,
      isHostRefusal: (error) => error instanceof IdentifierValidationError,
    },
    checkExpectedRevision: (resource, expected) =>
      expected !== undefined && state.staleRevision
        ? Promise.reject(
            new W5RevisionConflictError(resource.kind, expected, expected + 1),
          )
        : Promise.resolve(),
    withCommit: (options, work) =>
      runW5Commit(commitStore, options, work, (scope) => {
        state.commits.push({ ...scope.options });
        return Promise.resolve();
      }),
    paths: {
      workspaceIndex: () => '/data/workspaces/index.json',
      workspaceManifest: (id) => `/data/workspaces/${id}/workspace.json`,
      worktreeList: (id) => `/data/workspaces/${id}/worktrees.json`,
    },
    validateId,
  };
  return { state, index, manifest, host };
}

interface MetadataHarness extends Harness<WorkspaceMetadataCommandSource> {
  commands: WorkspaceMetadataCommands<Section>;
  staged: StagedWorkspaceMetadataUpdate<Section>[];
  after: WorkspaceMetadataUpdateOutcome[];
  serialized: string[];
  moves: () => number;
}

function metadataHarness(): MetadataHarness {
  const base = harness<WorkspaceMetadataCommandSource>();
  const staged: StagedWorkspaceMetadataUpdate<Section>[] = [];
  const after: WorkspaceMetadataUpdateOutcome[] = [];
  const serialized: string[] = [];
  let moves = 0;
  const commands = createWorkspaceMetadataCommands<Section>({
    ...base.host,
    index: () => base.index,
    manifest: base.manifest,
    storage: { index: INDEX, manifest: MANIFEST },
    isActivitySectionId: (value): value is Section =>
      value === 'summary' || value === 'plans',
    serializeUpdate: (work) => {
      serialized.push('update');
      return work();
    },
    updateOutcome: parser<WorkspaceMetadataUpdateOutcome>(
      'workspaceId',
      'indexWritten',
      'manifestWritten',
    ),
    reorderOutcome: parser<WorkspaceReorderOutcome>('workspaceIds'),
    afterUpdateStaged: (update) => {
      staged.push(update);
      return Promise.resolve();
    },
    afterUpdate: (outcome) => {
      after.push(outcome);
      return Promise.resolve();
    },
    afterMoveStaged: () => {
      moves += 1;
      return Promise.resolve();
    },
  });
  return {
    ...base,
    commands,
    staged,
    after,
    serialized,
    moves: () => moves,
  };
}

describe('core.workspace.update', () => {
  test('stages the manifest, then the index, in one keyed decision', async () => {
    const h = metadataHarness();
    const outcome = await h.commands.update({
      workspaceId: 'a',
      source: 'portal',
      patch: { name: '  Renamed  ', alwaysShow: true, pinned: true },
      expectedRevision: 3,
      idempotencyKey: 'key-1',
    });

    const expected = {
      workspaceId: 'a',
      indexWritten: true,
      manifestWritten: true,
    };
    expect(outcome).toEqual(expected);
    expect(h.state.writes).toEqual(['manifest:a', 'index']);
    expect(h.state.entries[0]).toMatchObject({ name: 'Renamed', pinned: true });
    expect(h.state.manifests.get('a')).toMatchObject({ alwaysShow: true });
    expect(h.state.admitted).toEqual([[INDEX, MANIFEST]]);
    expect(h.serialized).toEqual(['update']);
    expect(h.state.receipts).toEqual([
      expect.objectContaining({
        caller: 'test-host:workspace-metadata',
        operation: 'core.workspace.update',
        idempotencyKey: 'key-1',
      }),
    ]);
    expect(h.state.commits).toEqual([
      expect.objectContaining({
        operation: 'core.workspace.update',
        locks: [
          { kind: 'index', path: '/data/workspaces/index.json' },
          { kind: 'manifest', path: '/data/workspaces/a/workspace.json' },
        ],
        expectedRevisions: [
          { resource: { kind: 'workspace', workspaceId: 'a' }, revision: 3 },
        ],
        outcome: expected,
      }),
    ]);
    expect(h.staged).toEqual([
      expect.objectContaining({ workspaceId: 'a', source: 'portal' }),
    ]);
    expect(h.after).toEqual([expected]);
  });

  test('an unpin removes the key; an empty section order clears it', async () => {
    const h = metadataHarness();
    h.state.entries = [
      entry('a', { pinned: true, activitySectionOrder: ['plans'] }),
    ];
    await h.commands.update({
      workspaceId: 'a',
      source: 'portal',
      patch: { pinned: false, activitySectionOrder: [] },
    });
    expect(h.state.entries[0]).not.toHaveProperty('pinned');
    expect(h.state.entries[0]?.activitySectionOrder).toBeUndefined();
    expect(h.state.writes).toEqual(['index']);
    expect(h.state.admitted).toEqual([[INDEX]]);
  });

  test.each([
    ['name', '   ', 'Project name cannot be empty.'],
    ['color', '#000000', 'Invalid project color.'],
    [
      'activitySectionOrder',
      ['plans', 'plans'],
      'Invalid activity section order.',
    ],
    ['activitySectionOrder', ['memory'], 'Invalid activity section order.'],
    ['pinned', 'yes', 'Invalid pinned state.'],
    [
      'startPage',
      { kind: 'set', startPage: { kind: 'url', url: 'ftp://x' } },
      'Invalid start page',
    ],
  ] as const)(
    'refuses %s %j before admission',
    async (field, value, message) => {
      const h = metadataHarness();
      await expect(
        h.commands.update({
          workspaceId: 'a',
          source: 'portal',
          patch: untrustedPatch(field, value),
        }),
      ).rejects.toEqual(
        new WorkspaceMetadataRefusedError('invalid-patch', message),
      );
      expect(h.state.admitted).toEqual([]);
      expect(h.state.commits).toEqual([]);
    },
  );

  test('refuses an invalid workspace id as the host refusal', async () => {
    const h = metadataHarness();
    await expect(
      h.commands.update({ workspaceId: 'A', source: 'portal', patch: {} }),
    ).rejects.toBeInstanceOf(IdentifierValidationError);
  });

  test.each([
    ['absent', undefined, /could not be read/],
    // The editor's message, which names a capture class (CAN-5531).
    ['unreadable', 'unreadable', /^Unreadable manifest\.$/],
  ] as const)(
    'refuses an %s manifest and leaves the index unwritten',
    async (_name, stored, message) => {
      const h = metadataHarness();
      if (stored) h.state.manifests.set('a', stored);
      else h.state.manifests.delete('a');
      const refused = h.commands.update({
        workspaceId: 'a',
        source: 'portal',
        patch: { name: 'Renamed', itemSortMode: 'manual' },
      });
      await expect(refused).rejects.toMatchObject({
        reason: 'configuration-unavailable',
      });
      await expect(refused).rejects.toThrow(message);
      expect(h.state.writes).toEqual([]);
      expect(h.state.commits).toEqual([]);
    },
  );

  test('inherit removes the start page; a Cowork start page is refused', async () => {
    const h = metadataHarness();
    h.state.manifests.set('a', {
      type: 'multi-repo',
      repos: [],
      startPage: null,
    });
    await h.commands.update({
      workspaceId: 'a',
      source: 'desktop_set_start_page',
      patch: { startPage: { kind: 'inherit' } },
    });
    expect(h.state.manifests.get('a')).toEqual({
      type: 'multi-repo',
      repos: [],
    });

    h.state.entries = [entry('a', { type: 'cowork' })];
    await expect(
      h.commands.update({
        workspaceId: 'a',
        source: 'desktop_set_start_page',
        patch: { startPage: { kind: 'set', startPage: null } },
      }),
    ).rejects.toMatchObject({ reason: 'unsupported-for-cowork' });
  });

  test('a patch naming no field checks only the revision', async () => {
    const h = metadataHarness();
    h.state.staleRevision = true;
    await expect(
      h.commands.update({
        workspaceId: 'a',
        source: 'portal',
        patch: {},
        expectedRevision: 1,
      }),
    ).rejects.toBeInstanceOf(W5RevisionConflictError);
    h.state.staleRevision = false;
    await expect(
      h.commands.update({ workspaceId: 'a', source: 'portal', patch: {} }),
    ).resolves.toEqual({
      workspaceId: 'a',
      indexWritten: false,
      manifestWritten: false,
    });
    expect(h.state.admitted).toEqual([]);
    expect(h.serialized).toEqual([]);
    expect(h.staged).toEqual([]);
  });

  test('refuses an unreadable index before the manifest write', async () => {
    const h = metadataHarness();
    h.state.indexAuthority = 'unreadable';
    await expect(
      h.commands.update({
        workspaceId: 'a',
        source: 'portal',
        patch: { alwaysShow: true },
      }),
    ).rejects.toMatchObject({ reason: 'index-unavailable' });
    expect(h.state.writes).toEqual([]);
  });
});

// CAN-5531: an unreadable index's named capture class reaches the refusal.
describe.each([
  [
    'an update',
    (commands: WorkspaceMetadataCommands<Section>): Promise<unknown> =>
      commands.update({
        workspaceId: 'a',
        source: 'portal',
        patch: { name: 'Renamed', alwaysShow: true },
        idempotencyKey: 'key',
      }),
    "Couldn't update this project because the project list couldn't be read. Try again.",
  ],
  [
    'a drag move',
    (commands: WorkspaceMetadataCommands<Section>): Promise<unknown> =>
      commands.reorder({
        visibleWorkspaceIds: ['a', 'b'],
        activeWorkspaceId: 'a',
        overWorkspaceId: 'b',
        idempotencyKey: 'key',
      }),
    "Couldn't reorder projects because the project list couldn't be read. Try again.",
  ],
  [
    'the projects save',
    (commands: WorkspaceMetadataCommands<Section>): Promise<unknown> =>
      commands.reorder({
        source: 'projects_save',
        workspaceOrder: ['b', 'a'],
        idempotencyKey: 'key',
      }),
    "Couldn't update this project because the project list couldn't be read. Try again.",
  ],
] as const)('%s over an unreadable index', (_name, act, generic) => {
  test.each(['unsupported-id', 'limit-exceeded'] as const)(
    'names a %s capture, writes nothing and releases its key',
    async (reason) => {
      const h = metadataHarness();
      h.state.indexAuthority = 'unreadable';
      h.state.indexUnserved = new W5RecordUnservedError(reason, 'index');
      const refused = act(h.commands);
      await expect(refused).rejects.toMatchObject({
        name: 'WorkspaceMetadataRefusedError',
        reason: 'index-unavailable',
        message: h.state.indexUnserved.message,
      });
      expect(h.state.writes).toEqual([]);
      expect(h.moves()).toBe(0);
      expect(h.state.reservations).toEqual(['released']);
    },
  );

  test('keeps the generic message for an unnamed cause', async () => {
    const h = metadataHarness();
    h.state.indexAuthority = 'unreadable';
    await expect(act(h.commands)).rejects.toMatchObject({
      reason: 'index-unavailable',
      message: generic,
    });
    expect(h.state.writes).toEqual([]);
  });
});

test('an update names an index that became unreadable after its read', async () => {
  const h = metadataHarness();
  const index = { ...h.index };
  const unserved = new W5RecordUnservedError('limit-exceeded', 'index');
  h.index.read = async (): ReturnType<typeof index.read> => {
    const snapshot = await index.read();
    h.state.indexAuthority = 'unreadable';
    h.state.indexUnserved = unserved;
    return snapshot;
  };
  await expect(
    h.commands.update({
      workspaceId: 'a',
      source: 'portal',
      patch: { name: 'Renamed' },
    }),
  ).rejects.toMatchObject({
    reason: 'index-unavailable',
    message: unserved.message,
  });
  expect(h.state.writes).toEqual([]);
  expect(h.staged).toEqual([]);
});

describe('core.workspace.reorder', () => {
  test('moves one visible slot and keeps every other entry in place', async () => {
    const h = metadataHarness();
    const outcome = await h.commands.reorder({
      visibleWorkspaceIds: ['a', 'c', 'd'],
      activeWorkspaceId: 'd',
      overWorkspaceId: 'a',
    });
    expect(outcome).toEqual({ workspaceIds: ['d', 'b', 'a', 'c'] });
    expect(h.state.entries.map(({ id, order }) => [id, order])).toEqual([
      ['d', 0],
      ['b', 1],
      ['a', 2],
      ['c', 3],
    ]);
    expect(h.moves()).toBe(1);
    expect(h.state.commits[0]?.locks).toEqual([
      { kind: 'index', path: '/data/workspaces/index.json' },
    ]);
  });

  test('refuses a move of a workspace the caller does not show', async () => {
    const h = metadataHarness();
    await expect(
      h.commands.reorder({
        visibleWorkspaceIds: ['a', 'c'],
        activeWorkspaceId: 'b',
        overWorkspaceId: 'a',
      }),
    ).rejects.toEqual(
      new WorkspaceMetadataRefusedError(
        'not-found',
        'Project to reorder was not found.',
      ),
    );
    expect(h.state.writes).toEqual([]);
  });

  test('the projects save swaps only the named slots, unwritten when unchanged', async () => {
    const h = metadataHarness();
    await h.commands.reorder({
      source: 'projects_save',
      workspaceOrder: ['a', 'gone', 'b'],
    });
    expect(h.state.writes).toEqual([]);
    const outcome = await h.commands.reorder({
      source: 'projects_save',
      workspaceOrder: ['c', 'a'],
    });
    expect(outcome).toEqual({ workspaceIds: ['c', 'b', 'a', 'd'] });
    expect(h.state.writes).toEqual(['index']);
    expect(h.moves()).toBe(0);
  });
});

interface SettingsHarness extends Harness<ScriptHookSettingsSource> {
  commands: WorkspaceSettingsCommands;
}

function settingsHarness(writable = true): SettingsHarness {
  const base = harness<ScriptHookSettingsSource>();
  base.state.manifests.set('a', {
    type: 'multi-repo',
    repos: [
      { id: 'r1', name: 'R1', repoPath: '/r1', scripts: { lint: 'eslint' } },
    ],
    scripts: {
      dev: { command: 'pnpm dev', timeoutSeconds: 60 },
      test: 'pnpm test',
    },
  });
  const commands = createWorkspaceSettingsCommands({
    ...base.host,
    manifest: base.manifest,
    isWritableScope: () => writable,
    readOnlyScopeMessage: 'Read-only.',
  });
  return { ...base, commands };
}

describe('core.workspace.scripts.update and .planDetection.update', () => {
  test('a command merge keeps a definition and removes an emptied script', async () => {
    const h = settingsHarness();
    await h.commands.updateScripts({
      workspaceId: 'a',
      source: 'desktop',
      change: {
        kind: 'merge-commands',
        commands: { dev: 'pnpm start', test: ' ' },
      },
    });
    expect(h.state.manifests.get('a')).toMatchObject({
      scripts: { dev: { command: 'pnpm start', timeoutSeconds: 60 } },
    });
    expect(h.state.commits[0]?.locks).toEqual([
      { kind: 'manifest', path: '/data/workspaces/a/workspace.json' },
    ]);
  });

  test('repository scripts skip an unknown repository and still write', async () => {
    const h = settingsHarness();
    await h.commands.updateScripts({
      workspaceId: 'a',
      source: 'portal',
      change: {
        kind: 'repositories',
        repos: [{ repoId: 'missing', scripts: { build: 'make' } }],
      },
    });
    expect(h.state.writes).toEqual(['manifest:a']);
    expect(h.state.manifests.get('a')).toMatchObject({
      repos: [{ id: 'r1', scripts: { lint: 'eslint' } }],
    });
  });

  test('a definition edit refuses an unknown repository', async () => {
    const h = settingsHarness();
    await expect(
      h.commands.updateScripts({
        workspaceId: 'a',
        source: 'app_advisor',
        change: {
          kind: 'definition',
          repoId: 'missing',
          name: 'x',
          value: 'y',
        },
      }),
    ).rejects.toEqual(
      new ScriptHookSettingsRefusedError(
        'not-found',
        'Repo missing not found in project a',
      ),
    );
    await h.commands.updateScripts({
      workspaceId: 'a',
      source: 'app_advisor',
      change: { kind: 'remove-definition', repoId: 'r1', name: 'lint' },
    });
    expect(h.state.manifests.get('a')).toMatchObject({
      repos: [{ id: 'r1', scripts: undefined }],
    });
  });

  test('refuses a read-only scope and an absent manifest before any commit', async () => {
    const readOnly = settingsHarness(false);
    await expect(
      readOnly.commands.updatePlanDetection({
        workspaceId: 'a',
        source: 'desktop',
        planDetection: {},
      }),
    ).rejects.toEqual(
      new ScriptHookSettingsRefusedError('read-only-scope', 'Read-only.'),
    );
    const h = settingsHarness();
    await expect(
      h.commands.updatePlanDetection({
        workspaceId: 'b',
        source: 'desktop',
        planDetection: {},
      }),
    ).rejects.toMatchObject({ reason: 'configuration-unavailable' });
    expect(h.state.commits).toEqual([]);
  });

  test('stores the plan detection configuration as given', async () => {
    const h = settingsHarness();
    const planDetection = { disabledRuleIds: [' a ', 'a'] };
    await h.commands.updatePlanDetection({
      workspaceId: 'a',
      source: 'desktop',
      planDetection,
    });
    expect(h.state.manifests.get('a')).toMatchObject({ planDetection });
  });
});

interface PrivateMemoryHarness extends Harness<WorkspacePrivateMemorySource> {
  update: (
    request: WorkspacePrivateMemoryUpdateRequest,
  ) => Promise<WorkspacePrivateMemoryUpdateOutcome>;
}

function privateMemoryHarness(exists = true): PrivateMemoryHarness {
  const base = harness<WorkspacePrivateMemorySource>();
  const update = createWorkspacePrivateMemoryCommand({
    ...base.host,
    manifest: base.manifest,
    storage: { manifest: MANIFEST },
    hasWorkspace: () => Promise.resolve(exists),
    outcome: parser<WorkspacePrivateMemoryUpdateOutcome>(
      'workspaceId',
      'privateMemory',
    ),
  });
  return { ...base, update };
}

describe('core.workspace.privateMemory.update', () => {
  test('records the local choice', async () => {
    const h = privateMemoryHarness();
    await expect(
      h.update({
        workspaceId: 'a',
        source: 'workspace_settings',
        privateMemory: true,
      }),
    ).resolves.toEqual({ workspaceId: 'a', privateMemory: true });
    expect(h.state.manifests.get('a')).toMatchObject({ privateMemory: true });
    expect(h.state.admitted).toEqual([[MANIFEST]]);
  });

  test.each([
    ['organization policy', 'managed-by-organization'],
    ['malformed memory policy', 'configuration-unavailable'],
  ] as const)('refuses a manifest with an %s', async (name, reason) => {
    const h = privateMemoryHarness();
    if (name === 'organization policy')
      h.state.manifests.set('a', {
        type: 'multi-repo',
        repos: [],
        privateMemoryManagedBy: 'organization',
      });
    else h.state.memoryMalformed = true;
    await expect(
      h.update({
        workspaceId: 'a',
        source: 'workspace_settings',
        privateMemory: false,
      }),
    ).rejects.toEqual(expect.objectContaining({ reason }));
    expect(h.state.writes).toEqual([]);
  });

  test('refuses a workspace the index does not have, and a non-boolean', async () => {
    const h = privateMemoryHarness(false);
    await expect(
      h.update({
        workspaceId: 'a',
        source: 'workspace_settings',
        privateMemory: true,
      }),
    ).rejects.toEqual(
      new WorkspacePrivateMemoryRefusedError(
        'not-found',
        'Project was not found',
      ),
    );
    // An untyped IPC payload.
    const request: WorkspacePrivateMemoryUpdateRequest = {
      workspaceId: 'a',
      source: 'workspace_settings',
      privateMemory: false,
    };
    Reflect.set(request, 'privateMemory', 'true');
    await expect(h.update(request)).rejects.toEqual(
      new WorkspacePrivateMemoryRefusedError(
        'invalid-patch',
        'Private memory must be a boolean',
      ),
    );
  });
});

interface RepositoryHarness extends Harness<WorkspaceRepositoryCommandSource> {
  commands: WorkspaceRepositoryCommands;
  added: string[];
}

function repositoryHarness(
  repositories: readonly string[] = ['/repos/new'],
): RepositoryHarness {
  const base = harness<WorkspaceRepositoryCommandSource>();
  base.state.manifests.set('a', {
    type: 'multi-repo',
    repos: [{ id: 'my-repo', name: 'My Repo', repoPath: '/repos/old' }],
  });
  base.state.manifests.set('single', { type: 'single-repo', repos: [] });
  const added: string[] = [];
  const commands = createWorkspaceRepositoryCommands({
    ...base.host,
    manifest: base.manifest,
    storage: { manifest: MANIFEST },
    isRepository: (repoPath) =>
      Promise.resolve(repositories.includes(repoPath)),
    checkoutRepoIds: () => Promise.resolve(['my-repo-2']),
    afterAdd: (workspaceId, repository) => {
      added.push(`${workspaceId}/${repository.id}`);
      return Promise.resolve({ ...repository, scriptActionsOperationId: 'op' });
    },
    addOutcome: parser<WorkspaceRepositoryAddOutcome>('id', 'repoPath'),
    removeOutcome: parser<WorkspaceRepositoryRemoveOutcome>('removed'),
  });
  return { ...base, commands, added };
}

describe('core.workspace.repository.add and .remove', () => {
  test('allocates an id no repository or checkout has, after the others', async () => {
    const h = repositoryHarness();
    const outcome = await h.commands.add({
      workspaceId: 'a',
      source: 'workspace_settings',
      repository: { repoPath: '/repos/new', name: ' My Repo ' },
    });
    expect(outcome).toEqual({
      id: 'my-repo-3',
      name: 'My Repo',
      repoPath: '/repos/new',
      source: undefined,
      manifestUrl: undefined,
      scriptActionsOperationId: 'op',
    });
    expect(h.state.manifests.get('a')).toMatchObject({
      repos: [{ id: 'my-repo' }, { id: 'my-repo-3' }],
    });
    expect(h.added).toEqual(['a/my-repo-3']);
  });

  test.each([
    ['relative', 'repos/new', 'invalid-request'],
    ['non-repository', '/repos/plain', 'not-a-repository'],
    ['duplicate', '/repos/old', 'duplicate'],
  ] as const)('refuses a %s path', async (_name, repoPath, reason) => {
    const h = repositoryHarness(['/repos/old']);
    await expect(
      h.commands.add({
        workspaceId: 'a',
        source: 'workspace_settings',
        repository: { repoPath },
      }),
    ).rejects.toEqual(expect.objectContaining({ reason }));
    expect(h.state.writes).toEqual([]);
  });

  test('refuses a workspace that is not multi-repo or has no manifest', async () => {
    const h = repositoryHarness();
    for (const [workspaceId, reason] of [
      ['single', 'not-multi-repo'],
      ['none', 'not-found'],
    ] as const)
      await expect(
        h.commands.add({
          workspaceId,
          source: 'temporary_combine',
          repository: { repoPath: '/repos/new' },
        }),
      ).rejects.toEqual(expect.objectContaining({ reason }));
    expect(h.state.writes).toEqual([]);
  });

  test('a revert restores at its clamped position, unwritten when present', async () => {
    const h = repositoryHarness();
    const repository = { id: 'back', name: 'Back', repoPath: '/repos/back' };
    await h.commands.add({
      workspaceId: 'a',
      source: 'organization_sync_revert',
      restore: { repository, index: -4 },
    });
    expect(h.state.manifests.get('a')).toMatchObject({
      repos: [{ id: 'back' }, { id: 'my-repo' }],
    });
    await expect(
      h.commands.add({
        workspaceId: 'a',
        source: 'organization_sync_revert',
        restore: { repository: { ...repository, name: 'Other' }, index: 9 },
      }),
    ).resolves.toMatchObject({ id: 'back', name: 'Back' });
    expect(h.state.writes).toEqual(['manifest:a']);
    expect(h.added).toEqual([]);
  });

  test('a removal of a repository the workspace lacks writes nothing', async () => {
    const h = repositoryHarness();
    await expect(
      h.commands.remove({
        workspaceId: 'a',
        repoId: 'missing',
        source: 'workspace_settings',
      }),
    ).resolves.toEqual({ removed: null });
    await expect(
      h.commands.remove({
        workspaceId: 'a',
        repoId: 'my-repo',
        source: 'workspace_settings',
      }),
    ).resolves.toEqual({
      removed: { id: 'my-repo', name: 'My Repo', repoPath: '/repos/old' },
    });
    expect(h.state.writes).toEqual(['manifest:a']);
  });

  test('a referenced add resolves its path only for a new decision, and fingerprints the request as sent', async () => {
    const h = repositoryHarness(['/repos/new']);
    const resolved: string[] = [];
    const add = (
      reference: string,
      repoPath: string,
    ): Promise<WorkspaceRepositoryAddOutcome> =>
      h.commands.addReferenced(
        {
          workspaceId: 'a',
          source: 'workspace_settings',
          repository: { reference, name: 'New' },
          idempotencyKey: 'key',
        },
        () => {
          resolved.push(reference);
          return Promise.resolve(repoPath);
        },
      );
    const saved = {
      id: 'new',
      name: 'New',
      repoPath: '/repos/new',
      scriptActionsOperationId: 'op',
    };
    h.state.lookup = { status: 'replay', commitId: 1, outcome: saved };
    await expect(add('pick', '/repos/elsewhere')).resolves.toEqual(saved);
    // A receipt's refusal comes before any resolution, too.
    for (const lookup of [
      { status: 'key-reused' },
      { status: 'replay-expired', commitId: 1 },
      { status: 'in-progress', reservationId: 'r' },
      { status: 'recovery-required', reservationId: 'r', diagnostics: null },
      { status: 'commit-recovery-required', commitId: 1, diagnostics: null },
    ] as const) {
      h.state.lookup = lookup;
      await expect(add('pick', '/repos/new')).rejects.toBeInstanceOf(
        W5CommitRefusedError,
      );
    }
    expect(resolved).toEqual([]);
    expect(h.state.writes).toEqual([]);

    h.state.lookup = { status: 'none' };
    await expect(add('pick', '/repos/plain')).rejects.toEqual(
      expect.objectContaining({ reason: 'not-a-repository' }),
    );
    // Resolved under the reservation, a refused or failed resolution
    // releases the key.
    await expect(
      h.commands.addReferenced(
        {
          workspaceId: 'a',
          source: 'workspace_settings',
          repository: { reference: 'gone' },
          idempotencyKey: 'key',
        },
        () => Promise.reject(new Error('The selection is unknown.')),
      ),
    ).rejects.toThrow('The selection is unknown.');
    expect(h.state.reservations).toEqual(['released', 'released']);
    await expect(add('pick', '/repos/new')).resolves.toMatchObject({
      id: 'new',
      repoPath: '/repos/new',
    });
    await add('other-pick', '/repos/new').catch(() => undefined);
    expect(resolved).toEqual(['pick', 'pick', 'other-pick']);
    const fingerprints = h.state.receipts.map((receipt) => receipt.fingerprint);
    // One fingerprint for `pick` whatever path it resolved to; another
    // reference is another request.
    expect(
      fingerprints.map((fingerprint) => fingerprint === fingerprints[0]),
    ).toEqual([true, true, true, true, true, true, true, false, true, false]);
    expect(h.state.writes).toEqual(['manifest:a']);
  });

  test('standalone retry options cannot join a parent commit', async () => {
    const h = repositoryHarness();
    await expect(
      h.commands.remove(
        {
          workspaceId: 'a',
          repoId: 'my-repo',
          source: 'workspace_settings',
          idempotencyKey: 'key',
        },
        { operation: 'core.test.parent' },
      ),
    ).rejects.toBeInstanceOf(WorkspaceRepositoryRefusedError);
    expect(h.state.writes).toEqual([]);
  });
});
