import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ChatSearchQueryWorkerRequest } from '../chat-search/query-worker';

class FakeUtilityProcess extends EventEmitter {
  readonly postMessage = jest.fn<void, [ChatSearchQueryWorkerRequest]>();
  readonly kill = jest.fn(() => true);
}

const forkMock = jest.fn<FakeUtilityProcess, unknown[]>();
jest.mock('electron', () => ({
  utilityProcess: {
    fork: (...args: unknown[]): FakeUtilityProcess => forkMock(...args),
  },
}));

import { ChatSearchQueryRunner } from '../chat-search/query-runner';
import { executeChatSearchQuery } from '../chat-search/query-worker';
import { openChatSearchDatabase } from '../chat-search/schema';

describe('ChatSearchQueryRunner', () => {
  let runner: ChatSearchQueryRunner;
  const children: FakeUtilityProcess[] = [];

  beforeEach(() => {
    jest.useRealTimers();
    forkMock.mockReset();
    children.length = 0;
    forkMock.mockImplementation(() => {
      const child = new FakeUtilityProcess();
      children.push(child);
      return child;
    });
    runner = new ChatSearchQueryRunner();
  });

  afterEach(() => runner.close());

  it('forks a one-shot worker and returns its results', async () => {
    const pending = runner.run('/tmp/chat-search.sqlite', {
      query: 'needle',
      limit: 20,
    });

    expect(forkMock).toHaveBeenCalledWith(
      expect.stringContaining('chat-search-query-worker.js'),
      [],
      { serviceName: 'chat-search-query' },
    );
    expect(children[0]?.postMessage).toHaveBeenCalledWith({
      dbPath: '/tmp/chat-search.sqlite',
      request: { query: 'needle', limit: 20 },
    });

    children[0]?.emit('message', { data: { ok: true, results: [] } });
    await expect(pending).resolves.toEqual([]);
  });

  it('serializes concurrent query projections', async () => {
    const first = runner.run('/tmp/index.sqlite', { query: 'first' });
    const second = runner.run('/tmp/index.sqlite', { query: 'second' });
    expect(children).toHaveLength(1);

    children[0]?.emit('message', { data: { ok: true, results: [] } });
    await expect(first).resolves.toEqual([]);
    expect(children).toHaveLength(2);
    children[1]?.emit('message', { data: { ok: true, results: [] } });
    await expect(second).resolves.toEqual([]);
  });

  it('rejects malformed responses and kills that worker', async () => {
    const pending = runner.run('/tmp/index.sqlite', { query: 'needle' });
    children[0]?.emit('message', { data: { unexpected: true } });
    await expect(pending).rejects.toThrow('malformed response');
    expect(children[0]?.kill).toHaveBeenCalledTimes(1);
  });

  it('cancels active and queued work on close', async () => {
    const first = runner.run('/tmp/index.sqlite', { query: 'first' });
    const second = runner.run('/tmp/index.sqlite', { query: 'second' });
    runner.close();

    await expect(first).rejects.toThrow('canceled');
    await expect(second).rejects.toThrow('canceled');
    expect(children[0]?.kill).toHaveBeenCalled();
  });
});

describe('executeChatSearchQuery', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'chat-search-worker-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  function seedIndex(dbPath: string): void {
    const db = openChatSearchDatabase(dbPath);
    db.prepare(
      `INSERT INTO chat_docs (doc_id, project_id, worktree_id, chat_id, source,
                              document_kind, title, updated_at, message_count)
       VALUES (?, ?, ?, ?, 'live', 'chat', ?, ?, ?)`,
    ).run('doc-1', 'workspace-1', 'worktree-1', 'chat-1', 'Large chat', 1, 1);
    db.prepare(
      `INSERT INTO chat_fts (doc_id, title, body) VALUES (?, ?, ?)`,
    ).run('doc-1', 'Large chat', 'a worker needle in the transcript');
    db.close();
  }

  it('projects results from the shared index without initializing it', () => {
    const dbPath = join(dataDir, 'chat-search.sqlite');
    seedIndex(dbPath);

    const response = executeChatSearchQuery({
      dbPath,
      request: { query: 'worker needle' },
    });

    expect(response.ok).toBe(true);
    expect(
      response.ok && response.results.map((result) => result.chatId),
    ).toEqual(['chat-1']);
  });

  it('rejects instead of deleting the index when the database cannot be opened', async () => {
    const dbPath = join(dataDir, 'corrupt-chat-search.sqlite');
    await writeFile(dbPath, 'not a sqlite database', 'utf8');

    const response = executeChatSearchQuery({
      dbPath,
      request: { query: 'worker needle' },
    });

    expect(response.ok).toBe(false);
    // The main process owns this file. A worker-side failure must surface as a
    // rejection the service can recover from, never as delete-and-rebuild.
    expect(existsSync(dbPath)).toBe(true);
  });

  it('rejects a missing index rather than creating one', () => {
    const dbPath = join(dataDir, 'absent', 'chat-search.sqlite');

    const response = executeChatSearchQuery({
      dbPath,
      request: { query: 'worker needle' },
    });

    expect(response.ok).toBe(false);
    expect(existsSync(dbPath)).toBe(false);
  });

  it('cannot write through the worker connection', () => {
    const dbPath = join(dataDir, 'chat-search.sqlite');
    seedIndex(dbPath);

    const readOnly = new DatabaseSync(dbPath, { readOnly: true });
    expect(() => readOnly.exec(`DELETE FROM chat_docs`)).toThrow();
    readOnly.close();
  });
});
