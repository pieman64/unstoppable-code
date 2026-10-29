import type * as runtimeEnvironment from '../../cursor/runtime-environment';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  CursorTurnHost,
  CursorTurnRequest,
} from '../../cursor/turn-driver';
import type { CursorPromptRunnerResult } from '../executor/types';
import type { JsonValue } from '../../codex-runtime/generated/serde_json/JsonValue';

const runCursorTurn = jest.fn<
  Promise<unknown>,
  [CursorTurnRequest, CursorTurnHost]
>();
jest.mock('../../cursor/turn-driver', () => ({
  runCursorTurn: (
    request: CursorTurnRequest,
    host: CursorTurnHost,
  ): Promise<unknown> => runCursorTurn(request, host),
}));
jest.mock('../../cursor/runtime-process', () => ({
  verifyCursorRuntimeVersion: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../cursor/runtime-environment', () => ({
  // DELEGATED, not reimplemented. This used to be a hand-copied duplicate of
  // the refused-name list, which by construction could not fail when the real
  // implementation changed — the one thing the assertion exists to catch. The
  // function is pure, so the real one runs here; only the filesystem-touching
  // `prepareCursorRuntimeEnvironment` below is stubbed.
  withheldCursorEnvironmentNames: jest.requireActual<typeof runtimeEnvironment>(
    '../../cursor/runtime-environment',
  ).withheldCursorEnvironmentNames,
  // Faithful to the real prepareCursorRuntimeEnvironment, which deletes every
  // CURSOR_*-prefixed key from the merged env (runtime-environment.ts) — a
  // passthrough mock would let a stray CURSOR_API_KEY survive and mask a
  // regression in the real stripping behavior.
  prepareCursorRuntimeEnvironment: jest.fn(
    (_root: string, base: NodeJS.ProcessEnv) => {
      const stripped: NodeJS.ProcessEnv = {};
      for (const [key, value] of Object.entries(base)) {
        if (!key.toUpperCase().startsWith('CURSOR_')) stripped[key] = value;
      }
      return Promise.resolve({ ...stripped, HOME: '/private' });
    },
  ),
}));

import {
  readCursorSessionEntry,
  profileTurnQueueSize,
  runCursorPromptWithDriver,
  sanitizeCursorSpawnEnvironment,
  writeCursorSessionEntry,
} from '../cursor-prompt-runner';
import { getCursorRuntimeTarget } from '../../../lib/cursor-runtime-targets';
import { getPipelineExecutionCursorSessionEntryPath } from '../../lib/paths';

const target = getCursorRuntimeTarget('darwin', 'arm64');
if (!target) throw new Error('test host target');
const driver = {
  launch: { command: '/rt/cursor-agent', prefix: [] },
  target,
  baseEnvironment: { PATH: '/bin' },
};
const base = {
  cwd: '/work',
  prompt: 'Summarize',
  environment: { PATH: '/bin', CURSOR_API_KEY: 'leak' },
  model: 'cursor-default',
  totalTimeoutMs: 60_000,
  permissionPreset: 'read_only' as const,
  executionsDir: '/exec',
  executionId: 'e1',
  jobId: 'j1',
  stepId: 's1',
  attempt: 1,
};

beforeEach(() => {
  runCursorTurn.mockReset();
  runCursorTurn.mockImplementation((_request, host) => {
    void host.emit({ type: 'system', subtype: 'init', session_id: 'sess-1' });
    void host.emit({
      type: 'canopy_assistant_patch',
      patches: [{ index: 0, appendText: '{"summary":"ok"}' }],
    });
    void host.onUsage?.({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 30,
    });
    return Promise.resolve({
      sessionId: 'sess-1',
      isError: false,
      cancelled: false,
      message: '',
      stopReason: 'end_turn',
      contextLost: false,
      inheritedContextDelivered: false,
      responseText: '{"summary":"ok"}',
    });
  });
});

it('maps the request into a driver request with a persisted profile and stripped env', async () => {
  const result = await runCursorPromptWithDriver(base, driver);
  const [request, host] = runCursorTurn.mock.calls[0];
  // The prompt gets the budget REMAINING after runtime preparation and the
  // version probe, not the full declared budget again: `timeout_minutes` bounds
  // the step, and setup happens inside it (independent-review M1).
  expect(request.promptTimeoutMs).toBeLessThanOrEqual(60_000);
  expect(request.promptTimeoutMs).toBeGreaterThan(55_000);
  expect(request).toMatchObject({
    cwd: '/work',
    rawModelId: 'default[]',
    profileDir: '/exec/e1/cursor-sessions/j1/s1',
  });
  expect(request.env.CURSOR_API_KEY).toBeUndefined();
  expect(host.planMode).toBe(false);
  expect(result).toMatchObject({
    status: 'success',
    sessionId: 'sess-1',
    rawText: '{"summary":"ok"}',
  });
});

it('parses structured output and reports usage as HelperUsage, with cache reads subtracted out of inputTokens', async () => {
  const result = await runCursorPromptWithDriver(
    { ...base, schema: { type: 'object' } },
    driver,
  );
  expect(result).toMatchObject({
    status: 'success',
    structured: { summary: 'ok' },
    // The mocked CursorReportedUsage is inputTokens:100 with
    // cacheReadTokens:30 already included in it (per
    // packages/agent-transcript/src/lib/cursor-usage.ts), so the reported
    // HelperUsage.inputTokens must be 100-30=70, not the raw 100.
    usage: { inputTokens: 70, outputTokens: 20, cacheReadInputTokens: 30 },
  });
});

it('streams a canopy_cursor_usage transcript line for the reported usage, mirroring interactive Cursor chat', async () => {
  const result = await runCursorPromptWithDriver(base, driver);
  const usageLines: unknown[] = result.transcript
    .split('\n')
    .filter((line) => line.includes('canopy_cursor_usage'))
    .map((line): unknown => JSON.parse(line));
  expect(usageLines).toHaveLength(1);
  expect(usageLines[0]).toMatchObject({
    type: 'canopy_cursor_usage',
    provider: 'cursor',
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30 },
  });
});

