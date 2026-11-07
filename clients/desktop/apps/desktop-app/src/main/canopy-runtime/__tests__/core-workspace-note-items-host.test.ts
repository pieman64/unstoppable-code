// Canonical core.workspace.item.* results for notes and prompts over the real
// desktop stores; the IPC payloads are pinned by workspace-items-ipc-golden.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CoreWorkspaceItemSchema,
  type CanopyCallerDescriptor,
  type CoreWorkspaceItem,
  type CoreWorkspaceItemListResult,
  type CoreWorkspaceItemUpsertParams,
} from '@canopy/protocol/canopy-core';
import { SHARED_CONTAINER_VIEWER_PROJECT_ID } from '@canopy/desktop-shared/types';
import { getCoworkManagedSubdir } from '@canopy/desktop-shared/node/lib/cowork-managed-dir';

// Files removed just before their next raw read. The stores read text, so
// only the host's revision read is raw: removal lands between the two.
const mockRemoveBeforeRawRead = new Set<string>();
// Files rewritten with these bytes just before their next raw read: an edit
// landing between the store read and the revision read.
const mockRewriteBeforeRawRead = new Map<string, string>();
// Same-realm fs errors, as Electron main sees them.
jest.mock('node:fs/promises', () => {
  const actual =
    jest.requireActual<Record<string, unknown>>('node:fs/promises');
  const sameRealm = (error: unknown): unknown =>
    typeof error === 'object' && error !== null && !(error instanceof Error)
      ? Object.assign(new Error(String(Reflect.get(error, 'message'))), error)
      : error;
  const wrapped = Object.fromEntries(
    [
      'lstat',
      'mkdir',
      'open',
      'readFile',
      'readdir',
      'realpath',
      'rename',
      'rm',
      'stat',
      'writeFile',
    ].map((name) => {
      const original = actual[name];
      if (typeof original !== 'function') throw new Error(name);
      return [
        name,
        async (...args: unknown[]): Promise<unknown> => {
          const [path, encoding] = args;
          const rawRead =
            name === 'readFile' &&
            typeof path === 'string' &&
            encoding === undefined;
          const syncFs = jest.requireActual<{
            rmSync: (path: string) => void;
            writeFileSync: (path: string, data: string) => void;
          }>('node:fs');
          if (rawRead && mockRemoveBeforeRawRead.delete(path))
            syncFs.rmSync(path);
          const rewrite = rawRead
            ? mockRewriteBeforeRawRead.get(path)
            : undefined;
          if (rawRead && rewrite !== undefined) {
            mockRewriteBeforeRawRead.delete(path);
            syncFs.writeFileSync(path, rewrite);
          }
          try {
            return await Reflect.apply(original, actual, args);
          } catch (error) {
            throw sameRealm(error);
          }
        },
      ];
    }),
  );
  return { ...actual, ...wrapped };
});
const mockPublished: string[] = [];
jest.mock('../../shared-containers/publish/scheduler', () => ({
  getSharedContainerPublishScheduler: (): {
    scheduleWorkspace: (projectId: string) => Promise<void>;
  } => ({
    scheduleWorkspace: (projectId: string): Promise<void> => {
      mockPublished.push(projectId);
      return Promise.resolve();
    },
  }),
}));

import { registerWorkspaceTypes } from '../../lib/workspace-registry';
import {
  coworkMigrationMapTestExports,
  writeCoworkMigrationMap,
} from '../../lib/cowork-migration-map';
import { getWorkspaceHomeDir } from '../../lib/paths';
import {
  saveNote as saveCoworkNote,
  savePrompt as saveCoworkPrompt,
} from '../../lib/standalone-workspace-files';
import { isRecord } from '../../lib/type-guards';
import {
  saveWorkspaceNote,
  saveWorkspacePrompt,
} from '../../lib/workspace-items';
import {
  readSharedContainerFileScope,
  writeSharedContainerFileScope,
} from '../../shared-containers/file-scope-store';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../desktop-runtime';
import {
  runTextItemsCall,
  type TextItemsCall,
} from '../core-workspace-note-items-host';
import {
  deleteTextItemForIpc,
  readTextItemForIpc,
  saveTextItemForIpc,
} from '../workspace-item-notes-dispatch';

