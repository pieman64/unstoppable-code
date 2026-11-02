import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CanopyCallerDescriptor,
  CoreWorkspaceItem,
  CoreWorkspaceItemListResult,
} from '@canopy/protocol/canopy-core';
import { SHARED_CONTAINER_VIEWER_PROJECT_ID } from '@canopy/desktop-shared/types';

jest.mock('../../shared-containers/publish/scheduler', () => ({
  getSharedContainerPublishScheduler: (): {
    scheduleWorkspace: () => Promise<void>;
  } => ({ scheduleWorkspace: (): Promise<void> => Promise.resolve() }),
}));

import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../desktop-runtime';
import {
  importAttachmentsForIpc,
  listAttachmentsForIpc,
} from '../workspace-item-attachments-dispatch';
import { registerWorkspaceTypes } from '../../lib/workspace-registry';

jest.setTimeout(30_000);

const caller: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: [],
};
const READ: { caller: CanopyCallerDescriptor } = {
  caller: { ...caller, grants: ['core.workspace.read'] },
};
const WRITE = (
  key = 'key-1',
): {
  caller: CanopyCallerDescriptor;
  metadata: { idempotencyKey: string };
} => ({
  caller: { ...caller, grants: ['core.workspace.write'] },
  metadata: { idempotencyKey: key },
});

let dir: string;
let originalDataDir: string | undefined;
let runtime: DesktopCanopyDispatcher;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-items-adapter-')));
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  registerWorkspaceTypes(
    new Map([
      ['code-ws', 'single-repo'],
      ['cowork-ws', 'cowork'],
    ]),
  );
  runtime = createDesktopRuntime();
});

afterEach(async () => {
  await runtime.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
});

