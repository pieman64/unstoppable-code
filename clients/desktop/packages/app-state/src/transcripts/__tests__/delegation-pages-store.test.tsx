/** @jest-environment jsdom */
import { act, useEffect, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  CanopyCapabilities,
  CanopyClient,
  CommandMap,
  CommandName,
  DelegationBlocksPage,
  DelegationBlocksRequest,
  DelegationPage,
  DelegationPageRequest,
  DelegationReadTarget,
  DomainEventMap,
  DomainEventName,
  QueryMap,
  QueryName,
  TranscriptContentRange,
  TranscriptContentRequest,
  TranscriptReadResult,
  TranscriptReadSource,
  Unsubscribe,
} from '@canopy/app-core';
import { CanopyClientProvider } from '../../CanopyClientProvider';
import {
  createDelegationPagesStore,
  useDelegationPagesStore,
  type DelegationBlocksReadRequest,
  type DelegationPageReadRequest,
  type DelegationPagesState,
} from '../delegation-pages-store';
import {
  CLIENT_STORE_ACTIVATE,
  CLIENT_STORE_DISPOSE,
  type ClientStore,
} from '../../client-store-lifecycle';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
class TestTextEncoder {
  encode(text: string): Uint8Array {
    let byteLength = 0;
    for (let index = 0; index < text.length; index += 1) {
      const codePoint = text.codePointAt(index);
      if (codePoint === undefined) {
        continue;
      }
      if (codePoint > 0xffff) {
        byteLength += 4;
        index += 1;
      } else if (codePoint > 0x7ff) {
        byteLength += 3;
      } else if (codePoint > 0x7f) {
        byteLength += 2;
      } else {
        byteLength += 1;
      }
    }
    return new Uint8Array(byteLength);
  }
}
Reflect.set(globalThis, 'TextEncoder', TestTextEncoder);

const CAPABILITIES: CanopyCapabilities = {
  localExecution: false,
  terminalPty: false,
  fileSystemAccess: 'read',
  voice: false,
  settingsScope: 'api-keys-only',
  pipelines: 'crud-only',
  routing: 'url',
  overviewNotifications: false,
};

const SOURCE: TranscriptReadSource = {
  scope: {
    workspaceId: 'workspace-1',
    worktreeId: 'worktree-1',
    chatId: 'parent-chat',
  },
};

