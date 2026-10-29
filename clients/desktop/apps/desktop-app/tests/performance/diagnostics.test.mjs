import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  listUtilityCpuProfiles,
  startDiagnosticCapture,
  stopDiagnosticTrace,
} from './diagnostics.mjs';

async function loadDiagnosticBackend({
  mainSend,
  rendererSend,
  tracing,
  rendererAcquireError,
  boundTraceStop = false,
  mainClose = undefined,
  rendererDetach = undefined,
}) {
  const mainSession = {
    send: mainSend,
    closeCalls: 0,
    close() {
      this.closeCalls++;
      return mainClose?.();
    },
  };
  const rendererSession = {
    send: rendererSend,
    detachCalls: 0,
    async detach() {
      this.detachCalls++;
      return rendererDetach?.();
    },
  };
  const electronApp = {
    evaluate: async (operation, argument) =>
      operation({ contentTracing: tracing }, argument),
  };
  const page = {
    context: () => ({
      newCDPSession: async () => {
        if (rendererAcquireError) throw rendererAcquireError;
        return rendererSession;
      },
    }),
  };
  return {
    startDiagnosticCapture: (options) =>
      startDiagnosticCapture({
        ...options,
        dependencies: {
          connectInspector: async () => mainSession,
          newRendererSession: async () => {
            if (rendererAcquireError) throw rendererAcquireError;
            return rendererSession;
          },
          ...(boundTraceStop ? { traceStopTimeoutMs: 5 } : {}),
          ...(boundTraceStop ? { cleanupOperationTimeoutMs: 5 } : {}),
        },
      }),
    electronApp,
    page,
    mainSession,
    rendererSession,
  };
}

