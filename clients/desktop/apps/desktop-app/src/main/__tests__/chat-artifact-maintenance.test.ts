import type {
  PersistedChatMessage,
  PersistedToolOutputReference,
  PersistedVisualReference,
} from '@canopy/agent-transcript/types';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatMigrationEntry } from '../lib/chat-storage-v2';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import { ChatStorageTransactions } from '../lib/chat-storage-transactions';
import {
  ChatArtifactMaintenance,
  type ArtifactMaintenanceProgress,
} from '../lib/chat-artifact-maintenance';
import type { StoredArtifactFamily } from '../lib/chat-artifact-references';

function asAsync<T>(values: readonly T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      const iterator = values[Symbol.iterator]();
      return {
        next(): Promise<IteratorResult<T>> {
          return Promise.resolve(iterator.next());
        },
      };
    },
  };
}

function visualId(index: number): string {
  return `vis_00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function message(
  id: string,
  visualRef?: PersistedVisualReference,
  fullOutputRef?: PersistedToolOutputReference,
): PersistedChatMessage {
  return {
    id,
    role: 'assistant',
    timestamp: 1,
    blocks: [
      {
        type: 'tool_result',
        toolUseId: id,
        toolName: 'Read',
        output: 'preview',
        isError: false,
        ...(fullOutputRef !== undefined ? { fullOutputRef } : {}),
        ...(visualRef !== undefined ? { visualRef } : {}),
      },
    ],
  };
}

function artifactPath(
  root: string,
  chatId: string,
  family: StoredArtifactFamily,
  artifactId: string,
): string {
  const directory = family === 'visual' ? 'visuals' : 'tool-output';
  const extension = family === 'visual' ? '.html' : '.txt';
  return join(
    root,
    'transcripts',
    directory,
    chatId,
    `${artifactId}${extension}`,
  );
}

async function drainMaintenance(
  maintenance: ChatArtifactMaintenance,
  chatId: string,
): Promise<ArtifactMaintenanceProgress[]> {
  const progress: ArtifactMaintenanceProgress[] = [];
  for (let attempt = 0; attempt < 100; attempt++) {
    const next = await maintenance.maintain(chatId, 64 * 1024);
    progress.push(next);
    if (next.complete) return progress;
  }
  throw new Error('Artifact maintenance did not complete');
}

describe('chat artifact maintenance', () => {
  let root: string;
  let store: ChatStorageV2;
  let transactions: ChatStorageTransactions;
  let maintenance: ChatArtifactMaintenance;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-artifact-maintenance-'));
    store = new ChatStorageV2(root, 'scope');
    await store.migrate(() =>
      Promise.resolve({
        revision: 0,
        index: { activeTabId: 'chat', runtimeByChatId: {} },
        recovery: {
          receipts: [],
          mutationIds: [],
          removedTabIds: [],
          removedArchiveEntryIds: [],
          removedMessageIds: [],
        },
        chats: asAsync<ChatMigrationEntry>([
          {
            metadata: { id: 'chat', title: 'Chat', createdAt: 'now' },
            messages: asAsync<PersistedChatMessage>([]),
          },
        ]),
      }),
    );
    transactions = new ChatStorageTransactions(store);
    maintenance = new ChatArtifactMaintenance(transactions, store.directory);
  });

  afterEach(async () => {
    await maintenance.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it('retains referenced committed and active HTML and removes superseded or orphaned HTML', async () => {
    const artifacts = transactions.transcripts.artifacts;
    const supersededHtml = '<p>superseded</p>';
    const committedHtml = '<p>committed</p>';
    const activeHtml = '<p>active</p>';
    const orphanHtml = '<p>orphan</p>';
    const superseded = await artifacts.putVisual('chat', supersededHtml);
    const committed = await artifacts.putVisual('chat', committedHtml);
    const active = await artifacts.putVisual('chat', activeHtml);
    const orphan = await artifacts.putVisual('chat', orphanHtml);
    const visualReference = (
      content: Pick<
        PersistedVisualReference,
        'artifactId' | 'byteLength' | 'sha256'
      >,
      index: number,
      title: string,
    ): PersistedVisualReference => ({
      version: 1,
      visualId: visualId(index),
      artifactId: content.artifactId,
      byteLength: content.byteLength,
      sha256: content.sha256,
      mediaType: 'text/html',
      title,
      maxHeight: 600,
    });

    await transactions.transcripts.append('chat', [
      message('old', visualReference(superseded, 1, 'Superseded')),
    ]);
    await transactions.transcripts.replace(
      'chat',
      [message('committed', visualReference(committed, 2, 'Committed'))],
      1,
    );
    await transactions.transcripts.writeActive('chat', [
      message('active', visualReference(active, 3, 'Active')),
    ]);

    await drainMaintenance(maintenance, 'chat');

    await expect(
      readFile(
        artifactPath(store.directory, 'chat', 'visual', superseded.artifactId),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      readFile(
        artifactPath(store.directory, 'chat', 'visual', orphan.artifactId),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      readFile(
        artifactPath(store.directory, 'chat', 'visual', committed.artifactId),
        'utf8',
      ),
    ).resolves.toBe(committedHtml);
    await expect(
      readFile(
        artifactPath(store.directory, 'chat', 'visual', active.artifactId),
        'utf8',
      ),
    ).resolves.toBe(activeHtml);
  });

  it('defers cleanup while the metadata journal is pending', async () => {
    const orphan = await transactions.transcripts.artifacts.putVisual(
      'chat',
      '<p>orphan</p>',
    );
    const journal = join(store.directory, 'metadata-journal.jsonl');
    await writeFile(journal, 'pending transaction\n');

    await expect(maintenance.maintain('chat', 64 * 1024)).rejects.toThrow(
      'Artifact maintenance deferred while replay is pending',
    );
    await expect(
      readFile(
        artifactPath(store.directory, 'chat', 'visual', orphan.artifactId),
      ),
    ).resolves.toBeDefined();

    await writeFile(journal, '');
    await drainMaintenance(maintenance, 'chat');
    await expect(
      readFile(
        artifactPath(store.directory, 'chat', 'visual', orphan.artifactId),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains a referenced tool output and visual that share one digest', async () => {
    const html = '<p>shared bytes</p>';
    const output = await transactions.transcripts.artifacts.put('chat', html);
    const visual = await transactions.transcripts.artifacts.putVisual(
      'chat',
      html,
    );
    const visualReference: PersistedVisualReference = {
      version: 1,
      visualId: visualId(4),
      artifactId: visual.artifactId,
      byteLength: visual.byteLength,
      sha256: visual.sha256,
      mediaType: 'text/html',
      title: 'Shared digest',
      maxHeight: 600,
    };
    await transactions.transcripts.append('chat', [
      message('shared', visualReference, output),
    ]);

    await drainMaintenance(maintenance, 'chat');

    await expect(
      readFile(
        artifactPath(store.directory, 'chat', 'tool-output', output.artifactId),
        'utf8',
      ),
    ).resolves.toBe(html);
    await expect(
      readFile(
        artifactPath(store.directory, 'chat', 'visual', visual.artifactId),
        'utf8',
      ),
    ).resolves.toBe(html);
  });

  it('keeps candidate and unlink work bounded across both families', async () => {
    const toolOutputDirectory = join(
      store.directory,
      'transcripts',
      'tool-output',
      'chat',
    );
    const visualDirectory = join(
      store.directory,
      'transcripts',
      'visuals',
      'chat',
    );
    await mkdir(toolOutputDirectory, { recursive: true });
    await mkdir(visualDirectory, { recursive: true });
    for (let index = 0; index < 20; index++) {
      const artifactId = `sha256-v1-${index.toString(16).padStart(64, '0')}`;
      await writeFile(join(toolOutputDirectory, `${artifactId}.txt`), 'output');
      await writeFile(
        join(visualDirectory, `${artifactId}.html`),
        '<p>visual</p>',
      );
    }

    const progress = await drainMaintenance(maintenance, 'chat');

    expect(progress.every((chunk) => chunk.removed <= 16)).toBe(true);
    expect(progress.reduce((total, chunk) => total + chunk.removed, 0)).toBe(
      40,
    );
    await expect(readdir(toolOutputDirectory)).resolves.toHaveLength(0);
    await expect(readdir(visualDirectory)).resolves.toHaveLength(0);
  });

  it('rediscovers orphans that overflow the candidate set after a finished pass', async () => {
    // This overflow case commits 300 durable files before scanning and deleting them.
    // Allow bounded filesystem latency on the constrained export runners.
    const artifacts = transactions.transcripts.artifacts;
    const outputs: PersistedToolOutputReference[] = [];
    for (let index = 0; index < 300; index++)
      outputs.push(await artifacts.put('chat', `output ${index}`));
    const active = outputs.map((output, index) =>
      message(`active-${index}`, undefined, output),
    );
    await transactions.transcripts.writeActive('chat', active);
    await drainMaintenance(maintenance, 'chat');
    const toolOutputDirectory = join(
      store.directory,
      'transcripts',
      'tool-output',
      'chat',
    );
    await expect(readdir(toolOutputDirectory)).resolves.toHaveLength(300);

    // The turn finalizes without its full outputs, then the active rows go.
    const finalized = active.map((row) => message(row.id));
    const beforeAppend =
      await transactions.transcripts.artifactReferenceIdentity('chat');
    await transactions.transcripts.append('chat', finalized);
    await maintenance.committed(
      'chat',
      { chatId: 'chat', kind: 'append', messages: finalized },
      [],
      beforeAppend,
    );
    const beforeClear =
      await transactions.transcripts.artifactReferenceIdentity('chat');
    await transactions.transcripts.writeActive('chat', []);
    // More superseded references than the candidate set holds.
    await maintenance.committed(
      'chat',
      { chatId: 'chat', kind: 'active', messages: [] },
      active,
      beforeClear,
    );
    await drainMaintenance(maintenance, 'chat');

    await expect(readdir(toolOutputDirectory)).resolves.toHaveLength(0);
  }, 30_000);

  it('closes an open family directory handle when maintenance drains', async () => {
    const toolOutputDirectory = join(
      store.directory,
      'transcripts',
      'tool-output',
      'chat',
    );
    await mkdir(toolOutputDirectory, { recursive: true });
    for (let index = 0; index < 70; index++) {
      const artifactId = `sha256-v1-${index.toString(16).padStart(64, '0')}`;
      await writeFile(join(toolOutputDirectory, `${artifactId}.txt`), 'output');
    }
    const openDirectory =
      transactions.transcripts.artifacts.openCandidateDirectory.bind(
        transactions.transcripts.artifacts,
      );
    let closeCalls = 0;
    jest
      .spyOn(transactions.transcripts.artifacts, 'openCandidateDirectory')
      .mockImplementation(async (chatId, family) => {
        const directory = await openDirectory(chatId, family);
        if (directory) {
          const close = directory.close.bind(directory);
          directory.close = async (): Promise<void> => {
            closeCalls += 1;
            await close();
          };
        }
        return directory;
      });

    await maintenance.maintain('chat', 64 * 1024);
    expect(closeCalls).toBe(0);
    await maintenance.dispose();

    expect(closeCalls).toBe(1);
  });
});
