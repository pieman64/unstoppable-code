import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DelegationChildRow } from '@canopy/agent-transcript';
import { format4Scope, reopenFormat4Scope } from './helpers/chat-format4-scope';
import { message, scopeSource } from './helpers/chat-delta-journal-harness';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import { ChatTranscriptArtifacts } from '../lib/chat-transcript-artifacts';
import { ChatDeltaJournalWriter } from '../lib/chat-delta-journal/writer';
import type { ChatCoreMutation } from '@canopy/desktop-shared/types';

jest.setTimeout(60_000);

describe('format-4 child admission', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-child-admission-'));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it('commits child rows durably without making them primary checkpoint work', async () => {
    const { backend } = await format4Scope(
      root,
      'scope',
      scopeSource([{ id: 'chat', messages: [message('parent', 'hello')] }]),
    );
    const target = {
      kind: 'delegation' as const,
      chatId: 'chat',
      delegationId: 'delegate',
      runGeneration: 1,
    };
    await backend.registerTranscriptStream(target);
    const row: DelegationChildRow = {
      id: 'agent:item',
      role: 'assistant',
      timestamp: 2,
      parentBlockId: 'agent',
      delegationSequence: 0,
      itemRevision: 0,
      final: true,
      blocks: [{ type: 'text', text: 'child-only output' }],
    };
    const before = backend.pendingJournalRecords();
    const result = await backend.commitChildStream(target, 'child-mutation', [
      row,
    ]);
    expect(result.applied).toBe(true);
    expect(backend.pendingJournalRecords()).toBe(before + 1);
    expect(backend.pendingPrimaryRecordCount()).toBe(0);
    expect(backend.journalCheckpointDue()).toBe(false);
    await backend.flush();
  });

  it('rejects a late child event after parent deletion without recreating a stream', async () => {
    const { backend } = await format4Scope(
      root,
      'scope',
      scopeSource([{ id: 'chat', messages: [message('parent', 'hello')] }]),
    );
    const target = {
      kind: 'delegation' as const,
      chatId: 'chat',
      delegationId: 'delegate',
      runGeneration: 1,
    };
    await backend.registerTranscriptStream(target);
    await backend.storage.transcripts.childDeleteFence.retire('chat');
    await expect(
      backend.commitChildStream(target, 'late-event', []),
    ).rejects.toThrow('deleted');
  });

  it('rejects child admission after reopening with the parent deletion still pending', async () => {
    const { backend } = await format4Scope(
      root,
      'scope',
      scopeSource([
        { id: 'chat', messages: [message('parent', 'hello')] },
        { id: 'other', messages: [message('other', 'hello')] },
      ]),
    );
    const target = {
      kind: 'delegation' as const,
      chatId: 'chat',
      delegationId: 'delegate',
      runGeneration: 1,
    };
    await backend.registerTranscriptStream(target);
    const removal: ChatCoreMutation = { type: 'tab.removed', tabId: 'chat' };
    // The deletion is journaled, then the process dies before its checkpoint.
    jest
      .spyOn(ChatDeltaJournalWriter.prototype, 'checkpoint')
      .mockRejectedValueOnce(new Error('crash before checkpoint'));
    await expect(
      backend.transact(() => [removal], { source: 'renderer-command' }),
    ).rejects.toThrow('crash before checkpoint');
    // A new process starts with an unfenced parent; recovery fences it.
    backend.storage.transcripts.childDeleteFence.restore('chat');
    const reopened = reopenFormat4Scope(root, 'scope').backend;
    let timer: NodeJS.Timeout | undefined;
    const hung = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('admission hung')), 10_000);
    });
    try {
      await expect(
        Promise.race([
          reopened.commitChildStream(target, 'after-reopen', []),
          hung,
        ]),
      ).rejects.toThrow(/deleted|Unknown/);
    } finally {
      clearTimeout(timer);
    }
  });

  it('defers maintenance and capture while an artifact-bearing child record awaits checkpoint', async () => {
    const { store, backend } = await format4Scope(
      root,
      'scope',
      scopeSource([{ id: 'chat', messages: [message('parent', 'hello')] }]),
    );
    const target = {
      kind: 'delegation' as const,
      chatId: 'chat',
      delegationId: 'delegate',
      runGeneration: 1,
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
          output: 'large output '.repeat(10_000),
          isError: false,
        },
      ],
    };
    await backend.commitChildStream(target, 'artifact-pending', [row]);
    const artifactDirectory = join(
      store.directory,
      'transcripts',
      'tool-output',
      'chat',
    );
    const before = await readdir(artifactDirectory);
    expect(before).toHaveLength(1);
    await expect(backend.maintainArtifacts('chat')).rejects.toThrow(
      'replay is pending',
    );
    const capture = new ChatStorageV2(root, 'pending-capture', undefined, {
      maxManifestVersion: 4,
    });
    await expect(store.copyTo(capture)).rejects.toThrow('checkpointed');
    expect(await readdir(artifactDirectory)).toEqual(before);
  });

  it('attributes artifact-preparation ENOSPC and accepts a later retry', async () => {
    const { backend } = await format4Scope(
      root,
      'scope',
      scopeSource([{ id: 'chat', messages: [message('parent', 'hello')] }]),
    );
    const target = {
      kind: 'delegation' as const,
      chatId: 'chat',
      delegationId: 'delegate',
      runGeneration: 1,
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
          output: 'output '.repeat(20_000),
          isError: false,
        },
      ],
    };
    const before = backend.pendingJournalRecords();
    const put = ChatTranscriptArtifacts.prototype.put.bind(
      backend.storage.transcripts.artifacts,
    );
    jest
      .spyOn(ChatTranscriptArtifacts.prototype, 'put')
      .mockRejectedValueOnce(
        Object.assign(new Error('disk full'), { code: 'ENOSPC' }),
      )
      .mockImplementation((...args) => put(...args));
    await expect(
      backend.commitChildStream(target, 'disk-full', [row]),
    ).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(backend.pendingJournalRecords()).toBe(before);
    await expect(
      backend.commitChildStream(target, 'disk-full', [row]),
    ).resolves.toMatchObject({ applied: true });
  });

  it('cancels a staged child write when deletion starts and does not journal it', async () => {
    const { backend } = await format4Scope(
      root,
      'scope',
      scopeSource([{ id: 'chat', messages: [message('parent', 'hello')] }]),
    );
    const target = {
      kind: 'delegation' as const,
      chatId: 'chat',
      delegationId: 'delegate',
      runGeneration: 1,
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
          output: 'output '.repeat(20_000),
          isError: false,
        },
      ],
    };
    let staged: () => void = () => undefined;
    let resume: () => void = () => undefined;
    const stagedPromise = new Promise<void>((resolve) => {
      staged = resolve;
    });
    const resumePromise = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const put = ChatTranscriptArtifacts.prototype.put.bind(
      backend.storage.transcripts.artifacts,
    );
    jest
      .spyOn(ChatTranscriptArtifacts.prototype, 'put')
      .mockImplementation(async (...args) => {
        const ref = await put(...args);
        staged();
        await resumePromise;
        return ref;
      });
    const before = backend.pendingJournalRecords();
    const commit = backend.commitChildStream(target, 'cancelled-child', [row]);
    await stagedPromise;
    const retiring =
      backend.storage.transcripts.childDeleteFence.retire('chat');
    resume();
    await expect(commit).rejects.toThrow('deleted');
    await retiring;
    expect(backend.pendingJournalRecords()).toBe(before);
  });
});