test('utility CPU profile discovery is bounded to sorted cpuprofile files', () => {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-perf-profiles-'),
  );
  try {
    writeFileSync(path.join(directory, 'CPU.2.cpuprofile'), '{}', 'utf8');
    writeFileSync(path.join(directory, 'CPU.1.cpuprofile'), '{}', 'utf8');
    writeFileSync(path.join(directory, 'notes.txt'), 'ignored', 'utf8');

    assert.deepEqual(listUtilityCpuProfiles(directory), [
      path.join(directory, 'CPU.1.cpuprofile'),
      path.join(directory, 'CPU.2.cpuprofile'),
    ]);
    assert.deepEqual(
      listUtilityCpuProfiles(path.join(directory, 'missing')),
      [],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('diagnostic acquisition failure closes the already acquired main inspector', async () => {
  const backend = await loadDiagnosticBackend({
    mainSend: async () => ({}),
    rendererSend: async () => ({}),
    rendererAcquireError: new Error('renderer acquisition failed'),
    tracing: {},
  });
  await assert.rejects(
    backend.startDiagnosticCapture({
      electronApp: backend.electronApp,
      page: backend.page,
      launch: {
        inspectorPort: 9229,
        outputDir: '/tmp/diagnostic-output',
        utilityCpuProfileDir: '/tmp/diagnostic-output/utility-cpu',
      },
      scenarioName: 'common-frame-trace',
      benchmarkContext: {},
    }),
    /renderer acquisition failed/,
  );
  assert.equal(backend.mainSession.closeCalls, 1);
  assert.equal(backend.rendererSession.detachCalls, 0);
});

test('diagnostic trace-start failure cleans both acquired sessions once', async () => {
  const backend = await loadDiagnosticBackend({
    mainSend: async () => ({}),
    rendererSend: async () => ({}),
    tracing: {
      async startRecording() {
        throw new Error('trace start failed');
      },
    },
  });
  await assert.rejects(
    backend.startDiagnosticCapture({
      electronApp: backend.electronApp,
      page: backend.page,
      launch: {
        inspectorPort: 9229,
        outputDir: '/tmp/diagnostic-output',
        utilityCpuProfileDir: '/tmp/diagnostic-output/utility-cpu',
      },
      scenarioName: 'common-frame-trace',
      benchmarkContext: {},
    }),
    /trace start failed/,
  );
  assert.equal(backend.mainSession.closeCalls, 1);
  assert.equal(backend.rendererSession.detachCalls, 1);
});

test('diagnostic component stop failures remain partial and cleanup is exactly once', async () => {
  const outputDir = mkdtempSync(path.join(os.tmpdir(), 'diagnostic-stop-'));
  try {
    const backend = await loadDiagnosticBackend({
      mainSend: async (method) => {
        if (method === 'Profiler.stop') throw new Error('main stop failed');
        return {};
      },
      rendererSend: async (method) => {
        if (method === 'Profiler.stop') throw new Error('renderer stop failed');
        return {};
      },
      tracing: {
        async startRecording() {},
        async stopRecording() {
          throw new Error('trace stop failed');
        },
      },
    });
    const capture = await backend.startDiagnosticCapture({
      electronApp: backend.electronApp,
      page: backend.page,
      launch: {
        inspectorPort: 9229,
        outputDir,
        utilityCpuProfileDir: path.join(outputDir, 'utility-cpu'),
      },
      scenarioName: 'common-frame-trace',
      benchmarkContext: {},
    });
    const result = await capture.stop();
    assert.equal(result.status, 'partial');
    assert.equal(result.artifacts.trace, undefined);
    assert.deepEqual(
      [...result.errors].sort(),
      [
        'Electron trace: trace stop failed',
        'main CPU profile: main stop failed',
        'renderer CPU profile: renderer stop failed',
      ].sort(),
    );
    assert.equal(backend.mainSession.closeCalls, 1);
    assert.equal(backend.rendererSession.detachCalls, 1);
    await assert.rejects(capture.stop(), /already stopped/);
    assert.equal(backend.mainSession.closeCalls, 1);
    assert.equal(backend.rendererSession.detachCalls, 1);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('bounded trace stop contains a never-settling operation and a late rejection', async () => {
  let rejectLate;
  const stopping = new Promise((_resolve, reject) => {
    rejectLate = reject;
  });
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    await assert.rejects(
      stopDiagnosticTrace({
        electronApp: { evaluate: () => stopping },
        tracePath: '/tmp/never-created-trace.json',
        timeoutMs: 5,
      }),
      /timed out.*Chromium stop is unconfirmed/,
    );
    rejectLate(new Error('late native rejection'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('diagnostic setup rolls back a started trace when renderer profiler start fails', async () => {
  const calls = [];
  const backend = await loadDiagnosticBackend({
    mainSend: async (method) => {
      calls.push(`main:${method}`);
      return {};
    },
    rendererSend: async (method) => {
      calls.push(`renderer:${method}`);
      if (method === 'Profiler.start') throw new Error('renderer start failed');
      return {};
    },
    tracing: {
      async startRecording() {
        calls.push('trace:start');
      },
      async stopRecording() {
        calls.push('trace:stop');
      },
    },
  });

  await assert.rejects(
    backend.startDiagnosticCapture({
      electronApp: backend.electronApp,
      page: backend.page,
      launch: {
        inspectorPort: 9229,
        outputDir: '/tmp/diagnostic-output',
        utilityCpuProfileDir: '/tmp/diagnostic-output/utility-cpu',
      },
      scenarioName: 'common-frame-trace',
      benchmarkContext: {},
    }),
    /renderer start failed/,
  );
  assert(calls.includes('trace:start'));
  assert(calls.includes('main:Profiler.start'));
  assert(calls.includes('renderer:Profiler.start'));
  assert.equal(calls.filter((entry) => entry === 'trace:stop').length, 1);
  assert.equal(backend.mainSession.closeCalls, 1);
  assert.equal(backend.rendererSession.detachCalls, 1);
});

test('diagnostic setup rollback bounds a never-settling trace stop before session cleanup', async () => {
  const backend = await loadDiagnosticBackend({
    boundTraceStop: true,
    mainSend: async () => ({}),
    rendererSend: async (method) => {
      if (method === 'Profiler.start') throw new Error('renderer start failed');
      return {};
    },
    tracing: {
      async startRecording() {},
      stopRecording: () => new Promise(() => {}),
    },
  });
  const startedAt = Date.now();
  await assert.rejects(
    backend.startDiagnosticCapture({
      electronApp: backend.electronApp,
      page: backend.page,
      launch: {
        inspectorPort: 9229,
        outputDir: '/tmp/diagnostic-output',
        utilityCpuProfileDir: '/tmp/diagnostic-output/utility-cpu',
      },
      scenarioName: 'common-frame-trace',
      benchmarkContext: {},
    }),
    /renderer start failed/,
  );
  assert(Date.now() - startedAt < 1000);
  assert.equal(backend.mainSession.closeCalls, 1);
  assert.equal(backend.rendererSession.detachCalls, 1);
});

test('diagnostic setup preserves primary failure with rollback and cleanup uncertainty', async () => {
  const backend = await loadDiagnosticBackend({
    boundTraceStop: true,
    mainSend: async () => ({}),
    rendererSend: async (method) => {
      if (method === 'Profiler.start')
        throw new Error('primary renderer start');
      return {};
    },
    tracing: {
      async startRecording() {},
      async stopRecording() {
        throw new Error('rollback trace failed');
      },
    },
    mainClose: () => {
      throw new Error('main close failed');
    },
    rendererDetach: () => new Promise(() => {}),
  });
  let failure;
  try {
    await Promise.race([
      backend.startDiagnosticCapture({
        electronApp: backend.electronApp,
        page: backend.page,
        launch: {
          inspectorPort: 9229,
          outputDir: '/tmp/diagnostic-output',
          utilityCpuProfileDir: '/tmp/diagnostic-output/utility-cpu',
        },
        scenarioName: 'common-frame-trace',
        benchmarkContext: {},
      }),
      delay(50).then(() => {
        throw new Error('rollback cleanup remained pending');
      }),
    ]);
  } catch (error) {
    failure = error;
  }
  assert.match(String(failure), /primary renderer start/);
  assert.equal(failure?.diagnosticCapture?.status, 'partial');
  assert.deepEqual(
    failure.diagnosticCapture.errors.sort(),
    [
      'Electron trace: rollback trace failed',
      'main inspector close: main close failed',
      'renderer CDP detach: timed out after 5 ms; completion is unknown',
    ].sort(),
  );
});

test('trace stop starts promptly when profiler stop and detach never settle', async () => {
  const outputDir = mkdtempSync(path.join(os.tmpdir(), 'diagnostic-bounded-'));
  const calls = [];
  const backend = await loadDiagnosticBackend({
    boundTraceStop: true,
    mainSend: async (method) => {
      if (method === 'Profiler.stop') return new Promise(() => {});
      return {};
    },
    rendererSend: async (method) => {
      if (method === 'Profiler.stop') return new Promise(() => {});
      return {};
    },
    tracing: {
      async startRecording() {},
      async stopRecording() {
        calls.push('trace:stop');
      },
    },
    rendererDetach: () => new Promise(() => {}),
  });
  try {
    const capture = await backend.startDiagnosticCapture({
      electronApp: backend.electronApp,
      page: backend.page,
      launch: {
        inspectorPort: 9229,
        outputDir,
        utilityCpuProfileDir: path.join(outputDir, 'utility-cpu'),
      },
      scenarioName: 'common-frame-trace',
      benchmarkContext: {},
    });
    const result = await Promise.race([
      capture.stop(),
      delay(50).then(() => {
        throw new Error('capture stop remained pending before trace stop');
      }),
    ]);
    assert.deepEqual(calls, ['trace:stop']);
    assert.equal(result.status, 'partial');
    assert(
      result.errors.some((error) => error.startsWith('main CPU profile:')),
    );
    assert(
      result.errors.some((error) => error.startsWith('renderer CPU profile:')),
    );
    assert(
      result.errors.some((error) => error.startsWith('renderer CDP detach:')),
    );
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});
