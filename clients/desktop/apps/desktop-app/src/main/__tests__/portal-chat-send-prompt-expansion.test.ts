// Portal `portal.chat.send` prompt-mention expansion coverage: portal sends
// enter main directly (never through the renderer), so `handlePortalChatSend`
// must expand `@`-mentioned prompt pills itself before dispatching to
// `sendWorktreeChatMessage`. Uses real fs under a temp CANOPY_DATA_DIR (same
// posture as workspace-items.test.ts) so the path-validated prompt read in
// `lib/workspace-prompt-mentions.ts` runs for real.

import type {
  ChatSendMessageRequest,
  HostPortalChatFileReference,
  PortalChatFileReference,
  PortalChatSendPayload,
  PortalCommandEnvelope,
} from '@canopy/desktop-shared/types';

const mockSendWorktreeChatMessage = jest.fn<
  Promise<{ ok: true; chatId: string }>,
  [ChatSendMessageRequest | PortalChatSendPayload]
>(() => Promise.resolve({ ok: true, chatId: 'chat-1' }));
jest.mock('../services/chat-service', () => ({
  sendWorktreeChatMessage: mockSendWorktreeChatMessage,
  buildExistingTabDispatchOptions: jest.fn(() => Promise.resolve({})),
  ExistingTabDispatchTargetNotFoundError: class extends Error {},
}));

// These specs run against a real temp CANOPY_DATA_DIR with no signed-in
// provider, no credits and no gateway catalog, so the REAL lane resolver
// correctly reports `no-dispatchable-model` — and since CAN-1929 round-6 the
// send preflight refuses on that before any prompt expansion is observable.
// That refusal has its own coverage in `chat-adapter.test.ts`; here it would
// only mask what these specs actually assert, so the lane is stubbed as
// dispatchable.
jest.mock('../lib/default-model-lane-resolver', () => ({
  resolveLaneAwareDefaultSelection: jest.fn(() =>
    Promise.resolve({
      outcome: 'resolved',
      lane: 'claude-native',
      selection: { model: 'opus[1m]', thinkingLevel: 'high' },
    }),
  ),
}));

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handlePortalChatSend } from '../portal/adapters/chat-adapter';
import type { PortalAdapterContext } from '../portal/adapters/types';
import { saveWorkspacePrompt } from '../lib/workspace-items';
import { portalFileReferences } from '../portal/portal-file-references';

const WORKSPACE_ID = 'ws-1';
const SESSION_ID = 'sess-1';

/** Mint the opaque wire reference the paired desktop hands to the browser. */
function wireReference(
  reference: HostPortalChatFileReference,
  textStart?: number,
): PortalChatFileReference {
  const host: HostPortalChatFileReference = {
    displayPath: reference.displayPath,
    absolutePath: reference.absolutePath,
    ...(reference.kind !== undefined ? { kind: reference.kind } : {}),
  };
  const minted = portalFileReferences.mint(
    { sessionId: SESSION_ID, projectId: WORKSPACE_ID, worktreeId: 'wt-1' },
    host,
  );
  const start = textStart ?? reference.textStart;
  return start === undefined ? minted : { ...minted, textStart: start };
}

function makeCommand(
  payload: PortalChatSendPayload,
): PortalCommandEnvelope<PortalChatSendPayload> {
  return {
    id: 'cmd-1',
    sequence: 1,
    type: 'portal.chat.send',
    payload,
    createdAt: '2026-07-22T00:00:00.000Z',
    expiresAt: null,
  };
}

function makeContext(): PortalAdapterContext & {
  complete: jest.Mock;
  fail: jest.Mock;
} {
  return {
    sessionId: SESSION_ID,
    enqueueEvent: jest.fn(),
    complete: jest.fn(),
    fail: jest.fn(),
    getWindow: (): null => null,
  };
}

function sentRequest(): ChatSendMessageRequest | PortalChatSendPayload {
  expect(mockSendWorktreeChatMessage).toHaveBeenCalledTimes(1);
  return mockSendWorktreeChatMessage.mock.calls[0][0];
}

