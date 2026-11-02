import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatTranscriptArtifacts } from '../../lib/chat-transcript-artifacts';
import type { TranscriptFieldPreparation } from '../chat-state-contracts';
import { prepareCodexItemFields } from '../chat-transcript-field-preparation';
import type { PersistedToolOutputReference } from '@canopy/agent-transcript/types';

describe('Codex prepared output needsRead metadata', () => {
  let root: string;
  let artifacts: ChatTranscriptArtifacts;
  let publishCalls: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-field-needs-read-'));
    artifacts = new ChatTranscriptArtifacts(root);
    publishCalls = 0;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function fieldPort(): TranscriptFieldPreparation {
    return {
      format: 4,
      publish: async (
        chatId,
        chunks,
      ): Promise<PersistedToolOutputReference> => {
        publishCalls += 1;
        let output = '';
        for await (const chunk of chunks) output += chunk;
        return artifacts.put(chatId, output);
      },
    };
  }

  function dynamicToolEvent(
    itemId: string,
    text: string,
    onContentRead?: () => void,
  ): Record<string, unknown> {
    const item: Record<string, unknown> = {
      id: itemId,
      type: 'dynamic_tool_call',
      tool: 'read_file',
      status: 'completed',
      success: true,
    };
    Object.defineProperty(item, 'content_items', {
      enumerable: true,
      get: (): unknown => {
        onContentRead?.();
        return [{ type: 'inputText', text }];
      },
    });
    return { type: 'item.completed', thread_id: 'thread-1', item };
  }

  it('uses the traversed body length and stored reference without rereading it', async () => {
    const port = fieldPort();
    const short = await prepareCodexItemFields(
      port,
      'chat-1',
      dynamicToolEvent('short', 'x'.repeat(4_000)),
    );
    expect(short?.output).not.toHaveProperty('needsRead');

    let contentReads = 0;
    const inlineLong = await prepareCodexItemFields(
      port,
      'chat-1',
      dynamicToolEvent('inline-long', 'x'.repeat(4_001), () => {
        contentReads += 1;
        if (contentReads > 1) throw new Error('Codex output was reread');
      }),
    );
    expect(inlineLong).toMatchObject({ output: { needsRead: true } });
    expect(contentReads).toBe(1);

    const stored = await prepareCodexItemFields(
      port,
      'chat-1',
      dynamicToolEvent('stored', 'x'.repeat(80_000)),
    );
    expect(stored).toMatchObject({ output: { needsRead: true } });
    expect(stored?.output.field).toBe('output');
    if (stored?.output.field === 'output') {
      expect(stored.output.fullOutputRef).toBeDefined();
    }
    expect(publishCalls).toBe(1);
  });
});
