import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PersistedChatBlock } from '@canopy/agent-transcript/types';
import {
  ChatTranscriptArtifacts,
  toolResultNeedsRead,
} from '../chat-transcript-artifacts';

type ToolResultBlock = Extract<PersistedChatBlock, { type: 'tool_result' }>;

function toolResult(output: string): ToolResultBlock {
  return {
    type: 'tool_result',
    toolUseId: 'call-1',
    toolName: 'read_file',
    output,
    isError: false,
  };
}

describe('toolResultNeedsRead', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-artifact-needs-read-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('uses pre-shortening UTF-16 code-unit length at the Portal preview bound', () => {
    expect(toolResultNeedsRead(toolResult('x'.repeat(4_000)))).toBe(false);
    expect(toolResultNeedsRead(toolResult('x'.repeat(4_001)))).toBe(true);
  });

  it('treats stored-apart output as readable without accessing its preview body', async () => {
    const reference = await new ChatTranscriptArtifacts(root).put(
      'chat-1',
      'stored output',
    );
    let outputReads = 0;
    const block: ToolResultBlock = {
      type: 'tool_result',
      toolUseId: 'call-1',
      toolName: 'read_file',
      isError: false,
      fullOutputRef: reference,
      get output(): string {
        outputReads += 1;
        return 'stored preview';
      },
    };

    expect(toolResultNeedsRead(block)).toBe(true);
    expect(outputReads).toBe(0);
  });

  it('measures only the already-normalized output field', () => {
    const output = 'x'.repeat(4_001);
    let outputReads = 0;
    const block: ToolResultBlock = {
      type: 'tool_result',
      toolUseId: 'call-1',
      toolName: 'read_file',
      isError: false,
      get output(): string {
        outputReads += 1;
        return output;
      },
    };

    expect(toolResultNeedsRead(block)).toBe(true);
    expect(outputReads).toBe(1);
  });
});
