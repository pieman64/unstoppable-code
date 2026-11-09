import type { ExecutionSecretBinding } from '@canopy/protocol/canopy-core';

import type { ExecutionSecretSource } from '../../../execution-secrets';
import {
  createWorkerScriptHandlers,
  type ScriptChildProcess,
  type ScriptProcessOutcome,
} from '..';
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

  it('a drain cancel waits for a run whose process has not started yet', async () => {
    // The daemon reports a script's pid only once its process start returns.
    let startProcess = (): void => undefined;
    const signals: NodeJS.Signals[] = [];
    fixture = await createScriptWorkerFixture({
      host: {
        spawn: (): ScriptChildProcess => {
          const closeListeners: Array<(code: number | null) => void> = [];
          let pid: number | undefined;
          startProcess = (): void => {
            pid = 4242;
            // A run already told to end exits as soon as it starts.
            if (signals.includes('SIGKILL'))
              closeListeners.forEach((listener) => listener(null));
          };
          return {
            get pid(): number | undefined {
              return pid;
            },
            stdout: null,
            stderr: null,
            onError: (): void => undefined,
            onClose: (listener): void => {
              closeListeners.push(listener);
            },
            killGroup: (signal): void => {
              signals.push(signal);
            },
          };
        },
      },
    });
    const params = scriptParams('true');
    const started = new Promise<void>((resolve) => {
      fixture.worker.observe(params.executionId, {
        onProcessStarted: resolve,
      });
    });
    const running = fixture.worker.execute(params);
    await started;
    let answered = false;
    const cancelled = fixture.worker
      .cancel({ scope: SCOPE, scriptKey: 'dev', drain: true })
      .then((result) => {
        answered = true;
        return result;
      });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(answered).toBe(false);
    expect(signals).toContain('SIGKILL');
    startProcess();
    await expect(cancelled).resolves.toMatchObject({
      stopped: [{ executionId: params.executionId, status: 'cancelled' }],
    });
    await running;
  });

  it("a drain cancel fails when a run's processes cannot be confirmed ended", async () => {
    fixture = await createScriptWorkerFixture({
      host: {
        drainOwnedProcess: (pid): Promise<void> => {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            // Already gone.
          }
          return Promise.reject(new Error('termination unconfirmed'));
        },
      },
    });
    const params = scriptParams('sleep 30');
    const started = new Promise<void>((resolve) => {
      fixture.worker.observe(params.executionId, {
        onProcessStarted: resolve,
      });
    });
    const running = fixture.worker.execute(params);
    await started;
    await expect(
      fixture.worker.cancel({ scope: SCOPE, scriptKey: 'dev', drain: true }),
    ).rejects.toMatchObject({ payload: { kind: 'internal' } });
    await running.catch(() => undefined);
  });

  it("a drain cancel fails when a not-yet-started run's forced end is unconfirmed", async () => {
    let startProcess = (): void => undefined;
    let forced = false;
    fixture = await createScriptWorkerFixture({
      host: {
        spawn: (): ScriptChildProcess => {
          const closeListeners: Array<(code: number | null) => void> = [];
          let pid: number | undefined;
          startProcess = (): void => {
            pid = 4243;
            if (forced) closeListeners.forEach((listener) => listener(null));
          };
          return {
            get pid(): number | undefined {
              return pid;
            },
            stdout: null,
            stderr: null,
            onError: (): void => undefined,
            onClose: (listener): void => {
              closeListeners.push(listener);
            },
            killGroup: (signal): void => {
              if (signal === 'SIGKILL') forced = true;
            },
            // The host could not confirm the forced end took the tree.
            forced: (): Promise<void> =>
              Promise.reject(new Error('termination unconfirmed')),
          };
        },
      },
    });
    const params = scriptParams('true');
    const started = new Promise<void>((resolve) => {
      fixture.worker.observe(params.executionId, {
        onProcessStarted: resolve,
      });
    });
    const running = fixture.worker.execute(params);
    await started;
    const cancelled = fixture.worker.cancel({
      scope: SCOPE,
      scriptKey: 'dev',
      drain: true,
    });
    startProcess();
    await expect(cancelled).rejects.toMatchObject({
      payload: { kind: 'internal' },
    });
    await running.catch(() => undefined);
  });
});