describe('handlePortalChatSend prompt-mention expansion', () => {
  const originalCanopyDataDir = process.env.CANOPY_DATA_DIR;
  let tempDataDir = '';

  beforeEach(() => {
    jest.clearAllMocks();
    tempDataDir = mkdtempSync(join(tmpdir(), 'canopy-portal-prompt-'));
    process.env.CANOPY_DATA_DIR = tempDataDir;
  });

  afterEach(() => {
    if (originalCanopyDataDir === undefined) {
      delete process.env.CANOPY_DATA_DIR;
    } else {
      process.env.CANOPY_DATA_DIR = originalCanopyDataDir;
    }
    rmSync(tempDataDir, { recursive: true, force: true });
    portalFileReferences.clear();
  });

  it('expands a prompt-kind reference into the outgoing text and drops its reference', async () => {
    const prompt = await saveWorkspacePrompt({
      workspaceId: WORKSPACE_ID,
      title: 'Review checklist',
      content: 'Check boundaries.\nCheck tests.',
    });
    const displayPath = 'Prompt: Review checklist';
    const text = `Please apply ${displayPath} to this diff`;
    const fileReference = {
      displayPath: 'src/index.ts',
      absolutePath: '/tmp/repo/src/index.ts',
    };
    const context = makeContext();

    await handlePortalChatSend(
      makeCommand({
        projectId: WORKSPACE_ID,
        worktreeId: 'wt-1',
        text,
        fileReferences: [
          wireReference(fileReference),
          wireReference({
            displayPath,
            absolutePath: prompt.absolutePath,
            kind: 'prompt',
            textStart: text.indexOf(displayPath),
          }),
        ],
      }),
      context,
    );

    expect(context.fail).not.toHaveBeenCalled();
    const request = sentRequest();
    expect(request.text).toBe(
      'Please apply Check boundaries.\nCheck tests. to this diff',
    );
    // The prompt reference is consumed by the expansion; the plain file
    // reference passes through untouched.
    expect(request.fileReferences).toEqual([fileReference]);
    expect(context.complete).toHaveBeenCalledWith(expect.anything(), {
      ok: true,
      chatId: 'chat-1',
    });
  });

  it('keeps the pill and reference intact when the prompt path is unreadable', async () => {
    const displayPath = 'Prompt: Missing';
    const text = `Use ${displayPath} here`;
    const promptReference = {
      displayPath,
      absolutePath: join(tempDataDir, 'outside', 'missing.md'),
      kind: 'prompt',
      textStart: text.indexOf(displayPath),
    };
    const context = makeContext();

    await handlePortalChatSend(
      makeCommand({
        projectId: WORKSPACE_ID,
        worktreeId: 'wt-1',
        text,
        fileReferences: [wireReference(promptReference)],
      }),
      context,
    );

    const request = sentRequest();
    expect(request.text).toBe(text);
    expect(request.fileReferences).toEqual([promptReference]);
  });

  it('expands a prompt pill with an invalid offset via the indexOf fallback', async () => {
    const prompt = await saveWorkspacePrompt({
      workspaceId: WORKSPACE_ID,
      title: 'Sibling',
      content: 'Sibling body',
    });
    const displayPath = 'Prompt: Sibling';
    const text = `Use ${displayPath} now`;
    const sibling = {
      displayPath: 'notes.md',
      absolutePath: '/tmp/repo/notes.md',
    };
    const context = makeContext();

    await handlePortalChatSend(
      makeCommand({
        projectId: WORKSPACE_ID,
        worktreeId: 'wt-1',
        text,
        // A non-integer `textStart` is dropped by the wire sanitizer, so the
        // expansion must land through the ordered indexOf fallback instead of
        // slicing at NaN; the sibling reference passes through untouched.
        fileReferences: [
          wireReference(sibling),
          wireReference(
            {
              displayPath,
              absolutePath: prompt.absolutePath,
              kind: 'prompt',
            },
            Number.NaN,
          ),
        ],
      }),
      context,
    );

    const request = sentRequest();
    expect(request.text).toBe('Use Sibling body now');
    expect(request.fileReferences).toEqual([sibling]);
  });

  it('passes non-prompt references through without touching the text', async () => {
    const fileReference = {
      displayPath: 'README.md',
      absolutePath: '/tmp/repo/README.md',
    };
    const context = makeContext();

    await handlePortalChatSend(
      makeCommand({
        projectId: WORKSPACE_ID,
        worktreeId: 'wt-1',
        text: 'Look at README.md please',
        fileReferences: [wireReference(fileReference)],
      }),
      context,
    );

    const request = sentRequest();
    expect(request.text).toBe('Look at README.md please');
    expect(request.fileReferences).toEqual([fileReference]);
  });
});
