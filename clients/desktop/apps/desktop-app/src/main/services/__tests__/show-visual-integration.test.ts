import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PersistedVisualReference } from '@canopy/agent-transcript/types';
import { CANOPY_INJECTED_TOOL_REGISTRY } from '@canopy/desktop-shared/lib/canopy-injected-tools';
import { cursorCanopyMcpServerNames } from '@canopy/desktop-shared/lib/cursor-mcp-tool-call';
import { CursorEventProjection } from '@canopy/desktop-shared/node/cursor/events';
import type {
  ChatCommand,
  ChatCommandEnvelope,
} from '@canopy/desktop-shared/types';
import { createDesktopRuntime } from '../../canopy-runtime/desktop-runtime';
import {
  executeShowVisual,
  type ShowVisualHost,
} from '../../canopy-tools/show-visual-runtime';
import { ChatQueueService, getChatQueueService } from '../chat-queue-service';
import type * as ChatQueueServiceModule from '../chat-queue-service';
import { ChatStateService } from '../chat-state-service';
import { ChatStateV2Repository } from '../chat-state-v2-repository';
import {
  hasTrustedVisualToolUse,
  isTrustedCursorShowVisualInvocation,
  openTurnLedger,
} from '../visual-tool-identity';

jest.mock('../../observability', () => ({
  getObservabilityService: (): { observeSteeringInput: jest.Mock } => ({
    observeSteeringInput: jest.fn(),
  }),
}));
jest.mock('../chat-queue-service', (): typeof ChatQueueServiceModule => {
  const actual = jest.requireActual<typeof ChatQueueServiceModule>(
    '../chat-queue-service',
  );
  return { ...actual, getChatQueueService: jest.fn() };
});
jest.mock('../../integration/claude-terminal-session-service', () => ({
  getClaudeTerminalSessionService: (): { getState: () => undefined } => ({
    getState: (): undefined => undefined,
  }),
}));
jest.mock('../../lib/usage-limited-chats-registry', () => ({
  recordInterruptedChats: (): Promise<void> => Promise.resolve(),
}));
jest.mock('../../lib/model-policy-state', () => ({
  isModelBlockedByStoredPolicy: (): Promise<boolean> => Promise.resolve(false),
}));

const SCOPE = { projectId: 'workspace-1', worktreeId: 'worktree-1' };
const CHAT_ID = 'chat-1';
const TARGET = { ...SCOPE, chatId: CHAT_ID };
const SHOW_VISUAL = CANOPY_INJECTED_TOOL_REGISTRY.show_visual;
const CLAUDE_NAME = SHOW_VISUAL.claudeToolName;
const CODEX_NAME = SHOW_VISUAL.codexToolName;
const caller = {
  principalId: 'test-user',
  clientInstanceId: 'test-client',
  authorityId: 'local-desktop',
  interfaceKind: 'test' as const,
  grants: ['core.chat.read'],
};
const HTML = '﻿<!doctype html><title>Chart</title><p>Throughput — 42 ✓</p>';
const PREPARED = HTML.slice(1);

function envelope<T extends ChatCommand>(
  commandId: string,
  command: T,
): ChatCommandEnvelope<T> {
  return { schemaVersion: 1, commandId, ...SCOPE, command };
}

function requireName(name: string | undefined): string {
  if (!name) throw new Error('ShowVisual provider name is missing');
  return name;
}

function tokenOf(text: string): string {
  const token = text.split(' ', 1)[0];
  if (!token?.startsWith('vis_')) throw new Error(`No visual token: ${text}`);
  return token;
}

