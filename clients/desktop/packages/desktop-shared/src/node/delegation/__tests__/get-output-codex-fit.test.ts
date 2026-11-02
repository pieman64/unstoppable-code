import type {
  AgentDelegationResult,
  GetDelegateOutputValue,
} from '@canopy/protocol/delegation';
import {
  createDelegationProjection,
  type DelegationProjectionBroker,
} from '../projections';
import type { DelegationParentContext } from '../types';

const parent: DelegationParentContext = {
  harnessId: 'codex',
  projectId: 'project',
  worktreeId: 'worktree',
  chatId: 'chat',
  sessionKey: 'project/worktree/chat',
  turnId: 'turn',
  toolCallId: 'tool',
  runtimeGeneration: 1,
  depth: 0,
};
function output(text: string): AgentDelegationResult<GetDelegateOutputValue> {
  return {
    ok: true,
    value: {
      delegationId: 'child',
      currentRunGeneration: 1,
      currentStatus: 'completed',
      latestResultIndex: 1,
      result: {
        resultIndex: 1,
        runGeneration: 1,
        status: 'completed',
        finalText: text,
        outputTruncated: false,
      },
    },
  };
}
function stub(
  getOutput: DelegationProjectionBroker['getOutput'],
): DelegationProjectionBroker {
  return {
    getOutput,
    spawn: () =>
      Promise.resolve({
        ok: false,
        error: { code: 'runtime_error', message: 'unused', retryable: false },
      }),
    inspect: () => undefined,
    list: () => [],
    stop: () => ({
      ok: false,
      error: { code: 'runtime_error', message: 'unused', retryable: false },
    }),
  };
}
it('re-reads an oversized Codex answer at its pinned result index', async () => {
  const getOutput = jest
    .fn<
      ReturnType<DelegationProjectionBroker['getOutput']>,
      Parameters<DelegationProjectionBroker['getOutput']>
    >()
    .mockResolvedValueOnce(output('x'.repeat(1024 * 1024)))
    .mockResolvedValueOnce({
      ok: true,
      value: {
        delegationId: 'child',
        currentRunGeneration: 1,
        currentStatus: 'completed',
        latestResultIndex: 2,
        result: {
          resultIndex: 1,
          runGeneration: 1,
          status: 'completed',
          outputTruncated: false,
          answer: {
            role: 'final',
            text: 'x',
            encoding: 'utf8',
            byteLength: 1024 * 1024,
            offset: 0,
            nextOffset: 1,
          },
        },
      },
    });
  const projection = createDelegationProjection(
    'codex',
    'test',
    stub(getOutput),
  );
  const result = await projection.invoke(parent, 'test_get_delegate_output', {
    delegationId: 'child',
  });
  expect(getOutput).toHaveBeenCalledTimes(2);
  expect(getOutput).toHaveBeenLastCalledWith(parent, {
    delegationId: 'child',
    resultIndex: 1,
    offset: 0,
    limit: 65_536,
  });
  expect(result).toMatchObject({
    ok: true,
    value: { result: { resultIndex: 1, answer: { text: 'x' } } },
  });
});

// Real dispatcher acceptance is deliberately not replaced with the classifier oracle.
import { CodexHostToolDispatcher } from '../../codex-runtime/host-tools';
import * as hostTools from '../../codex-runtime/host-tools';
import * as pages from '../output-page';
import type { DynamicToolCallResponse } from '../../codex-runtime/generated/v2/DynamicToolCallResponse';
import type {
  DelegateOutputAnswerPage,
  GetDelegateOutputRequest,
} from '@canopy/protocol/delegation';

