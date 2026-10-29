import type {
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import {
  armE2eClaudeQueryPrelude,
  createE2eClaudeQueryWithPrelude,
  readE2eClaudeQueryPreludeState,
  resetE2eClaudeQueryPreludes,
} from '../lib/e2e-claude-query-prelude';

const scope = {
  projectId: 'project',
  worktreeId: 'worktree',
  chatId: 'chat',
};

interface TestQuery extends AsyncGenerator<SDKMessage, void> {
  setModel(model: string): Promise<void>;
}

function makePrompt(onConsumed: () => void): AsyncGenerator<SDKUserMessage> {
  return (async function* (): AsyncGenerator<SDKUserMessage, void> {
    await Promise.resolve();
    onConsumed();
    const message: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: 'Follow up' },
      parent_tool_use_id: null,
      session_id: 'session',
    };
    yield message;
  })();
}

function makeQuery(
  prompt: AsyncIterable<SDKUserMessage>,
  setModel = jest.fn(async (model: string): Promise<void> => {
    void model;
    await Promise.resolve();
  }),
): TestQuery {
  const stream = (async function* (): AsyncGenerator<SDKMessage, void> {
    await prompt[Symbol.asyncIterator]().next();
    const result: SDKMessage = {
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 1,
      result: 'done',
      duration_ms: 1,
      duration_api_ms: 1,
      total_cost_usd: 0,
      stop_reason: null,
      usage: {
        cache_creation: null,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        fallback_credit: null,
        inference_geo: null,
        input_tokens: 0,
        iterations: null,
        output_tokens: 0,
        output_tokens_details: null,
        server_tool_use: null,
        service_tier: null,
        speed: null,
      },
      modelUsage: {},
      permission_denials: [],
      session_id: 'session',
      uuid: 'result',
    };
    yield result;
  })();
  const query: TestQuery = Object.assign(stream, { setModel });
  return query;
}

describe('E2E Claude query prelude fixture', () => {
  afterEach(() => resetE2eClaudeQueryPreludes());

  it('emits the raw prelude before releasing foreground prompt consumption', async () => {
    let promptConsumed = false;
    armE2eClaudeQueryPrelude(scope);
    const query = createE2eClaudeQueryWithPrelude({
      scope,
      prompt: makePrompt(() => {
        promptConsumed = true;
      }),
      createQuery: makeQuery,
    });

    const iterator = query[Symbol.asyncIterator]();
    const prelude = await iterator.next();
    expect(prelude.done).toBe(false);
    expect(prelude.value).toMatchObject({
      type: 'result',
      num_turns: 0,
      result: '',
      origin: { kind: 'task-notification' },
    });
    expect(promptConsumed).toBe(false);
    expect(readE2eClaudeQueryPreludeState(scope)).toMatchObject({
      consumedArmCount: 1,
      preludeEmittedCount: 1,
      promptConsumedCount: 0,
    });

    const completed = await iterator.next();
    expect(completed.done).toBe(false);
    expect(completed.value).toMatchObject({ type: 'result', result: 'done' });
    expect(promptConsumed).toBe(true);
    expect(readE2eClaudeQueryPreludeState(scope).promptConsumedCount).toBe(1);
    await iterator.return();
  });

  it('isolates exact scope and consumes an arm only once', async () => {
    armE2eClaudeQueryPrelude(scope);
    const otherScope = { ...scope, chatId: 'other-chat' };
    const other = createE2eClaudeQueryWithPrelude({
      scope: otherScope,
      prompt: makePrompt(() => undefined),
      createQuery: makeQuery,
    });
    const otherResult = await other.next();
    expect(otherResult.value).toMatchObject({ result: 'done' });

    const first = createE2eClaudeQueryWithPrelude({
      scope,
      prompt: makePrompt(() => undefined),
      createQuery: makeQuery,
    });
    const firstResult = await first.next();
    expect(firstResult.value).toMatchObject({ num_turns: 0 });
    await first.return();

    const second = createE2eClaudeQueryWithPrelude({
      scope,
      prompt: makePrompt(() => undefined),
      createQuery: makeQuery,
    });
    const secondResult = await second.next();
    expect(secondResult.value).toMatchObject({ result: 'done' });
    expect(readE2eClaudeQueryPreludeState(scope).consumedArmCount).toBe(1);
  });

  it('delegates Query methods and releases iterator resources on cancellation', async () => {
    const delegatedSetModel = jest.fn(async (model: string): Promise<void> => {
      void model;
      await Promise.resolve();
    });
    const prompt = makePrompt(() => undefined);
    armE2eClaudeQueryPrelude(scope);
    const query = createE2eClaudeQueryWithPrelude({
      scope,
      prompt,
      createQuery: (heldPrompt) => {
        return makeQuery(heldPrompt, delegatedSetModel);
      },
    });

    await query.setModel('claude-test');
    expect(delegatedSetModel).toHaveBeenCalledWith('claude-test');
    await query.next();
    await query.return();
    expect(readE2eClaudeQueryPreludeState(scope)).toMatchObject({
      cleanupCount: 1,
      promptGateReleaseCount: 1,
    });
  });
});