describe('structured output schema enforcement', () => {
  const requiredSummarySchema: Record<string, JsonValue> = {
    type: 'object',
    required: ['summary'],
  };

  it('accepts a response that conforms to the requested schema', async () => {
    const result = await runCursorPromptWithDriver(
      { ...base, schema: requiredSummarySchema },
      driver,
    );
    expect(result).toMatchObject({
      status: 'success',
      structured: { summary: 'ok' },
    });
    expect(runCursorTurn).toHaveBeenCalledTimes(1);
  });

  it('retries and then fails the step when the response never satisfies the requested schema', async () => {
    runCursorTurn.mockImplementation((_request, host) => {
      void host.emit({ type: 'system', subtype: 'init', session_id: 'sess-1' });
      return Promise.resolve({
        sessionId: 'sess-1',
        isError: false,
        cancelled: false,
        message: '',
        stopReason: 'end_turn',
        contextLost: false,
        inheritedContextDelivered: false,
        responseText: '{}',
      });
    });
    const result = await runCursorPromptWithDriver(
      { ...base, schema: requiredSummarySchema },
      driver,
    );
    expect(result.status).toBe('failure');
    // 1 initial attempt + CODEX_STRUCTURED_OUTPUT_RETRY_ATTEMPTS retries.
    expect(runCursorTurn).toHaveBeenCalledTimes(3);
    const retryPrompt = runCursorTurn.mock.calls[1][0].text;
    expect(retryPrompt).toContain('failed JSON Schema validation');
    expect(retryPrompt).toContain('summary');
  });

  it('never echoes the parser input excerpt into the retry prompt or the failure', async () => {
    // V8's `JSON.parse` message embeds a SHORTENED excerpt of the response —
    // `Unexpected token 's', "{"a":sk-live-ab"... is not valid JSON`. That
    // fragment went into BOTH the structured-output retry prompt (sending it
    // straight back to the vendor) and the failure message that reaches
    // `agent-failure.json` and the step's `error` output. A configured value
    // straddling the excerpt's cut is no longer an exact match, so no later
    // masking pass can recognise it.
    const secret = 'sk-live-abcdef0123456789XYZ';
    runCursorTurn.mockImplementation((_request, host) => {
      void host.emit({ type: 'system', subtype: 'init', session_id: 'sess-1' });
      return Promise.resolve({
        sessionId: 'sess-1',
        isError: false,
        cancelled: false,
        message: '',
        stopReason: 'end_turn',
        contextLost: false,
        inheritedContextDelivered: false,
        responseText: `{"a":${secret}}`,
      });
    });
    const result = await runCursorPromptWithDriver(
      { ...base, schema: requiredSummarySchema },
      driver,
    );
    expect(result.status).toBe('failure');
    const retryPrompt = runCursorTurn.mock.calls[1][0].text;
    expect(retryPrompt).not.toContain('sk-live-ab');
    expect(retryPrompt).toContain('invalid JSON');
    expect(result).toMatchObject({
      status: 'failure',
      failure: { provider: 'cursor' },
    });
    const failureMessage =
      result.status === 'failure' ? result.failure.message : '';
    expect(failureMessage).not.toContain('sk-live-ab');
  });
});

it('returns a failure with cursor metadata when the driver reports an error', async () => {
  runCursorTurn.mockResolvedValue({
    sessionId: 'sess-1',
    isError: true,
    cancelled: false,
    message: 'Cursor declined the request.',
    contextLost: false,
    inheritedContextDelivered: false,
    responseText: '',
  });
  const result = await runCursorPromptWithDriver(base, driver);
  expect(result).toMatchObject({
    status: 'failure',
    failure: {
      provider: 'cursor',
      agent_harness: 'cursor',
      session_id: 'sess-1',
      message: 'Cursor declined the request.',
    },
  });
});

it('does not count a host-authored system notice as agent activity', async () => {
  runCursorTurn.mockImplementation((_request, host) => {
    void host.emit({ type: 'system', subtype: 'init', session_id: 'sess-1' });
    // Shape of the event createHeadlessCursorHost's `notice()` projection
    // emits for host-authored guidance (the plugin warning, the context-loss
    // warning): `type: 'canopy_assistant_patch'` with `role: 'system'`. The
    // agent itself never produced anything before this turn fails.
    void host.emit({
      type: 'canopy_assistant_patch',
      role: 'system',
      patches: [{ index: 0, block: { type: 'text', text: 'notice' } }],
    });
    return Promise.resolve({
      sessionId: 'sess-1',
      isError: true,
      cancelled: false,
      message: 'Cursor could not select this model.',
      contextLost: false,
      inheritedContextDelivered: false,
      responseText: '',
    });
  });
  const result = await runCursorPromptWithDriver(base, driver);
  expect(result).toMatchObject({
    status: 'failure',
    failure: {
      session_id: 'sess-1',
      had_agent_activity: false,
    },
  });
});

it('counts a real assistant patch as agent activity', async () => {
  runCursorTurn.mockImplementation((_request, host) => {
    void host.emit({ type: 'system', subtype: 'init', session_id: 'sess-1' });
    void host.emit({
      type: 'canopy_assistant_patch',
      patches: [{ index: 0, appendText: 'partial response' }],
    });
    return Promise.resolve({
      sessionId: 'sess-1',
      isError: true,
      cancelled: false,
      message: 'Cursor pipeline turn failed.',
      contextLost: false,
      inheritedContextDelivered: false,
      responseText: '',
    });
  });
  const result = await runCursorPromptWithDriver(base, driver);
  expect(result).toMatchObject({
    status: 'failure',
    failure: {
      session_id: 'sess-1',
      had_agent_activity: true,
    },
  });
});

it('returns cancelled when the signal aborted', async () => {
  const controller = new AbortController();
  runCursorTurn.mockImplementation(() => {
    controller.abort();
    return Promise.resolve({
      isError: true,
      cancelled: true,
      message: 'Turn cancelled',
      contextLost: false,
      inheritedContextDelivered: false,
      responseText: '',
    });
  });
  const result = await runCursorPromptWithDriver(
    { ...base, signal: controller.signal },
    driver,
  );
  expect(result.status).toBe('cancelled');
});

it('fails selected capabilities before execution when the host cannot prepare them', async () => {
  const result = await runCursorPromptWithDriver(
    {
      ...base,
      pluginSelections: { collectionIds: ['c'], skillRefs: [], pluginRefs: [] },
    },
    driver,
  );
  expect(result.status).toBe('failure');
  if (result.status !== 'failure')
    throw new Error('Expected preparation failure');
  expect(result.failure.message).toContain('capabilities');
  expect(runCursorTurn).not.toHaveBeenCalled();
});

