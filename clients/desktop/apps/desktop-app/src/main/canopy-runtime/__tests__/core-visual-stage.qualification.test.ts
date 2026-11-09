import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CORE_CHAT_VISUAL_STAGE_GRANTS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import { AGENT_VISUAL_STRIPPED_HTTP_EQUIV } from '@canopy/ui-shared/lib/agent-visual-html';
import type { StageVisualDocument } from '../../lib/chat-visual-contracts';
import { VisualStagingStoreImpl } from '../../lib/visual-staging';
import {
  inlineVisualImages,
  validateVisualHtml,
} from '../../canopy-tools/prepare-visual-html';
import { createShowVisualHost } from '../../canopy-tools/show-visual-host';
import {
  executeCanopyInjectedTool,
  type CanopyInjectedToolRuntime,
} from '../../canopy-tools/core';
import type { CoreChatVisualStageHost } from '../core-chat-visual-stage-adapter';
import { INTERFACE_RELAY_ALLOWLIST } from '../renderer-relay/interface-allowlist.generated';
import { createCoreOperationAdapter } from '../core-operation-adapter';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../desktop-runtime';

const mockState = { runtime: null as DesktopCanopyDispatcher | null };

jest.mock('../desktop-runtime', () => ({
  ...jest.requireActual<Record<string, unknown>>('../desktop-runtime'),
  getActiveDesktopRuntime: (): unknown => mockState.runtime,
}));
jest.mock('../../lib/chat-visuals-feature-flag', () => ({
  isChatVisualsEnabled: (): boolean => true,
}));
jest.mock('../../browser/visual-preview-service', () => ({
  getVisualPreviewService: (): unknown => ({
    measure: (): Promise<unknown> => Promise.resolve({ status: 'unavailable' }),
  }),
}));

const SESSION = { projectId: 'p', worktreeId: 'w', chatId: 'chat-1' };
const WRITE: CanopyCallerDescriptor = {
  principalId: 'desktop-agent-visuals',
  clientInstanceId: 'desktop-main',
  authorityId: 'local',
  interfaceKind: 'mcp',
  grants: [CORE_CHAT_VISUAL_STAGE_GRANTS.write],
};
// A BOM, the agent's own CSP meta and a script: today's preparation keeps the
// meta and script and drops the BOM; the frame strips the meta at render.
const HTML =
  '﻿<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head><body><h1>Chart</h1><script>document.title="x"</script></body></html>';

interface Staged {
  target: { projectId: string; worktreeId: string; chatId: string };
  document: StageVisualDocument;
}

let root: string;
let staged: Staged[];
let stores: Map<string, VisualStagingStoreImpl>;

function storeFor(target: Staged['target']): VisualStagingStoreImpl {
  const key = `${target.projectId}/${target.worktreeId}/${target.chatId}`;
  let store = stores.get(key);
  if (!store) {
    store = new VisualStagingStoreImpl(join(root, 'staging', key));
    stores.set(key, store);
  }
  return store;
}

const host: CoreChatVisualStageHost = {
  stage: (target, document) => {
    staged.push({ target, document });
    return storeFor(target).stage({ chatId: target.chatId }, document);
  },
};

function session(): CanopyInjectedToolRuntime {
  return {
    showVisual: createShowVisualHost({ ...SESSION, cwd: root }),
  } as CanopyInjectedToolRuntime;
}

