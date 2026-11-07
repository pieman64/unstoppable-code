import type { ExecutionSecretBinding } from '@canopy/protocol/canopy-core';

import type { ExecutionSecretSource } from '../../../execution-secrets';
import { createWorkerScriptHandlers, type ScriptProcessOutcome } from '..';
import {
  SCOPE,
  createScriptWorkerFixture,
  describePosix,
  handlerContext,
  scriptParams,
  type ScriptWorkerFixture,
} from './script-worker-fixtures';

const binding: ExecutionSecretBinding = {
  name: 'S',
  source: {
    kind: 'stored-secret',
    family: 'environment',
    record: 'config',
    ref: `ssr1_${'a'.repeat(43)}`,
  },
};

describePosix('script worker host options', () => {
  let fixture: ScriptWorkerFixture;

  afterEach(async () => {
    await fixture.cleanup();
  });

  async function logLines(scriptKey = 'dev'): Promise<string[]> {
    const { run } = await fixture.worker.get({
      scope: SCOPE,
      scriptKey,
      tailLines: 50,
    });
    return run?.lines ?? [];
  }

  it("passes the request's host execution to resolvePlace", async () => {
    fixture = await createScriptWorkerFixture();
    const handlers = createWorkerScriptHandlers(fixture.worker);
    const result = await handlers.instructions['worker.script.execute'](
      scriptParams('printf %s "$MARK"'),
      handlerContext({
        execution: { childEnvironment: { PATH: '/usr/bin:/bin', MARK: 'x' } },
      }),
    );
    expect(result.status).toBe('success');
    expect(fixture.places[0]?.execution).toEqual({
      childEnvironment: { PATH: '/usr/bin:/bin', MARK: 'x' },
    });
    expect(await logLines()).toEqual(['x']);
  });

  it('keeps a detached run running when its request aborts', async () => {
    fixture = await createScriptWorkerFixture();
    const handlers = createWorkerScriptHandlers(fixture.worker, {
      detached: true,
    });
    const abort = new AbortController();
    const params = scriptParams('sleep 0.5; echo done');
    const started = new Promise<void>((resolve) => {
      fixture.worker.observe(params.executionId, {
        onProcessStarted: resolve,
      });
    });
    const running = handlers.instructions['worker.script.execute'](
      params,
      handlerContext({ signal: abort.signal }),
    );
    await started;
    abort.abort();
    await expect(running).resolves.toMatchObject({ status: 'success' });
  });

  it('stops an attached run when its request aborts', async () => {
    fixture = await createScriptWorkerFixture();
    const handlers = createWorkerScriptHandlers(fixture.worker);
    const abort = new AbortController();
    const params = scriptParams('sleep 30');
    const started = new Promise<void>((resolve) => {
      fixture.worker.observe(params.executionId, {
        onProcessStarted: resolve,
      });
    });
    const running = handlers.instructions['worker.script.execute'](
      params,
      handlerContext({ signal: abort.signal }),
    );
    await started;
    abort.abort();
    await expect(running).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('uses already redeemed secrets without redeeming again', async () => {
    const redeem = jest.fn<
      ReturnType<ExecutionSecretSource['redeem']>,
      Parameters<ExecutionSecretSource['redeem']>
    >(() => Promise.resolve({ env: {} }));
    fixture = await createScriptWorkerFixture({ secrets: { redeem } });
    const result = await fixture.worker.execute(
      scriptParams('printf %s "$S"', { secrets: [binding] }),
      undefined,
      { secrets: { env: { S: 'v' } } },
    );
    expect(result.status).toBe('success');
    expect(redeem).not.toHaveBeenCalled();
    expect(fixture.places[0]?.secrets).toEqual({ env: { S: 'v' } });
    expect(await logLines()).toEqual(['v']);
  });

  it('relays a remote run to its observers', async () => {
    fixture = await createScriptWorkerFixture();
    const events: string[] = [];
    const outcome: ScriptProcessOutcome = {
      success: true,
      exitCode: 0,
      output: 'a',
      timedOut: false,
      durationMs: 1,
      outputBytes: 1,
      outputTruncated: false,
      failure: null,
    };
    fixture.worker.observe('remote', {
      onProcessStarted: () => events.push('started'),
      onLines: (lines) => events.push(`lines:${lines.join(',')}`),
      onFinished: (finished) => events.push(`finished:${finished.output}`),
    });
    const relay = fixture.worker.relay('remote');
    relay.processStarted();
    relay.lines(['a']);
    relay.finished(outcome);
    expect(events).toEqual(['started', 'lines:a', 'finished:a']);
  });
});
