import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  codexDynamicToolOutput,
  codexMcpToolResult,
  type PreparedCodexItem,
} from '@canopy/agent-transcript';
import type {
  PersistedChatMessage,
  PersistedToolOutputReference,
} from '@canopy/agent-transcript/types';
import { ChatTranscriptArtifacts } from '../../lib/chat-transcript-artifacts';
import type { TranscriptFieldPreparation } from '../chat-state-contracts';
import {
  prepareCodexItemFields,
  transcriptFieldPreviewFromEnds,
} from '../chat-transcript-field-preparation';

const pair = '\u{1F600}';

interface RecordingPort extends TranscriptFieldPreparation {
  calls: { chatId: string; chunks: string[] }[];
}

/** Stub port: records chunks and returns the real artifact reference. */
function recordingPort(artifacts: ChatTranscriptArtifacts): RecordingPort {
  const calls: RecordingPort['calls'] = [];
  return {
    format: 4,
    calls,
    publish: async (chatId, chunks): Promise<PersistedToolOutputReference> => {
      const received: string[] = [];
      for await (const chunk of chunks) received.push(chunk);
      calls.push({ chatId, chunks: received });
      return artifacts.put(chatId, received.join(''));
    },
  };
}

/**
 * Port that measures the event loop only while it consumes the chunk stream,
 * so artifact hashing and file writes cannot hide synchronous serialization.
 */
function heartbeatPort(): RecordingPort & {
  beats: () => number;
  maxGapMs: () => number;
} {
  const calls: RecordingPort['calls'] = [];
  let beats = 0;
  let maxGapMs = 0;
  return {
    format: 4,
    calls,
    beats: () => beats,
    maxGapMs: () => maxGapMs,
    publish: async (chatId, chunks): Promise<PersistedToolOutputReference> => {
      let running = true;
      let last = performance.now();
      const beat = (): void => {
        const now = performance.now();
        maxGapMs = Math.max(maxGapMs, now - last);
        last = now;
        beats += 1;
        if (running) setImmediate(beat);
      };
      setImmediate(beat);
      const received: string[] = [];
      try {
        for await (const chunk of chunks) received.push(chunk);
      } finally {
        running = false;
      }
      calls.push({ chatId, chunks: received });
      const joined = received.join('');
      const sha256 = '0'.repeat(64);
      return {
        version: 1,
        artifactId: `sha256-v1-${sha256}`,
        byteLength: Buffer.byteLength(joined),
        sha256,
        encoding: 'utf-8',
        mediaType: 'text/plain',
      };
    },
  };
}

function completed(item: Record<string, unknown>): Record<string, unknown> {
  return { type: 'item.completed', thread_id: 'thread-1', item };
}

function mcpEvent(
  id: string,
  result: unknown,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return completed({
    id,
    type: 'mcp_tool_call',
    server: 'server',
    tool: 'tool',
    status: 'completed',
    result,
    error: null,
    ...extra,
  });
}

