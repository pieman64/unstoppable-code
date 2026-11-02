/** @jest-environment jsdom */
// eslint-disable-next-line no-restricted-imports -- jsdom needs the real UTF-8 encoder for bounded reply validation (test only).
import { TextEncoder } from 'node:util';
Object.defineProperty(globalThis, 'TextEncoder', {
  configurable: true,
  value: TextEncoder,
});
import type {
  DelegationPageRequest,
  TranscriptContentRequest,
} from '@canopy/app-core';
import type { CanopyCoreRelayReply } from '../../../../shared/canopy-core-relay';
import { ipcTranscriptReadClient } from '../ipc-transcript-read-client';

const request: DelegationPageRequest = {
  scope: { workspaceId: 'workspace', worktreeId: 'worktree', chatId: 'chat' },
  target: {
    kind: 'delegation',
    chatId: 'chat',
    delegationId: 'delegate',
    runGeneration: 1,
  },
};
const content: TranscriptContentRequest = {
  ...request,
  messageId: 'row',
  blockOrdinal: 0,
  field: 'output',
  offset: 0,
  limit: 4096,
};
const page = {
  messages: [
    {
      id: 'row',
      role: 'assistant',
      timestamp: 10,
      blocks: [],
      truncated: true,
      blocksOmitted: { blockCount: 3 },
    },
    {
      id: 'ref',
      role: 'user',
      timestamp: 11,
      blocks: [],
      blocksRef: { blockCount: 2 },
    },
  ],
  totalMessages: 2,
  transcriptRevision: 7,
  cursor: 'older',
  runTruncated: true,
};
const invoke = jest.fn<Promise<CanopyCoreRelayReply>, [unknown]>();
const signal = (): AbortSignal => new AbortController().signal;
beforeEach(() => {
  invoke.mockReset();
  Object.defineProperty(window, 'canopyCore', {
    configurable: true,
    value: { invoke },
  });
});

it('unwraps and validates a page, mapping omission and block refs without losing the raw row', async () => {
  invoke.mockResolvedValue({ ok: true, value: page });
  expect(
    await ipcTranscriptReadClient.delegationPage(request, signal()),
  ).toEqual({
    ok: true,
    value: {
      rows: [
        {
          id: 'row',
          role: 'assistant',
          timestamp: 10,
          truncated: true,
          blocksPaged: { blockCount: 3 },
          row: page.messages[0],
        },
        {
          id: 'ref',
          role: 'user',
          timestamp: 11,
          blocksPaged: { blockCount: 2 },
          row: page.messages[1],
        },
      ],
      transcriptRevision: 7,
      cursor: 'older',
      runTruncated: true,
    },
  });
  expect(invoke).toHaveBeenCalledWith({
    kind: 'request',
    method: 'core.chat.transcript.page',
    params: request,
  });
});

it('maps the specific stale cursor code but not arbitrary failed preconditions', async () => {
  invoke.mockResolvedValue({
    ok: false,
    error: {
      kind: 'failed_precondition',
      code: 'core.chat.transcript.page.staleCursor',
      message: 'Private detail',
      retry: { kind: 'never' },
    },
  });
  expect(
    await ipcTranscriptReadClient.delegationPage(request, signal()),
  ).toEqual({ ok: false, kind: 'stale' });
  invoke.mockResolvedValue({
    ok: false,
    error: {
      kind: 'failed_precondition',
      message: 'Private detail',
      retry: { kind: 'never' },
    },
  });
  expect(
    await ipcTranscriptReadClient.delegationPage(request, signal()),
  ).toEqual({ ok: false, kind: 'failed' });
});

it('maps unavailable envelopes, failures and malformed successes without rejecting', async () => {
  invoke.mockResolvedValue({
    ok: false,
    error: {
      kind: 'unavailable',
      message: 'Private detail',
      retry: { kind: 'never' },
    },
  });
  expect(
    await ipcTranscriptReadClient.delegationPage(request, signal()),
  ).toEqual({ ok: false, kind: 'unavailable' });
  invoke.mockRejectedValue(new Error('Private detail'));
  expect(
    await ipcTranscriptReadClient.delegationPage(request, signal()),
  ).toEqual({ ok: false, kind: 'failed' });
  for (const value of [
    null,
    { ...page, transcriptRevision: -1 },
    { ...page, messages: [{ ...page.messages[0], truncated: 'yes' }] },
    {
      ...page,
      messages: [{ ...page.messages[1], blocksRef: { blockCount: -2 } }],
    },
  ]) {
    invoke.mockResolvedValue({ ok: true, value });
    expect(
      await ipcTranscriptReadClient.delegationPage(request, signal()),
    ).toEqual({ ok: false, kind: 'failed' });
  }
});

