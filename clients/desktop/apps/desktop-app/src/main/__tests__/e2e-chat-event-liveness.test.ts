import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { transpileModule } from 'typescript';

// Exercise the installed ingress without booting unrelated Electron services.
function ingressHarness(): {
  ingress: (event: unknown) => Promise<void>;
  ingest: jest.Mock;
  send: jest.Mock;
  liveness: jest.Mock;
} {
  const source = readFileSync(join(__dirname, '../index.ts'), 'utf8');
  const start = source.indexOf(
    'Object.defineProperty(globalThis, E2E_CHAT_EVENT_INGESTOR_KEY,',
  );
  const end = source.indexOf('Object.defineProperty(globalThis,', start + 1);
  const ingest = jest.fn().mockResolvedValue('applied');
  const send = jest.fn();
  const liveness = jest.fn().mockReturnValue({
    kind: 'known',
    liveParentToolUseIds: ['parent-agent'],
    hasUncorrelatedLiveTask: false,
  });
  const globals: { ingress?: (event: unknown) => Promise<void> } = {};
  runInNewContext(transpileModule(source.slice(start, end), {}).outputText, {
    globalThis: globals,
    E2E_CHAT_EVENT_INGESTOR_KEY: 'ingress',
    applyE2eIngestedLiveBackgroundTaskEvent: jest.fn(),
    getChildToolLiveness: liveness,
    CHILD_TOOL_LIVENESS_STAMP: 'canopy_child_tool_liveness',
    readChildToolLivenessStamp: (data: Record<string, unknown>) =>
      data.canopy_child_tool_liveness,
    isRecord: (value: unknown) => value !== null && typeof value === 'object',
    getChatStateService: () => ({ ingestProviderEventWithOutcome: ingest }),
    randomUUID: () => 'event-id',
    mainWindow: { webContents: {} },
    sendToWebContents: send,
    IPC_CHANNELS: { chatEvent: 'chat:event' },
  });
  if (!globals.ingress) throw new Error('E2E ingress was not installed');
  return { ingress: globals.ingress, ingest, send, liveness };
}

describe('E2E Claude terminal liveness ingress', () => {
  it.each([{ type: 'result' }, { type: 'error', error: 'failed' }])(
    'stamps $type before canonical ingestion and renderer delivery',
    async (data) => {
      const { ingress, ingest, send, liveness } = ingressHarness();
      await ingress({
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        providerType: 'claude',
        data,
      });
      expect(liveness).toHaveBeenCalledWith('project', 'worktree', 'chat');
      const stamped = {
        ...data,
        canopy_child_tool_liveness: {
          kind: 'known',
          liveParentToolUseIds: ['parent-agent'],
          hasUncorrelatedLiveTask: false,
        },
      };
      expect(ingest).toHaveBeenCalledWith(
        expect.objectContaining({ data: stamped }),
      );
      expect(send).toHaveBeenCalledWith(
        {},
        'chat:event',
        expect.objectContaining({ data: stamped }),
      );
    },
  );

  it.each([
    {
      providerType: 'claude',
      data: { type: 'result', canopy_session_continues: true },
    },
    { providerType: 'codex', data: { type: 'error', error: 'failed' } },
    { providerType: 'claude', data: { type: 'assistant' } },
  ])('does not stamp nonterminal/other-provider events: %o', async (event) => {
    const { ingress, ingest, liveness } = ingressHarness();
    await ingress({ projectId: 'p', worktreeId: 'w', chatId: 'c', ...event });
    expect(liveness).not.toHaveBeenCalled();
    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({ data: event.data }),
    );
  });

  it('preserves a previously stamped terminal on redelivery', async () => {
    const { ingress, ingest, liveness } = ingressHarness();
    const data = {
      type: 'result',
      canopy_child_tool_liveness: { kind: 'no-live-session' },
    };
    await ingress({ projectId: 'p', worktreeId: 'w', chatId: 'c', data });
    expect(liveness).not.toHaveBeenCalled();
    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({ data }));
  });
});