describe('prepareCodexItemFields', () => {
  let root: string;
  let artifacts: ChatTranscriptArtifacts;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'canopy-field-preparation-'));
    artifacts = new ChatTranscriptArtifacts(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function body(reference: PersistedToolOutputReference): string {
    return readFileSync(
      join(root, 'tool-output', 'chat-1', `${reference.artifactId}.txt`),
      reference.encoding === 'utf-8' ? 'utf8' : 'utf16le',
    );
  }

  /** The legacy whole-string externalizer is the preview oracle. */
  async function legacyPreview(output: string): Promise<string> {
    const message: PersistedChatMessage = {
      id: 'oracle',
      role: 'system',
      timestamp: 1,
      blocks: [
        {
          type: 'tool_result',
          toolUseId: 'oracle',
          toolName: 'oracle',
          output,
          isError: false,
        },
      ],
    };
    const stored = await new ChatTranscriptArtifacts(
      mkdtempSync(join(tmpdir(), 'canopy-field-oracle-')),
    ).externalize('chat-1', message);
    const [block] = stored.blocks;
    if (block?.type !== 'tool_result') throw new Error('missing oracle');
    return block.output;
  }

  it('prepares nothing without a port or a final output body', async () => {
    const port = recordingPort(artifacts);
    const event = completed({
      id: 'fco',
      type: 'function_call_output',
      output: 'x'.repeat(100_000),
    });
    await expect(
      prepareCodexItemFields(undefined, 'chat-1', event),
    ).resolves.toBeUndefined();
    for (const other of [
      { ...event, type: 'item.updated' },
      completed({ id: 'msg', type: 'agent_message', text: 'x' }),
      completed({ type: 'function_call_output', output: 'x' }),
      'not an event',
    ])
      await expect(
        prepareCodexItemFields(port, 'chat-1', other),
      ).resolves.toBeUndefined();
    expect(port.calls).toHaveLength(0);
  });

  it('keeps a small body inline without publishing', async () => {
    const port = recordingPort(artifacts);
    await expect(
      prepareCodexItemFields(
        port,
        'chat-1',
        completed({
          id: 'fco',
          type: 'function_call_output',
          name: 'tool',
          output: '42 passed',
        }),
      ),
    ).resolves.toEqual({
      itemId: 'fco',
      output: { field: 'text', text: 'Tool output (tool)\n\n42 passed' },
    });
    expect(port.calls).toHaveLength(0);
  });

  it('publishes a >64 KiB function_call_output whose middle sentinel survives', async () => {
    const port = recordingPort(artifacts);
    const sentinel = 'prepared-middle-sentinel';
    const output = `${'a'.repeat(80_000)}${sentinel}${'b'.repeat(80_000)}`;
    const prepared = await prepareCodexItemFields(
      port,
      'chat-1',
      completed({
        id: 'fco',
        type: 'function_call_output',
        name: 'tool',
        output,
      }),
    );
    const whole = `Tool output (tool)\n\n${output}`;
    if (prepared?.output.field !== 'text' || !prepared.output.textRef)
      throw new Error('missing reference');
    expect(body(prepared.output.textRef) === whole).toBe(true);
    expect(prepared.output.text === (await legacyPreview(whole))).toBe(true);
    expect(prepared.output.text.includes(sentinel)).toBe(false);
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0].chunks.join('') === whole).toBe(true);
  });

  it.each([
    ['ascii', 'x'.repeat(200_000)],
    ['multibyte', `${'é'.repeat(30_000)}${pair.repeat(30_000)}é`],
    ['pair at head edge', `${'x'.repeat(49_151)}${pair}${'y'.repeat(70_000)}`],
    ['pair at tail edge', `${'x'.repeat(70_000)}${pair}${'y'.repeat(16_349)}`],
    ['lone surrogates', `\uDC00${'x'.repeat(70_000)}\uD800${'y'.repeat(20)}`],
    ['final lone high', `${pair.repeat(20_000)}\uD83D`],
    ['three-byte tail', `${'x'.repeat(70_000)}${'€'.repeat(30_000)}`],
  ])(
    'matches the whole-string preview and reference: %s',
    async (_name, text) => {
      const port = recordingPort(artifacts);
      const prepared = await prepareCodexItemFields(
        port,
        'chat-1',
        completed({
          id: 'dyn',
          type: 'dynamic_tool_call',
          tool: 'tool',
          status: 'completed',
          success: true,
          content_items: [{ type: 'inputText', text }],
        }),
      );
      if (prepared?.output.field !== 'output' || !prepared.output.fullOutputRef)
        throw new Error('missing reference');
      expect(prepared.output.output === (await legacyPreview(text))).toBe(true);
      expect(prepared.output.fullOutputRef).toEqual(
        await artifacts.put('chat-1', text),
      );
      expect(body(prepared.output.fullOutputRef) === text).toBe(true);
    },
  );

  it('computes the preview from its ends like the whole-string builder', async () => {
    const text = `${'é'.repeat(60_000)}${pair.repeat(40_000)}`;
    expect(
      transcriptFieldPreviewFromEnds(
        text.slice(0, 49_154),
        text.slice(-65_538),
      ) === (await legacyPreview(text)),
    ).toBe(true);
  });

  it('streams an 8 MiB structured-only MCP result cooperatively', async () => {
    const structuredContent = {
      rows: Array.from({ length: 64 * 1024 }, (_, index) => ({
        index,
        label: `row-${index}-${'v'.repeat(96)}`,
        _meta: { hidden: true },
      })),
    };
    const event = mcpEvent('mcp-8mib', { structuredContent });
    const expected = codexMcpToolResult({
      status: 'completed',
      result: { structuredContent, content: undefined },
      error: null,
    }).output;
    expect(expected.length).toBeGreaterThan(8 * 1024 * 1024);

    const port = heartbeatPort();
    const prepared: PreparedCodexItem | undefined =
      await prepareCodexItemFields(port, 'chat-1', event);
    expect(port.beats()).toBeGreaterThan(16);
    expect(port.maxGapMs()).toBeLessThan(250);
    expect(port.calls).toHaveLength(1);
    const { chunks } = port.calls[0];
    expect(
      Math.max(...chunks.map((chunk) => chunk.length)),
    ).toBeLessThanOrEqual(65_536);
    expect(chunks.length).toBeGreaterThan(100);
    expect(chunks.join('') === expected).toBe(true);
    if (prepared?.output.field !== 'output' || !prepared.output.fullOutputRef)
      throw new Error('missing reference');
    expect(Buffer.byteLength(prepared.output.output)).toBeLessThanOrEqual(
      65_536,
    );
    expect(prepared.output.output).not.toContain('_meta');
  });

  it('escapes a giant structured scalar in bounded chunks cooperatively', async () => {
    const scalar = `"\\\n${'q"'.repeat(2 * 1024 * 1024)}\u2028${pair}`;
    const event = mcpEvent('mcp-scalar', { structuredContent: scalar });
    const port = heartbeatPort();
    await prepareCodexItemFields(port, 'chat-1', event);
    expect(port.beats()).toBeGreaterThan(16);
    expect(port.maxGapMs()).toBeLessThan(250);
    const { chunks } = port.calls[0];
    expect(
      Math.max(...chunks.map((chunk) => chunk.length)),
    ).toBeLessThanOrEqual(65_536);
    expect(chunks.join('') === JSON.stringify(scalar)).toBe(true);
  });

  it('publishes the synchronous fallback for an unreadable value', async () => {
    const port = recordingPort(artifacts);
    const text = 't'.repeat(70_000);
    const contentItems = [
      { type: 'inputText', text },
      {
        type: 'inputText',
        get text(): string {
          throw new Error('unreadable');
        },
      },
    ];
    // Dynamic results read every item eagerly, so this one throws in both
    // forms. An MCP structured getter throws only in the chunked form.
    expect(() =>
      codexDynamicToolOutput({ contentItems, success: true }),
    ).toThrow('unreadable');
    const result = {
      content: [{ type: 'text', text }],
    };
    const structured = {
      ok: 'x'.repeat(70_000),
      get broken(): unknown {
        throw new Error('unreadable');
      },
    };
    const fallback = await prepareCodexItemFields(
      port,
      'chat-1',
      mcpEvent('mcp-getter', {
        content: [{ type: 'custom', value: structured }],
      }),
    );
    expect(fallback?.output).toEqual({
      field: 'output',
      output: codexMcpToolResult({
        status: 'completed',
        result: { content: [{ type: 'custom', value: structured }] },
        error: null,
      }).output,
    });
    const normal = await prepareCodexItemFields(
      port,
      'chat-1',
      mcpEvent('mcp-text', result),
    );
    if (normal?.output.field !== 'output' || !normal.output.fullOutputRef)
      throw new Error('missing reference');
    expect(body(normal.output.fullOutputRef) === text).toBe(true);
  });

  it('stops on abort without a fallback', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      prepareCodexItemFields(
        recordingPort(artifacts),
        'chat-1',
        mcpEvent('mcp-abort', { content: [{ type: 'text', text: 'x' }] }),
        { signal: controller.signal },
      ),
    ).rejects.toThrow();
  });

  it('rejects a port reference that does not match the streamed body', async () => {
    const real = recordingPort(artifacts);
    const lying: TranscriptFieldPreparation = {
      format: 4,
      publish: async (
        chatId,
        chunks,
      ): Promise<PersistedToolOutputReference> => {
        await real.publish(chatId, chunks);
        return artifacts.put(chatId, 'different');
      },
    };
    await expect(
      prepareCodexItemFields(
        lying,
        'chat-1',
        mcpEvent('mcp-lie', {
          content: [{ type: 'text', text: 'z'.repeat(70_000) }],
        }),
      ),
    ).rejects.toThrow('does not match');
    const lazy: TranscriptFieldPreparation = {
      format: 4,
      publish: async (chatId) => artifacts.put(chatId, 'z'.repeat(70_000)),
    };
    await expect(
      prepareCodexItemFields(
        lazy,
        'chat-1',
        mcpEvent('mcp-lazy', {
          content: [{ type: 'text', text: 'z'.repeat(70_000) }],
        }),
      ),
    ).rejects.toThrow('ended before its body');
  });
});