jest.setTimeout(60_000);

/** Whether the temporary filesystem folds case, as default APFS does. */
const foldsCase = ((): boolean => {
  const probeDir = mkdtempSync(join(tmpdir(), 'note-items-case-'));
  try {
    writeFileSync(join(probeDir, 'Probe'), '');
    return existsSync(join(probeDir, 'probe'));
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
})();

const caller: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: [],
};
const read = {
  caller: { ...caller, grants: ['core.workspace.read' as const] },
};
let keys = 0;
const write = (): {
  caller: CanopyCallerDescriptor;
  metadata: { idempotencyKey: string };
} => ({
  caller: { ...caller, grants: ['core.workspace.write'] },
  metadata: { idempotencyKey: `key-${(keys += 1)}` },
});

let dir: string;
let dataDir: string;
let originalDataDir: string | undefined;
let runtime: DesktopCanopyDispatcher;

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'note-items-host-')));
  dataDir = join(dir, 'data');
  mkdirSync(dataDir);
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = dataDir;
  registerWorkspaceTypes(
    new Map([
      ['code-ws', 'single-repo'],
      ['cowork-ws', 'cowork'],
      ['legacy-chat', 'cowork'],
    ]),
  );
  coworkMigrationMapTestExports.resetCache();
  await writeCoworkMigrationMap({ 'legacy-chat': 'cowork-ws' });
  mockPublished.length = 0;
  runtime = createDesktopRuntime();
});

afterEach(async () => {
  await runtime.shutdown();
  coworkMigrationMapTestExports.resetCache();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  mockRemoveBeforeRawRead.clear();
  mockRewriteBeforeRawRead.clear();
  rmSync(dir, { recursive: true, force: true });
});

const codeStore = (folder: 'notes' | 'prompts'): string =>
  join(dataDir, 'workspaces', 'code-ws', folder);
const coworkStore = (folder: 'notes' | 'prompts'): string =>
  getCoworkManagedSubdir(getWorkspaceHomeDir('cowork-ws'), folder);

function params(
  overrides: Partial<CoreWorkspaceItemUpsertParams> = {},
): CoreWorkspaceItemUpsertParams {
  return {
    itemId: null,
    workspaceId: 'code-ws',
    worktreeId: null,
    kind: 'note',
    title: 'Plan',
    content: '# Plan\n',
    artifactId: null,
    expectedRevision: null,
    originWorktreeId: null,
    ...overrides,
  };
}

function list(
  workspaceId: string,
  kinds: Array<'note' | 'prompt'>,
): Promise<CoreWorkspaceItemListResult> {
  return runtime.query(
    'core.workspace.item.list',
    { workspaceId, worktreeId: null, kinds, cursor: null, limit: 500 },
    read,
  );
}

async function refusal(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    const payload: unknown =
      typeof error === 'object' && error !== null
        ? Reflect.get(error, 'payload')
        : undefined;
    if (typeof payload === 'object' && payload !== null) {
      const kind: unknown = Reflect.get(payload, 'kind');
      const code: unknown = Reflect.get(payload, 'code');
      return { kind, code };
    }
    return error;
  }
  return 'resolved';
}