function visualId(index: number): string {
  return `vis_00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'visual-stage-'));
  staged = [];
  stores = new Map();
  mockState.runtime = createDesktopRuntime({
    operationAdapter: createCoreOperationAdapter({
      ledgerPath: () => join(root, 'ledger.sqlite'),
    }),
    visualStageHost: host,
    shutdownTimeoutMs: 25,
  });
});
afterEach(async () => {
  await mockState.runtime?.shutdown();
  mockState.runtime = null;
  rmSync(root, { recursive: true, force: true });
});

describe('ShowVisual stages through core.chat.visual.stage (CAN-5996)', () => {
  it("stages only into the session's chat; chat or scope fields in tool input change nothing", async () => {
    const result = await executeCanopyInjectedTool(
      'show_visual',
      {
        html: HTML,
        title: 'Chart',
        height: 400,
        chatId: 'other-chat',
        projectId: 'other',
        worktreeId: 'other',
        recipient: { workspaceId: 'other', worktreeId: 'other', chatId: 'x' },
      },
      session(),
    );
    expect(result.isError).toBeUndefined();
    expect(staged.map((entry) => entry.target)).toEqual([SESSION]);
    const id = staged[0]?.document.visualId ?? '';
    expect(result.text.startsWith(`${id} Shown to the user`)).toBe(true);
    expect(await storeFor(SESSION).readCandidate('chat-1', id)).toBeDefined();
    expect(
      await storeFor({ ...SESSION, chatId: 'other-chat' }).readCandidate(
        'other-chat',
        id,
      ),
    ).toBeUndefined();
  });

  it("stages the bytes today's preparation produces, so the frame applies the same sanitizing and CSP", async () => {
    await executeCanopyInjectedTool(
      'show_visual',
      { html: HTML, title: 'Chart', height: 400 },
      session(),
    );
    const validated = validateVisualHtml(HTML);
    if (!validated.ok) throw new Error(validated.error);
    const prepared = await inlineVisualImages(
      validated.value,
      { scope: SESSION, cwd: root },
      { unresolved: 'error' },
    );
    if (!prepared.ok) throw new Error(prepared.error);
    const id = staged[0]?.document.visualId ?? '';
    const candidate = await storeFor(SESSION).readCandidate('chat-1', id);
    expect(candidate?.html).toBe(prepared.value.html);
    expect(candidate?.html.startsWith('﻿')).toBe(false);
    // The agent's own CSP meta is kept and stripped at render, as before.
    expect(candidate?.html).toContain('http-equiv="Content-Security-Policy"');
    expect(
      AGENT_VISUAL_STRIPPED_HTTP_EQUIV.has('content-security-policy'),
    ).toBe(true);
  });

  it("keeps today's size limits: the tool refuses over 512,000 bytes, the operation over the 4 MiB prepared limit", async () => {
    const tooLong = await executeCanopyInjectedTool(
      'show_visual',
      { html: 'x'.repeat(512_001), title: 'Big', height: 400 },
      session(),
    );
    expect(tooLong.isError).toBe(true);
    const runtime = mockState.runtime;
    if (!runtime) throw new Error('no runtime');
    const stage = (html: string, key: string): Promise<unknown> =>
      runtime.instruction(
        'core.chat.visual.stage',
        {
          recipient: { workspaceId: 'p', worktreeId: 'w', chatId: 'chat-1' },
          visual: { visualId: visualId(1), html, title: 'Big', maxHeight: 400 },
          _meta: { idempotencyKey: key },
        },
        { caller: WRITE, metadata: { idempotencyKey: key } },
      );
    // 4 MiB + 1 byte in characters, and 4 MiB of characters that are
    // 2 UTF-8 bytes each: both over the prepared byte limit.
    await expect(
      stage('x'.repeat(4 * 1024 * 1024 + 1), 'k1'),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
    await expect(
      stage('é'.repeat(2 * 1024 * 1024 + 1), 'k2'),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
    expect(staged).toEqual([]);
  });

  it('a keyed retry stages once; another visual under the same key conflicts', async () => {
    const runtime = mockState.runtime;
    if (!runtime) throw new Error('no runtime');
    const stage = (id: string): Promise<unknown> =>
      runtime.instruction(
        'core.chat.visual.stage',
        {
          recipient: { workspaceId: 'p', worktreeId: 'w', chatId: 'chat-1' },
          visual: {
            visualId: id,
            html: '<p>ok</p>',
            title: 'T',
            maxHeight: 400,
          },
          _meta: { idempotencyKey: 'agent-visual-stage:chat-1:k' },
        },
        {
          caller: WRITE,
          metadata: { idempotencyKey: 'agent-visual-stage:chat-1:k' },
        },
      );
    const first = await stage(visualId(2));
    await expect(stage(visualId(2))).resolves.toEqual(first);
    expect(staged).toHaveLength(1);
    await expect(stage(visualId(3))).rejects.toMatchObject({
      payload: { kind: 'conflict' },
    });
    expect(staged).toHaveLength(1);
  });

  it('a staging failure is the tool error ShowVisual gave before', async () => {
    const result = await executeCanopyInjectedTool(
      'show_visual',
      { html: '<p>ok</p>', title: 'T', height: 400 },
      {
        showVisual: createShowVisualHost({
          ...SESSION,
          chatId: 'not a valid chat id',
          cwd: root,
        }),
      } as CanopyInjectedToolRuntime,
    );
    expect(result).toEqual({
      text: 'The visual could not be shown in this chat. Check that the chat is still open, then try again.',
      isError: true,
    });
  });

  it('no renderer relay or Portal session can stage: the interface allowlist excludes the operation', () => {
    for (const mode of Object.values(INTERFACE_RELAY_ALLOWLIST))
      for (const operations of Object.values(mode))
        expect(operations).not.toContain('core.chat.visual.stage');
    expect(INTERFACE_RELAY_ALLOWLIST.authority.query).toContain(
      'core.chat.visual.read',
    );
  });
});