const TARGET: DelegationReadTarget = {
  kind: 'delegation',
  chatId: 'child-chat',
  delegationId: 'delegation-1',
  runGeneration: 1,
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

interface RecordedPageCall {
  readonly request: DelegationPageRequest;
  readonly signal: AbortSignal;
  readonly resolve: (result: TranscriptReadResult<DelegationPage>) => void;
}

interface RecordedContentCall {
  readonly request: TranscriptContentRequest;
  readonly signal: AbortSignal;
  readonly resolve: (
    result: TranscriptReadResult<TranscriptContentRange>,
  ) => void;
}

interface TranscriptHarness {
  readonly client: CanopyClient;
  readonly pageCalls: RecordedPageCall[];
  readonly contentCalls: RecordedContentCall[];
  readonly blockCalls: {
    request: DelegationBlocksRequest;
    signal: AbortSignal;
    resolve: (value: TranscriptReadResult<DelegationBlocksPage>) => void;
  }[];
  releaseOutstanding(): void;
}

const transcriptHarnesses: TranscriptHarness[] = [];

function createDeferred<T>(): Deferred<T> {
  let settle: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return {
    promise,
    resolve(value: T): void {
      const resolveCurrent = settle;
      if (!resolveCurrent) {
        return;
      }
      settle = undefined;
      resolveCurrent(value);
    },
  };
}

function pageResult(
  transcriptRevision: number,
): TranscriptReadResult<DelegationPage> {
  return {
    ok: true,
    value: { rows: [], transcriptRevision },
  };
}

function contentResult(): TranscriptReadResult<TranscriptContentRange> {
  return { ok: true, value: { text: 'body', byteLength: 4 } };
}

function createTranscriptHarness(options?: {
  readonly deferPages?: boolean;
  readonly deferContent?: boolean;
  readonly deferBlocks?: boolean;
}): TranscriptHarness {
  const pageCalls: RecordedPageCall[] = [];
  const contentCalls: RecordedContentCall[] = [];
  const blockCalls: TranscriptHarness['blockCalls'] = [];
  const client: CanopyClient = {
    capabilities: CAPABILITIES,
    transcripts: {
      blocks(request, signal) {
        const deferred =
          createDeferred<TranscriptReadResult<DelegationBlocksPage>>();
        blockCalls.push({
          request,
          signal,
          resolve: (value) => deferred.resolve(value),
        });
        if (!options?.deferBlocks)
          deferred.resolve(blockResult(request.messageId));
        return deferred.promise;
      },
      delegationPage(
        request: DelegationPageRequest,
        signal: AbortSignal,
      ): Promise<TranscriptReadResult<DelegationPage>> {
        // Deliberately ignore abort: tests may settle this relay-like request
        // after its caller has already been fenced locally.
        const deferred = createDeferred<TranscriptReadResult<DelegationPage>>();
        pageCalls.push({
          request,
          signal,
          resolve: (result) => deferred.resolve(result),
        });
        if (options?.deferPages !== true) {
          deferred.resolve(pageResult(1));
        }
        return deferred.promise;
      },
      content(
        request: TranscriptContentRequest,
        signal: AbortSignal,
      ): Promise<TranscriptReadResult<TranscriptContentRange>> {
        const deferred =
          createDeferred<TranscriptReadResult<TranscriptContentRange>>();
        contentCalls.push({
          request,
          signal,
          resolve: (result) => deferred.resolve(result),
        });
        if (options?.deferContent !== true) {
          deferred.resolve(contentResult());
        }
        return deferred.promise;
      },
    },
    query<K extends QueryName>(
      name: K,
      args: QueryMap[K]['args'],
    ): Promise<QueryMap[K]['result']> {
      void name;
      void args;
      return Promise.reject(new Error('Unexpected query.'));
    },
    command<K extends CommandName>(
      name: K,
      args: CommandMap[K]['args'],
    ): Promise<CommandMap[K]['result']> {
      void name;
      void args;
      return Promise.reject(new Error('Unexpected command.'));
    },
    subscribe<K extends DomainEventName>(
      name: K,
      handler: (event: DomainEventMap[K]) => void,
    ): Unsubscribe {
      void name;
      void handler;
      return (): void => {};
    },
  };
  const harness: TranscriptHarness = {
    client,
    pageCalls,
    contentCalls,
    blockCalls,
    releaseOutstanding(): void {
      for (const call of pageCalls) call.resolve(pageResult(1));
      for (const call of contentCalls) call.resolve(contentResult());
      for (const call of blockCalls)
        call.resolve(blockResult(call.request.messageId));
    },
  };
  transcriptHarnesses.push(harness);
  return harness;
}

afterEach(async () => {
  for (const harness of transcriptHarnesses) harness.releaseOutstanding();
  transcriptHarnesses.splice(0);
  await Promise.resolve();
  await Promise.resolve();
});

function pageRequest(
  cursor: string = 'newest',
  epoch = 1,
  source: TranscriptReadSource = SOURCE,
  target: DelegationReadTarget = TARGET,
  streamRevisionHint?: number,
): DelegationPageReadRequest {
  return {
    source,
    target,
    cursor,
    epoch,
    ...(streamRevisionHint === undefined ? {} : { streamRevisionHint }),
  };
}

function targetFor(index: number): DelegationReadTarget {
  return {
    kind: 'delegation',
    chatId: `child-chat-${index}`,
    delegationId: `delegation-${index}`,
    runGeneration: index,
  };
}

function completePage(
  harness: TranscriptHarness,
  index: number,
  result: TranscriptReadResult<DelegationPage>,
): void {
  const call = harness.pageCalls[index];
  if (!call) {
    throw new Error(`Page call ${index} was not started.`);
  }
  call.resolve(result);
}

function completeContent(
  harness: TranscriptHarness,
  index: number,
  result: TranscriptReadResult<TranscriptContentRange>,
): void {
  const call = harness.contentCalls[index];
  if (!call) {
    throw new Error(`Content call ${index} was not started.`);
  }
  call.resolve(result);
}

function ReaderStoreCapture({
  onStore,
}: {
  readonly onStore: (store: ClientStore<DelegationPagesState>) => void;
}): JSX.Element {
  const store = useDelegationPagesStore();
  useEffect(() => {
    onStore(store);
  }, [onStore, store]);
  return <></>;
}

function blockResult(
  messageId = 'row',
  transcriptRevision = 1,
  text = 'block',
): TranscriptReadResult<DelegationBlocksPage> {
  return {
    ok: true,
    value: {
      messageId,
      firstBlockOrdinal: 0,
      entries: [{ kind: 'block', ordinal: 0, block: { type: 'text', text } }],
      blockCount: 2,
      cursor: 'next',
      nextBlockOrdinal: 1,
      transcriptRevision,
    },
  };
}
function blockRequest(messageId = 'row'): DelegationBlocksReadRequest {
  return {
    ...SOURCE,
    target: TARGET,
    messageId,
    epoch: 1,
    streamRevisionHint: 1,
    firstBlockOrdinal: 0,
    limit: 16,
  };
}

describe('delegation transcript page store', () => {
  it('shares two permits and a queue of 32 across pages, blocks and uncached bodies', async () => {
    const harness = createTranscriptHarness({
      deferPages: true,
      deferBlocks: true,
      deferContent: true,
    });
    const store = createDelegationPagesStore(harness.client).getState();
    const controller = new AbortController();
    const first = store.readPage(pageRequest(), controller.signal);
    const second = store.readContent(
      {
        ...SOURCE,
        target: TARGET,
        messageId: 'body',
        blockOrdinal: 0,
        field: 'text',
        offset: 0,
        limit: 64,
        epoch: 1,
      },
      controller.signal,
    );
    const queued = Array.from({ length: 32 }, (_, index) =>
      store.readBlocks(blockRequest(`block-${index}`), controller.signal),
    );
    expect(harness.pageCalls).toHaveLength(1);
    expect(harness.contentCalls).toHaveLength(1);
    expect(harness.blockCalls).toHaveLength(0);
    expect(
      await store.readBlocks(blockRequest('overflow'), controller.signal),
    ).toEqual({ ok: false, kind: 'failed' });
    harness.contentCalls[0]?.resolve(contentResult());
    await second;
    expect(harness.blockCalls).toHaveLength(1);
    controller.abort();
    await Promise.all([first, ...queued]);
    // Started aborts retain both permits until the adapter actually settles.
    const another = new AbortController();
    const after = store.readBlocks(blockRequest('after'), another.signal);
    expect(harness.blockCalls).toHaveLength(1);
    harness.pageCalls[0]?.resolve(pageResult(1));
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.blockCalls).toHaveLength(2);
    harness.blockCalls[0]?.resolve(blockResult('block-0'));
    harness.blockCalls[1]?.resolve(blockResult('after'));
    expect(await after).toEqual(blockResult('after'));
  });

  it('uses one 24-page LRU for both page kinds and includes block identity dimensions', async () => {
    const harness = createTranscriptHarness();
    const store = createDelegationPagesStore(harness.client).getState();
    const signal = new AbortController().signal;
    await store.readBlocks(blockRequest('oldest'), signal);
    for (let index = 0; index < 24; index += 1) {
      if (index % 2 === 0)
        await store.readPage(
          pageRequest('newest', 1, SOURCE, targetFor(index), 1),
          signal,
        );
      else await store.readBlocks(blockRequest(`row-${index}`), signal);
    }
    expect(harness.blockCalls).toHaveLength(13);
    await store.readBlocks(blockRequest('oldest'), signal);
    expect(harness.blockCalls).toHaveLength(14);
    await store.readBlocks(blockRequest('oldest'), signal);
    expect(harness.blockCalls).toHaveLength(14);
    for (const variant of [
      { epoch: 2 },
      { limit: 8 },
      { firstBlockOrdinal: 1 },
      { archivedContainerId: 'archive' },
      { standaloneHistory: true as const },
      { target: { ...TARGET, runGeneration: 2 } },
      { streamRevisionHint: 2 },
    ])
      await store.readBlocks({ ...blockRequest('oldest'), ...variant }, signal);
    expect(harness.blockCalls).toHaveLength(21);
  });

  it('evicts by one 12 MiB byte budget across blocks and child pages', async () => {
    const harness = createTranscriptHarness();
    if (!harness.client.transcripts) throw new Error('Missing fixture');
    const transcripts = harness.client.transcripts;
    const text = 'x'.repeat(700000);
    const blocks = jest
      .spyOn(transcripts, 'blocks')
      .mockImplementation((request) =>
        Promise.resolve(blockResult(request.messageId, 1, text)),
      );
    const pages = jest.spyOn(transcripts, 'delegationPage').mockResolvedValue({
      ok: true,
      value: {
        rows: [{ id: 'big', role: 'assistant', timestamp: 1, row: { text } }],
        transcriptRevision: 1,
      },
    });
    const store = createDelegationPagesStore(harness.client).getState();
    const signal = new AbortController().signal;
    await store.readBlocks(blockRequest('oldest'), signal);
    for (let index = 0; index < 18; index += 1) {
      if (index % 2 === 0)
        await store.readPage(
          pageRequest('newest', 1, SOURCE, targetFor(index), 1),
          signal,
        );
      else await store.readBlocks(blockRequest(`bytes-${index}`), signal);
    }
    expect(blocks).toHaveBeenCalledTimes(10);
    expect(pages).toHaveBeenCalledTimes(9);
    await store.readBlocks(blockRequest('oldest'), signal);
    expect(blocks).toHaveBeenCalledTimes(11);
  });

  it('clears only a stale row block chain and retries the first page once', async () => {
    const harness = createTranscriptHarness();
    if (!harness.client.transcripts) throw new Error('Missing fixture');
    const blocks = jest.spyOn(harness.client.transcripts, 'blocks');
    const store = createDelegationPagesStore(harness.client).getState();
    const signal = new AbortController().signal;
    await store.readBlocks(blockRequest('a'), signal);
    await store.readBlocks(blockRequest('b'), signal);
    blocks
      .mockResolvedValueOnce({ ok: false, kind: 'stale' })
      .mockResolvedValueOnce(blockResult('a', 2));
    expect(
      await store.readBlocks(
        { ...blockRequest('a'), firstBlockOrdinal: undefined, cursor: 'next' },
        signal,
      ),
    ).toEqual(blockResult('a', 2));
    expect(blocks.mock.calls[3]?.[0]).toEqual({
      ...SOURCE,
      target: TARGET,
      messageId: 'a',
      cursor: undefined,
      firstBlockOrdinal: 0,
      limit: 16,
    });
    await store.readBlocks(blockRequest('b'), signal);
    expect(blocks).toHaveBeenCalledTimes(4);
    await store.readBlocks(
      { ...blockRequest('a'), streamRevisionHint: undefined },
      signal,
    );
    expect(blocks).toHaveBeenCalledTimes(5);
    blocks.mockResolvedValue({ ok: false, kind: 'stale' });
    expect(
      await store.readBlocks(
        {
          ...blockRequest('a'),
          streamRevisionHint: 2,
          cursor: 'next-2',
          firstBlockOrdinal: undefined,
        },
        signal,
      ),
    ).toEqual({ ok: false, kind: 'stale' });
    expect(blocks).toHaveBeenCalledTimes(7);
  });

  it('keeps field, logical mode, target kind and epoch out of one another’s content flights', async () => {
    const harness = createTranscriptHarness({ deferContent: true });
    const store = createDelegationPagesStore(harness.client).getState();
    const signal = new AbortController().signal;
    const base = {
      ...SOURCE,
      target: TARGET,
      messageId: 'same',
      blockOrdinal: 0,
      field: 'text' as const,
      offset: 0,
      limit: 64,
      epoch: 1,
    };
    const requests = [
      base,
      { ...base, field: 'input' as const },
      { ...base, fieldSource: 'logical' as const },
      { ...base, target: { kind: 'primary' as const, chatId: TARGET.chatId } },
      { ...base, epoch: 2 },
    ];
    const pending = requests.map((request) =>
      store.readContent(request, signal),
    );
    const duplicate = store.readContent(base, signal);
    for (let index = 0; index < 5; index += 1) {
      harness.contentCalls[index]?.resolve({
        ok: true,
        value: { text: `field-${index}`, byteLength: 7 },
      });
      await pending[index];
    }
    expect(harness.contentCalls).toHaveLength(5);
    expect(await duplicate).toEqual({
      ok: true,
      value: { text: 'field-0', byteLength: 7 },
    });
    expect(harness.contentCalls[0]?.request).not.toHaveProperty('epoch');
    const reread = store.readContent(base, signal);
    expect(harness.contentCalls).toHaveLength(6);
    harness.contentCalls[5]?.resolve(contentResult());
    await reread;
  });

  it('never joins content from a different read epoch', async () => {
    const harness = createTranscriptHarness({ deferContent: true });
    const store = createDelegationPagesStore(harness.client);
    const signal = new AbortController().signal;
    const request = {
      ...pageRequest().source,
      target: targetFor(0),
      messageId: 'same-row',
      blockOrdinal: 0,
      field: 'text' as const,
      offset: 0,
      limit: 64,
      epoch: 3,
    };
    const first = store.getState().readContent(request, signal);
    const second = store
      .getState()
      .readContent({ ...request, epoch: 4 }, signal);
    expect(harness.contentCalls).toHaveLength(2);
    harness.contentCalls[0]?.resolve({
      ok: true,
      value: { text: 'old', byteLength: 3 },
    });
    harness.contentCalls[1]?.resolve({
      ok: true,
      value: { text: 'new', byteLength: 3 },
    });
    expect(await first).toEqual({
      ok: true,
      value: { text: 'old', byteLength: 3 },
    });
    expect(await second).toEqual({
      ok: true,
      value: { text: 'new', byteLength: 3 },
    });
  });

  it('passes extra host source provenance through both client read methods intact', async () => {
    const harness = createTranscriptHarness();
    const store = createDelegationPagesStore(harness.client);
    const source = {
      ...SOURCE,
      standalone: { projectLocalId: 'owner-project' },
    };
    const signal = new AbortController().signal;
    await store.getState().readPage(pageRequest('newest', 1, source), signal);
    await store.getState().readContent(
      {
        ...source,
        target: TARGET,
        messageId: 'result-row',
        blockOrdinal: 3,
        field: 'output',
        offset: 0,
        limit: 65536,
      },
      signal,
    );
    expect(harness.pageCalls[0]?.request).toMatchObject({
      standalone: { projectLocalId: 'owner-project' },
    });
    expect(harness.contentCalls[0]?.request).toMatchObject({
      standalone: { projectLocalId: 'owner-project' },
    });
  });

  it('keeps cache, fence, and body-flight identity separate for full source provenance', async () => {
    const harness = createTranscriptHarness({
      deferContent: true,
      deferPages: true,
    });
    const state = createDelegationPagesStore(harness.client).getState();
    const sourceA = {
      ...SOURCE,
      standalone: { projectLocalId: 'owner-project' },
      ownerHint: undefined,
    };
    const sourceB = {
      ...SOURCE,
      standalone: { projectLocalId: 'owner-project' },
      ownerHint: 'undefined',
    };
    const equivalentSourceA = {
      ownerHint: undefined,
      standalone: { projectLocalId: 'owner-project' },
      scope: {
        chatId: SOURCE.scope.chatId,
        worktreeId: SOURCE.scope.worktreeId,
        workspaceId: SOURCE.scope.workspaceId,
      },
    };
    const pageA = state.readPage(
      pageRequest('newest', 1, sourceA, TARGET, 5),
      new AbortController().signal,
    );
    completePage(harness, 0, pageResult(5));
    await expect(pageA).resolves.toEqual(pageResult(5));
    const equivalentPage = state.readPage(
      pageRequest('newest', 1, equivalentSourceA, TARGET, 5),
      new AbortController().signal,
    );
    await expect(equivalentPage).resolves.toEqual(pageResult(5));
    const pageB = state.readPage(
      pageRequest('newest', 1, sourceB, TARGET, 1),
      new AbortController().signal,
    );
    completePage(harness, 1, pageResult(1));
    await expect(pageB).resolves.toEqual(pageResult(1));
    expect(harness.pageCalls).toHaveLength(2);

    const bodyBase = {
      target: TARGET,
      messageId: 'same-row',
      blockOrdinal: 0,
      field: 'text' as const,
      offset: 0,
      limit: 64,
      epoch: 1,
      streamRevision: 1,
    };
    const bodyA = state.readContent(
      { ...sourceA, ...bodyBase, streamRevision: 5 },
      new AbortController().signal,
    );
    const bodyB = state.readContent(
      { ...sourceB, ...bodyBase },
      new AbortController().signal,
    );
    const equivalentBody = state.readContent(
      { ...equivalentSourceA, ...bodyBase, streamRevision: 5 },
      new AbortController().signal,
    );
    expect(harness.contentCalls).toHaveLength(2);
    expect(harness.contentCalls[0]?.request).toMatchObject({
      standalone: { projectLocalId: 'owner-project' },
    });
    expect(harness.contentCalls[1]?.request).toMatchObject({
      standalone: { projectLocalId: 'owner-project' },
      ownerHint: 'undefined',
    });
    completeContent(harness, 0, contentResult());
    completeContent(harness, 1, contentResult());
    await Promise.all([bodyA, bodyB, equivalentBody]);
  });
  it('reads newest fresh without a revision on re-expand but keeps revision and cursor cache controls', async () => {
    const harness = createTranscriptHarness({ deferPages: true });
    const store = createDelegationPagesStore(harness.client);
    const signal = new AbortController().signal;
    const request = pageRequest('newest', 1);
    const first = store.getState().readPage(request, signal);
    completePage(harness, 0, pageResult(7));
    await first;
    const reopened = store.getState().readPage(request, signal);
    expect(harness.pageCalls).toHaveLength(2);
    completePage(harness, 1, pageResult(8));
    await expect(reopened).resolves.toEqual(pageResult(8));
    const warm = store
      .getState()
      .readPage(pageRequest('newest', 1, SOURCE, TARGET, 8), signal);
    await expect(warm).resolves.toEqual(pageResult(8));
    expect(harness.pageCalls).toHaveLength(2);
    const older = store.getState().readPage(pageRequest('older', 1), signal);
    completePage(harness, 2, pageResult(8));
    await older;
    await store.getState().readPage(pageRequest('older', 1), signal);
    expect(harness.pageCalls).toHaveLength(3);
  });
  it('deduplicates an exact page request and shares the resolved page', async () => {
    const harness = createTranscriptHarness({ deferPages: true });
    const store = createDelegationPagesStore(harness.client);
    const signalA = new AbortController().signal;
    const signalB = new AbortController().signal;
    const request = pageRequest('newest', 1);

    const first = store.getState().readPage(request, signalA);
    const second = store.getState().readPage(request, signalB);

    expect(harness.pageCalls).toHaveLength(1);
    expect(harness.pageCalls[0]?.request).toEqual({
      ...SOURCE,
      target: TARGET,
    });
    completePage(harness, 0, pageResult(7));
    await expect(first).resolves.toEqual(pageResult(7));
    await expect(second).resolves.toEqual(pageResult(7));
  });

  it('keeps the 30 and 65 consumer request bursts within the permit and queue bounds', async () => {
    const thirtyHarness = createTranscriptHarness();
    const thirtyStore = createDelegationPagesStore(thirtyHarness.client);
    const thirtyResults = await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        thirtyStore
          .getState()
          .readPage(
            pageRequest('newest', 1, SOURCE, targetFor(index)),
            new AbortController().signal,
          ),
      ),
    );

    expect(thirtyHarness.pageCalls).toHaveLength(30);
    expect(thirtyResults).toHaveLength(30);
    expect(thirtyResults.every((result) => result.ok)).toBe(true);

    const sixtyFiveHarness = createTranscriptHarness({ deferPages: true });
    const sixtyFiveStore = createDelegationPagesStore(sixtyFiveHarness.client);
    const sixtyFiveReads = Array.from({ length: 65 }, (_, index) =>
      sixtyFiveStore
        .getState()
        .readPage(
          pageRequest('newest', 1, SOURCE, targetFor(index)),
          new AbortController().signal,
        ),
    );

    expect(sixtyFiveHarness.pageCalls).toHaveLength(2);
    for (let index = 0; index < 34; index += 2) {
      completePage(sixtyFiveHarness, index, pageResult(1));
      completePage(sixtyFiveHarness, index + 1, pageResult(1));
      await Promise.resolve();
      await Promise.resolve();
    }
    const sixtyFiveResults = await Promise.all(sixtyFiveReads);
    expect(sixtyFiveHarness.pageCalls).toHaveLength(34);
    expect(sixtyFiveResults).toHaveLength(65);
    expect(sixtyFiveResults.filter((result) => result.ok)).toHaveLength(34);
    expect(
      sixtyFiveResults.filter(
        (result) => !result.ok && result.kind === 'failed',
      ),
    ).toHaveLength(31);
  });

  it('does not refetch when an LRU page is evicted unless it is read again', async () => {
    const harness = createTranscriptHarness();
    const store = createDelegationPagesStore(harness.client);
    const signal = new AbortController().signal;

    for (let index = 0; index < 25; index += 1) {
      await store.getState().readPage(pageRequest(`cursor-${index}`), signal);
    }

    expect(harness.pageCalls).toHaveLength(25);
    await store.getState().readPage(pageRequest('cursor-24'), signal);
    expect(harness.pageCalls).toHaveLength(25);
    await store.getState().readPage(pageRequest('cursor-0'), signal);
    expect(harness.pageCalls).toHaveLength(26);
  });

  it('evicts pages by the UTF-8 reply byte bound independently of page count', async () => {
    const harness = createTranscriptHarness({ deferPages: true });
    const store = createDelegationPagesStore(harness.client);
    const signal = new AbortController().signal;
    const payload = 'x'.repeat(5_500_000);
    const largePage: DelegationPage = {
      rows: [
        {
          id: 'large-row',
          role: 'assistant',
          timestamp: 1,
          row: { output: payload },
        },
      ],
      transcriptRevision: 1,
    };

    for (let index = 1; index <= 3; index += 1) {
      const result = store
        .getState()
        .readPage(pageRequest(`large-${index}`), signal);
      completePage(harness, index - 1, { ok: true, value: largePage });
      await expect(result).resolves.toEqual({ ok: true, value: largePage });
    }

    expect(harness.pageCalls).toHaveLength(3);
    await store.getState().readPage(pageRequest('large-3'), signal);
    expect(harness.pageCalls).toHaveLength(3);
    const evicted = store.getState().readPage(pageRequest('large-1'), signal);
    expect(harness.pageCalls).toHaveLength(4);
    completePage(harness, 3, { ok: true, value: largePage });
    await evicted;
  });

  it('removes a queued read when its last caller aborts', async () => {
    const harness = createTranscriptHarness({ deferPages: true });
    const store = createDelegationPagesStore(harness.client);
    const first = store
      .getState()
      .readPage(pageRequest('first'), new AbortController().signal);
    const second = store
      .getState()
      .readPage(pageRequest('second'), new AbortController().signal);
    const queuedController = new AbortController();
    const queued = store
      .getState()
      .readPage(pageRequest('queued'), queuedController.signal);

    expect(harness.pageCalls).toHaveLength(2);
    queuedController.abort();
    await expect(queued).resolves.toEqual({ ok: false, kind: 'cancelled' });
    completePage(harness, 0, pageResult(1));
    completePage(harness, 1, pageResult(1));
    await Promise.all([first, second]);
    expect(harness.pageCalls).toHaveLength(2);
  });

  it('holds a permit until the client promise settles after a caller aborts', async () => {
    const harness = createTranscriptHarness({ deferPages: true });
    const store = createDelegationPagesStore(harness.client);
    const abortedController = new AbortController();
    const aborted = store
      .getState()
      .readPage(pageRequest('aborted'), abortedController.signal);
    const second = store
      .getState()
      .readPage(pageRequest('second'), new AbortController().signal);
    const queued = store
      .getState()
      .readPage(pageRequest('queued'), new AbortController().signal);

    expect(harness.pageCalls).toHaveLength(2);
    abortedController.abort();
    await expect(aborted).resolves.toEqual({ ok: false, kind: 'cancelled' });
    expect(harness.pageCalls[0]?.signal.aborted).toBe(true);
    expect(harness.pageCalls).toHaveLength(2);

    completePage(harness, 0, pageResult(1));
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.pageCalls).toHaveLength(3);
    completePage(harness, 1, pageResult(1));
    completePage(harness, 2, pageResult(1));
    await Promise.all([second, queued]);

    const retryAbortedRequest = store
      .getState()
      .readPage(pageRequest('aborted'), new AbortController().signal);
    expect(harness.pageCalls).toHaveLength(4);
    completePage(harness, 3, pageResult(1));
    await expect(retryAbortedRequest).resolves.toEqual(pageResult(1));
  });

  it('shares the two permits between transcript pages and content ranges', async () => {
    const harness = createTranscriptHarness({
      deferPages: true,
      deferContent: true,
    });
    const store = createDelegationPagesStore(harness.client);
    const signal = new AbortController().signal;
    const first = store.getState().readPage(pageRequest('one'), signal);
    const second = store.getState().readPage(pageRequest('two'), signal);
    const contentRequest: TranscriptContentRequest = {
      ...SOURCE,
      target: TARGET,
      messageId: 'message-1',
      blockOrdinal: 0,
      field: 'output',
      offset: 0,
      limit: 65_536,
    };
    const content = store.getState().readContent(contentRequest, signal);

    expect(harness.pageCalls).toHaveLength(2);
    expect(harness.contentCalls).toHaveLength(0);
    completePage(harness, 0, pageResult(1));
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.contentCalls).toHaveLength(1);
    completePage(harness, 1, pageResult(1));
    completeContent(harness, 0, contentResult());
    await Promise.all([first, second, content]);
  });

  it('uses a new epoch for identical source, target, and revision hints', async () => {
    const harness = createTranscriptHarness({ deferPages: true });
    const store = createDelegationPagesStore(harness.client);
    const signal = new AbortController().signal;
    const oldEpochPending = store
      .getState()
      .readPage(pageRequest('newest', 10, SOURCE, TARGET, 7), signal);
    const afterEpochBump = store
      .getState()
      .readPage(pageRequest('newest', 11, SOURCE, TARGET, 7), signal);
    const currentEpochPage: TranscriptReadResult<DelegationPage> = {
      ok: true,
      value: {
        rows: [
          {
            id: 'current-epoch-row',
            role: 'assistant',
            timestamp: 11,
            row: { output: 'current epoch body' },
          },
        ],
        transcriptRevision: 7,
      },
    };
    const oldEpochPage: TranscriptReadResult<DelegationPage> = {
      ok: true,
      value: {
        rows: [
          {
            id: 'old-epoch-row',
            role: 'assistant',
            timestamp: 10,
            row: { output: 'old epoch body' },
          },
        ],
        transcriptRevision: 7,
      },
    };
    expect(harness.pageCalls).toHaveLength(2);
    completePage(harness, 1, currentEpochPage);
    await expect(afterEpochBump).resolves.toEqual(currentEpochPage);
    completePage(harness, 0, oldEpochPage);
    await expect(oldEpochPending).resolves.toEqual(oldEpochPage);

    const currentEpochWarm = await store
      .getState()
      .readPage(pageRequest('newest', 11, SOURCE, TARGET, 7), signal);
    expect(currentEpochWarm).toEqual(currentEpochPage);
    expect(harness.pageCalls).toHaveLength(2);
  });

  it('prunes settled hints with evicted pages after 125 distinct streams', async () => {
    const harness = createTranscriptHarness({ deferPages: true });
    const store = createDelegationPagesStore(harness.client);
    const signal = new AbortController().signal;

    for (let index = 0; index < 125; index += 1) {
      const revision = index === 0 ? 100 : 1;
      const request = store
        .getState()
        .readPage(
          pageRequest('newest', 2, SOURCE, targetFor(index), revision),
          signal,
        );
      completePage(harness, index, pageResult(revision));
      await expect(request).resolves.toEqual(pageResult(revision));
    }

    // The oldest target's revision 100 hint must not outlive its evicted page.
    // A fresh low-revision response is accepted only if that hint was pruned.
    const firstTargetAfterEviction = store
      .getState()
      .readPage(pageRequest('newest', 2, SOURCE, targetFor(0), 1), signal);
    expect(harness.pageCalls).toHaveLength(126);
    completePage(harness, 125, pageResult(1));
    await expect(firstTargetAfterEviction).resolves.toEqual(pageResult(1));
  });

  it('invalidates and fences older pages on a newer stream revision hint', async () => {
    const harness = createTranscriptHarness({ deferPages: true });
    const store = createDelegationPagesStore(harness.client);
    const signal = new AbortController().signal;
    const cached = store
      .getState()
      .readPage(pageRequest('newest', 2, SOURCE, TARGET, 4), signal);
    completePage(harness, 0, pageResult(4));
    await expect(cached).resolves.toEqual(pageResult(4));

    const pendingOlder = store
      .getState()
      .readPage(pageRequest('older-cursor', 2, SOURCE, TARGET, 4), signal);
    const newerHint = store
      .getState()
      .readPage(pageRequest('newest', 2, SOURCE, TARGET, 5), signal);
    expect(harness.pageCalls).toHaveLength(3);

    completePage(harness, 1, pageResult(4));
    await expect(pendingOlder).resolves.toEqual({
      ok: false,
      kind: 'stale',
    });
    completePage(harness, 2, pageResult(5));
    await expect(newerHint).resolves.toEqual(pageResult(5));

    const olderHintCannotDowngrade = await store
      .getState()
      .readPage(pageRequest('newest', 2, SOURCE, TARGET, 4), signal);
    expect(olderHintCannotDowngrade).toEqual({ ok: false, kind: 'stale' });
    expect(harness.pageCalls).toHaveLength(3);
  });

  it('advances the target fence to a page response newer than its hint', async () => {
    const harness = createTranscriptHarness({ deferPages: true });
    const state = createDelegationPagesStore(harness.client).getState();
    const first = state.readPage(
      pageRequest('newest', 1, SOURCE, TARGET, 4),
      new AbortController().signal,
    );
    completePage(harness, 0, pageResult(5));
    await expect(first).resolves.toEqual(pageResult(5));

    const regressingPage = await state.readPage(
      pageRequest('newest', 1, SOURCE, TARGET, 4),
      new AbortController().signal,
    );
    const regressingBlocks = await state.readBlocks(
      { ...blockRequest('same-target'), streamRevisionHint: 4 },
      new AbortController().signal,
    );
    const regressingBody = await state.readContent(
      {
        ...SOURCE,
        target: TARGET,
        messageId: 'same-target',
        blockOrdinal: 0,
        field: 'text',
        offset: 0,
        limit: 64,
        epoch: 1,
        streamRevision: 4,
      },
      new AbortController().signal,
    );

    expect(regressingPage).toEqual({ ok: false, kind: 'stale' });
    expect(regressingBlocks).toEqual({ ok: false, kind: 'stale' });
    expect(regressingBody).toEqual({ ok: false, kind: 'stale' });
    expect(harness.pageCalls).toHaveLength(1);
    expect(harness.blockCalls).toHaveLength(0);
    expect(harness.contentCalls).toHaveLength(0);
  });

  it('fences older block and body work when the page revision advances', async () => {
    const harness = createTranscriptHarness({
      deferPages: true,
      deferBlocks: true,
      deferContent: true,
    });
    const state = createDelegationPagesStore(harness.client).getState();
    const signal = new AbortController().signal;
    const olderBlocks = state.readBlocks(
      { ...blockRequest('retained-row'), streamRevisionHint: 4 },
      signal,
    );
    const bodyRequest = {
      ...SOURCE,
      target: TARGET,
      messageId: 'retained-row',
      blockOrdinal: 0,
      field: 'text' as const,
      offset: 0,
      limit: 64,
      epoch: 1,
      streamRevision: 4,
    };
    const olderBody = state.readContent(bodyRequest, signal);
    const newestPage = state.readPage(
      pageRequest('newest', 1, SOURCE, TARGET, 5),
      signal,
    );
    const newestBody = state.readContent(
      { ...bodyRequest, streamRevision: 5 },
      signal,
    );

    const oldBlockCall = harness.blockCalls[0];
    if (!oldBlockCall) {
      throw new Error('Older block read was not started.');
    }
    oldBlockCall.resolve(blockResult('retained-row', 4, 'old-block'));
    const olderBlocksResult = await olderBlocks;

    const newestPageCall = harness.pageCalls[0];
    if (!newestPageCall) {
      throw new Error('Newest page read was not started.');
    }
    newestPageCall.resolve(pageResult(5));
    const newestPageResult = await newestPage;

    const oldBodyCall = harness.contentCalls[0];
    if (!oldBodyCall) {
      throw new Error('Older body read was not started.');
    }
    oldBodyCall.resolve({
      ok: true,
      value: { text: 'old-body', byteLength: 8 },
    });
    const olderBodyResult = await olderBody;

    const hasNewBodyCall = harness.contentCalls[1] !== undefined;
    const newestBodyCall = harness.contentCalls[1];
    if (newestBodyCall) {
      newestBodyCall.resolve({
        ok: true,
        value: { text: 'new-body', byteLength: 8 },
      });
    }
    const newestBodyResult = await newestBody;

    expect(olderBlocksResult).toEqual({ ok: false, kind: 'stale' });
    expect(olderBodyResult).toEqual({ ok: false, kind: 'stale' });
    expect(newestPageResult).toEqual(pageResult(5));
    expect(hasNewBodyCall).toBe(true);
    expect(harness.contentCalls).toHaveLength(2);
    expect(harness.contentCalls[1]?.request).not.toHaveProperty(
      'streamRevision',
    );
    expect(newestBodyResult).toEqual({
      ok: true,
      value: { text: 'new-body', byteLength: 8 },
    });
  });

  it('keeps the advanced fence through old-job invalidation before page admission', async () => {
    const harness = createTranscriptHarness({
      deferPages: true,
      deferContent: true,
    });
    const state = createDelegationPagesStore(harness.client).getState();
    const signal = new AbortController().signal;
    const olderBody = state.readContent(
      {
        ...SOURCE,
        target: TARGET,
        messageId: 'same-row',
        blockOrdinal: 0,
        field: 'text',
        offset: 0,
        limit: 64,
        epoch: 1,
        streamRevision: 4,
      },
      signal,
    );
    const newerPage = state.readPage(
      pageRequest('newest', 1, SOURCE, TARGET, 5),
      signal,
    );

    completePage(harness, 0, pageResult(4));

    await expect(olderBody).resolves.toEqual({ ok: false, kind: 'stale' });
    await expect(newerPage).resolves.toEqual({ ok: false, kind: 'stale' });
    completeContent(harness, 0, contentResult());
  });

  it('advances and prunes the fence for a block-only target lifetime', async () => {
    const harness = createTranscriptHarness({ deferBlocks: true });
    const state = createDelegationPagesStore(harness.client).getState();
    const signal = new AbortController().signal;
    const newestBlocks = state.readBlocks(
      { ...blockRequest('block-only-row'), streamRevisionHint: 100 },
      signal,
    );
    const newestBlockCall = harness.blockCalls[0];
    if (!newestBlockCall) {
      throw new Error('Newest block read was not started.');
    }
    newestBlockCall.resolve(blockResult('block-only-row', 100));
    await newestBlocks;

    const regressingPage = state.readPage(
      pageRequest('newest', 1, SOURCE, TARGET, 99),
      signal,
    );
    const callsBeforeBlockEviction = harness.pageCalls.length;
    const regressingPageResult = await regressingPage;

    for (let index = 0; index < 24; index += 1) {
      const target = targetFor(index + 1);
      const blockCallIndex = harness.blockCalls.length;
      const blocks = state.readBlocks(
        {
          ...SOURCE,
          target,
          messageId: `block-only-${index}`,
          epoch: 1,
          streamRevisionHint: 1,
          firstBlockOrdinal: 0,
          limit: 16,
        },
        signal,
      );
      const blockCall = harness.blockCalls[blockCallIndex];
      if (!blockCall) {
        throw new Error(`Block cache fill ${index} was not started.`);
      }
      blockCall.resolve(blockResult(`block-only-${index}`, 1));
      const result = await blocks;
      expect(result.ok).toBe(true);
    }

    const readAfterEviction = state.readPage(
      pageRequest('newest', 1, SOURCE, TARGET, 1),
      signal,
    );
    const freshPageResult = await readAfterEviction;

    expect(regressingPageResult).toEqual({ ok: false, kind: 'stale' });
    expect(callsBeforeBlockEviction).toBe(0);
    expect(harness.pageCalls).toHaveLength(1);
    expect(freshPageResult).toEqual(pageResult(1));
  });

  it('retains a history fence without cache or jobs until the target lease ends', async () => {
    const harness = createTranscriptHarness({ deferPages: true });
    const state = createDelegationPagesStore(harness.client).getState();
    const lease = state.retainTarget;
    const advance = state.advanceRevision;
    expect(lease).toEqual(expect.any(Function));
    expect(advance).toEqual(expect.any(Function));
    if (!lease || !advance) return;

    const release = lease({ source: SOURCE, target: TARGET, epoch: 1 });
    advance({
      source: SOURCE,
      target: TARGET,
      epoch: 1,
      streamRevisionHint: 100,
    });
    const regressing = await state.readPage(
      pageRequest('newest', 1, SOURCE, TARGET, 99),
      new AbortController().signal,
    );
    expect(regressing).toEqual({ ok: false, kind: 'stale' });
    expect(harness.pageCalls).toHaveLength(0);

    release();
    const fresh = state.readPage(
      pageRequest('newest', 1, SOURCE, TARGET, 1),
      new AbortController().signal,
    );
    expect(harness.pageCalls).toHaveLength(1);
    completePage(harness, 0, pageResult(1));
    await expect(fresh).resolves.toEqual(pageResult(1));
  });

  it('prunes many unmounted target leases and their fence-only owners', async () => {
    const harness = createTranscriptHarness();
    const state = createDelegationPagesStore(harness.client).getState();
    const lease = state.retainTarget;
    const advance = state.advanceRevision;
    expect(lease).toEqual(expect.any(Function));
    expect(advance).toEqual(expect.any(Function));
    if (!lease || !advance) return;

    const targets = Array.from({ length: 40 }, (_, index) => targetFor(index));
    const releases = targets.map((target) => {
      const release = lease({ source: SOURCE, target, epoch: 1 });
      advance({
        source: SOURCE,
        target,
        epoch: 1,
        streamRevisionHint: 100,
      });
      return release;
    });
    for (const release of releases) release();

    for (const target of targets) {
      const result = await state.readPage(
        pageRequest('newest', 1, SOURCE, target, 1),
        new AbortController().signal,
      );
      expect(result).toEqual(pageResult(1));
    }
    expect(harness.pageCalls).toHaveLength(40);
  });

  it('ignores a pre-disposal lease release after the store is reactivated', async () => {
    const harness = createTranscriptHarness({ deferPages: true });
    const store = createDelegationPagesStore(harness.client);
    const firstState = store.getState();
    const lease = firstState.retainTarget;
    const advance = firstState.advanceRevision;
    expect(lease).toEqual(expect.any(Function));
    expect(advance).toEqual(expect.any(Function));
    if (!lease || !advance) return;

    const staleRelease = lease({ source: SOURCE, target: TARGET, epoch: 1 });
    advance({
      source: SOURCE,
      target: TARGET,
      epoch: 1,
      streamRevisionHint: 99,
    });
    store[CLIENT_STORE_DISPOSE]?.();
    store[CLIENT_STORE_ACTIVATE]?.();

    const activeState = store.getState();
    const activeLease = activeState.retainTarget?.({
      source: SOURCE,
      target: TARGET,
      epoch: 1,
    });
    activeState.advanceRevision?.({
      source: SOURCE,
      target: TARGET,
      epoch: 1,
      streamRevisionHint: 5,
    });
    staleRelease();
    const regressing = await activeState.readPage(
      pageRequest('newest', 1, SOURCE, TARGET, 4),
      new AbortController().signal,
    );
    expect(regressing).toEqual({ ok: false, kind: 'stale' });
    expect(harness.pageCalls).toHaveLength(0);
    activeLease?.();
  });

  it('clears only the released target and preserves a sibling target lease', async () => {
    const harness = createTranscriptHarness({
      deferBlocks: true,
      deferPages: true,
    });
    const state = createDelegationPagesStore(harness.client).getState();
    const lease = state.retainTarget;
    expect(lease).toEqual(expect.any(Function));
    if (!lease) return;

    const releaseFirst = lease({ source: SOURCE, target: TARGET, epoch: 1 });
    const secondTarget = targetFor(2);
    const releaseSecond = lease({
      source: SOURCE,
      target: secondTarget,
      epoch: 1,
    });
    const pendingBlocks = state.readBlocks(
      { ...blockRequest('leased-row'), streamRevisionHint: 100 },
      new AbortController().signal,
    );
    const pendingSiblingBlocks = state.readBlocks(
      {
        ...blockRequest('sibling-row'),
        target: secondTarget,
        streamRevisionHint: 101,
      },
      new AbortController().signal,
    );
    const blockCall = harness.blockCalls[0];
    const siblingBlockCall = harness.blockCalls[1];
    if (!blockCall) throw new Error('Leased block read was not started.');
    if (!siblingBlockCall)
      throw new Error('Sibling block read was not started.');

    releaseFirst();
    expect(blockCall.signal.aborted).toBe(true);
    expect(siblingBlockCall.signal.aborted).toBe(false);
    await expect(pendingBlocks).resolves.toEqual({
      ok: false,
      kind: 'cancelled',
    });
    blockCall.resolve(blockResult('leased-row', 100));
    siblingBlockCall.resolve(blockResult('sibling-row', 101));
    await expect(pendingSiblingBlocks).resolves.toEqual(
      blockResult('sibling-row', 101),
    );
    releaseSecond();

    const reactivatedLease = lease({
      source: SOURCE,
      target: TARGET,
      epoch: 1,
    });
    const freshPage = state.readPage(
      pageRequest('newest', 1, SOURCE, TARGET, 1),
      new AbortController().signal,
    );
    expect(harness.pageCalls).toHaveLength(1);
    completePage(harness, 0, pageResult(1));
    await expect(freshPage).resolves.toEqual(pageResult(1));
    reactivatedLease();
  });

  it('clears a cached block-only target when its final target lease ends', async () => {
    const harness = createTranscriptHarness({ deferBlocks: true });
    const state = createDelegationPagesStore(harness.client).getState();
    const lease = state.retainTarget;
    expect(lease).toEqual(expect.any(Function));
    if (!lease) return;

    const release = lease({ source: SOURCE, target: TARGET, epoch: 1 });
    const firstBlocks = state.readBlocks(
      { ...blockRequest('cached-only-row'), streamRevisionHint: 100 },
      new AbortController().signal,
    );
    const firstCall = harness.blockCalls[0];
    if (!firstCall) throw new Error('Initial block read was not started.');
    firstCall.resolve(blockResult('cached-only-row', 100));
    await expect(firstBlocks).resolves.toEqual(
      blockResult('cached-only-row', 100),
    );
    release();

    const reactivatedLease = lease({
      source: SOURCE,
      target: TARGET,
      epoch: 1,
    });
    const secondBlocks = state.readBlocks(
      { ...blockRequest('cached-only-row'), streamRevisionHint: 1 },
      new AbortController().signal,
    );
    expect(harness.blockCalls).toHaveLength(2);
    const secondCall = harness.blockCalls[1];
    if (!secondCall) throw new Error('Fresh block read was not started.');
    secondCall.resolve(blockResult('cached-only-row', 1));
    await expect(secondBlocks).resolves.toEqual(
      blockResult('cached-only-row', 1),
    );
    reactivatedLease();
  });

  it('preserves an unleased primary body read when a child target lease ends', async () => {
    const harness = createTranscriptHarness({ deferContent: true });
    const state = createDelegationPagesStore(harness.client).getState();
    const lease = state.retainTarget;
    expect(lease).toEqual(expect.any(Function));
    if (!lease) return;

    const releaseChild = lease({ source: SOURCE, target: TARGET, epoch: 1 });
    const primaryTarget: TranscriptContentRequest['target'] = {
      kind: 'primary',
      chatId: SOURCE.scope.chatId,
    };
    const primaryBody = state.readContent(
      {
        ...SOURCE,
        target: primaryTarget,
        messageId: 'primary-row',
        blockOrdinal: 0,
        field: 'text',
        offset: 0,
        limit: 64,
        epoch: 1,
        streamRevision: 7,
      },
      new AbortController().signal,
    );
    const primaryCall = harness.contentCalls[0];
    if (!primaryCall) throw new Error('Primary body read was not started.');

    releaseChild();
    expect(primaryCall.signal.aborted).toBe(false);
    primaryCall.resolve(contentResult());
    await expect(primaryBody).resolves.toEqual(contentResult());
  });

  it('prunes a removed source fence after its last in-flight read settles', async () => {
    const harness = createTranscriptHarness({ deferPages: true });
    const state = createDelegationPagesStore(harness.client).getState();
    const removedSource: TranscriptReadSource = {
      ...SOURCE,
      scope: { ...SOURCE.scope, worktreeId: 'removed-worktree' },
    };
    const sourceController = new AbortController();
    const removedRead = state.readPage(
      pageRequest('newest', 1, removedSource, TARGET, 100),
      sourceController.signal,
    );
    const sourceClientSignal = harness.pageCalls[0]?.signal;
    if (!sourceClientSignal) {
      throw new Error('Removed source read was not started.');
    }

    sourceController.abort();
    const removedReadResult = await removedRead;
    const sourceControllerWasAborted = sourceClientSignal.aborted;
    completePage(harness, 0, pageResult(100));
    await Promise.resolve();

    const survivingRead = state.readPage(
      pageRequest('newest', 1, removedSource, TARGET, 1),
      new AbortController().signal,
    );
    const hasSurvivingCall = harness.pageCalls[1] !== undefined;
    if (hasSurvivingCall) {
      completePage(harness, 1, pageResult(1));
    }
    const survivingReadResult = await survivingRead;

    expect(removedReadResult).toEqual({ ok: false, kind: 'cancelled' });
    expect(sourceControllerWasAborted).toBe(true);
    expect(hasSurvivingCall).toBe(true);
    expect(survivingReadResult).toEqual(pageResult(1));
  });

  it('rejects malformed stream revision hints without starting reads', async () => {
    const harness = createTranscriptHarness();
    const state = createDelegationPagesStore(harness.client).getState();
    const signal = new AbortController().signal;
    const invalidHints = [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1];
    const results = [];
    for (const hint of invalidHints) {
      results.push(
        await state.readPage(
          pageRequest('newest', 1, SOURCE, targetFor(hint), hint),
          signal,
        ),
      );
    }
    const invalidBlocks = await state.readBlocks(
      { ...blockRequest('invalid-hint-row'), streamRevisionHint: Number.NaN },
      signal,
    );
    const invalidBody = await state.readContent(
      {
        ...SOURCE,
        target: TARGET,
        messageId: 'invalid-hint-row',
        blockOrdinal: 0,
        field: 'text',
        offset: 0,
        limit: 64,
        epoch: 1,
        streamRevision: -1,
      },
      signal,
    );

    expect(results).toEqual(
      invalidHints.map(() => ({ ok: false, kind: 'stale' })),
    );
    expect(invalidBlocks).toEqual({ ok: false, kind: 'stale' });
    expect(invalidBody).toEqual({ ok: false, kind: 'stale' });
    expect(harness.pageCalls).toHaveLength(0);
    expect(harness.blockCalls).toHaveLength(0);
  });

  it('does not cache a stale result', async () => {
    const harness = createTranscriptHarness({ deferPages: true });
    const store = createDelegationPagesStore(harness.client);
    const signal = new AbortController().signal;
    const first = store.getState().readPage(pageRequest('newest'), signal);
    completePage(harness, 0, { ok: false, kind: 'stale' });
    await expect(first).resolves.toEqual({ ok: false, kind: 'stale' });

    const second = store.getState().readPage(pageRequest('newest'), signal);
    expect(harness.pageCalls).toHaveLength(2);
    completePage(harness, 1, pageResult(1));
    await expect(second).resolves.toEqual(pageResult(1));
  });

  it('clears account-owned fences and aborts page, block, and body jobs on disposal', async () => {
    const harness = createTranscriptHarness({
      deferPages: true,
      deferBlocks: true,
      deferContent: true,
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    let store: ClientStore<DelegationPagesState> | undefined;
    const capture = (captured: ClientStore<DelegationPagesState>): void => {
      store = captured;
    };

    act(() => {
      root.render(
        <CanopyClientProvider client={harness.client}>
          <ReaderStoreCapture onStore={capture} />
        </CanopyClientProvider>,
      );
    });
    const currentStore = store;
    if (!currentStore) {
      throw new Error('Provider did not create the transcript store.');
    }
    const accountLease = currentStore.getState().retainTarget?.({
      source: SOURCE,
      target: TARGET,
      epoch: 1,
    });
    const pending = currentStore
      .getState()
      .readPage(
        pageRequest('newest', 1, SOURCE, TARGET, 99),
        new AbortController().signal,
      );
    const pendingBlocks = currentStore
      .getState()
      .readBlocks(
        { ...blockRequest('account-row'), streamRevisionHint: 99 },
        new AbortController().signal,
      );
    const pendingBodyRequest = {
      ...SOURCE,
      target: TARGET,
      messageId: 'account-row',
      blockOrdinal: 0,
      field: 'text' as const,
      offset: 0,
      limit: 64,
      epoch: 1,
      streamRevision: 99,
    };
    const pendingBody = currentStore
      .getState()
      .readContent(pendingBodyRequest, new AbortController().signal);

    expect(harness.pageCalls).toHaveLength(1);
    const clientSignal = harness.pageCalls[0]?.signal;
    if (!clientSignal) {
      throw new Error('Transcript client was not given a signal.');
    }
    const blockSignal = harness.blockCalls[0]?.signal;
    if (!blockSignal) {
      throw new Error('Blocks client was not given a signal.');
    }
    act(() => root.unmount());
    await Promise.resolve();

    expect(clientSignal.aborted).toBe(true);
    expect(blockSignal.aborted).toBe(true);
    await expect(pending).resolves.toEqual({ ok: false, kind: 'cancelled' });
    await expect(pendingBlocks).resolves.toEqual({
      ok: false,
      kind: 'cancelled',
    });
    await expect(pendingBody).resolves.toEqual({
      ok: false,
      kind: 'cancelled',
    });
    completePage(harness, 0, pageResult(99));
    const firstBlockCall = harness.blockCalls[0];
    if (!firstBlockCall) {
      throw new Error('The original account block read was not started.');
    }
    firstBlockCall.resolve(blockResult('account-row', 99));
    await Promise.resolve();
    expect(currentStore[CLIENT_STORE_ACTIVATE]).toBeDefined();
    currentStore[CLIENT_STORE_ACTIVATE]?.();
    const afterLateSuccess = currentStore
      .getState()
      .readPage(
        pageRequest('newest', 1, SOURCE, TARGET, 1),
        new AbortController().signal,
      );
    expect(harness.pageCalls).toHaveLength(2);
    completePage(harness, 1, pageResult(1));
    await expect(afterLateSuccess).resolves.toEqual(pageResult(1));
    accountLease?.();
    container.remove();
  });
});