describe('agent-resume session continuity', () => {
  it('fails the step when a resume request loses context instead of silently starting a new session', async () => {
    runCursorTurn.mockImplementation((_request, host) => {
      void host.emit({ type: 'system', subtype: 'init', session_id: 'new' });
      return Promise.resolve({
        sessionId: 'new',
        isError: false,
        cancelled: false,
        message: '',
        stopReason: 'end_turn',
        contextLost: true,
        inheritedContextDelivered: false,
        responseText: 'ok',
      });
    });
    const result = await runCursorPromptWithDriver(
      { ...base, resumeSessionId: 'sess-1' },
      driver,
    );
    expect(result).toMatchObject({
      status: 'failure',
      failure: {
        provider: 'cursor',
        message: 'Cursor session sess-1 could not be resumed.',
      },
    });
  });

  it('reuses the originating profile dir for a resumed session instead of the resume steps own step-keyed dir', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-cursor-prompt-runner-'),
    );
    try {
      const executionsDir = path.join(tempDir, 'executions');
      const created = await runCursorPromptWithDriver(
        { ...base, executionsDir, jobId: 'j1', stepId: 'create-step' },
        driver,
      );
      expect(created.status).toBe('success');
      const createProfileDir = runCursorTurn.mock.calls[0][0].profileDir;

      const resumed = await runCursorPromptWithDriver(
        {
          ...base,
          executionsDir,
          jobId: 'j1',
          stepId: 'resume-step',
          resumeSessionId: 'sess-1',
        },
        driver,
      );
      expect(resumed.status).toBe('success');
      const resumeProfileDir = runCursorTurn.mock.calls[1][0].profileDir;

      expect(resumeProfileDir).toBe(createProfileDir);
      expect(resumeProfileDir).not.toBe(
        path.join(executionsDir, 'e1', 'cursor-sessions', 'j1', 'resume-step'),
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('session entry index integrity', () => {
  it('writes N concurrent session entries for distinct sessions without losing any', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-cursor-session-index-'),
    );
    try {
      const executionsDir = path.join(tempDir, 'executions');
      const executionId = 'exec-concurrent';
      const sessionIds = Array.from({ length: 8 }, (_, i) => `sess-${i}`);
      // Real profile directories, which is what every caller writes: they live
      // under this execution's own `cursor-sessions` root. A synthetic
      // `/profile/N` was never a value production could produce.
      const profileDirOf = (index: number): string =>
        `${executionsDir}/${executionId}/cursor-sessions/job-${index}/step-${index}`;

      await Promise.all(
        sessionIds.map((sessionId, i) =>
          writeCursorSessionEntry(
            executionsDir,
            executionId,
            sessionId,
            profileDirOf(i),
            `step-${i}`,
            undefined,
          ),
        ),
      );
      const readBack = await Promise.all(
        sessionIds.map((sessionId) =>
          readCursorSessionEntry(executionsDir, executionId, sessionId),
        ),
      );

      expect(readBack).toEqual(sessionIds.map((_, i) => profileDirOf(i)));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('refuses a profile directory outside this execution', async () => {
    // Defence in depth: the value becomes `CURSOR_DATA_DIR` and receives a
    // `hooks.json` carrying a live bearer token. Writing this file already
    // needs write access to the data directory, so this is not a remote
    // boundary — but every legitimate value is one of this execution's own
    // profile directories, so anything else is refused and the step falls back
    // to its own step-keyed profile.
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-cursor-session-escape-'),
    );
    try {
      const executionsDir = path.join(tempDir, 'executions');
      const executionId = 'exec-escape';
      await writeCursorSessionEntry(
        executionsDir,
        executionId,
        'sess-escape',
        path.join(tempDir, 'elsewhere'),
        'step-1',
        undefined,
      );
      await expect(
        readCursorSessionEntry(executionsDir, executionId, 'sess-escape'),
      ).resolves.toBeUndefined();

      // ...and a sibling step's directory, which cross-step resume genuinely
      // needs, is still accepted.
      const sibling = `${executionsDir}/${executionId}/cursor-sessions/job-9/step-9`;
      await writeCursorSessionEntry(
        executionsDir,
        executionId,
        'sess-sibling',
        sibling,
        'step-9',
        undefined,
      );
      await expect(
        readCursorSessionEntry(executionsDir, executionId, 'sess-sibling'),
      ).resolves.toBe(sibling);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('never reads a partially written temp file as a session entry', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-cursor-session-index-'),
    );
    try {
      const executionsDir = path.join(tempDir, 'executions');
      const executionId = 'exec-tmp';
      const sessionId = 'sess-tmp';
      const entryPath = getPipelineExecutionCursorSessionEntryPath(
        executionsDir,
        executionId,
        sessionId,
      );
      fs.mkdirSync(path.dirname(entryPath), { recursive: true });
      // A crashed/incomplete writer's temp file: matches the writer's naming
      // pattern but was never renamed into place, and is not valid JSON.
      fs.writeFileSync(
        `${entryPath}.12345-abc.tmp`,
        '{"profileDir":"/sh',
        'utf8',
      );

      const found = await readCursorSessionEntry(
        executionsDir,
        executionId,
        sessionId,
      );

      expect(found).toBeUndefined();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('sanitizeCursorSpawnEnvironment', () => {
  it('strips canonical-home overrides case-insensitively while keeping other keys', () => {
    expect(
      sanitizeCursorSpawnEnvironment({
        Home: '/tmp/home',
        home: '/tmp/lower-home',
        UserProfile: 'C:\\Users\\override',
        homeDrive: 'D:',
        HOMEPATH: '\\Users\\override',
        homeShare: '\\\\server\\users\\override',
        SAFE_VALUE: 'kept',
      }),
    ).toEqual({ SAFE_VALUE: 'kept' });
  });
});

/** Narrows a runner result's failure message without casting. */
const failureMessageOf = (value: unknown): string => {
  if (typeof value !== 'object' || value === null || !('failure' in value))
    return '';
  const { failure } = value;
  if (
    typeof failure !== 'object' ||
    failure === null ||
    !('message' in failure)
  )
    return '';
  return typeof failure.message === 'string' ? failure.message : '';
};

describe('step deadline, usage and session index across schema retries', () => {
  const requireSummary = {
    type: 'object',
    properties: { summary: { type: 'string' } },
    required: ['summary'],
  };

  it('spends one step deadline across every attempt instead of restarting it', async () => {
    // Independent-review finding M3: each retry received the FULL
    // `totalTimeoutMs` again, so a step declaring `timeout_minutes: N` with
    // a structured schema could spend ~3N minutes in prompts alone. The
    // declared timeout bounds the STEP, not each internal attempt.
    let now = 1_000_000;
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      runCursorTurn.mockImplementation((_request, host) => {
        void host.emit({
          type: 'canopy_assistant_patch',
          patches: [{ index: 0, appendText: 'not json' }],
        });
        now += 20_000;
        return Promise.resolve({
          sessionId: 'sess-1',
          isError: false,
          cancelled: false,
          message: '',
          stopReason: 'end_turn',
          contextLost: false,
          inheritedContextDelivered: false,
          responseText: 'not json',
        });
      });
      await runCursorPromptWithDriver(
        { ...base, schema: requireSummary },
        driver,
      );
    } catch {
      // The step still fails on the unparseable response; the deadline
      // behaviour is what this asserts.
    } finally {
      clock.mockRestore();
    }
    const timeouts = runCursorTurn.mock.calls.map(
      ([request]) => request.promptTimeoutMs,
    );
    expect(timeouts[0]).toBe(60_000);
    for (let index = 1; index < timeouts.length; index += 1) {
      const previous = timeouts[index - 1] ?? 0;
      const current = timeouts[index] ?? 0;
      expect(current).toBeLessThan(previous);
      expect(current).toBeLessThanOrEqual(60_000 - 20_000 * index);
    }
  });

  it('reports the canonical step-timeout wording when the ACP deadline fires', async () => {
    // Independent-review finding M9: the ACP client's own "did not settle
    // within its deadline" wording reads as a provider fault, so a step
    // that merely ran long was indistinguishable from a broken one.
    runCursorTurn.mockImplementation(() =>
      Promise.resolve({
        sessionId: 'sess-1',
        isError: true,
        cancelled: false,
        message: 'ACP prompt did not settle within its deadline',
        contextLost: false,
        inheritedContextDelivered: false,
        responseText: '',
      }),
    );
    const result = await runCursorPromptWithDriver(base, driver);
    expect(result).toMatchObject({
      status: 'failure',
      failure: { message: 'Step timed out after 1 minute(s)' },
    });
  });

  it('stops a turn that outlives the declared step budget, not just its prompt RPC', async () => {
    // Independent-review findings (two reviewers): `promptTimeoutMs` bounds
    // only `client.prompt()`. The per-attempt ACP setup RPCs
    // (initialize/newSession/loadSession/setSessionConfigOption) carry their
    // own fixed 15s/30s windows and are re-done on every attempt, so nothing
    // actually enforced the step's declared `timeout_minutes` end to end. A
    // turn that never settles must still end at the declared bound.
    runCursorTurn.mockImplementation(
      (turnRequest: { signal?: AbortSignal }) =>
        new Promise((resolve) => {
          turnRequest.signal?.addEventListener('abort', () => {
            resolve({
              sessionId: 'sess-1',
              isError: true,
              cancelled: true,
              message: 'Turn cancelled',
              contextLost: false,
              inheritedContextDelivered: false,
              responseText: '',
            });
          });
        }),
    );
    const result = await runCursorPromptWithDriver(
      { ...base, totalTimeoutMs: 40 },
      driver,
    );
    expect(result).toMatchObject({ status: 'failure' });
    expect(failureMessageOf(result)).toContain('Step timed out');
  }, 15_000);

  it('does not report a fixed RPC deadline as the declared step timeout', async () => {
    // Independent-review finding: the ACP client throws the generic
    // "operation did not settle" wording for its own fixed 15s/30s per-RPC
    // windows (initialize/newSession/loadSession/setSessionConfigOption),
    // which have nothing to do with the step's declared budget. Mapping that
    // to "Step timed out after N minute(s)" told a user debugging a 30-second
    // hiccup that a 1-minute budget had been exhausted.
    runCursorTurn.mockImplementation(() =>
      Promise.resolve({
        sessionId: 'sess-1',
        isError: true,
        cancelled: false,
        message: 'ACP operation did not settle within its deadline',
        contextLost: false,
        inheritedContextDelivered: false,
        responseText: '',
      }),
    );
    const result = await runCursorPromptWithDriver(base, driver);
    expect(result).toMatchObject({ status: 'failure' });
    expect(failureMessageOf(result)).toContain('did not settle');
    expect(failureMessageOf(result)).not.toContain('Step timed out');
  });

  it('accumulates usage across retry attempts instead of reporting only the last', async () => {
    // Independent-review finding M4: every attempt is a separate child
    // process and ACP session, and the durable observer ASSIGNS the newest
    // snapshot — so attempts before the last vanished from Audit Trail and
    // Usage even though they were paid for.
    let attempt = 0;
    runCursorTurn.mockImplementation((_request, host) => {
      attempt += 1;
      const responseText = attempt === 1 ? 'not json' : '{"summary":"ok"}';
      void host.emit({
        type: 'canopy_assistant_patch',
        patches: [{ index: 0, appendText: responseText }],
      });
      void host.onUsage?.({ inputTokens: 10, outputTokens: 5 });
      return Promise.resolve({
        sessionId: 'sess-1',
        isError: false,
        cancelled: false,
        message: '',
        stopReason: 'end_turn',
        contextLost: false,
        inheritedContextDelivered: false,
        responseText,
      });
    });
    const result = await runCursorPromptWithDriver(
      { ...base, schema: requireSummary },
      driver,
    );
    expect(attempt).toBe(2);
    const usageLines = result.transcript
      .split('\n')
      .filter((line) => line.includes('canopy_cursor_usage'))
      .map((line): unknown => JSON.parse(line));
    expect(usageLines[usageLines.length - 1]).toMatchObject({
      usage: { inputTokens: 20, outputTokens: 10 },
    });
  });

  it('indexes the new session id when a retry loses the previous context', async () => {
    // Independent-review finding L5: the "already indexed" latch was a
    // boolean, so when a retry's `loadSession` failed and a NEW session id
    // was minted, the id the step actually returns was never written to the
    // index — and a later `builtin/agent-resume` could not find its profile.
    const executionsDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'cursor-session-index-'),
    );
    let attempt = 0;
    runCursorTurn.mockImplementation((_request, host) => {
      attempt += 1;
      const responseText = attempt === 1 ? 'not json' : '{"summary":"ok"}';
      void host.emit({
        type: 'canopy_assistant_patch',
        patches: [{ index: 0, appendText: responseText }],
      });
      return Promise.resolve({
        sessionId: attempt === 1 ? 'sess-1' : 'sess-2',
        isError: false,
        cancelled: false,
        message: '',
        stopReason: 'end_turn',
        contextLost: attempt === 2,
        inheritedContextDelivered: false,
        responseText,
      });
    });
    const result = await runCursorPromptWithDriver(
      { ...base, executionsDir, schema: requireSummary },
      driver,
    );
    expect(result).toMatchObject({ status: 'success', sessionId: 'sess-2' });
    await expect(
      readCursorSessionEntry(executionsDir, 'e1', 'sess-2'),
    ).resolves.toBe(`${executionsDir}/e1/cursor-sessions/j1/s1`);
    fs.rmSync(executionsDir, { recursive: true, force: true });
  });

  it('keeps a session it created when the step budget ends the turn', async () => {
    // The deadline throw ran BEFORE the session id was assigned and indexed,
    // so a turn that really did create a session — and really did do work in
    // it — reported a timeout with no session to resume. Recovery then had
    // nothing to reconnect to, which is precisely the case a deadline exists
    // to leave recoverable.
    const executionsDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'cursor-deadline-index-'),
    );
    runCursorTurn.mockImplementation(
      (turnRequest: { signal?: AbortSignal }, host) => {
        void host.emit({
          type: 'system',
          subtype: 'init',
          session_id: 'deadline-session',
        });
        void host.emit({
          type: 'canopy_assistant_patch',
          patches: [{ index: 0, appendText: 'partial' }],
        });
        return new Promise((resolve) => {
          turnRequest.signal?.addEventListener('abort', () => {
            resolve({
              sessionId: 'deadline-session',
              isError: true,
              cancelled: true,
              message: 'Turn cancelled',
              contextLost: false,
              inheritedContextDelivered: false,
              responseText: '',
            });
          });
        });
      },
    );
    const result = await runCursorPromptWithDriver(
      { ...base, executionsDir, totalTimeoutMs: 40 },
      driver,
    );
    // The timeout still settles as a timeout.
    expect(result).toMatchObject({ status: 'failure' });
    expect(failureMessageOf(result)).toContain('Step timed out');
    // Positive control: the turn really did reach the agent.
    expect(
      (result as { failure?: { had_agent_activity?: boolean } }).failure
        ?.had_agent_activity,
    ).toBe(true);
    // ...and the session it created survives for recovery.
    expect(
      (result as { failure?: { session_id?: string } }).failure?.session_id,
    ).toBe('deadline-session');
    await expect(
      readCursorSessionEntry(executionsDir, 'e1', 'deadline-session'),
    ).resolves.toBe(`${executionsDir}/e1/cursor-sessions/j1/s1`);
    fs.rmSync(executionsDir, { recursive: true, force: true });
  }, 15_000);

  it.each(['9384716502', 'constructor', 'toString', '__proto__'])(
    'never sends the data-chosen property %s back in the retry prompt or failure',
    async (value) => {
      // Through the actual runner: the validation message becomes the
      // outbound retry prompt AND the returned failure, so both are checked.
      runCursorTurn.mockImplementation(() =>
        Promise.resolve({
          sessionId: 'schema-session',
          isError: false,
          cancelled: false,
          message: '',
          contextLost: false,
          inheritedContextDelivered: false,
          responseText: JSON.stringify({ [value]: 'wrong-type' }),
        }),
      );
      const result = await runCursorPromptWithDriver(
        {
          ...base,
          schema: {
            type: 'object',
            properties: { declared: { type: 'number' } },
            additionalProperties: { type: 'number' },
          },
          environment: { ...base.environment, API_KEY: value },
        },
        driver,
      );
      const retry = runCursorTurn.mock.calls[1]?.[0].text ?? '';
      expect(retry).toContain('must be number');
      expect(retry).not.toContain(value);
      expect(failureMessageOf(result)).not.toContain(value);
    },
  );

  it('asks the driver to refuse a resume whose session cannot be loaded', async () => {
    // Independent-review finding M5: without this flag the driver silently
    // started a fresh session and ran the resume prompt — write-capable —
    // to completion before anyone checked `contextLost`.
    await runCursorPromptWithDriver(
      { ...base, resumeSessionId: 'sess-old' },
      driver,
    );
    const [request] = runCursorTurn.mock.calls[0];
    expect(request.requireExistingSession).toBe(true);
    expect(request.sessionId).toBe('sess-old');
  });
});

describe('withheld step environment variables', () => {
  it('warns by name when a step declares variables Cursor will not receive', async () => {
    // A pipeline declaring GH_TOKEN for its agent's `gh`
    // calls got a silently different environment on Cursor. The names stay
    // withheld — they are code-injection and credential vectors — but the step
    // now says which ones.
    const lines: string[] = [];
    await runCursorPromptWithDriver(
      {
        ...base,
        environment: {
          GH_TOKEN: 'x',
          NODE_OPTIONS: '--require evil',
          GIT_CONFIG_COUNT: '1',
          ORDINARY_VALUE: 'kept',
        },
        onTranscriptLine: (line) => lines.push(line),
      },
      driver,
    );
    const warning = lines.find(
      (line) =>
        line.includes('"type":"warning"') &&
        line.includes('does not receive these step environment variables'),
    );
    expect(warning).toBeDefined();
    expect(warning).toContain('GH_TOKEN');
    expect(warning).toContain('NODE_OPTIONS');
    expect(warning).toContain('GIT_CONFIG_COUNT');
    expect(warning).not.toContain('ORDINARY_VALUE');
  });

  it('says nothing when a step declares only forwardable variables', async () => {
    const lines: string[] = [];
    await runCursorPromptWithDriver(
      {
        ...base,
        environment: { ORDINARY_VALUE: 'kept' },
        onTranscriptLine: (line) => lines.push(line),
      },
      driver,
    );
    expect(
      lines.some((line) =>
        line.includes('does not receive these step environment variables'),
      ),
    ).toBe(false);
  });

  it('names an inherited shell selection on Windows, where the runtime drops it', async () => {
    // prepareCursorRuntimeEnvironment removes SHELL and MSYSTEM on Windows so
    // the pinned CLI runs its PowerShell-syntax hooks in PowerShell. The
    // warning reads the same platform, so a step that declares either is told
    // rather than finding its Shell tool in a different shell in silence.
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32',
    });
    const lines: string[] = [];
    try {
      await runCursorPromptWithDriver(
        {
          ...base,
          environment: {
            SHELL: '/usr/bin/bash',
            MSYSTEM: 'MINGW64',
            ORDINARY_VALUE: 'kept',
          },
          onTranscriptLine: (line) => lines.push(line),
        },
        driver,
      );
    } finally {
      if (realPlatform)
        Object.defineProperty(process, 'platform', realPlatform);
    }
    const warning = lines.find((line) =>
      line.includes('does not receive these step environment variables'),
    );
    expect(warning).toBeDefined();
    expect(warning).toContain('SHELL');
    expect(warning).toContain('MSYSTEM');
    expect(warning).not.toContain('ORDINARY_VALUE');
  });
});

describe('cancellation and concurrent resume', () => {
  it('runs no turn when the caller aborts before the turn starts', async () => {
    // The abort listener is a no-op on an already-aborted signal, and the resume
    // path awaits a session lookup between the entry check and registration. An
    // abort landing in that window must not run a write-capable turn.
    const controller = new AbortController();
    controller.abort();
    const result = await runCursorPromptWithDriver(
      { ...base, signal: controller.signal },
      driver,
    );
    expect(result.status).toBe('cancelled');
    // No turn is started at all. `addEventListener` alone could not achieve that:
    // it is a no-op on a signal that aborted before registration, which is
    // exactly the window the awaited session lookup on the resume path opens.
    expect(runCursorTurn).not.toHaveBeenCalled();
  });

  it('does not start a queued turn whose caller cancelled while it waited', async () => {
    // A waiter that is cancelled while queued must not run afterwards, and must
    // not release its predecessor's place.
    const controller = new AbortController();
    let releaseFirst: (() => void) | undefined;
    runCursorTurn.mockImplementation(
      () =>
        new Promise((resolve): void => {
          releaseFirst = (): void =>
            resolve({
              sessionId: 'sess-1',
              isError: false,
              cancelled: false,
              message: '',
              contextLost: false,
              inheritedContextDelivered: false,
              responseText: 'ok',
            });
        }),
    );
    const first = runCursorPromptWithDriver({ ...base, stepId: 'q' }, driver);
    for (let tick = 0; tick < 6; tick += 1) await Promise.resolve();
    const second = runCursorPromptWithDriver(
      { ...base, stepId: 'q', signal: controller.signal },
      driver,
    );
    for (let tick = 0; tick < 6; tick += 1) await Promise.resolve();
    controller.abort();
    releaseFirst?.();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.status).toBe('success');
    expect(secondResult.status).toBe('cancelled');
    // Only the first turn ever started.
    expect(runCursorTurn).toHaveBeenCalledTimes(1);
  });

  it('keeps staggered arrivals on one profile serialized', async () => {
    // With A running and B queued, finishing A attached cleanup to the CURRENT
    // chain; enqueueing C before B finished meant that older cleanup deleted the
    // map entry without checking it still owned it, so D started while C was
    // still running. Two turns on one profile then overlapped.
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const finishers: Array<() => void> = [];
    runCursorTurn.mockImplementation(
      () =>
        new Promise((resolve) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          finishers.push(() => {
            active -= 1;
            resolve({
              sessionId: 'sess-1',
              isError: false,
              cancelled: false,
              message: '',
              contextLost: false,
              inheritedContextDelivered: false,
              responseText: 'ok',
            });
          });
        }),
    );
    const start = (name: string): Promise<unknown> => {
      order.push(`${name} queued`);
      return runCursorPromptWithDriver({ ...base, stepId: 'shared' }, driver);
    };
    const settle = async (): Promise<void> => {
      for (let tick = 0; tick < 6; tick += 1) await Promise.resolve();
    };

    const a = start('A');
    await settle();
    const b = start('B');
    await settle();
    finishers.shift()?.(); // A completes while B is queued
    await settle();
    const c = start('C'); // arrives before B's turn finishes
    await settle();
    finishers.shift()?.(); // B completes
    await settle();
    const d = start('D');
    await settle();
    while (finishers.length > 0) {
      finishers.shift()?.();
      await settle();
    }
    await Promise.all([a, b, c, d]);
    expect(maxActive).toBe(1);
  });

  it('releases the profile when a turn rejects so the next one still runs', async () => {
    // A failed turn must not strand ownership: the next waiter on the profile
    // would otherwise never be released.
    let call = 0;
    runCursorTurn.mockImplementation(() => {
      call += 1;
      if (call === 1) return Promise.reject(new Error('driver exploded'));
      return Promise.resolve({
        sessionId: 'sess-1',
        isError: false,
        cancelled: false,
        message: '',
        contextLost: false,
        inheritedContextDelivered: false,
        responseText: 'ok',
      });
    });
    const first = runCursorPromptWithDriver(
      { ...base, stepId: 'shared' },
      driver,
    );
    const second = runCursorPromptWithDriver(
      { ...base, stepId: 'shared' },
      driver,
    );
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.status).toBe('failure');
    expect(secondResult.status).toBe('success');
    expect(call).toBe(2);
  });

  /**
   * A waiter that withdraws must SETTLE while its predecessor is still running.
   *
   * Waiting on the predecessor alone meant a cancelled caller could not settle
   * at all until the predecessor finished, and a caller with a 20ms budget
   * inherited the predecessor's 60s one. The earlier tests released the
   * predecessor immediately after cancelling, which hid exactly that.
   */
  describe('a withdrawn waiter settles while its predecessor still holds the profile', () => {
    /** Holds the profile open until `release()` so the waiter really is queued. */
    const holdPredecessor = (): { release: () => void } => {
      let release: () => void = () => {};
      runCursorTurn.mockImplementation(
        () =>
          new Promise((resolve): void => {
            release = (): void =>
              resolve({
                sessionId: 'sess-1',
                isError: false,
                cancelled: false,
                message: '',
                contextLost: false,
                inheritedContextDelivered: false,
                responseText: 'ok',
              });
          }),
      );
      return {
        release: (): void => {
          release();
        },
      };
    };
    const settle = async (): Promise<void> => {
      for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
    };
    /** True when `pending` settles without the predecessor being released. */
    const settlesWhileHeld = (pending: Promise<unknown>): Promise<boolean> =>
      Promise.race([
        pending.then(() => true),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), 150),
        ),
      ]);

    it.each([
      ['its own budget elapses', 'timeout'],
      ['its caller cancels', 'cancel'],
    ])('settles when %s', async (_label, mode) => {
      const predecessor = holdPredecessor();
      const first = runCursorPromptWithDriver(
        { ...base, stepId: 'shared', totalTimeoutMs: 60_000 },
        driver,
      );
      await settle();
      const controller = new AbortController();
      const second = runCursorPromptWithDriver(
        {
          ...base,
          stepId: 'shared',
          totalTimeoutMs: mode === 'timeout' ? 20 : 60_000,
          signal: controller.signal,
        },
        driver,
      );
      await settle();
      if (mode === 'cancel') controller.abort();

      expect(await settlesWhileHeld(second)).toBe(true);

      predecessor.release();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(firstResult.status).toBe('success');
      // A deadline is the canonical step timeout; a caller abort is cancelled.
      expect(secondResult.status).toBe(
        mode === 'timeout' ? 'failure' : 'cancelled',
      );
      if (mode === 'timeout')
        expect(
          secondResult.status === 'failure' ? secondResult.failure.message : '',
        ).toContain('timed out');
      // The withdrawn waiter never started a turn — not then, not later.
      expect(runCursorTurn).toHaveBeenCalledTimes(1);
    });

    it('does not release the predecessor or let a later waiter overlap it', async () => {
      // The withdrawal gives up only this caller's own place. A live waiter
      // that arrives afterwards still has to wait for the PREDECESSOR.
      let active = 0;
      let maxActive = 0;
      const finishers: Array<() => void> = [];
      runCursorTurn.mockImplementation(
        () =>
          new Promise((resolve): void => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            finishers.push((): void => {
              active -= 1;
              resolve({
                sessionId: 'sess-1',
                isError: false,
                cancelled: false,
                message: '',
                contextLost: false,
                inheritedContextDelivered: false,
                responseText: 'ok',
              });
            });
          }),
      );
      const first = runCursorPromptWithDriver(
        { ...base, stepId: 'shared', totalTimeoutMs: 60_000 },
        driver,
      );
      await settle();
      const controller = new AbortController();
      const withdrawn = runCursorPromptWithDriver(
        {
          ...base,
          stepId: 'shared',
          totalTimeoutMs: 60_000,
          signal: controller.signal,
        },
        driver,
      );
      await settle();
      controller.abort();
      expect(await settlesWhileHeld(withdrawn)).toBe(true);

      // A live waiter arriving after the withdrawal.
      const third = runCursorPromptWithDriver(
        { ...base, stepId: 'shared', totalTimeoutMs: 60_000 },
        driver,
      );
      await settle();
      // The predecessor still owns the profile, so the live waiter has not run.
      expect(runCursorTurn).toHaveBeenCalledTimes(1);
      // The queue entry still exists while the predecessor holds it.
      expect(profileTurnQueueSize()).toBe(1);

      finishers.shift()?.(); // predecessor completes
      await settle();
      expect(runCursorTurn).toHaveBeenCalledTimes(2);
      while (finishers.length > 0) {
        finishers.shift()?.();
        await settle();
      }
      const [firstResult, withdrawnResult, thirdResult] = await Promise.all([
        first,
        withdrawn,
        third,
      ]);
      expect(firstResult.status).toBe('success');
      expect(withdrawnResult.status).toBe('cancelled');
      expect(thirdResult.status).toBe('success');
      expect(maxActive).toBe(1);
      // Nobody left: the entry is reclaimed rather than leaked.
      expect(profileTurnQueueSize()).toBe(0);
    });

    it('lets a withdrawn waiter settle while a THROWING predecessor still holds the profile', async () => {
      let rejectFirst: (() => void) | undefined;
      let call = 0;
      runCursorTurn.mockImplementation(() => {
        call += 1;
        if (call === 1)
          return new Promise((_resolve, reject): void => {
            rejectFirst = (): void => reject(new Error('driver exploded'));
          });
        return Promise.resolve({
          sessionId: 'sess-1',
          isError: false,
          cancelled: false,
          message: '',
          contextLost: false,
          inheritedContextDelivered: false,
          responseText: 'ok',
        });
      });
      const first = runCursorPromptWithDriver(
        { ...base, stepId: 'shared', totalTimeoutMs: 60_000 },
        driver,
      );
      await settle();
      const controller = new AbortController();
      const withdrawn = runCursorPromptWithDriver(
        {
          ...base,
          stepId: 'shared',
          totalTimeoutMs: 60_000,
          signal: controller.signal,
        },
        driver,
      );
      await settle();
      controller.abort();
      expect(await settlesWhileHeld(withdrawn)).toBe(true);
      rejectFirst?.();
      const [firstResult, withdrawnResult] = await Promise.all([
        first,
        withdrawn,
      ]);
      expect(firstResult.status).toBe('failure');
      expect(withdrawnResult.status).toBe('cancelled');
      expect(profileTurnQueueSize()).toBe(0);
    });

    it('does not make a withdrawn waiter on one profile block another profile', async () => {
      const predecessor = holdPredecessor();
      const first = runCursorPromptWithDriver(
        { ...base, stepId: 'profile-a', totalTimeoutMs: 60_000 },
        driver,
      );
      await settle();
      const controller = new AbortController();
      const withdrawn = runCursorPromptWithDriver(
        {
          ...base,
          stepId: 'profile-a',
          totalTimeoutMs: 60_000,
          signal: controller.signal,
        },
        driver,
      );
      await settle();
      controller.abort();
      expect(await settlesWhileHeld(withdrawn)).toBe(true);
      expect((await withdrawn).status).toBe('cancelled');
      predecessor.release();
      expect((await first).status).toBe('success');
    });

    it('removes its abort listener when the turn runs normally', async () => {
      // The signal outlives the queue call on the success path, so a listener
      // left attached would accumulate one entry per queued attempt.
      const controller = new AbortController();
      const added: string[] = [];
      const removed: string[] = [];
      const realAdd = controller.signal.addEventListener.bind(
        controller.signal,
      );
      const realRemove = controller.signal.removeEventListener.bind(
        controller.signal,
      );
      controller.signal.addEventListener = ((
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ): void => {
        added.push(type);
        realAdd(type, listener, options);
      }) as typeof controller.signal.addEventListener;
      controller.signal.removeEventListener = ((
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | EventListenerOptions,
      ): void => {
        removed.push(type);
        realRemove(type, listener, options);
      }) as typeof controller.signal.removeEventListener;

      const result = await runCursorPromptWithDriver(
        { ...base, stepId: 'shared', signal: controller.signal },
        driver,
      );
      expect(result.status).toBe('success');
      expect(added.filter((type) => type === 'abort').length).toBeGreaterThan(
        0,
      );
      expect(removed.filter((type) => type === 'abort').length).toBe(
        added.filter((type) => type === 'abort').length,
      );
    });
  });

  it('reports the step timeout for a turn whose deadline elapsed while queued', async () => {
    // The waiter must not start a turn after its own budget is gone, and the
    // step must report the canonical timeout rather than a cancellation.
    let releaseFirst: (() => void) | undefined;
    runCursorTurn.mockImplementation(
      () =>
        new Promise((resolve): void => {
          releaseFirst = (): void =>
            resolve({
              sessionId: 'sess-1',
              isError: false,
              cancelled: false,
              message: '',
              contextLost: false,
              inheritedContextDelivered: false,
              responseText: 'ok',
            });
        }),
    );
    const first = runCursorPromptWithDriver(
      { ...base, stepId: 'shared', totalTimeoutMs: 60_000 },
      driver,
    );
    const second = runCursorPromptWithDriver(
      { ...base, stepId: 'shared', totalTimeoutMs: 20 },
      driver,
    );
    // Let the queued waiter's own 20ms budget elapse while it waits.
    await new Promise((resolve) => setTimeout(resolve, 60));
    releaseFirst?.();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.status).toBe('success');
    expect(secondResult.status).toBe('failure');
    const timeoutMessage =
      secondResult.status === 'failure' ? secondResult.failure.message : '';
    expect(timeoutMessage).toContain('timed out');
    // Only the first turn ever started.
    expect(runCursorTurn).toHaveBeenCalledTimes(1);
  });

  it('serializes turns that share a conversation profile and not those that do not', async () => {
    // Two resumes of the same session resolve the same CURSOR_DATA_DIR, so their
    // turns must not overlap; turns on different profiles stay parallel.
    let active = 0;
    let maxActive = 0;
    runCursorTurn.mockImplementation(
      () =>
        new Promise((resolve) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          setTimeout(() => {
            active -= 1;
            resolve({
              sessionId: 'sess-1',
              isError: false,
              cancelled: false,
              message: '',
              contextLost: false,
              inheritedContextDelivered: false,
              responseText: 'ok',
            });
          }, 20);
        }),
    );

    await Promise.all([
      runCursorPromptWithDriver({ ...base, stepId: 'a' }, driver),
      runCursorPromptWithDriver({ ...base, stepId: 'a' }, driver),
    ]);
    expect(maxActive).toBe(1);

    active = 0;
    maxActive = 0;
    await Promise.all([
      runCursorPromptWithDriver({ ...base, stepId: 'p1' }, driver),
      runCursorPromptWithDriver({ ...base, stepId: 'p2' }, driver),
    ]);
    expect(maxActive).toBe(2);
  });
});

