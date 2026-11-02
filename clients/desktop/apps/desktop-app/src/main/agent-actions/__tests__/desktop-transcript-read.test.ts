const mockQuery = jest.fn<Promise<unknown>, [string, unknown, unknown]>();
const mockStandalone = jest.fn<Promise<object>, [unknown]>();
const mockEntries = jest.fn<Promise<object[]>, [string]>();

jest.mock('../../canopy-runtime/desktop-runtime-access', () => ({
  getDesktopCanopyRuntime: (): object => ({ query: mockQuery }),
}));
jest.mock('../../services/standalone-chat-service', () => ({
  resolveStandaloneChatTarget: (input: unknown): Promise<object> =>
    mockStandalone(input),
}));
jest.mock('../../lib/cowork-work-entries', () => ({
  listWorkEntryChatSummaries: (workspaceId: string): Promise<object[]> =>
    mockEntries(workspaceId),
}));

import { CanopyOperationError } from '@canopy/core-runtime';
import Ajv from 'ajv';
import type { AgentActionCall } from '@canopy/agent-actions';
import type { CanopyInjectedToolRuntime } from '../../canopy-tools/core';
import { createDesktopAgentActionSurface } from '../desktop-surface';
import { createDesktopTranscriptReadPort } from '../desktop-transcript-read-port';

const runtime: CanopyInjectedToolRuntime = {
  requestUserAnswers: () => Promise.resolve([]),
  loadScriptOutput: () => Promise.resolve({ found: false, lines: [] }),
  worktreeActionRuntime: {
    projectId: 'w1',
    worktreeId: 'caller-tree',
    chatId: 'caller',
    cwd: '/private/work',
    getWindow: () => null,
  },
};
const call: AgentActionCall<CanopyInjectedToolRuntime> = {
  host: runtime,
  scope: { workspaceId: 'w1', worktreeId: 'caller-tree', chatId: 'caller' },
};
const target = {
  kind: 'delegation',
  chatId: 'owner',
  delegationId: 'child',
  runGeneration: 1,
} as const;
const pageAction = { type: 'chat.transcript.page', target };
const contentAction = {
  type: 'chat.content.read',
  target,
  messageId: 'row',
  blockOrdinal: 0,
  offset: 0,
  field: 'text',
};
const blocksAction = {
  type: 'chat.transcript.blocks.page',
  target,
  messageId: 'row',
};
let kind: 'git' | 'cowork';
let owner: {
  workspaceId: string;
  worktreeId: string | null;
  state: string;
} | null;
let onMetadata: (() => Promise<void>) | undefined;
let onRead: (() => Promise<void>) | undefined;
let workspacePresent: boolean;

async function dispatch(action: object): Promise<unknown> {
  const result = await createDesktopAgentActionSurface(runtime).execute(
    'dispatch_action',
    { action },
    call,
  );
  return JSON.parse(result.text);
}
function transcriptCalls(): unknown[][] {
  return mockQuery.mock.calls.filter(
    ([name]) =>
      name.startsWith('core.chat.transcript.') ||
      name === 'core.chat.content.read',
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  kind = 'git';
  owner = { workspaceId: 'w1', worktreeId: 'owner-tree', state: 'idle' };
  onMetadata = undefined;
  onRead = undefined;
  workspacePresent = true;
  mockEntries.mockResolvedValue([
    { entryId: 'entry', title: 'Entry', createdAt: '2026-01-01' },
  ]);
  mockStandalone.mockImplementation(() =>
    Promise.resolve({
      workspaceId: 'w1',
      entryId: 'entry',
      archivedInEntryId: null,
      isArchived: false,
    }),
  );
  mockQuery.mockImplementation(async (name, raw) => {
    const input = raw as {
      scope: { workspaceId: string; worktreeId?: string };
      cursor?: string;
    };
    if (name === 'core.workspace.get') {
      if (!workspacePresent)
        throw new CanopyOperationError({
          kind: 'not_found',
          message: '/private/missing-workspace',
          retry: { kind: 'never' },
        });
      return { workspaceId: 'w1', kind };
    }
    if (name === 'core.worktree.list')
      return { items: [{ worktreeId: 'owner-tree' }], nextCursor: null };
    if (name === 'core.chat.list') {
      const selected =
        owner &&
        (input.scope.worktreeId === 'owner-tree' ||
          input.scope.worktreeId === 'entry')
          ? { ...owner, chatId: 'owner' }
          : null;
      await onMetadata?.();
      return { items: selected ? [selected] : [], nextCursor: null };
    }
    await onRead?.();
    if (name === 'core.chat.transcript.page')
      return { messages: [], totalMessages: 0, transcriptRevision: 1 };
    if (name === 'core.chat.content.read')
      return { text: 'stored text', byteLength: 11 };
    if (name === 'core.chat.transcript.blocks.page')
      return {
        projection: 'bounded-v1',
        messageId: 'row',
        firstBlockOrdinal: 0,
        entries: [],
        blockCount: 0,
        transcriptRevision: 1,
      };
    throw new Error('Unexpected operation');
  });
});

