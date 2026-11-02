import type {
  ScriptDescriptor,
  ScriptRunResponse,
  ScriptRunSnapshot,
} from '@canopy/desktop-shared/types';
import type { ScriptDevServerPattern } from '@canopy/desktop-shared/scripts';
import {
  hasActiveSetupRun,
  hasActiveWorkspaceLaunchRun,
  isWorkspaceLaunchRun,
  useScriptsStore,
  flushPendingScriptOutputs,
} from '@/stores/scriptsStore';

const PROJECT_ID = 'project-1';
const WORKTREE_ID = 'worktree-1';
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  'window',
);

function makeScriptDescriptor(
  devServerPattern?: ScriptDevServerPattern,
): ScriptDescriptor {
  const descriptor: ScriptDescriptor = {
    scriptKey: 'project:launch',
    scriptName: 'launch',
    label: 'Launch',
    command: 'npm run dev',
    lifecycle: 'launch',
    target: 'project',
  };
  if (devServerPattern !== undefined) {
    descriptor.devServerPattern = devServerPattern;
  }
  return descriptor;
}

function makeSuccessResponse(): ScriptRunResponse {
  return {
    success: true,
    exitCode: 0,
    output: '',
    timedOut: false,
    durationMs: 1234,
  };
}

function makeSnapshot(
  script: ScriptDescriptor,
  overrides: Partial<ScriptRunSnapshot> = {},
): ScriptRunSnapshot {
  return {
    projectId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    script,
    invocation: 'manual-run',
    status: 'running',
    outputLines: [],
    exitCode: null,
    timedOut: false,
    durationMs: 0,
    startedAt: new Date(100).toISOString(),
    ...overrides,
  };
}

function mockLoadWorktreeScriptRuns(snapshots: ScriptRunSnapshot[]): void {
  const currentWindow = (
    globalThis as typeof globalThis & {
      window?: { api?: Record<string, unknown> };
    }
  ).window;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      ...(currentWindow ?? {}),
      api: {
        ...(currentWindow?.api ?? {}),
        loadWorktreeScriptRuns: jest.fn().mockResolvedValue(snapshots),
      },
    },
  });
}