function source(name: string, content: string): string {
  const path = join(dir, 'source', name);
  mkdirSync(join(dir, 'source'), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function errorOf(error: unknown): Record<string, unknown> {
  const payload: unknown =
    typeof error === 'object' && error !== null
      ? Reflect.get(error, 'payload')
      : undefined;
  if (typeof payload !== 'object' || payload === null)
    return { thrown: String(error) };
  return {
    kind: Reflect.get(payload, 'kind'),
    code: Reflect.get(payload, 'code'),
    message: Reflect.get(payload, 'message'),
  };
}

async function refusal(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
    return 'resolved';
  } catch (error) {
    return errorOf(error);
  }
}

const importParams = {
  workspaceId: 'code-ws',
  worktreeId: 'wt-1',
  kind: 'attachment' as const,
  sources: [{ kind: 'host' as const, handle: `h-${'0'.repeat(32)}` }],
};

describe('core.workspace.item.* on the desktop dispatcher', () => {
  it('admits each operation with only its own grant', async () => {
    const listParams = {
      workspaceId: 'code-ws',
      worktreeId: 'wt-1',
      kinds: ['attachment' as const],
      cursor: null,
      limit: 10,
    };
    expect(
      await refusal(
        runtime.query('core.workspace.item.list', listParams, {
          caller: { ...caller, grants: ['core.workspace.write'] },
        }),
      ),
    ).toMatchObject({ kind: 'permission_denied' });
    expect(
      await refusal(
        runtime.instruction('core.workspace.item.import', importParams, {
          caller: { ...caller, grants: ['core.workspace.read'] },
          metadata: { idempotencyKey: 'k' },
        }),
      ),
    ).toMatchObject({ kind: 'permission_denied' });
    await expect(
      runtime.query('core.workspace.item.list', listParams, READ),
    ).resolves.toEqual({ items: [], nextCursor: null });
  });

  it('requires an idempotency key and refuses unknown params', async () => {
    expect(
      await refusal(
        runtime.instruction('core.workspace.item.import', importParams, {
          caller: WRITE().caller,
        }),
      ),
    ).toEqual({
      kind: 'invalid_argument',
      code: undefined,
      message: 'An idempotency key is required.',
    });
    expect(
      await refusal(
        runtime.instruction(
          'core.workspace.item.import',
          Object.assign({ path: '/etc/passwd' }, importParams),
          WRITE(),
        ),
      ),
    ).toMatchObject({ kind: 'invalid_argument' });
  });

  it('never resolves a host handle outside the call that issued it', async () => {
    const result = await runtime.instruction(
      'core.workspace.item.import',
      importParams,
      WRITE(),
    );
    expect(result.outcomes).toEqual([
      {
        status: 'failed',
        error: {
          kind: 'not_found',
          code: 'core.workspace.item.sourceNotFound',
          message: 'The import source does not exist.',
        },
      },
    ]);
  });

  it('round-trips an imported file through list and get, and copies it as an item', async () => {
    const imported = await importAttachmentsForIpc(runtime, caller, {
      scope: { workspaceId: 'code-ws', worktreeId: 'wt-1' },
      filePaths: [source('report.pdf', 'pdf body')],
      clipboardItems: [],
    });
    expect(imported).toEqual([
      expect.objectContaining({
        filename: 'report.pdf',
        absolutePath: join(
          dir,
          'data/workspaces/code-ws/attachments/wt-1/report.pdf',
        ),
        sizeBytes: 8,
      }),
    ]);
    const listed = await runtime.query(
      'core.workspace.item.list',
      {
        workspaceId: 'code-ws',
        worktreeId: 'wt-1',
        kinds: ['attachment'],
        cursor: null,
        limit: 500,
      },
      READ,
    );
    expect(listed.items).toEqual([
      expect.objectContaining({
        itemId: 'attachment:code-ws@wt-1:report.pdf',
        title: 'report.pdf',
        sizeBytes: 8,
      }),
    ]);
    expect(JSON.stringify(listed)).not.toContain(dir);
    await expect(
      runtime.query(
        'core.workspace.item.get',
        { itemId: 'attachment:code-ws@wt-1:report.pdf' },
        READ,
      ),
    ).resolves.toEqual(listed.items[0]);
    const copied = await runtime.instruction(
      'core.workspace.item.import',
      {
        workspaceId: 'cowork-ws',
        worktreeId: null,
        kind: 'attachment',
        sources: [
          { kind: 'item', itemId: 'attachment:code-ws@wt-1:report.pdf' },
        ],
      },
      WRITE('copy'),
    );
    expect(copied.outcomes).toMatchObject([
      {
        status: 'imported',
        item: {
          itemId: 'attachment:cowork-ws:report.pdf',
          worktreeId: null,
          sizeBytes: 8,
        },
      },
    ]);
    expect(
      (await listAttachmentsForIpc(runtime, caller, 'cowork-ws', 'wt-9')).map(
        (attachment) => attachment.filename,
      ),
    ).toEqual(['report.pdf']);
  });

  it('refuses viewer and code workspace-level scopes as typed errors', async () => {
    const list = (
      workspaceId: string,
      worktreeId: string | null,
    ): Promise<CoreWorkspaceItemListResult> =>
      runtime.query(
        'core.workspace.item.list',
        {
          workspaceId,
          worktreeId,
          kinds: ['attachment'],
          cursor: null,
          limit: 10,
        },
        READ,
      );
    expect(
      await refusal(list(SHARED_CONTAINER_VIEWER_PROJECT_ID, 'wt-1')),
    ).toMatchObject({
      kind: 'capability_unavailable',
      code: 'core.workspace.item.scopeUnavailable',
    });
    await expect(list('code-ws', null)).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    expect(
      await refusal(
        runtime.instruction(
          'core.workspace.item.import',
          { ...importParams, workspaceId: SHARED_CONTAINER_VIEWER_PROJECT_ID },
          WRITE('viewer'),
        ),
      ),
    ).toMatchObject({
      kind: 'failed_precondition',
      code: 'core.workspace.item.readOnlyScope',
    });
    expect(
      await refusal(
        runtime.instruction(
          'core.workspace.item.import',
          { ...importParams, worktreeId: null },
          WRITE('code-level'),
        ),
      ),
    ).toMatchObject({
      kind: 'failed_precondition',
      code: 'core.workspace.item.unsupportedScope',
    });
    expect(await refusal(list('Bad_Id', 'wt-1'))).toEqual({
      kind: 'invalid_argument',
      code: 'core.workspace.item.invalidScope',
      message: 'Invalid projectId: must be lowercase alphanumeric with hyphens',
    });
  });

  it('dispatches the projections with only the grant each operation needs', async () => {
    const query = jest.spyOn(runtime, 'query');
    const instruction = jest.spyOn(runtime, 'instruction');
    await importAttachmentsForIpc(runtime, caller, {
      scope: { workspaceId: 'code-ws', worktreeId: 'wt-1' },
      filePaths: [],
      clipboardItems: [{ filename: 'a.png', data: Buffer.from('a') }],
    });
    await listAttachmentsForIpc(runtime, caller, 'code-ws', 'wt-1');
    expect(instruction).toHaveBeenCalledTimes(1);
    const [name, , options] = instruction.mock.calls[0];
    expect(name).toBe('core.workspace.item.import');
    expect(options.caller).toEqual({
      ...caller,
      grants: ['core.workspace.write'],
    });
    expect(typeof options.metadata?.idempotencyKey).toBe('string');
    expect(
      query.mock.calls.map(([name, , options]) => [name, options]),
    ).toEqual([
      [
        'core.workspace.item.list',
        { caller: { ...caller, grants: ['core.workspace.read'] } },
      ],
    ]);
  });

  it('keeps the viewer list on its replica reader instead of the dispatcher', async () => {
    const query = jest.spyOn(runtime, 'query');
    let caught: unknown;
    try {
      await listAttachmentsForIpc(
        runtime,
        caller,
        SHARED_CONTAINER_VIEWER_PROJECT_ID,
        'container-1',
      );
    } catch (error) {
      caught = error;
    }
    // The dispatcher would answer scopeUnavailable; the replica reader
    // fails on the missing container with its own error.
    expect(caught).toBeInstanceOf(Error);
    expect(errorOf(caught)).not.toHaveProperty('kind');
    expect(query).not.toHaveBeenCalled();
  });

  // A backslash is a legal POSIX file-name character but never a key one.
  (process.platform === 'win32' ? it.skip : it)(
    'keeps files whose names an ID cannot spell out listable and importable',
    async () => {
      const store = join(dir, 'data/workspaces/code-ws/attachments/wt-1');
      mkdirSync(store, { recursive: true });
      writeFileSync(join(store, 'old.v1\\2'), 'existing');
      const imported = await importAttachmentsForIpc(runtime, caller, {
        scope: { workspaceId: 'code-ws', worktreeId: 'wt-1' },
        filePaths: [],
        clipboardItems: [{ filename: 'paste.a\\b', data: Buffer.from('ab') }],
      });
      expect(imported).toEqual([
        expect.objectContaining({
          filename: 'paste.a\\b',
          absolutePath: join(store, 'paste.a\\b'),
          sizeBytes: 2,
        }),
      ]);
      const listed = await listAttachmentsForIpc(
        runtime,
        caller,
        'code-ws',
        'wt-1',
      );
      expect(listed.map((attachment) => attachment.filename).sort()).toEqual([
        'old.v1\\2',
        'paste.a\\b',
      ]);
      const { items } = await runtime.query(
        'core.workspace.item.list',
        {
          workspaceId: 'code-ws',
          worktreeId: 'wt-1',
          kinds: ['attachment'],
          cursor: null,
          limit: 10,
        },
        READ,
      );
      for (const item of items) {
        expect(item.itemId).toMatch(/^attachment:code-ws@wt-1:#/);
        await expect(
          runtime.query(
            'core.workspace.item.get',
            { itemId: item.itemId },
            READ,
          ),
        ).resolves.toEqual(item);
      }
    },
  );

  it('imports more sources than one call allows in batches, in order', async () => {
    const instruction = jest.spyOn(runtime, 'instruction');
    const imported = await importAttachmentsForIpc(runtime, caller, {
      scope: { workspaceId: 'code-ws', worktreeId: 'wt-1' },
      filePaths: [source('first.txt', 'f')],
      clipboardItems: Array.from({ length: 100 }, (_, index) => ({
        filename: 'x.txt',
        data: Buffer.from(String(index)),
      })),
    });
    expect(instruction).toHaveBeenCalledTimes(2);
    expect(imported.map((attachment) => attachment.filename)).toEqual([
      'first.txt',
      'x.txt',
      ...Array.from({ length: 99 }, (_, index) => `x-${index + 2}.txt`),
    ]);
  });

  it('lists each file once when the store shifts between pages', async () => {
    const item = (name: string): CoreWorkspaceItem => ({
      itemId: `attachment:code-ws@wt-1:${name}`,
      workspaceId: 'code-ws',
      worktreeId: 'wt-1',
      kind: 'attachment',
      title: name,
      content: null,
      artifactId: null,
      mediaType: null,
      sizeBytes: 1,
      origin: {},
      revision: 0,
      createdAt: '2026-10-31T00:00:00.000Z',
      updatedAt: '2026-10-31T00:00:00.000Z',
    });
    // A file imported between pages pushes `b.txt` onto the second page too.
    jest
      .spyOn(runtime, 'query')
      .mockResolvedValueOnce({
        items: [item('c.txt'), item('b.txt')],
        nextCursor: 'c1.0000000000000000.2',
      })
      .mockResolvedValueOnce({
        items: [item('b.txt'), item('a.txt')],
        nextCursor: null,
      });
    const listed = await listAttachmentsForIpc(
      runtime,
      caller,
      'code-ws',
      'wt-1',
    );
    expect(listed.map((attachment) => attachment.filename)).toEqual([
      'c.txt',
      'b.txt',
      'a.txt',
    ]);
  });

  it('refuses an import once shutdown starts', async () => {
    await runtime.shutdown();
    expect(
      await refusal(
        importAttachmentsForIpc(runtime, caller, {
          scope: { workspaceId: 'code-ws', worktreeId: 'wt-1' },
          filePaths: [source('late.txt', 'late')],
          clipboardItems: [],
        }),
      ),
    ).toMatchObject({ kind: 'unavailable' });
  });
});