describe('desktop transcript-read surface', () => {
  it.each(['worktree', 'directory'] as const)(
    'advertises valid transcript payloads after environment actions (%s)',
    (executionScope) => {
      const scopedRuntime: CanopyInjectedToolRuntime = {
        ...runtime,
        worktreeActionRuntime: {
          projectId: 'w1',
          worktreeId: 'caller-tree',
          chatId: 'caller',
          cwd: '/work',
          getWindow: () => null,
          executionScope,
        },
      };
      const definition = createDesktopAgentActionSurface(scopedRuntime)
        .toolDefinitions()
        .find((tool) => tool.key === 'dispatch_action');
      expect(definition).toBeDefined();
      if (!definition) return;
      const schema = definition.inputSchema as {
        properties: { action: { properties: { type: { enum: string[] } } } };
      };
      expect(
        schema.properties.action.properties.type.enum.slice(0, 10),
      ).toEqual([
        'workspace.get',
        'worktree.list',
        'chat.list',
        'chat.get',
        'chat.create',
        'chat.send_message',
        'models.list',
        'chat.transcript.page',
        'chat.content.read',
        'chat.transcript.blocks.page',
      ]);
      const validate = new Ajv().compile(definition.inputSchema);
      for (const action of [pageAction, contentAction, blocksAction])
        expect(validate({ action })).toBe(true);
      expect(
        validate({
          action: { ...pageAction, target: { ...target, runGeneration: 0 } },
        }),
      ).toBe(false);
    },
  );
  it('advertises the three shared actions', async () => {
    const result = await createDesktopAgentActionSurface(runtime).execute(
      'search_actions',
      { query: 'transcript' },
      call,
    );
    expect(JSON.stringify(result)).toContain('chat.transcript.page');
    expect(JSON.stringify(result)).toContain('chat.content.read');
    expect(JSON.stringify(result)).toContain('chat.transcript.blocks.page');
  });
  it.each([pageAction, contentAction, blocksAction])(
    'dispatches $type through the desktop runtime',
    async (action) => {
      const result = await dispatch(action);
      expect(result).not.toHaveProperty('error');
      expect(result).toMatchObject({ ok: true });
      expect(transcriptCalls()).toHaveLength(1);
    },
  );
  it.each(['foreign', 'removed', 'unresolved', 'pre-entry'])(
    'rejects %s owners before any transcript read',
    async (scenario) => {
      if (scenario === 'foreign')
        owner = { workspaceId: 'w2', worktreeId: 'owner-tree', state: 'idle' };
      if (scenario === 'removed') owner = null;
      if (scenario === 'unresolved')
        owner = { workspaceId: 'w1', worktreeId: null, state: 'archived' };
      if (scenario === 'pre-entry') {
        kind = 'cowork';
        mockStandalone.mockResolvedValue({
          workspaceId: 'w1',
          entryId: null,
          archivedInEntryId: null,
          isArchived: true,
        });
      }
      expect(await dispatch(pageAction)).toMatchObject({
        ok: false,
        error: { code: 'not_found' },
      });
      expect(transcriptCalls()).toEqual([]);
    },
  );
  it('reads with owner scope and read-only grants, never with caller scope', async () => {
    expect(await dispatch(contentAction)).toMatchObject({ ok: true });
    expect(transcriptCalls()).toEqual([
      [
        'core.chat.content.read',
        expect.objectContaining({
          scope: {
            workspaceId: 'w1',
            worktreeId: 'owner-tree',
            chatId: 'owner',
          },
        }),
        expect.anything(),
      ],
    ]);
    expect(transcriptCalls()[0]?.[2]).toMatchObject({
      caller: {
        grants: ['core.chat.read'],
        principalId: 'local-desktop-user',
        interfaceKind: 'mcp',
      },
    });
  });
  it('rejects a removed workspace even if stale chat metadata remains', async () => {
    workspacePresent = false;
    expect(await dispatch(pageAction)).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(transcriptCalls()).toEqual([]);
  });
  it('forces bounded-v1 blocks and does not fetch lastResponse', async () => {
    expect(await dispatch(blocksAction)).toMatchObject({ ok: true });
    expect(transcriptCalls()).toEqual([
      [
        'core.chat.transcript.blocks.page',
        expect.objectContaining({ projection: 'bounded-v1' }),
        expect.anything(),
      ],
    ]);
  });
  it('reads a chat archived inside a live git worktree through its scope', async () => {
    // `archived` names the live worktree's own archive index, which the scope
    // read resolves; an archived container would route to a missing manifest.
    owner = { workspaceId: 'w1', worktreeId: 'owner-tree', state: 'archived' };
    expect(await dispatch(pageAction)).toMatchObject({ ok: true });
    expect(transcriptCalls()[0]?.[1]).toMatchObject({
      scope: { worktreeId: 'owner-tree' },
    });
    expect(transcriptCalls()[0]?.[1]).not.toHaveProperty(
      'archivedContainerId',
      'owner-tree',
    );
  });
  it.each([false, true])(
    'reads an entry-backed Cowork chat (archived=%s)',
    async (archived) => {
      kind = 'cowork';
      owner = {
        workspaceId: 'w1',
        worktreeId: 'entry',
        state: archived ? 'archived' : 'idle',
      };
      mockStandalone.mockResolvedValue({
        workspaceId: 'w1',
        entryId: archived ? null : 'entry',
        archivedInEntryId: archived ? 'entry' : null,
        isArchived: archived,
      });
      expect(await dispatch(pageAction)).toMatchObject({ ok: true });
      expect(mockStandalone).toHaveBeenCalledWith({
        projectLocalId: 'w1',
        chatId: 'owner',
      });
      expect(transcriptCalls()[0]?.[1]).toEqual(
        expect.objectContaining({
          scope: { workspaceId: 'w1', worktreeId: 'entry', chatId: 'owner' },
          ...(archived ? { archivedContainerId: 'entry' } : {}),
        }),
      );
    },
  );
  it('reauthorizes every cursor call', async () => {
    expect(await dispatch(pageAction)).toMatchObject({ ok: true });
    owner = null;
    expect(
      await dispatch({ ...pageAction, cursor: 'old-cursor' }),
    ).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(transcriptCalls()).toHaveLength(1);
  });
  it.each(['metadata', 'content'])(
    'drops a reply after revocation during held %s',
    async (stage) => {
      let release: () => void = () => {};
      let entered: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const hold = async (): Promise<void> => {
        entered();
        await held;
      };
      if (stage === 'metadata') onMetadata = hold;
      else onRead = hold;
      const pending = dispatch(contentAction);
      await started;
      owner = null;
      release();
      expect(await pending).toMatchObject({ ok: false });
    },
  );
  it('maps stale cursors without exposing a backend path', async () => {
    onRead = (): Promise<void> =>
      Promise.reject(
        new CanopyOperationError({
          kind: 'failed_precondition',
          code: 'core.chat.transcript.page.staleCursor',
          message: '/private/secret/body',
          retry: { kind: 'never' },
        }),
      );
    const result = await dispatch({ ...pageAction, cursor: 'stale' });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid_target' },
    });
    expect(JSON.stringify(result)).not.toContain('/private/secret');
  });
  it.each([
    ['not_found', 'not_found'],
    ['permission_denied', 'authorization_conflict'],
    ['unauthenticated', 'authentication_failed'],
    ['invalid_argument', 'invalid_payload'],
    ['unavailable', 'surface_unavailable'],
    ['deadline_exceeded', 'timeout'],
    ['internal', 'execution_failed'],
  ] as const)('maps %s errors with sanitized text', async (kind, code) => {
    onRead = (): Promise<void> =>
      Promise.reject(
        new CanopyOperationError({
          kind,
          message: '/private/backend',
          retry: { kind: 'never' },
        }),
      );
    const result = await dispatch(contentAction);
    expect(result).toMatchObject({ ok: false, error: { code } });
    expect(JSON.stringify(result)).not.toContain('/private/backend');
  });
  it('maps a foreign cursor to invalid_target', async () => {
    onRead = (): Promise<void> =>
      Promise.reject(
        new CanopyOperationError({
          kind: 'invalid_argument',
          message: 'Invalid transcript page cursor',
          retry: { kind: 'never' },
        }),
      );
    expect(await dispatch({ ...pageAction, cursor: 'foreign' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_target' },
    });
  });
  it('forwards supplied owner fields and cancellation, ignoring caller scope', async () => {
    const controller = new AbortController();
    const port = createDesktopTranscriptReadPort();
    await port.page(
      { target, cursor: 'cursor' },
      {
        scope: { workspaceId: 'w1', worktreeId: 'archive', chatId: 'owner' },
        archivedContainerId: 'archive',
        standaloneHistory: true,
      },
      { ...call, signal: controller.signal },
    );
    expect(transcriptCalls()).toEqual([
      [
        'core.chat.transcript.page',
        {
          target,
          cursor: 'cursor',
          scope: { workspaceId: 'w1', worktreeId: 'archive', chatId: 'owner' },
          archivedContainerId: 'archive',
          standaloneHistory: true,
        },
        expect.objectContaining({ signal: controller.signal }),
      ],
    ]);
  });
});