it('keeps the driver-specific reason when a resume loses its context', async () => {
  // The `outcome.contextLost` branch is REACHABLE, not defence in depth: the
  // driver's `requireExistingSession` throw is caught by its own outer catch,
  // which returns `contextLost: true`. Deleting the branch would silently swap
  // the driver's specific sentence for the runner's generic one.
  runCursorTurn.mockResolvedValue({
    sessionId: 'fresh-session',
    isError: true,
    cancelled: false,
    message:
      'Cursor session sess-old could not be resumed: its saved context is no longer available.',
    contextLost: true,
    inheritedContextDelivered: false,
    responseText: '',
  });
  const result = await runCursorPromptWithDriver(
    { ...base, resumeSessionId: 'sess-old' },
    driver,
  );
  expect(result.status).toBe('failure');
  const message = result.status === 'failure' ? result.failure.message : '';
  expect(message).toContain('its saved context is no longer available');
  // Not replaced by the generic fallback.
  expect(message).not.toBe('Cursor session sess-old could not be resumed.');
});

describe('the step budget and cancellation cover shared setup', () => {
  // Environment preparation, the version probe and the session-index read all
  // happen inside the step, before any turn. They ran before the step's
  // deadline timer existed and without looking at its signal, so a held
  // filesystem or probe kept a step past its budget, and a cancellation was
  // only noticed after setup had finished.
  const prepare = jest.requireMock<{
    prepareCursorRuntimeEnvironment: jest.Mock;
  }>('../../cursor/runtime-environment').prepareCursorRuntimeEnvironment;
  const version = jest.requireMock<{
    verifyCursorRuntimeVersion: jest.Mock;
  }>('../../cursor/runtime-process').verifyCursorRuntimeVersion;

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** Holds one setup stage until released; resolves with its own value then. */
  const hold = (
    stage: 'prepare' | 'version' | 'session-index',
  ): {
    release: () => void;
    entered: Promise<void>;
  } => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let enter: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    if (stage === 'prepare')
      prepare.mockImplementationOnce(async () => {
        enter();
        await gate;
        return { PATH: '/bin', HOME: '/private' };
      });
    else if (stage === 'version')
      version.mockImplementationOnce(async () => {
        enter();
        await gate;
      });
    else {
      const realReadFile = fs.promises.readFile.bind(fs.promises);
      jest
        .spyOn(fs.promises, 'readFile')
        .mockImplementation(async (file, options) => {
          if (typeof file === 'string' && file.includes('cursor-session')) {
            enter();
            await gate;
          }
          return realReadFile(file, options);
        });
    }
    return { release, entered };
  };

  const settlesWithin = async <T>(
    work: Promise<T>,
    ms: number,
  ): Promise<T | 'still pending'> =>
    Promise.race([
      work,
      new Promise<'still pending'>((resolve) =>
        setTimeout(() => resolve('still pending'), ms),
      ),
    ]);

  it.each([
    ['prepare', 'deadline'],
    ['version', 'deadline'],
    ['session-index', 'deadline'],
    ['prepare', 'cancel'],
    ['version', 'cancel'],
    ['session-index', 'cancel'],
  ] as const)(
    'settles while %s is held when the step is stopped by %s',
    async (stage, stop) => {
      const held = hold(stage);
      const controller = new AbortController();
      const running = runCursorPromptWithDriver(
        {
          ...base,
          ...(stage === 'session-index' ? { resumeSessionId: 'sess-1' } : {}),
          totalTimeoutMs: stop === 'deadline' ? 25 : 60_000,
          signal: controller.signal,
        },
        driver,
      );
      try {
        await held.entered;
        if (stop === 'cancel') controller.abort();
        const outcome: CursorPromptRunnerResult | 'still pending' =
          await settlesWithin(running, 1_000);
        expect(outcome).not.toBe('still pending');
        if (outcome === 'still pending') return;
        if (stop === 'deadline') {
          expect(outcome.status).toBe('failure');
          expect(
            outcome.status === 'failure' ? outcome.failure.message : '',
          ).toMatch(/timed out/i);
        } else {
          expect(outcome.status).toBe('cancelled');
        }
      } finally {
        held.release();
        await running;
      }
      // Nothing the step no longer owns reached the provider.
      expect(runCursorTurn).not.toHaveBeenCalled();
    },
  );

  it('leaves a concurrent step unaffected while another is stopped in setup', async () => {
    const held = hold('prepare');
    const controller = new AbortController();
    const stopped = runCursorPromptWithDriver(
      { ...base, stepId: 'stopped', signal: controller.signal },
      driver,
    );
    await held.entered;
    const sibling = runCursorPromptWithDriver(
      { ...base, stepId: 'sibling' },
      driver,
    );
    controller.abort();
    try {
      expect((await stopped).status).toBe('cancelled');
      const result = await sibling;
      expect(result.status).toBe('success');
      expect(runCursorTurn).toHaveBeenCalledTimes(1);
    } finally {
      held.release();
    }
  });
});