describe('scriptsStore', () => {
  beforeEach(() => {
    useScriptsStore.setState({ runs: {} });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    useScriptsStore.setState({ runs: {} });
    if (originalWindowDescriptor) {
      Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  });

  it('clears prior output and resets the timestamp when rerunning a completed script', () => {
    const script = makeScriptDescriptor();
    const nowSpy = jest.spyOn(Date, 'now');

    nowSpy.mockReturnValueOnce(100);
    useScriptsStore.getState().startRun(PROJECT_ID, WORKTREE_ID, script);
    useScriptsStore.getState().appendOutput({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      script,
      invocation: 'manual-run',
      lines: ['first run output'],
    });
    flushPendingScriptOutputs();
    useScriptsStore
      .getState()
      .completeRun(
        PROJECT_ID,
        WORKTREE_ID,
        script.scriptKey,
        makeSuccessResponse(),
      );

    nowSpy.mockReturnValueOnce(200);
    useScriptsStore.getState().startRun(PROJECT_ID, WORKTREE_ID, script);

    const run =
      useScriptsStore.getState().runs[`${PROJECT_ID}/${WORKTREE_ID}`]?.[
        script.scriptKey
      ];

    expect(run?.status).toBe('running');
    expect(run?.outputLines).toEqual([]);
    expect(run?.startedAt).toBe(200);
  });

  it('reports whether markStopping transitioned a running script', () => {
    const script = makeScriptDescriptor();
    useScriptsStore.getState().startRun(PROJECT_ID, WORKTREE_ID, script);

    const firstTransition = useScriptsStore
      .getState()
      .markStopping(PROJECT_ID, WORKTREE_ID, script.scriptKey);
    const secondTransition = useScriptsStore
      .getState()
      .markStopping(PROJECT_ID, WORKTREE_ID, script.scriptKey);

    const run =
      useScriptsStore.getState().runs[`${PROJECT_ID}/${WORKTREE_ID}`]?.[
        script.scriptKey
      ];

    expect(firstTransition).toBe(true);
    expect(secondTransition).toBe(false);
    expect(run?.status).toBe('stopping');
  });

  it('completes an active script as stale when no backend process exists', () => {
    const script = makeScriptDescriptor();
    const nowSpy = jest.spyOn(Date, 'now');

    nowSpy.mockReturnValueOnce(100);
    useScriptsStore.getState().startRun(PROJECT_ID, WORKTREE_ID, script);
    useScriptsStore
      .getState()
      .markStopping(PROJECT_ID, WORKTREE_ID, script.scriptKey);

    nowSpy.mockReturnValueOnce(600);
    useScriptsStore
      .getState()
      .completeStaleRun(PROJECT_ID, WORKTREE_ID, script.scriptKey);

    const run =
      useScriptsStore.getState().runs[`${PROJECT_ID}/${WORKTREE_ID}`]?.[
        script.scriptKey
      ];

    expect(run?.status).toBe('failed');
    expect(run?.exitCode).toBeNull();
    expect(run?.timedOut).toBe(false);
    expect(run?.durationMs).toBe(500);
  });

  it('seeds devServerHits as an empty array on startRun', () => {
    const script = makeScriptDescriptor('https?://\\S+');
    useScriptsStore.getState().startRun(PROJECT_ID, WORKTREE_ID, script);
    const run =
      useScriptsStore.getState().runs[`${PROJECT_ID}/${WORKTREE_ID}`]?.[
        script.scriptKey
      ];
    expect(run?.devServerHits).toEqual([]);
    expect(run?.devServerPattern).toBe('https?://\\S+');
  });

  it('detects URLs in streamed output and dedupes across batches', () => {
    const script = makeScriptDescriptor({
      pattern: 'https?://\\S+',
      label: 'Web',
    });
    useScriptsStore.getState().startRun(PROJECT_ID, WORKTREE_ID, script);
    useScriptsStore.getState().appendOutput({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      script,
      invocation: 'manual-run',
      lines: ['Server listening on http://localhost:3000'],
    });
    flushPendingScriptOutputs();

    let run =
      useScriptsStore.getState().runs[`${PROJECT_ID}/${WORKTREE_ID}`]?.[
        script.scriptKey
      ];
    expect(run?.devServerHits).toHaveLength(1);
    expect(run?.devServerHits[0]).toMatchObject({
      url: 'http://localhost:3000/',
      label: 'Web',
    });

    // Second batch with the same URL should not produce a duplicate.
    useScriptsStore.getState().appendOutput({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      script,
      invocation: 'manual-run',
      lines: ['Reconnected to http://localhost:3000'],
    });
    flushPendingScriptOutputs();

    run =
      useScriptsStore.getState().runs[`${PROJECT_ID}/${WORKTREE_ID}`]?.[
        script.scriptKey
      ];
    expect(run?.devServerHits).toHaveLength(1);
  });

  it('applies pattern priority order to label detected URLs', () => {
    const script = makeScriptDescriptor([
      { pattern: '(https?://\\S+:3000\\S*)', label: 'App' },
      { pattern: '(https?://\\S+:3001\\S*)', label: 'API' },
    ]);
    useScriptsStore.getState().startRun(PROJECT_ID, WORKTREE_ID, script);
    useScriptsStore.getState().appendOutput({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      script,
      invocation: 'manual-run',
      lines: ['both http://localhost:3000/foo and http://localhost:3001/bar'],
    });
    flushPendingScriptOutputs();

    const run =
      useScriptsStore.getState().runs[`${PROJECT_ID}/${WORKTREE_ID}`]?.[
        script.scriptKey
      ];
    // First entry wins per line: only the App URL should be present.
    expect(run?.devServerHits).toHaveLength(1);
    expect(run?.devServerHits[0]).toMatchObject({
      label: 'App',
      url: 'http://localhost:3000/foo',
    });
  });

  it('clears devServerHits when a script is restarted', () => {
    const script = makeScriptDescriptor('https?://\\S+');
    useScriptsStore.getState().startRun(PROJECT_ID, WORKTREE_ID, script);
    useScriptsStore.getState().appendOutput({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      script,
      invocation: 'manual-run',
      lines: ['http://localhost:1234/'],
    });
    flushPendingScriptOutputs();
    useScriptsStore
      .getState()
      .completeRun(PROJECT_ID, WORKTREE_ID, script.scriptKey, {
        success: true,
        exitCode: 0,
        output: '',
        timedOut: false,
        durationMs: 10,
      });

    // Restart — hits should reset to empty.
    useScriptsStore.getState().startRun(PROJECT_ID, WORKTREE_ID, script);
    const run =
      useScriptsStore.getState().runs[`${PROJECT_ID}/${WORKTREE_ID}`]?.[
        script.scriptKey
      ];
    expect(run?.devServerHits).toEqual([]);
  });

  it('preserves devServerHits through completeRunFromEvent', () => {
    const script = makeScriptDescriptor('https?://\\S+');
    useScriptsStore.getState().startRun(PROJECT_ID, WORKTREE_ID, script);
    useScriptsStore.getState().appendOutput({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      script,
      invocation: 'manual-run',
      lines: ['http://localhost:4321'],
    });
    flushPendingScriptOutputs();

    useScriptsStore.getState().completeRunFromEvent({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      script,
      invocation: 'manual-run',
      result: {
        success: true,
        exitCode: 0,
        output: '',
        timedOut: false,
        durationMs: 50,
      },
    });

    const run =
      useScriptsStore.getState().runs[`${PROJECT_ID}/${WORKTREE_ID}`]?.[
        script.scriptKey
      ];
    expect(run?.status).toBe('success');
    expect(run?.devServerHits).toHaveLength(1);
    expect(run?.devServerHits[0].url).toBe('http://localhost:4321/');
  });

  it('retains the recent output tail after unload and ignores output while unloaded', () => {
    const script = makeScriptDescriptor();
    useScriptsStore.getState().startRun(PROJECT_ID, WORKTREE_ID, script);
    useScriptsStore.getState().appendOutput({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      script,
      invocation: 'manual-run',
      lines: ['visible output'],
    });
    flushPendingScriptOutputs();

    useScriptsStore.getState().unloadWorktreeRuns(PROJECT_ID, WORKTREE_ID);

    // Switching away keeps the running box populated with its recent tail so
    // returning to the worktree is not a blank flash.
    let run =
      useScriptsStore.getState().runs[`${PROJECT_ID}/${WORKTREE_ID}`]?.[
        script.scriptKey
      ];
    expect(run?.status).toBe('running');
    expect(run?.outputLines).toEqual(['visible output']);
    expect(run?.outputIsRetainedTail).toBe(true);

    // Output emitted while the worktree is unloaded is dropped by the renderer
    // guard; the retained tail is unchanged.
    useScriptsStore.getState().appendOutput({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      script,
      invocation: 'manual-run',
      lines: ['hidden output'],
    });
    flushPendingScriptOutputs();

    run =
      useScriptsStore.getState().runs[`${PROJECT_ID}/${WORKTREE_ID}`]?.[
        script.scriptKey
      ];
    expect(run?.outputLines).toEqual(['visible output']);

    useScriptsStore.getState().completeRunFromEvent({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      script,
      invocation: 'manual-run',
      result: makeSuccessResponse(),
    });

    run =
      useScriptsStore.getState().runs[`${PROJECT_ID}/${WORKTREE_ID}`]?.[
        script.scriptKey
      ];
    expect(run?.status).toBe('success');
  });

  it('caps the retained tail to the last 50 lines on unload', () => {
    const script = makeScriptDescriptor();
    useScriptsStore.getState().startRun(PROJECT_ID, WORKTREE_ID, script);
    useScriptsStore.getState().appendOutput({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      script,
      invocation: 'manual-run',
      lines: Array.from({ length: 120 }, (_, i) => `line ${i}`),
    });
    flushPendingScriptOutputs();

    useScriptsStore.getState().unloadWorktreeRuns(PROJECT_ID, WORKTREE_ID);

    const run =
      useScriptsStore.getState().runs[`${PROJECT_ID}/${WORKTREE_ID}`]?.[
        script.scriptKey
      ];
    expect(run?.outputLines).toHaveLength(50);
    expect(run?.outputLines[0]).toBe('line 70');
    expect(run?.outputLines[49]).toBe('line 119');
    expect(run?.outputIsRetainedTail).toBe(true);
  });

  it('hydrates an unloaded active run with the persisted output tail on reload', async () => {
    const script = makeScriptDescriptor({
      pattern: 'https?://\\S+',
      label: 'Web',
    });
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValueOnce(1000);
    useScriptsStore.getState().startRun(PROJECT_ID, WORKTREE_ID, script);
    useScriptsStore.getState().appendOutput({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      script,
      invocation: 'manual-run',
      lines: ['visible output http://localhost:3000'],
    });
    flushPendingScriptOutputs();

    useScriptsStore.getState().unloadWorktreeRuns(PROJECT_ID, WORKTREE_ID);

    mockLoadWorktreeScriptRuns([
      makeSnapshot(script, {
        outputLines: [
          'visible output http://localhost:3000',
          'hidden output http://localhost:5173',
        ],
        startedAt: new Date(1100).toISOString(),
      }),
    ]);

    await useScriptsStore.getState().loadWorktreeRuns(PROJECT_ID, WORKTREE_ID);

    const run =
      useScriptsStore.getState().runs[`${PROJECT_ID}/${WORKTREE_ID}`]?.[
        script.scriptKey
      ];
    expect(run?.status).toBe('running');
    expect(run?.outputLines).toEqual([
      'visible output http://localhost:3000',
      'hidden output http://localhost:5173',
    ]);
    expect(run?.devServerHits.map((hit) => hit.url)).toEqual([
      'http://localhost:3000/',
      'http://localhost:5173/',
    ]);
  });

  it('hydrates retained active output when persisted setup started just before the renderer placeholder', async () => {
    const script = makeScriptDescriptor();
    const nowSpy = jest.spyOn(Date, 'now');

    nowSpy.mockReturnValueOnce(2_000);
    useScriptsStore.getState().startRun(PROJECT_ID, WORKTREE_ID, script);
    useScriptsStore.getState().unloadWorktreeRuns(PROJECT_ID, WORKTREE_ID);

    mockLoadWorktreeScriptRuns([
      makeSnapshot(script, {
        outputLines: ['setup output from disk'],
        startedAt: new Date(1_000).toISOString(),
      }),
    ]);

    await useScriptsStore.getState().loadWorktreeRuns(PROJECT_ID, WORKTREE_ID);

    const run =
      useScriptsStore.getState().runs[`${PROJECT_ID}/${WORKTREE_ID}`]?.[
        script.scriptKey
      ];
    expect(run?.status).toBe('running');
    expect(run?.outputLines).toEqual(['setup output from disk']);
  });

  it('hydrates an empty active placeholder with a completed persisted run status', async () => {
    const script = makeScriptDescriptor({
      pattern: 'https?://\\S+',
      label: 'Web',
    });
    const nowSpy = jest.spyOn(Date, 'now');

    nowSpy.mockReturnValueOnce(2_000);
    useScriptsStore.getState().startRun(PROJECT_ID, WORKTREE_ID, script);
    useScriptsStore.getState().unloadWorktreeRuns(PROJECT_ID, WORKTREE_ID);

    mockLoadWorktreeScriptRuns([
      makeSnapshot(script, {
        status: 'success',
        outputLines: [
          'completed output http://localhost:3000',
          'final output http://localhost:5173',
        ],
        exitCode: 0,
        durationMs: 60_000,
        startedAt: new Date(2_100).toISOString(),
        completedAt: new Date(62_100).toISOString(),
      }),
    ]);

    await useScriptsStore.getState().loadWorktreeRuns(PROJECT_ID, WORKTREE_ID);

    const run =
      useScriptsStore.getState().runs[`${PROJECT_ID}/${WORKTREE_ID}`]?.[
        script.scriptKey
      ];
    expect(run?.status).toBe('success');
    expect(run?.outputLines).toEqual([
      'completed output http://localhost:3000',
      'final output http://localhost:5173',
    ]);
    expect(run?.devServerHits.map((hit) => hit.url)).toEqual([
      'http://localhost:3000/',
      'http://localhost:5173/',
    ]);
  });

  it('hydrates an empty completed run shell from persisted output after completion while unloaded', async () => {
    const script = makeScriptDescriptor({
      pattern: 'https?://\\S+',
      label: 'Web',
    });
    const nowSpy = jest.spyOn(Date, 'now');

    nowSpy.mockReturnValueOnce(2_000);
    useScriptsStore.getState().startRun(PROJECT_ID, WORKTREE_ID, script);
    useScriptsStore.getState().appendOutput({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      script,
      invocation: 'manual-run',
      lines: ['visible output http://localhost:3000'],
    });
    flushPendingScriptOutputs();

    useScriptsStore.getState().unloadWorktreeRuns(PROJECT_ID, WORKTREE_ID);
    useScriptsStore.getState().completeRunFromEvent({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      script,
      invocation: 'manual-run',
      result: {
        success: false,
        exitCode: 1,
        output: '',
        timedOut: false,
        durationMs: 60_000,
      },
    });

    let run =
      useScriptsStore.getState().runs[`${PROJECT_ID}/${WORKTREE_ID}`]?.[
        script.scriptKey
      ];
    // A run that completes while unloaded keeps its retained tail (so you see
    // its last lines on return), and is still hydrated to full output on reload.
    expect(run?.status).toBe('failed');
    expect(run?.outputLines).toEqual(['visible output http://localhost:3000']);
    expect(run?.outputIsRetainedTail).toBe(true);

    mockLoadWorktreeScriptRuns([
      makeSnapshot(script, {
        status: 'failed',
        outputLines: [
          'visible output http://localhost:3000',
          'hidden output http://localhost:5173',
        ],
        exitCode: 1,
        durationMs: 60_000,
        startedAt: new Date(1_995).toISOString(),
        completedAt: new Date(61_995).toISOString(),
      }),
    ]);

    await useScriptsStore.getState().loadWorktreeRuns(PROJECT_ID, WORKTREE_ID);

    run =
      useScriptsStore.getState().runs[`${PROJECT_ID}/${WORKTREE_ID}`]?.[
        script.scriptKey
      ];
    expect(run?.status).toBe('failed');
    expect(run?.outputLines).toEqual([
      'visible output http://localhost:3000',
      'hidden output http://localhost:5173',
    ]);
    expect(run?.devServerHits.map((hit) => hit.url)).toEqual([
      'http://localhost:3000/',
      'http://localhost:5173/',
    ]);
  });

  it('does not hydrate an empty completed run shell from an older persisted run', async () => {
    const script = makeScriptDescriptor();
    const nowSpy = jest.spyOn(Date, 'now');

    nowSpy.mockReturnValueOnce(20_000);
    useScriptsStore.getState().startRun(PROJECT_ID, WORKTREE_ID, script);
    useScriptsStore.getState().completeRunFromEvent({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      script,
      invocation: 'manual-run',
      result: {
        success: false,
        exitCode: 1,
        output: '',
        timedOut: false,
        durationMs: 25,
      },
    });

    mockLoadWorktreeScriptRuns([
      makeSnapshot(script, {
        status: 'failed',
        outputLines: ['older output'],
        exitCode: 1,
        durationMs: 25,
        startedAt: new Date(1_000).toISOString(),
        completedAt: new Date(1_025).toISOString(),
      }),
    ]);

    await useScriptsStore.getState().loadWorktreeRuns(PROJECT_ID, WORKTREE_ID);

    const run =
      useScriptsStore.getState().runs[`${PROJECT_ID}/${WORKTREE_ID}`]?.[
        script.scriptKey
      ];
    expect(run?.status).toBe('failed');
    expect(run?.outputLines).toEqual([]);
  });

  it('preserves Unix epoch timestamps when loading persisted runs', async () => {
    const script = makeScriptDescriptor();
    mockLoadWorktreeScriptRuns([
      makeSnapshot(script, {
        startedAt: new Date(0).toISOString(),
      }),
    ]);

    await useScriptsStore.getState().loadWorktreeRuns(PROJECT_ID, WORKTREE_ID);

    const run =
      useScriptsStore.getState().runs[`${PROJECT_ID}/${WORKTREE_ID}`]?.[
        script.scriptKey
      ];
    expect(run?.startedAt).toBe(0);
  });

  it('does not replace a fresh active run with an older persisted run', async () => {
    const script = makeScriptDescriptor();
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValueOnce(2000);
    useScriptsStore.getState().startRun(PROJECT_ID, WORKTREE_ID, script);

    mockLoadWorktreeScriptRuns([
      makeSnapshot(script, {
        status: 'success',
        outputLines: ['old output'],
        exitCode: 0,
        durationMs: 25,
        startedAt: new Date(1000).toISOString(),
        completedAt: new Date(1025).toISOString(),
      }),
    ]);

    await useScriptsStore.getState().loadWorktreeRuns(PROJECT_ID, WORKTREE_ID);

    const run =
      useScriptsStore.getState().runs[`${PROJECT_ID}/${WORKTREE_ID}`]?.[
        script.scriptKey
      ];
    expect(run?.status).toBe('running');
    expect(run?.outputLines).toEqual([]);
  });

  it('treats workspace-root launch scripts as project launch runs', () => {
    const runKey = `${PROJECT_ID}/${WORKTREE_ID}`;
    useScriptsStore.setState({
      runs: {
        [runKey]: {
          'workspace-root:launch': {
            label: 'Workspace Root - Launch',
            scriptName: 'launch',
            lifecycle: 'launch',
            command: 'npm run launch',
            target: 'workspace-root',
            status: 'running',
            outputLines: [],
            exitCode: null,
            timedOut: false,
            durationMs: 0,
            startedAt: 100,
            devServerHits: [],
          },
        },
      },
    });

    const run =
      useScriptsStore.getState().runs[runKey]?.['workspace-root:launch'];

    expect(run).toBeDefined();
    expect(run ? isWorkspaceLaunchRun(run) : false).toBe(true);
    expect(
      hasActiveWorkspaceLaunchRun(useScriptsStore.getState().runs[runKey]),
    ).toBe(true);
  });

  it('identifies active setup work so background polling can yield to typing', () => {
    const setupScript: ScriptDescriptor = {
      ...makeScriptDescriptor(),
      scriptKey: 'project:setup',
      scriptName: 'setup',
      label: 'Setup',
      lifecycle: 'setup',
      command: 'npm install',
    };
    useScriptsStore.getState().startRun(PROJECT_ID, WORKTREE_ID, setupScript);
    const runs =
      useScriptsStore.getState().runs[`${PROJECT_ID}/${WORKTREE_ID}`];

    expect(hasActiveSetupRun(runs)).toBe(true);

    useScriptsStore
      .getState()
      .completeRun(PROJECT_ID, WORKTREE_ID, setupScript.scriptKey, {
        ...makeSuccessResponse(),
      });
    expect(
      hasActiveSetupRun(
        useScriptsStore.getState().runs[`${PROJECT_ID}/${WORKTREE_ID}`],
      ),
    ).toBe(false);
  });
});
