import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DelegationChildRow } from '@canopy/agent-transcript';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import * as transcriptLog from '../lib/chat-transcript-log';
import { format4Scope } from './helpers/chat-format4-scope';
import { message, scopeSource } from './helpers/chat-delta-journal-harness';

jest.setTimeout(60_000);

describe('registered child artifact closure', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-child-artifact-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('scans a large child history in budgeted slices and keeps its artifacts', async () => {
    const { store, backend } = await format4Scope(
      root,
      'source',
      scopeSource([{ id: 'chat', messages: [message('parent', 'hello')] }]),
    );
    const target = {
      kind: 'delegation' as const,
      chatId: 'chat',
      delegationId: 'history',
      runGeneration: 0,
    };
    await backend.registerTranscriptStream(target);
    // About 1.6 MiB of committed child rows, plus one externalized tool output.
    const rows: DelegationChildRow[] = Array.from(
      { length: 200 },
      (_, index) => ({
        id: `agent:text-${index}`,
        role: 'assistant',
        timestamp: 2,
        parentBlockId: 'agent',
        delegationSequence: index,
        itemRevision: 0,
        final: true,
        blocks: [{ type: 'text', text: 'x'.repeat(8 * 1024) }],
      }),
    );
    rows.push({
      id: 'agent:tool',
      role: 'assistant',
      timestamp: 2,
      parentBlockId: 'agent',
      delegationSequence: 200,
      itemRevision: 0,
      final: true,
      blocks: [
        {
          type: 'tool_result',
          toolName: 'shell',
          toolUseId: 'call-1',
          output: 'kept body '.repeat(20_000),
          isError: false,
        },
      ],
    });
    await backend.commitChildStream(target, 'history', rows);
    await backend.flush();
    const artifactDirectory = join(
      store.directory,
      'transcripts',
      'tool-output',
      'chat',
    );
    const [kept] = await readdir(artifactDirectory);
    const orphan = `sha256-v1-${'0'.repeat(64)}.txt`;
    await writeFile(join(artifactDirectory, orphan), 'orphan');
    const fullReads = jest.spyOn(
      transcriptLog,
      'readCompleteTranscriptMessages',
    );
    const budget = 64 * 1024;
    const slices: number[] = [];
    for (let attempt = 0; attempt < 200; attempt++) {
      const progress = await backend.maintainArtifacts('chat', budget);
      slices.push(progress.scannedBytes);
      if (progress.complete) break;
    }
    // One full child pass would read ~1.6 MiB in a single call.
    expect(Math.max(...slices)).toBeLessThan(2 * budget);
    expect(slices.length).toBeGreaterThan(10);
    expect(
      fullReads.mock.calls.filter(([path]) => path.includes('delegations')),
    ).toEqual([]);
    fullReads.mockRestore();
    expect(await readdir(artifactDirectory)).toEqual([kept]);
  });

  it('keeps an open-sidecar-only body through maintenance and checkpointed copy', async () => {
    const { store, backend } = await format4Scope(
      root,
      'source',
      scopeSource([{ id: 'chat', messages: [message('parent', 'hello')] }]),
    );
    const target = {
      kind: 'delegation' as const,
      chatId: 'chat',
      delegationId: 'child',
      runGeneration: 0,
    };
    await backend.registerTranscriptStream(target);
    const row: DelegationChildRow = {
      id: 'agent:tool',
      role: 'assistant',
      timestamp: 2,
      parentBlockId: 'agent',
      delegationSequence: 0,
      itemRevision: 0,
      final: false,
      blocks: [
        {
          type: 'tool_result',
          toolName: 'shell',
          toolUseId: 'call-1',
          output: 'child body '.repeat(20_000),
          isError: false,
        },
      ],
    };
    await backend.commitChildStream(target, 'child-artifact', [row]);
    await backend.flush();
    const artifactDirectory = join(
      store.directory,
      'transcripts',
      'tool-output',
      'chat',
    );
    const [filename] = await readdir(artifactDirectory);
    expect(filename).toMatch(/^sha256-v1-[a-f0-9]{64}\.txt$/);
    for (let attempt = 0; attempt < 20; attempt++) {
      const progress = await backend.maintainArtifacts('chat');
      if (progress.complete) break;
    }
    expect(await readFile(join(artifactDirectory, filename), 'utf8')).toBe(
      'child body '.repeat(20_000),
    );
    const capture = new ChatStorageV2(root, 'capture', undefined, {
      maxManifestVersion: 4,
    });
    await store.copyTo(capture);
    expect(
      await readFile(
        join(capture.directory, 'transcripts', 'tool-output', 'chat', filename),
        'utf8',
      ),
    ).toBe('child body '.repeat(20_000));
    await unlink(join(artifactDirectory, filename));
    expect(
      await readFile(
        join(capture.directory, 'transcripts', 'tool-output', 'chat', filename),
        'utf8',
      ),
    ).toBe('child body '.repeat(20_000));
    const missing = new ChatStorageV2(root, 'missing', undefined, {
      maxManifestVersion: 4,
    });
    await expect(store.copyTo(missing)).rejects.toThrow();
    expect(await missing.authority()).toBe('v1');
  });
});