it('reports missing content support as unavailable, not a failure', async () => {
  invoke.mockResolvedValue({
    ok: false,
    error: {
      kind: 'capability_unavailable',
      message: 'Private detail',
      retry: { kind: 'never' },
    },
  });
  expect(await ipcTranscriptReadClient.content(content, signal())).toEqual({
    ok: false,
    kind: 'unavailable',
  });
});

it('validates and unwraps content', async () => {
  invoke.mockResolvedValue({
    ok: true,
    value: { text: 'hello', byteLength: 20, nextOffset: 5 },
  });
  expect(await ipcTranscriptReadClient.content(content, signal())).toEqual({
    ok: true,
    value: { text: 'hello', byteLength: 20, nextOffset: 5 },
  });
  expect(invoke).toHaveBeenCalledWith({
    kind: 'request',
    method: 'core.chat.content.read',
    params: content,
  });
  invoke.mockResolvedValue({
    ok: true,
    value: { text: 'hello', byteLength: -1 },
  });
  expect(await ipcTranscriptReadClient.content(content, signal())).toEqual({
    ok: false,
    kind: 'failed',
  });
});

it('fences aborts before invocation and after the uncancellable relay settles', async () => {
  const controller = new AbortController();
  controller.abort();
  expect(
    await ipcTranscriptReadClient.delegationPage(request, controller.signal),
  ).toEqual({ ok: false, kind: 'cancelled' });
  expect(invoke).not.toHaveBeenCalled();
  let finish: (reply: CanopyCoreRelayReply) => void = () => {
    throw new Error('Not started');
  };
  invoke.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const active = new AbortController();
  const result = ipcTranscriptReadClient.delegationPage(request, active.signal);
  active.abort();
  finish({ ok: true, value: page });
  expect(await result).toEqual({ ok: false, kind: 'cancelled' });
});

const blocksRequest = {
  ...request,
  messageId: 'row',
  firstBlockOrdinal: 42,
  limit: 2,
};
const boundedPage = {
  projection: 'bounded-v1',
  messageId: 'row',
  firstBlockOrdinal: 42,
  entries: [
    {
      kind: 'preview',
      ordinal: 42,
      block: { type: 'tool_result', output: 'cut' },
      omittedFields: ['output'],
    },
  ],
  blockCount: 44,
  nextBlockOrdinal: 43,
  cursor: 'next-block',
  transcriptRevision: 7,
};
it('reads bounded blocks with absolute ordinals through the dispatcher', async () => {
  invoke.mockResolvedValue({ ok: true, value: boundedPage });
  expect(await ipcTranscriptReadClient.blocks(blocksRequest, signal())).toEqual(
    {
      ok: true,
      value: {
        messageId: 'row',
        firstBlockOrdinal: 42,
        entries: [
          {
            kind: 'preview',
            ordinal: 42,
            block: { type: 'tool_result', output: 'cut' },
            omittedFields: ['output'],
          },
        ],
        blockCount: 44,
        nextBlockOrdinal: 43,
        cursor: 'next-block',
        transcriptRevision: 7,
      },
    },
  );
  expect(invoke).toHaveBeenCalledWith({
    kind: 'request',
    method: 'core.chat.transcript.blocks.page',
    params: { ...blocksRequest, projection: 'bounded-v1' },
  });
});
it('forwards primary logical content to its owner chat dispatcher', async () => {
  invoke.mockResolvedValue({
    ok: true,
    value: { text: 'tail', byteLength: 4 },
  });
  const primary: TranscriptContentRequest = {
    ...content,
    target: { kind: 'primary', chatId: 'chat' },
    fieldSource: 'logical',
  };
  expect(await ipcTranscriptReadClient.content(primary, signal())).toEqual({
    ok: true,
    value: { text: 'tail', byteLength: 4 },
  });
  expect(invoke).toHaveBeenCalledWith({
    kind: 'request',
    method: 'core.chat.content.read',
    params: primary,
  });
});
it('rejects raw or noncontiguous block replies', async () => {
  for (const value of [
    { ...boundedPage, entries: undefined, blocks: [] },
    { ...boundedPage, firstBlockOrdinal: 41 },
  ]) {
    invoke.mockResolvedValue({ ok: true, value });
    expect(
      await ipcTranscriptReadClient.blocks(blocksRequest, signal()),
    ).toEqual({ ok: false, kind: 'failed' });
  }
});
it('fences an aborted blocks reply until the relay settles', async () => {
  let finish: (reply: CanopyCoreRelayReply) => void = () => {};
  invoke.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const controller = new AbortController();
  const result = ipcTranscriptReadClient.blocks(
    blocksRequest,
    controller.signal,
  );
  controller.abort();
  finish({ ok: true, value: boundedPage });
  expect(await result).toEqual({ ok: false, kind: 'cancelled' });
});