function envelope(
  result: AgentDelegationResult<unknown>,
): DynamicToolCallResponse {
  return {
    success: result.ok,
    contentItems: [{ type: 'inputText', text: JSON.stringify(result) }],
  };
}
function deliver(
  response: DynamicToolCallResponse,
): Promise<DynamicToolCallResponse> {
  return new CodexHostToolDispatcher(
    'thread',
    () => 'turn',
    {
      allowedTools: [{ namespace: null, tool: 'output' }],
      authorize: () => Promise.resolve(true),
      execute: () => Promise.resolve(response),
    },
    new AbortController().signal,
  ).run({
    params: {
      threadId: 'thread',
      turnId: 'turn',
      callId: 'call',
      namespace: null,
      tool: 'output',
      arguments: {},
    },
  });
}
function answer(
  result: AgentDelegationResult<unknown>,
): DelegateOutputAnswerPage {
  if (!result.ok || typeof result.value !== 'object' || result.value === null)
    throw new Error('No output value');
  // Validate through the typed fixture broker rather than casting the public unknown.
  const raw: unknown = result.value;
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !('result' in raw) ||
    typeof raw.result !== 'object' ||
    raw.result === null ||
    !('answer' in raw.result)
  )
    throw new Error('No answer');
  const page: unknown = raw.result.answer;
  if (
    typeof page !== 'object' ||
    page === null ||
    !('text' in page) ||
    typeof page.text !== 'string' ||
    !('offset' in page) ||
    typeof page.offset !== 'number' ||
    !('byteLength' in page) ||
    typeof page.byteLength !== 'number' ||
    !('encoding' in page) ||
    (page.encoding !== 'utf8' && page.encoding !== 'utf16le') ||
    !('role' in page) ||
    (page.role !== 'final' && page.role !== 'partial')
  )
    throw new Error('Invalid page');
  return {
    role: page.role,
    text: page.text,
    offset: page.offset,
    byteLength: page.byteLength,
    encoding: page.encoding,
    ...('nextOffset' in page && typeof page.nextOffset === 'number'
      ? { nextOffset: page.nextOffset }
      : {}),
    ...('notice' in page && typeof page.notice === 'string'
      ? { notice: page.notice }
      : {}),
  };
}
function legacyBroker(text: string): {
  broker: DelegationProjectionBroker;
  getOutput: jest.Mock<
    ReturnType<DelegationProjectionBroker['getOutput']>,
    Parameters<DelegationProjectionBroker['getOutput']>
  >;
} {
  const getOutput = jest.fn(
    (
      context: DelegationParentContext,
      request: GetDelegateOutputRequest,
    ): Promise<AgentDelegationResult<GetDelegateOutputValue>> => {
      void context;
      const original = output(text);
      if (!original.ok || !original.value.result)
        throw new Error('Bad fixture');
      if (request.offset === undefined && request.limit === undefined)
        return Promise.resolve(original);
      const page = pages.projectLegacyDelegateOutput(
        original.value.result,
        request.offset ?? 0,
        request.limit ?? 65_536,
      );
      return Promise.resolve(
        page.ok
          ? { ok: true, value: { ...original.value, result: page.value } }
          : page,
      );
    },
  );
  return { broker: stub(getOutput), getOutput };
}
afterEach(() => jest.restoreAllMocks());
it.each([
  ['63 KiB', 'x'.repeat(63 * 1024)],
  ['about 64 KiB UTF8', 'é'.repeat(32_768)],
  ['1 MiB', 'x'.repeat(1024 * 1024)],
  ['escaping-heavy', '\u0000"\\'.repeat(20_000)],
  ['astral-heavy', '😀'.repeat(32_768)],
  ['lone-surrogate', '\uD800😀'.repeat(24_000)],
])(
  'fits %s, uses bounded work and continues to exact reassembly',
  async (_name, text) => {
    const f = legacyBroker(text);
    const classify = jest.spyOn(hostTools, 'classifyCodexDynamicToolResult');
    const pageWork = jest.spyOn(pages, 'projectLegacyDelegateOutput');
    const projection = createDelegationProjection('codex', 'test', f.broker);
    let request: GetDelegateOutputRequest = { delegationId: 'child' };
    let joined = '';
    for (;;) {
      classify.mockClear();
      f.getOutput.mockClear();
      pageWork.mockClear();
      const reply = await projection.invoke(
        parent,
        'test_get_delegate_output',
        request,
      );
      const delivered = envelope(reply);
      expect(await deliver(delivered)).toEqual(delivered);
      // Projection calls are counted through the imported classifier boundary.
      expect(classify.mock.calls.length).toBeLessThanOrEqual(18);
      expect(f.getOutput.mock.calls.length).toBeLessThanOrEqual(2);
      if (_name === '63 KiB') {
        expect(reply).toEqual(output(text));
        expect(f.getOutput).toHaveBeenCalledTimes(1);
        expect(pageWork).not.toHaveBeenCalled();
        break;
      }
      const page = answer(reply);
      joined += page.text;
      if (page.nextOffset === undefined) {
        expect(joined).toBe(text);
        break;
      }
      const next = Array.from(text.slice(joined.length))[0];
      if (!next) throw new Error('Missing next character');
      const extended = { ...reply };
      if (
        !extended.ok ||
        typeof extended.value !== 'object' ||
        extended.value === null ||
        !('result' in extended.value) ||
        typeof extended.value.result !== 'object' ||
        extended.value.result === null
      )
        throw new Error('Bad reply');
      const { nextOffset, notice, ...pageFields } = page;
      const end = nextOffset + Buffer.byteLength(next, page.encoding);
      const longerPage = {
        ...pageFields,
        text: page.text + next,
        ...(end < page.byteLength ? { nextOffset: end, notice } : {}),
      };
      const candidate = {
        ok: true as const,
        value: {
          ...extended.value,
          result: { ...extended.value.result, answer: longerPage },
        },
      };
      expect((await deliver(envelope(candidate))).success).toBe(false);
      request = {
        delegationId: 'child',
        resultIndex: 1,
        offset: page.nextOffset,
        limit: 65_536,
      };
    }
  },
);
it.each([false, true])(
  'returns the pinned re-read failure without leaking old or newer text (historical=%s)',
  async (historical) => {
    const first = output('x'.repeat(1024 * 1024));
    if (!first.ok) throw new Error('fixture');
    const original = {
      ...first,
      value: { ...first.value, latestResultIndex: 2 },
    };
    const failure: AgentDelegationResult<GetDelegateOutputValue> = {
      ok: false,
      error: {
        code: 'parent_unavailable',
        message: 'No access',
        retryable: false,
      },
    };
    const read = jest
      .fn<
        ReturnType<DelegationProjectionBroker['getOutput']>,
        Parameters<DelegationProjectionBroker['getOutput']>
      >()
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(failure);
    const projection = createDelegationProjection('codex', 'test', stub(read));
    expect(
      await projection.invoke(parent, 'test_get_delegate_output', {
        delegationId: 'child',
        ...(historical ? { resultIndex: 1 } : {}),
      }),
    ).toBe(failure);
    expect(read).toHaveBeenLastCalledWith(parent, {
      delegationId: 'child',
      resultIndex: 1,
      offset: 0,
      limit: 65_536,
    });
  },
);