describe('desktop note and prompt items host', () => {
  it('upserts, reads, lists and deletes code items without host paths', async () => {
    mkdirSync(join(dataDir, 'workspaces', 'code-ws'), { recursive: true });
    writeFileSync(
      join(dataDir, 'workspaces', 'code-ws', 'worktrees.json'),
      JSON.stringify({
        version: 1,
        worktrees: [
          { id: 'wt-1', branchName: 'feature/one', createdAt: '2020-01-01' },
        ],
      }),
    );
    const created = await runtime.instruction(
      'core.workspace.item.upsert',
      params({ kind: 'prompt', title: 'Review', originWorktreeId: 'wt-1' }),
      write(),
    );
    expect(CoreWorkspaceItemSchema.parse(created)).toEqual(created);
    expect(created).toMatchObject({
      itemId: 'prompt:code-ws:review',
      title: 'Review',
      content: '# Plan\n',
      mediaType: 'text/markdown',
      origin: {
        worktreeId: 'wt-1',
        branchName: 'feature/one',
        worktreeExists: true,
      },
    });
    expect(JSON.stringify(created)).not.toContain(dataDir);
    expect(readFileSync(join(codeStore('prompts'), 'review.md'), 'utf8')).toBe(
      '---\ntitle: "Review"\ntags: []\n---\n# Plan\n',
    );
    await expect(
      runtime.query(
        'core.workspace.item.get',
        { itemId: created.itemId },
        read,
      ),
    ).resolves.toEqual(created);
    const listed = await list('code-ws', ['note', 'prompt']);
    expect(listed.items).toEqual([{ ...created, content: null }]);
    await expect(
      runtime.instruction(
        'core.workspace.item.delete',
        { itemId: created.itemId, expectedRevision: created.revision },
        write(),
      ),
    ).resolves.toEqual({ deleted: true });
    expect((await list('code-ws', ['prompt'])).items).toEqual([]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockPublished).toEqual(['code-ws', 'code-ws']);
  });

  it('applies an IPC request only to the save it describes, once', async () => {
    const call: TextItemsCall = {
      legacySave: {
        kind: 'note',
        workspaceId: 'code-ws',
        itemId: undefined,
        title: '',
        content: 'from the channel',
        standsIn: true,
      },
    };
    const saved = await runTextItemsCall(call, async () => {
      // Another store's write inside the call keeps its own params.
      const prompt = await runtime.instruction(
        'core.workspace.item.upsert',
        params({ kind: 'prompt', title: 'Other', content: 'canonical' }),
        write(),
      );
      const note = await runtime.instruction(
        'core.workspace.item.upsert',
        params({ title: 'note', content: 'placeholder' }),
        write(),
      );
      // A second write of the same store does not reuse the claimed request.
      const again = await runtime.instruction(
        'core.workspace.item.upsert',
        params({ title: 'Again', content: 'canonical' }),
        write(),
      );
      return { prompt, note, again };
    });
    expect(saved.prompt).toMatchObject({
      title: 'Other',
      content: 'canonical',
    });
    expect(saved.note).toMatchObject({
      itemId: 'note:code-ws:note',
      content: 'from the channel',
    });
    expect(saved.again).toMatchObject({ title: 'Again', content: 'canonical' });
    expect(call.saved).toMatchObject({ id: 'note', title: 'note' });
  });

  it.each([
    ['a title over 512 characters', { title: 't'.repeat(513) }],
    ['content over 2,000,000 characters', { content: 'x'.repeat(2_000_001) }],
  ])(
    'refuses %s from a canonical caller and writes nothing',
    async (_name, overrides) => {
      // Only the IPC and Portal projection clamps its stand-in params and
      // stores what the channel was sent; the contract bounds stay for others.
      for (const kind of ['note', 'prompt'] as const)
        for (const workspaceId of ['code-ws', 'cowork-ws'])
          expect(
            await refusal(
              runtime.instruction(
                'core.workspace.item.upsert',
                params({ kind, workspaceId, ...overrides }),
                write(),
              ),
            ),
          ).toEqual({ kind: 'invalid_argument', code: undefined });
      expect(existsSync(codeStore('notes'))).toBe(false);
      expect(existsSync(codeStore('prompts'))).toBe(false);
      expect(existsSync(coworkStore('notes'))).toBe(false);
      expect(existsSync(coworkStore('prompts'))).toBe(false);
    },
  );

  it('never stores stand-in params for an IPC request it cannot apply', async () => {
    const other = await runtime.instruction(
      'core.workspace.item.upsert',
      params({ title: 'Other', content: 'kept' }),
      write(),
    );
    const call: TextItemsCall = {
      legacySave: {
        kind: 'note',
        workspaceId: 'code-ws',
        itemId: 'requested',
        title: 't'.repeat(600),
        content: 'from the channel',
        standsIn: true,
      },
    };
    // A write of the same store that names another item is not the request.
    const outcome = await refusal(
      runTextItemsCall(call, () =>
        runtime.instruction(
          'core.workspace.item.upsert',
          params({
            itemId: other.itemId,
            expectedRevision: other.revision,
            title: 'Other',
            content: 'clamped',
          }),
          write(),
        ),
      ),
    );
    expect(outcome).not.toBe('resolved');
    expect(call.saved).toBeUndefined();
    expect(readFileSync(join(codeStore('notes'), 'other.md'), 'utf8')).toBe(
      'kept',
    );
  });

  it.each([
    ['code-ws', 'note'],
    ['code-ws', 'prompt'],
    ['cowork-ws', 'note'],
    ['cowork-ws', 'prompt'],
  ] as const)(
    'saves over-limit IPC updates and renames of an existing %s %s as sent',
    async (projectId, kind) => {
      // The golden pins over-limit creates; an update also reads the item
      // first, and `get` cannot return content over the bound.
      await saveTextItemForIpc(runtime, caller, kind, {
        projectId,
        title: 'Plan',
        content: 'v0',
      });
      const big = 'x'.repeat(2_000_001);
      const updated = await saveTextItemForIpc(runtime, caller, kind, {
        projectId,
        itemId: 'plan',
        title: 'Plan',
        content: big,
      });
      expect(updated).toMatchObject({ id: 'plan', title: 'Plan' });
      expect(readFileSync(updated.absolutePath, 'utf8').endsWith(big)).toBe(
        true,
      );
      // Accented letters normalize away, so the stored name is `item`.
      const title = 'é'.repeat(600);
      const renamed = await saveTextItemForIpc(runtime, caller, kind, {
        projectId,
        itemId: 'plan',
        title,
        content: big,
      });
      expect(renamed).toMatchObject({ id: 'item', title });
      expect(existsSync(updated.absolutePath)).toBe(false);
      expect(readFileSync(renamed.absolutePath, 'utf8').endsWith(big)).toBe(
        true,
      );
    },
  );

  it('refuses an update after an edit outside the runtime and keeps the file', async () => {
    const created = await runtime.instruction(
      'core.workspace.item.upsert',
      params(),
      write(),
    );
    writeFileSync(join(codeStore('notes'), 'plan.md'), '# Plan\nedited\n');
    expect(
      await refusal(
        runtime.instruction(
          'core.workspace.item.upsert',
          params({
            itemId: created.itemId,
            expectedRevision: created.revision,
            content: 'mine',
          }),
          write(),
        ),
      ),
    ).toEqual({
      kind: 'conflict',
      code: 'core.workspace.item.revisionConflict',
    });
    expect(readFileSync(join(codeStore('notes'), 'plan.md'), 'utf8')).toBe(
      '# Plan\nedited\n',
    );
  });

  it('renames a code item, rewriting its selections for a canonical caller', async () => {
    const created = await runtime.instruction(
      'core.workspace.item.upsert',
      params(),
      write(),
    );
    await writeSharedContainerFileScope('code-ws', 'wt-1', {
      includedPaths: [],
      // Excluded IDs keep the file; an all-included scope is the default.
      includedNoteIds: ['plan'],
      excludedNoteIds: ['plan'],
      includedPromptIds: [],
      excludedPromptIds: [],
    });
    const renamed = await runtime.instruction(
      'core.workspace.item.upsert',
      params({
        itemId: created.itemId,
        expectedRevision: created.revision,
        title: 'Roadmap',
      }),
      write(),
    );
    expect(renamed.itemId).toBe('note:code-ws:roadmap');

    expect(await readSharedContainerFileScope('code-ws', 'wt-1')).toMatchObject(
      {
        includedNoteIds: ['roadmap'],
        excludedNoteIds: ['roadmap'],
      },
    );
    expect(
      await refusal(
        runtime.query(
          'core.workspace.item.get',
          { itemId: created.itemId },
          read,
        ),
      ),
    ).toEqual({ kind: 'not_found', code: 'core.workspace.item.notFound' });
  });

  it('lists repaired code stores canonically: cut titles, file times, nameless and unreadable files left out', async () => {
    const store = codeStore('notes');
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, 'long.md'), 'long');
    writeFileSync(join(store, 'bad-times.md'), 'bad');
    writeFileSync(join(store, '.md'), '# Nameless');
    writeFileSync(join(store, 'dropped.md'), '# Dropped heading');
    writeFileSync(
      join(store, 'index.json'),
      JSON.stringify({
        version: 1,
        items: {
          long: {
            id: 'long',
            filename: 'long.md',
            title: 'x'.repeat(600),
            createdAt: '2020-01-01T00:00:00.000Z',
            updatedAt: '2020-01-02T00:00:00.000Z',
          },
          'bad-times': {
            id: 'bad-times',
            filename: 'bad-times.md',
            title: 'Bad times',
            createdAt: 'not-a-date',
            updatedAt: 'yesterday',
          },
        },
      }),
    );
    const { items } = await list('code-ws', ['note']);
    for (const item of items) CoreWorkspaceItemSchema.parse(item);
    const byId = new Map(
      items.map((item: CoreWorkspaceItem) => [item.itemId, item]),
    );
    expect([...byId.keys()].sort()).toEqual([
      'note:code-ws:bad-times',
      'note:code-ws:dropped',
      'note:code-ws:long',
    ]);
    expect(byId.get('note:code-ws:long')?.title).toBe('x'.repeat(512));
    expect(byId.get('note:code-ws:dropped')?.title).toBe('Dropped heading');
    expect(byId.get('note:code-ws:bad-times')?.createdAt).not.toBe(
      'not-a-date',
    );
  });

  const posix = process.platform === 'win32' || process.getuid?.() === 0;
  (posix ? it.skip : it)(
    'skips an unreadable indexed code file canonically',
    async () => {
      const created = await runtime.instruction(
        'core.workspace.item.upsert',
        params(),
        write(),
      );
      const file = join(codeStore('notes'), 'plan.md');
      chmodSync(file, 0o000);
      try {
        expect((await list('code-ws', ['note'])).items).toEqual([]);
        expect(
          await refusal(
            runtime.query(
              'core.workspace.item.get',
              { itemId: created.itemId },
              read,
            ),
          ),
        ).toMatchObject({ kind: 'internal' });
      } finally {
        chmodSync(file, 0o600);
      }
    },
  );

  it('serves Cowork items through the legacy chat-project alias, deleting without side effects', async () => {
    const created = await runtime.instruction(
      'core.workspace.item.upsert',
      params({ workspaceId: 'legacy-chat', title: 'Ignored title' }),
      write(),
    );
    // Cowork notes take their title from the first heading.
    expect(created).toMatchObject({
      itemId: 'note:legacy-chat:ignored-title',
      title: 'Plan',
      origin: {},
    });
    expect(
      readFileSync(join(coworkStore('notes'), 'ignored-title.md'), 'utf8'),
    ).toBe('# Plan\n');
    await writeSharedContainerFileScope('legacy-chat', 'wt-1', {
      includedPaths: [],
      includedNoteIds: ['ignored-title'],
      excludedNoteIds: ['ignored-title'],
      includedPromptIds: [],
      excludedPromptIds: [],
    });
    await new Promise((resolve) => setImmediate(resolve));
    mockPublished.length = 0;
    await runtime.instruction(
      'core.workspace.item.delete',
      { itemId: created.itemId, expectedRevision: created.revision },
      write(),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockPublished).toEqual([]);
    expect(
      (await readSharedContainerFileScope('legacy-chat', 'wt-1'))
        .excludedNoteIds,
    ).toEqual(['ignored-title']);
    expect((await list('cowork-ws', ['note'])).items).toEqual([]);
  });

  it.each([
    { kind: 'note' as const, workspaceId: 'code-ws', store: codeStore },
    { kind: 'prompt' as const, workspaceId: 'cowork-ws', store: coworkStore },
  ])(
    'returns the store read of a $kind in $workspaceId removed before its revision read',
    async ({ kind, workspaceId, store }) => {
      const created = await runtime.instruction(
        'core.workspace.item.upsert',
        params({ kind, workspaceId, title: 'Gone', content: '# Gone\nbody\n' }),
        write(),
      );
      const name = created.itemId.split(':').at(-1) ?? '';
      const file = join(
        store(kind === 'note' ? 'notes' : 'prompts'),
        `${name}.md`,
      );
      mockRemoveBeforeRawRead.add(file);

      const response = await readTextItemForIpc(
        runtime,
        caller,
        kind,
        workspaceId,
        name,
      );

      expect(mockRemoveBeforeRawRead.has(file)).toBe(false);
      expect(existsSync(file)).toBe(false);
      expect(response.meta).toMatchObject({ id: name, absolutePath: file });
      expect(response.content).toContain('body');
    },
  );

  it.each([
    { kind: 'note' as const, workspaceId: 'code-ws', store: codeStore },
    { kind: 'prompt' as const, workspaceId: 'cowork-ws', store: coworkStore },
  ])(
    'never pairs a $kind in $workspaceId with the revision of an edit that lands mid-read',
    async ({ kind, workspaceId, store }) => {
      const created = await runtime.instruction(
        'core.workspace.item.upsert',
        params({ kind, workspaceId, title: 'Torn', content: '# Torn\nbody\n' }),
        write(),
      );
      const name = created.itemId.split(':').at(-1) ?? '';
      const file = join(
        store(kind === 'note' ? 'notes' : 'prompts'),
        `${name}.md`,
      );
      mockRewriteBeforeRawRead.set(
        file,
        readFileSync(file, 'utf8').replace('body', 'edited elsewhere'),
      );

      const got = await runtime.query(
        'core.workspace.item.get',
        { itemId: created.itemId },
        read,
      );

      expect(mockRewriteBeforeRawRead.has(file)).toBe(false);
      expect(got.content).toContain('edited elsewhere');
      await expect(
        runtime.query(
          'core.workspace.item.get',
          { itemId: created.itemId },
          read,
        ),
      ).resolves.toEqual(got);
      // An update at the returned revision cannot overwrite an unseen edit.
      expect(
        await refusal(
          runtime.instruction(
            'core.workspace.item.upsert',
            params({
              kind,
              workspaceId,
              itemId: created.itemId,
              expectedRevision: created.revision,
              title: 'Torn',
              content: 'mine',
            }),
            write(),
          ),
        ),
      ).toEqual({
        kind: 'conflict',
        code: 'core.workspace.item.revisionConflict',
      });
    },
  );

  const textStores = [
    { kind: 'note' as const, workspaceId: 'code-ws', store: codeStore },
    { kind: 'prompt' as const, workspaceId: 'code-ws', store: codeStore },
    { kind: 'note' as const, workspaceId: 'cowork-ws', store: coworkStore },
    { kind: 'prompt' as const, workspaceId: 'cowork-ws', store: coworkStore },
  ];

  it.each(textStores)(
    'addresses a $kind in $workspaceId only by its exact stored name',
    async ({ kind, workspaceId, store }) => {
      const folder = kind === 'note' ? 'notes' : 'prompts';
      const storeDir = store(folder);
      mkdirSync(storeDir, { recursive: true });
      const nfc = 'caf\u00e9';
      writeFileSync(join(storeDir, 'PLAN.md'), '# Plan\nkept\n');
      writeFileSync(join(storeDir, `${nfc}.md`), '# Cafe\nkept\n');
      // Excluded IDs keep the file; an all-included scope is the default.
      const ids = ['PLAN'];
      const selected = (selection: string[]): Record<string, string[]> =>
        kind === 'note'
          ? { includedNoteIds: selection, excludedNoteIds: selection }
          : { includedPromptIds: selection, excludedPromptIds: selection };
      const selections = {
        includedPaths: [],
        includedNoteIds: [],
        excludedNoteIds: [],
        includedPromptIds: [],
        excludedPromptIds: [],
        ...selected(ids),
      };
      const code = workspaceId === 'code-ws';
      // Only the Code store's delete removes selections.
      if (code)
        await writeSharedContainerFileScope(workspaceId, 'wt-1', selections);
      const listed = (await list(workspaceId, [kind])).items;
      const id = (name: string): string =>
        `${kind}:${workspaceId}:${encodeURIComponent(name)}`;
      expect(listed.map((item) => item.itemId).sort()).toEqual(
        [id('PLAN'), id(nfc)].sort(),
      );
      const stored = new Map(listed.map((item) => [item.itemId, item]));
      const notFound = {
        kind: 'not_found',
        code: 'core.workspace.item.notFound',
      };

      // A case-folding or normalizing filesystem opens these files too.
      for (const [alias, name] of [
        ['plan', 'PLAN'],
        ['Plan', 'PLAN'],
        ['cafe\u0301', nfc],
      ]) {
        const revision = stored.get(id(name))?.revision ?? 0;
        expect(
          await refusal(
            runtime.query(
              'core.workspace.item.get',
              { itemId: id(alias) },
              read,
            ),
          ),
        ).toEqual(notFound);
        expect(
          await refusal(
            runtime.instruction(
              'core.workspace.item.upsert',
              params({
                kind,
                workspaceId,
                itemId: id(alias),
                expectedRevision: revision,
                content: 'overwritten',
              }),
              write(),
            ),
          ),
        ).toEqual(notFound);
        expect(
          await refusal(
            runtime.instruction(
              'core.workspace.item.delete',
              { itemId: id(alias), expectedRevision: revision },
              write(),
            ),
          ),
        ).toEqual(notFound);
      }
      // The channels' store read is unchanged; their delete leaves the item.
      const channelRead = readTextItemForIpc(
        runtime,
        caller,
        kind,
        workspaceId,
        'plan',
      );
      if (foldsCase) {
        const response = await channelRead;
        expect(response.meta.id).toBe('plan');
        expect(response.content).toContain('kept');
      } else await expect(channelRead).rejects.toThrow();
      await deleteTextItemForIpc(runtime, caller, kind, workspaceId, 'plan');

      expect(readFileSync(join(storeDir, 'PLAN.md'), 'utf8')).toBe(
        '# Plan\nkept\n',
      );
      expect(readFileSync(join(storeDir, `${nfc}.md`), 'utf8')).toBe(
        '# Cafe\nkept\n',
      );
      expect((await list(workspaceId, [kind])).items).toEqual(listed);
      if (code)
        expect(
          await readSharedContainerFileScope(workspaceId, 'wt-1'),
        ).toMatchObject(selected(ids));
      const exact = await runtime.query(
        'core.workspace.item.get',
        { itemId: id('PLAN') },
        read,
      );
      expect(exact.content).toContain('kept');

      await runtime.instruction(
        'core.workspace.item.delete',
        {
          itemId: id('PLAN'),
          expectedRevision: stored.get(id('PLAN'))?.revision ?? 0,
        },
        write(),
      );
      expect(existsSync(join(storeDir, 'PLAN.md'))).toBe(false);
      expect(
        (await list(workspaceId, [kind])).items.map((item) => item.itemId),
      ).toEqual([id(nfc)]);
      if (code) {
        const index: unknown = JSON.parse(
          readFileSync(join(storeDir, 'index.json'), 'utf8'),
        );
        expect(
          isRecord(index) && isRecord(index.items)
            ? Object.keys(index.items)
            : null,
        ).toEqual([nfc]);
        expect(
          JSON.stringify(
            await readSharedContainerFileScope(workspaceId, 'wt-1'),
          ),
        ).not.toContain('PLAN');
      }
    },
  );

  (foldsCase ? it.skip : it).each(textStores)(
    'keeps case-variant $kind names in $workspaceId apart on a case-sensitive filesystem',
    async ({ kind, workspaceId, store }) => {
      const storeDir = store(kind === 'note' ? 'notes' : 'prompts');
      mkdirSync(storeDir, { recursive: true });
      writeFileSync(join(storeDir, 'PLAN.md'), '# Upper\n');
      writeFileSync(join(storeDir, 'plan.md'), '# Lower\n');
      const listed = (await list(workspaceId, [kind])).items;
      const upper = listed.find((item) => item.itemId.endsWith(':PLAN'));
      const lower = listed.find((item) => item.itemId.endsWith(':plan'));
      if (!upper || !lower) throw new Error('both spellings must list');
      await expect(
        runtime.query(
          'core.workspace.item.get',
          { itemId: lower.itemId },
          read,
        ),
      ).resolves.toMatchObject({ content: '# Lower\n' });
      await runtime.instruction(
        'core.workspace.item.delete',
        { itemId: lower.itemId, expectedRevision: lower.revision },
        write(),
      );
      expect(existsSync(join(storeDir, 'plan.md'))).toBe(false);
      await expect(
        runtime.query(
          'core.workspace.item.get',
          { itemId: upper.itemId },
          read,
        ),
      ).resolves.toMatchObject({ content: '# Upper\n' });
    },
  );

  it.each(
    textStores.flatMap((store) => [
      { ...store, title: 'Plan' },
      { ...store, title: 'Renamed' },
    ]),
  )(
    'passes a channel save of a $kind alias in $workspaceId titled $title to the unchanged writer',
    async ({ kind, workspaceId, store, title }) => {
      const storeDir = store(kind === 'note' ? 'notes' : 'prompts');
      const seed = (): void => {
        rmSync(storeDir, { recursive: true, force: true });
        mkdirSync(storeDir, { recursive: true });
        writeFileSync(join(storeDir, 'PLAN.md'), '# Plan\nkept\n');
      };
      const timeless = (item: object): object => ({
        ...item,
        createdAt: null,
        updatedAt: null,
      });
      const storeState = (): object => {
        const indexPath = join(storeDir, 'index.json');
        const index: unknown = existsSync(indexPath)
          ? JSON.parse(readFileSync(indexPath, 'utf8'))
          : null;
        return {
          files: readdirSync(storeDir)
            .filter((name) => name.endsWith('.md'))
            .sort()
            .map((name) => [name, readFileSync(join(storeDir, name), 'utf8')]),
          index:
            isRecord(index) && isRecord(index.items)
              ? Object.values(index.items).map((entry) =>
                  isRecord(entry) ? timeless(entry) : entry,
                )
              : null,
        };
      };
      const request = { title, content: 'edited' };

      seed();
      const legacy =
        workspaceId === 'code-ws'
          ? await (kind === 'note'
              ? saveWorkspaceNote({ workspaceId, noteId: 'plan', ...request })
              : saveWorkspacePrompt({
                  workspaceId,
                  promptId: 'plan',
                  ...request,
                }))
          : await (kind === 'note'
              ? saveCoworkNote(workspaceId, title, 'edited', 'plan')
              : saveCoworkPrompt(workspaceId, title, 'edited', 'plan'));
      const legacyState = storeState();

      seed();
      const saved = await saveTextItemForIpc(runtime, caller, kind, {
        projectId: workspaceId,
        itemId: 'plan',
        ...request,
      });
      expect(timeless(saved)).toEqual(
        timeless(
          workspaceId === 'code-ws'
            ? legacy
            : {
                ...legacy,
                absolutePath: join(storeDir, `${legacy.id}.md`),
              },
        ),
      );
      expect(storeState()).toEqual(legacyState);
    },
  );

  it('refuses the viewer and worktree scopes', async () => {
    expect(
      await refusal(
        runtime.instruction(
          'core.workspace.item.upsert',
          params({ workspaceId: SHARED_CONTAINER_VIEWER_PROJECT_ID }),
          write(),
        ),
      ),
    ).toEqual({
      kind: 'failed_precondition',
      code: 'core.workspace.item.readOnlyScope',
    });
    expect(
      await refusal(list(SHARED_CONTAINER_VIEWER_PROJECT_ID, ['note'])),
    ).toEqual({
      kind: 'capability_unavailable',
      code: 'core.workspace.item.scopeUnavailable',
    });
    expect(
      await refusal(
        runtime.instruction(
          'core.workspace.item.upsert',
          params({ worktreeId: 'wt-1' }),
          write(),
        ),
      ),
    ).toEqual({
      kind: 'failed_precondition',
      code: 'core.workspace.item.unsupportedScope',
    });
    expect(
      await refusal(
        runtime.instruction(
          'core.workspace.item.delete',
          { itemId: 'attachment:cowork-ws:a.png', expectedRevision: 0 },
          write(),
        ),
      ),
    ).toEqual({
      kind: 'capability_unavailable',
      code: 'core.workspace.item.kindUnavailable',
    });
  });

  it('requires the write grant and an idempotency key', async () => {
    expect(
      await refusal(
        runtime.instruction('core.workspace.item.upsert', params(), {
          ...read,
          metadata: { idempotencyKey: 'k' },
        }),
      ),
    ).toMatchObject({ kind: 'permission_denied' });
    expect(
      await refusal(
        runtime.instruction('core.workspace.item.upsert', params(), {
          caller: { ...caller, grants: ['core.workspace.write'] },
        }),
      ),
    ).toMatchObject({ kind: 'invalid_argument' });
  });
});