describe('ShowVisual end to end', () => {
  let tempDir: string;
  let repository: ChatStateV2Repository;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'canopy-show-visual-'));
    jest.mocked(getChatQueueService).mockReturnValue(new ChatQueueService());
  });

  afterEach(async () => {
    await repository.drainAll();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function createService(): Promise<ChatStateService> {
    repository = new ChatStateV2Repository({
      resolvePaths: (): {
        tabs: string;
        archives: string;
        journal: string;
      } => ({
        tabs: join(tempDir, 'chats.json'),
        archives: join(tempDir, 'archives.json'),
        journal: join(tempDir, 'journal.jsonl'),
      }),
    });
    const service = new ChatStateService({
      repository,
      now: (): number => 1_786_104_000_000,
      createId: (): string => 'event-id',
      dispatch: (): Promise<void> => Promise.resolve(),
      steer: (): Promise<boolean> => Promise.resolve(false),
      onInputPickup: (): Promise<undefined> => Promise.resolve(undefined),
      authorizeSend: (): Promise<undefined> => Promise.resolve(undefined),
      cleanupSession: (): Promise<void> => Promise.resolve(),
      recordDiagnostic: jest.fn(),
      claudeToolNames: new Set([requireName(CLAUDE_NAME)]),
      codexToolNames: new Set([requireName(CODEX_NAME)]),
      cursorToolUse: hasTrustedVisualToolUse,
    });
    await expect(
      service.command(
        envelope('create-1', {
          type: 'chat.create_tab',
          tabId: CHAT_ID,
          title: 'Visual chat',
          providerType: 'claude',
          model: 'claude-opus-4-6',
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'applied' });
    return service;
  }

  function host(
    service: ChatStateService,
    codexCallId?: string,
    heights?: ReadonlyArray<readonly [number, number]>,
  ): ShowVisualHost {
    return {
      scope: SCOPE,
      chatId: CHAT_ID,
      cwd: tempDir,
      stageVisual: (document) =>
        service.stageVisual(SCOPE, { chatId: CHAT_ID }, document),
      ...(heights
        ? {
            measureVisual: () =>
              Promise.resolve({ status: 'ok' as const, heights }),
          }
        : {}),
      ...(codexCallId ? { codexCallId } : {}),
    };
  }

  async function show(
    service: ChatStateService,
    codexCallId?: string,
  ): Promise<string> {
    const result = await executeShowVisual(
      { html: HTML, title: 'Throughput', height: 360 },
      host(service, codexCallId),
    );
    expect(result.isError).toBeFalsy();
    return result.text;
  }

  async function visualReference(messageId?: string): Promise<
    | {
        messageId: string;
        toolUseId: string;
        reference: PersistedVisualReference;
      }
    | undefined
  > {
    const state = await repository.getState(SCOPE, { chatIds: [CHAT_ID] });
    const tab = state.tabsFile.tabs.find(
      (candidate) => candidate.id === CHAT_ID,
    );
    for (const message of tab?.messages ?? []) {
      if (messageId && message.id !== messageId) continue;
      for (const block of message.blocks) {
        if (block.type === 'tool_result' && block.visualRef)
          return {
            messageId: message.id,
            toolUseId: block.toolUseId,
            reference: block.visualRef,
          };
      }
    }
    return undefined;
  }

  async function readRange(
    service: ChatStateService,
    owned: {
      messageId: string;
      toolUseId: string;
      reference: PersistedVisualReference;
    },
    offset: number,
    limit: number,
  ): Promise<{ bytes: Buffer; sha256: string }> {
    const dispatcher = createDesktopRuntime({
      chatServices: { getPort: () => service },
    });
    const result = await dispatcher.query(
      'core.chat.visual.read',
      {
        scope: {
          workspaceId: SCOPE.projectId,
          worktreeId: SCOPE.worktreeId,
          chatId: CHAT_ID,
        },
        messageId: owned.messageId,
        toolUseId: owned.toolUseId,
        reference: owned.reference,
        offset,
        limit,
      },
      { caller },
    );
    return { bytes: Buffer.from(result.data, 'base64'), sha256: result.sha256 };
  }

  async function expectReadsBack(
    service: ChatStateService,
    visualId: string,
  ): Promise<void> {
    const owned = await visualReference();
    expect(owned?.reference).toMatchObject({
      visualId,
      title: 'Throughput',
      maxHeight: 360,
      byteLength: Buffer.byteLength(PREPARED),
    });
    if (!owned) return;
    // Read in two ranges that split a multibyte character.
    const split = Buffer.from(PREPARED).indexOf(Buffer.from('—')) + 1;
    const first = await readRange(service, owned, 0, split);
    const second = await readRange(
      service,
      owned,
      split,
      owned.reference.byteLength - split,
    );
    expect(Buffer.concat([first.bytes, second.bytes]).toString('utf8')).toBe(
      PREPARED,
    );
    expect(second.sha256).toBe(owned.reference.sha256);
    expect(createHash('sha256').update(PREPARED).digest('hex')).toBe(
      owned.reference.sha256,
    );
  }

  async function claudeCall(
    service: ChatStateService,
    options: {
      toolName: string | undefined;
      output: string;
      id?: string;
      isError?: boolean;
      providerType?: string;
      chatId?: string;
    },
  ): Promise<void> {
    const id = options.id ?? 'claude-call';
    for (const [mutationId, data] of [
      [
        `${id}-use`,
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id,
                name: options.toolName,
                input: { title: 'Throughput' },
              },
            ],
          },
        },
      ],
      [
        `${id}-result`,
        {
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: id,
                content: options.output,
                is_error: options.isError ?? false,
              },
            ],
          },
        },
      ],
    ] as const) {
      await service.ingestProviderEvent({
        ...SCOPE,
        chatId: options.chatId ?? CHAT_ID,
        providerType: options.providerType ?? 'claude',
        mutationId,
        data,
      });
    }
  }

  function codexCompleted(
    callId: string,
    output: string,
    sequence = 1,
  ): Record<string, unknown> {
    return {
      type: 'codex',
      event: {
        type: 'item.completed',
        item: {
          id: callId,
          type: 'dynamic_tool_call',
          tool: CODEX_NAME,
          arguments: { title: 'Throughput' },
          status: 'completed',
          success: true,
          content_items: [{ type: 'inputText', text: output }],
        },
        sequence,
      },
    };
  }

  describe('Claude', () => {
    it('promotes measured heights without changing token or digest', async () => {
      const service = await createService();
      const heights: ReadonlyArray<readonly [number, number]> = [
        [360, 180],
        [520, 210],
        [720, 260],
        [960, 320],
      ];
      const result = await executeShowVisual(
        { html: HTML, title: 'Throughput', height: 360 },
        host(service, undefined, heights),
      );
      expect(result.isError).toBeUndefined();
      await claudeCall(service, { toolName: CLAUDE_NAME, output: result.text });
      const owned = await visualReference();
      expect(owned?.reference.heights).toEqual(heights);
      await expectReadsBack(service, tokenOf(result.text));
    });

    it('promotes the result and reads it back byte-identical in ranges', async () => {
      const service = await createService();
      const output = await show(service);
      await claudeCall(service, { toolName: CLAUDE_NAME, output });
      await expectReadsBack(service, tokenOf(output));
    });

    it('keeps one owner and the same reference when the result is re-reported', async () => {
      const service = await createService();
      const output = await show(service);
      await claudeCall(service, { toolName: CLAUDE_NAME, output });
      const first = await visualReference();
      await claudeCall(service, { toolName: CLAUDE_NAME, output });
      await claudeCall(service, {
        toolName: CLAUDE_NAME,
        output,
        id: 'claude-second-call',
      });
      const state = await repository.getState(SCOPE, { chatIds: [CHAT_ID] });
      const owners = state.tabsFile.tabs
        .find((tab) => tab.id === CHAT_ID)
        ?.messages.flatMap((message) => message.blocks)
        .filter((block) => block.type === 'tool_result' && block.visualRef);
      expect(owners).toHaveLength(1);
      expect((await visualReference())?.reference).toEqual(first?.reference);
    });

    it.each([
      ['a tool named only ShowVisual', { toolName: 'ShowVisual' }],
      ['an echo from another tool', { toolName: 'Read' }],
      ['an error result', { toolName: CLAUDE_NAME, isError: true }],
    ])('does not promote %s', async (_case, options) => {
      const service = await createService();
      const output = await show(service);
      await claudeCall(service, { ...options, output });
      expect(await visualReference()).toBeUndefined();
    });
  });

  describe('Codex', () => {
    it('promotes a dynamic tool result bound to its native call id', async () => {
      const service = await createService();
      const output = await show(service, 'codex-call');
      await service.ingestProviderEvent({
        ...TARGET,
        providerType: 'codex',
        mutationId: 'codex-completed',
        data: codexCompleted('codex-call', output),
      });
      await expectReadsBack(service, tokenOf(output));
    });

    it('does not promote a result from a different call id', async () => {
      const service = await createService();
      const output = await show(service, 'codex-call');
      await service.ingestProviderEvent({
        ...TARGET,
        providerType: 'codex',
        mutationId: 'codex-other',
        data: codexCompleted('other-call', output),
      });
      expect(await visualReference()).toBeUndefined();
    });
  });

  describe('Cursor', () => {
    const main = cursorCanopyMcpServerNames().main;
    const trustedInput = {
      providerIdentifier: main,
      toolName: 'ShowVisual',
      args: { title: 'Throughput' },
    };

    async function runCursorCall(
      service: ChatStateService,
      options: {
        rawInput: unknown;
        title: string;
        failed?: boolean;
        ledgerChatId?: string;
        providerType?: string;
      },
    ): Promise<void> {
      const output = await show(service);
      const ledger = openTurnLedger({
        ...SCOPE,
        chatId: options.ledgerChatId ?? CHAT_ID,
      });
      const projection = new CursorEventProjection(undefined, {
        onToolInvocation: (invocation): void => {
          if (
            isTrustedCursorShowVisualInvocation(invocation, {
              serverMode: 'default',
              appToolsReachedCli: true,
              toolSurface: 'cursor-acp',
            })
          )
            ledger.record(invocation.toolUseId);
          else ledger.forget(invocation.toolUseId);
        },
      });
      try {
        let revision = 0;
        for (const update of [
          {
            sessionUpdate: 'tool_call' as const,
            toolCallId: 'acp-1',
            title: options.title,
            kind: 'other' as const,
            status: 'pending' as const,
            rawInput: options.rawInput,
          },
          {
            sessionUpdate: 'tool_call_update' as const,
            toolCallId: 'acp-1',
            status: options.failed
              ? ('failed' as const)
              : ('completed' as const),
            rawOutput: { content: [{ type: 'text', text: output }] },
          },
        ]) {
          const patch = projection.update({
            sessionId: 'cursor-session',
            update,
          });
          if (!patch) continue;
          revision += 1;
          await service.ingestProviderEvent({
            ...TARGET,
            providerType: options.providerType ?? 'cursor',
            mutationId: `cursor-${revision}`,
            data: patch,
          });
        }
      } finally {
        ledger.close();
      }
    }

    it('promotes a call the session recorded from structured input', async () => {
      const service = await createService();
      await runCursorCall(service, {
        rawInput: trustedInput,
        title: `${main}: ShowVisual`,
      });
      const owned = await visualReference();
      expect(owned).toBeDefined();
      if (owned) await expectReadsBack(service, owned.reference.visualId);
    });

    it.each([
      ['a call identified only by its title', { rawInput: undefined }],
      [
        'a call whose title and input disagree',
        { rawInput: trustedInput, title: `${main}: ShowFiles` },
      ],
      ['a call recorded for another chat', { ledgerChatId: 'chat-2' }],
      ['a failed call', { failed: true }],
      ['a Copilot event', { providerType: 'copilot' }],
    ])('does not promote %s', async (_case, overrides) => {
      const service = await createService();
      await runCursorCall(service, {
        rawInput: trustedInput,
        title: `${main}: ShowVisual`,
        ...overrides,
      });
      expect(await visualReference()).toBeUndefined();
    });
  });
});