it.each([
  'outer-failure',
  'no-result',
  'no-answer',
  'empty-answer',
  'no-fitting-character',
])(
  'keeps C4 terminal fallback %s object and dispatcher denial unchanged',
  async (kind) => {
    const huge = 'm'.repeat(70_000);
    let original: AgentDelegationResult<GetDelegateOutputValue>;
    let pinned: AgentDelegationResult<GetDelegateOutputValue>;
    if (kind === 'outer-failure') {
      original = {
        ok: false,
        error: { code: 'runtime_error', message: huge, retryable: false },
      };
      pinned = original;
    } else if (kind === 'no-result') {
      original = {
        ok: true,
        value: {
          delegationId: huge,
          currentRunGeneration: 1,
          currentStatus: 'pending',
          latestResultIndex: null,
          result: null,
        },
      };
      pinned = original;
    } else {
      original = {
        ok: true,
        value: {
          delegationId: 'child',
          currentRunGeneration: 1,
          currentStatus: 'failed',
          latestResultIndex: 1,
          result: {
            resultIndex: 1,
            runGeneration: 1,
            status: 'failed',
            finalText: 'xxxx',
            outputTruncated: false,
            error: { code: 'runtime_error', message: huge, retryable: false },
          },
        },
      };
      pinned = {
        ok: true,
        value: {
          ...original.value,
          result: {
            resultIndex: 1,
            runGeneration: 1,
            status: 'failed',
            outputTruncated: false,
            error: { code: 'runtime_error', message: huge, retryable: false },
            ...(kind === 'no-answer'
              ? {}
              : {
                  answer: {
                    role: 'final',
                    text: kind === 'empty-answer' ? '' : 'xxxx',
                    encoding: 'utf8',
                    byteLength: kind === 'empty-answer' ? 0 : 4,
                    offset: 0,
                  },
                }),
          },
        },
      };
    }
    const read = jest
      .fn<
        ReturnType<DelegationProjectionBroker['getOutput']>,
        Parameters<DelegationProjectionBroker['getOutput']>
      >()
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(pinned);
    const projection = createDelegationProjection('codex', 'test', stub(read));
    const reply = await projection.invoke(parent, 'test_get_delegate_output', {
      delegationId: 'child',
    });
    expect(reply).toBe(original);
    expect(read).toHaveBeenCalledTimes(
      kind === 'outer-failure' || kind === 'no-result' ? 1 : 2,
    );
    const denial = {
      success: false,
      contentItems: [
        { type: 'inputText', text: 'Invalid or oversized host tool result.' },
      ],
    };
    expect(await deliver(envelope(reply))).toEqual(denial);
    expect(await deliver(envelope(original))).toEqual(denial);
  },
);
it('keeps an explicit range fallback relative to the new ranged envelope', async () => {
  const original: AgentDelegationResult<GetDelegateOutputValue> = {
    ok: true,
    value: {
      delegationId: 'child',
      currentRunGeneration: 1,
      currentStatus: 'failed',
      latestResultIndex: 1,
      result: {
        resultIndex: 1,
        runGeneration: 1,
        status: 'failed',
        outputTruncated: false,
        error: {
          code: 'runtime_error',
          message: 'm'.repeat(70_000),
          retryable: false,
        },
        answer: {
          role: 'final',
          text: 'abcd',
          encoding: 'utf8',
          byteLength: 8,
          offset: 0,
          nextOffset: 4,
          notice:
            'The answer continues. Call Get Delegate Output again with this resultIndex and offset set to nextOffset.',
        },
      },
    },
  };
  const read = jest.fn(() => Promise.resolve(original));
  const reply = await createDelegationProjection(
    'codex',
    'test',
    stub(read),
  ).invoke(parent, 'test_get_delegate_output', {
    delegationId: 'child',
    resultIndex: 1,
    limit: 4,
  });
  expect(reply).toBe(original);
  expect(read).toHaveBeenCalledTimes(1);
  expect(await deliver(envelope(reply))).toEqual({
    success: false,
    contentItems: [
      { type: 'inputText', text: 'Invalid or oversized host tool result.' },
    ],
  });
});
it('never exceeds a caller-supplied explicit limit', async () => {
  const f = legacyBroker('😀'.repeat(100));
  const reply = await createDelegationProjection(
    'codex',
    'test',
    f.broker,
  ).invoke(parent, 'test_get_delegate_output', {
    delegationId: 'child',
    limit: 5,
  });
  expect(answer(reply)).toEqual({
    role: 'final',
    text: '😀',
    encoding: 'utf8',
    byteLength: 400,
    offset: 0,
    nextOffset: 4,
    notice:
      'The answer continues. Call Get Delegate Output again with this resultIndex and offset set to nextOffset.',
  });
  expect(f.getOutput).toHaveBeenCalledTimes(1);
});
it.each([false, true])(
  'pins the old oversized body across a result arriving inside one call (historical=%s)',
  async (historical) => {
    const f = legacyBroker('o'.repeat(1024 * 1024));
    const originalRead = f.getOutput;
    let latest = 1;
    const racing = jest.fn(
      async (
        context: DelegationParentContext,
        request: GetDelegateOutputRequest,
      ): Promise<AgentDelegationResult<GetDelegateOutputValue>> => {
        const reply = await originalRead(context, request);
        if (!reply.ok) return reply;
        const current = {
          ok: true as const,
          value: { ...reply.value, latestResultIndex: latest },
        };
        latest = 2;
        return current;
      },
    );
    f.broker.getOutput = racing;
    const reply = await createDelegationProjection(
      'codex',
      'test',
      f.broker,
    ).invoke(parent, 'test_get_delegate_output', {
      delegationId: 'child',
      ...(historical ? { resultIndex: 1 } : {}),
    });
    expect(racing).toHaveBeenLastCalledWith(parent, {
      delegationId: 'child',
      resultIndex: 1,
      offset: 0,
      limit: 65_536,
    });
    expect(reply).toMatchObject({
      ok: true,
      value: {
        latestResultIndex: 2,
        result: { resultIndex: 1, answer: { byteLength: 1024 * 1024 } },
      },
    });
    expect(answer(reply).text).toMatch(/^o+$/);
  },
);

it('returns disappearance of the pinned index instead of the earlier output', async () => {
  const failure: AgentDelegationResult<GetDelegateOutputValue> = {
    ok: false,
    error: {
      code: 'invalid_request',
      message: 'Result index is not available.',
      retryable: false,
    },
  };
  const read = jest
    .fn<
      ReturnType<DelegationProjectionBroker['getOutput']>,
      Parameters<DelegationProjectionBroker['getOutput']>
    >()
    .mockResolvedValueOnce(output('x'.repeat(1024 * 1024)))
    .mockResolvedValueOnce(failure);
  const reply = await createDelegationProjection(
    'codex',
    'test',
    stub(read),
  ).invoke(parent, 'test_get_delegate_output', { delegationId: 'child' });
  expect(reply).toBe(failure);
  expect(read).toHaveBeenLastCalledWith(parent, {
    delegationId: 'child',
    resultIndex: 1,
    offset: 0,
    limit: 65_536,
  });
});
