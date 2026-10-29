import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TranscriptTooLargeError,
  projectClaudeTranscriptFile,
  projectCodexRolloutFile,
  projectCodexRolloutRecords,
} from '../chat-projection';

function jsonl(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n';
}

describe('projectClaudeTranscriptFile', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-projection-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('projects user, assistant, and tool records and reads the provider title', async () => {
    const filePath = join(root, 's1.jsonl');
    await writeFile(
      filePath,
      jsonl([
        { type: 'queue-operation', operation: 'enqueue', sessionId: 's1' },
        {
          type: 'user',
          uuid: 'u1',
          timestamp: '2026-09-01T00:00:00.000Z',
          cwd: '/Users/me/app',
          sessionId: 's1',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'Fix the bug' }],
          },
        },
        { type: 'ai-title', aiTitle: 'Bug fix', sessionId: 's1' },
        {
          type: 'assistant',
          uuid: 'a1',
          timestamp: '2026-09-01T00:00:05.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'On it.' },
              {
                type: 'tool_use',
                id: 'tool-1',
                name: 'Read',
                input: { file_path: 'x.ts' },
              },
            ],
          },
        },
        {
          type: 'user',
          uuid: 'r1',
          timestamp: '2026-09-01T00:00:06.000Z',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool-1',
                content: 'file body',
              },
            ],
          },
        },
        {
          type: 'user',
          uuid: 'side',
          isSidechain: true,
          timestamp: '2026-09-01T00:00:07.000Z',
          message: { role: 'user', content: 'subagent prompt' },
        },
      ]),
    );
    const projected = await projectClaudeTranscriptFile(filePath);
    expect(projected.title).toBe('Bug fix');
    expect(projected.firstTimestamp).toBe(
      Date.parse('2026-09-01T00:00:00.000Z'),
    );
    expect(
      projected.messages.map((message) => [message.id, message.role]),
    ).toEqual([
      ['u1', 'user'],
      ['a1', 'assistant'],
      ['r1', 'system'],
    ]);
    expect(projected.messages[1]?.blocks.map((block) => block.type)).toEqual([
      'text',
      'tool_use',
    ]);
  });

  it('extracts inline base64 attachments to files instead of embedding them as text', async () => {
    const filePath = join(root, 'image.jsonl');
    const payload = Buffer.from('fake-png-bytes').toString('base64');
    await writeFile(
      filePath,
      jsonl([
        {
          type: 'user',
          uuid: 'u1',
          timestamp: '2026-09-01T00:00:00.000Z',
          cwd: '/Users/me/app',
          sessionId: 's1',
          message: {
            role: 'user',
            content: [
              { type: 'text', text: 'What is in this image?' },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: payload,
                },
              },
            ],
          },
        },
        {
          type: 'user',
          uuid: 'u2',
          timestamp: '2026-09-01T00:00:01.000Z',
          message: {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: payload,
                },
              },
            ],
          },
        },
      ]),
    );
    const attachmentsDir = join(root, 'attachments');
    const projected = await projectClaudeTranscriptFile(filePath, {
      attachmentsDir,
    });
    expect(projected.warnings).toEqual([]);
    expect(projected.messages).toHaveLength(2);
    const [withText, imageOnly] = projected.messages;
    expect(withText?.attachmentPaths).toHaveLength(1);
    expect(withText?.attachmentPaths?.[0]).toContain(attachmentsDir);
    expect(JSON.stringify(withText?.blocks)).not.toContain(payload);
    // A text-free image turn survives as an attachment-only user message.
    expect(imageOnly?.role).toBe('user');
    expect(imageOnly?.attachmentPaths).toHaveLength(1);
    expect((await readdir(attachmentsDir)).length).toBeGreaterThan(0);

    // Without an attachments dir the payload is dropped, never embedded.
    const stripped = await projectClaudeTranscriptFile(filePath);
    expect(JSON.stringify(stripped.messages)).not.toContain(payload);
    expect(stripped.messages).toHaveLength(2);
  });

  it('refuses oversized transcripts without reading them', async () => {
    const filePath = join(root, 'big.jsonl');
    await writeFile(filePath, 'x'.repeat(100));
    await expect(
      projectClaudeTranscriptFile(filePath, { maxBytes: 10 }),
    ).rejects.toBeInstanceOf(TranscriptTooLargeError);
    await expect(
      projectCodexRolloutFile(filePath, { maxBytes: 10 }),
    ).rejects.toThrow(/above the 0 MB import limit/);
  });
});

describe('projectCodexRolloutRecords', () => {
  it('projects messages, reasoning, and tool calls while dropping injected context', () => {
    const projected = projectCodexRolloutRecords(
      [
        {
          timestamp: '2026-03-12T21:08:11.457Z',
          type: 'session_meta',
          payload: { id: 't1', cwd: '/Users/me/app' },
        },
        {
          timestamp: '2026-03-12T21:08:11.500Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'developer',
            content: [{ type: 'input_text', text: 'rules' }],
          },
        },
        {
          timestamp: '2026-03-12T21:08:12.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: '<environment_context>cwd</environment_context>\n\nAdd tests',
              },
            ],
          },
        },
        {
          timestamp: '2026-03-12T21:08:13.000Z',
          type: 'response_item',
          payload: {
            type: 'reasoning',
            summary: [{ type: 'summary_text', text: 'Plan the tests' }],
          },
        },
        {
          timestamp: '2026-03-12T21:08:14.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'shell',
            arguments: '{"cmd":"ls"}',
            call_id: 'call-1',
          },
        },
        {
          timestamp: '2026-03-12T21:08:15.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: 'call-1',
            output: { content: 'a.ts', metadata: { exit_code: 1 } },
          },
        },
        {
          timestamp: '2026-03-12T21:08:16.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Done.' }],
          },
        },
        {
          timestamp: '2026-03-12T21:08:17.000Z',
          type: 'event_msg',
          payload: {
            type: 'agent_message',
            message: 'ignored duplicate stream',
          },
        },
      ],
      'seed',
    );
    expect(projected.title).toBe('Add tests');
    expect(projected.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'assistant',
      'system',
      'assistant',
    ]);
    expect(projected.messages[0]?.blocks).toEqual([
      { type: 'text', text: 'Add tests' },
    ]);
    expect(projected.messages[1]?.blocks).toEqual([
      { type: 'thinking', text: 'Plan the tests' },
    ]);
    expect(projected.messages[2]?.blocks).toEqual([
      {
        type: 'tool_use',
        toolUseId: 'call-1',
        toolName: 'shell',
        input: '{"cmd":"ls"}',
      },
    ]);
    expect(projected.messages[3]?.blocks).toEqual([
      {
        type: 'tool_result',
        toolUseId: 'call-1',
        toolName: 'shell',
        output: 'a.ts',
        isError: true,
      },
    ]);
    expect(projected.messages[3]?.timestamp).toBe(
      Date.parse('2026-03-12T21:08:15.000Z'),
    );
  });

  it('reads a rollout file end to end', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-projection-'));
    try {
      const filePath = join(root, 'rollout.jsonl');
      await writeFile(
        filePath,
        jsonl([
          { type: 'session_meta', payload: { id: 't', cwd: '/x' } },
          {
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'Hello' }],
            },
          },
        ]) + '{"torn":',
      );
      const projected = await projectCodexRolloutFile(filePath);
      expect(projected.messages).toHaveLength(1);
      expect(projected.title).toBe('Hello');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
