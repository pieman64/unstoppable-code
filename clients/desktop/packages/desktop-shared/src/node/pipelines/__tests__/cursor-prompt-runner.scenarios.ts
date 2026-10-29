import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test as nodeTest, type TestContext } from 'node:test';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  getCursorRuntimeTarget,
  type CursorRuntimeTarget,
} from '../../../lib/cursor-runtime-targets';
import { CURSOR_RUNTIME_VERSION } from '../../cursor/runtime-metadata';
import { fingerprintCursorRuntime } from '../../cursor/runtime-fingerprint';
import { createCliExecutionRuntime } from '../cli-runtime';
import { runCursorPromptWithDriver } from '../cursor-prompt-runner';
import { getPipelineExecutionCursorProfileDir } from '../../lib/paths';

// End-to-end coverage for the SHARED runner body the CLI uses. The approved
// design asked for a CLI pipeline run against the fixture and against a missing
// runtime; the existing CLI tests only cover the three preflight gates, which
// never reach this function. The fixture answers `--version` with exactly the
// pinned `cursor-cli` version, so the real version verification runs rather than
// being stubbed.
const FIXTURE = path.resolve(
  __dirname,
  '../../../../../../apps/desktop-app/tests/electron/fixtures/cursor-acp-agent.mjs',
);

function test(
  name: string,
  scenario: (context: TestContext) => Promise<void>,
): void {
  void nodeTest(name, scenario);
}

/**
 * The host target these scenarios run against.
 *
 * The production target table deliberately has NO Linux entry: Canopy does not
 * ship a Cursor runtime for Linux, and adding one so that a test can run would
 * be shipping unsupported product surface. But the required PR shards run on
 * Ubuntu, where `getCursorRuntimeTarget` returns undefined — and the previous
 * `if (!target) return` guard made all five scenarios below report PASS there
 * with zero assertions executed.
 *
 * The pinned ACP fixture is a portable `.mjs` run through `process.execPath`,
 * so nothing about the thing under test is platform-specific. A host with no
 * target of its own injects the macOS host target of the same architecture
 * into the CLI runtime factory. The real install-status check, launch
 * resolution and `--version` verification all run against the fixture without
 * mutating Node's process-wide platform. No production Linux support is added.
 *
 * A host whose ARCHITECTURE has no target at all is reported as a genuine skip
 * rather than a silent pass.
 */
const nativeTarget = getCursorRuntimeTarget(process.platform, process.arch);
const hostTarget =
  nativeTarget ?? getCursorRuntimeTarget('darwin', process.arch);

/** A missing target is a real unsupported host: skip, never a silent pass. */
function requireTarget(context: TestContext): NonNullable<typeof hostTarget> {
  if (!hostTarget)
    throw new Error(
      `no Cursor runtime target for ${process.platform}-${process.arch}`,
    );
  void context;
  return hostTarget;
}

async function workspace(context: TestContext): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'cursor-cli-runner-'));
  context.after(async () => {
    await rm(cwd, { recursive: true, force: true });
  });
  return cwd;
}

interface RunnerRequest {
  cwd: string;
  prompt: string;
  environment: Record<string, string>;
  model: string;
  totalTimeoutMs: number;
  permissionPreset: 'read_only' | 'plan' | 'dangerous_all';
  executionsDir: string;
  executionId: string;
  jobId: string;
  stepId: string;
  attempt: number;
  signal: AbortSignal;
}

function request(cwd: string, executionsDir: string): RunnerRequest {
  return {
    cwd,
    prompt: 'Summarize the repository',
    environment: { PATH: process.env.PATH ?? '/usr/bin' },
    model: 'cursor-default',
    totalTimeoutMs: 60_000,
    permissionPreset: 'read_only' as const,
    executionsDir,
    executionId: 'cli-exec',
    jobId: 'cli-job',
    stepId: 'cli-step',
    attempt: 1,
    signal: new AbortController().signal,
  };
}

test('the shared runner completes a Cursor step against the pinned ACP fixture', async (context) => {
  const target = requireTarget(context);
  const dataDir = await workspace(context);
  const cwd = await workspace(context);
  const executionsDir = await workspace(context);
  withDataDir(context, dataDir);
  const transcript: string[] = [];
  const result = await runCursorPromptWithDriver(
    {
      ...request(cwd, executionsDir),
      onTranscriptLine: (line) => transcript.push(line),
    },
    {
      launch: { command: process.execPath, prefix: [FIXTURE] },
      target,
      baseEnvironment: { ...process.env },
    },
  );
  assert.equal(result.status, 'success');
  assert.ok(result.transcript.length > 0, 'a transcript was produced');
  assert.ok(
    transcript.some((line) => line.includes('"type"')),
    'structured transcript lines were streamed',
  );
});

test('a failed version probe records its exit status and never starts a pipeline turn', async (context) => {
  const target = requireTarget(context);
  const dataDir = await workspace(context);
  const cwd = await workspace(context);
  const executionsDir = await workspace(context);
  withDataDir(context, dataDir);
  const probeFile = path.join(dataDir, 'version-probe.json');
  await writeFile(probeFile, JSON.stringify({ mode: 'exit' }));
  const result = await runCursorPromptWithDriver(request(cwd, executionsDir), {
    launch: { command: process.execPath, prefix: [FIXTURE] },
    target,
    baseEnvironment: {
      ...process.env,
      CANOPY_E2E_CURSOR_VERSION_PROBE_FILE: probeFile,
    },
  });
  assert.equal(result.status, 'failure');
  assert.equal(
    result.failure?.message,
    'The Cursor version check exited before it completed. Try again.',
  );
  assert.match(
    result.transcript,
    /"type":"cursor_version_check","outcome":"process-exit"/,
  );
  assert.match(result.transcript, /"exitCode":7/);
  assert.ok(!result.transcript.includes('reinstall'));
  const probeState: unknown = JSON.parse(await readFile(probeFile, 'utf8'));
  assert.ok(
    typeof probeState === 'object' &&
      probeState !== null &&
      'attempts' in probeState,
  );
  assert.equal(probeState.attempts, 1);
});

for (const forgets of [true, false]) {
  test(`a structured retry ${forgets ? 'that loses its conversation still has the original task' : 'in its own conversation gets only the retry prompt'}`, async (context) => {
    // The first answer does not parse, so the step retries. The retry prompt
    // says "use the original task from this thread" — true only while the
    // thread still exists. When its saved conversation cannot be restored,
    // the retry must carry the task itself rather than start a new thread
    // that has never seen it.
    const target = requireTarget(context);
    const dataDir = await workspace(context);
    const cwd = await workspace(context);
    const executionsDir = await workspace(context);
    withDataDir(context, dataDir);
    const base = request(cwd, executionsDir);
    const profile = getPipelineExecutionCursorProfileDir(
      executionsDir,
      base.executionId,
      base.jobId,
      base.stepId,
    );
    await mkdir(profile, { recursive: true });
    if (forgets)
      await writeFile(path.join(profile, 'fixture-forget-sessions'), '1');
    const result = await runCursorPromptWithDriver(
      {
        ...base,
        prompt: 'CURSOR_E2E_STRUCTURED_RETRY summarize ORIGINAL-TASK-7731',
        schema: {
          type: 'object',
          required: ['summary'],
          properties: { summary: { type: 'string' } },
        },
      },
      {
        launch: { command: process.execPath, prefix: [FIXTURE] },
        target,
        baseEnvironment: { ...process.env },
      },
    );
    assert.equal(result.status, 'success');
    assert.deepEqual(result.structured, {
      summary: forgets ? 'had-task' : 'no-task',
    });
    if (!forgets)
      assert.equal(
        await readFile(path.join(profile, 'fixture-loaded.txt'), 'utf8'),
        'cursor-fixture-session',
        'the retry was sent into the saved conversation',
      );
  });
}

test('the shared runner stops a turn whose tool never reached the approval hook', async (context) => {
  // The integrity anchor is the backstop behind the approval hook: a tool that
  // CHANGES the worktree and completes without having gone through the hook
  // must stop the turn rather than be reported as a normal success. Nothing
  // exercised it at the fixture level, so a regression here would have been
  // invisible to every runner test.
  const target = requireTarget(context);
  const dataDir = await workspace(context);
  const cwd = await workspace(context);
  const executionsDir = await workspace(context);
  withDataDir(context, dataDir);
  const result = await runCursorPromptWithDriver(
    {
      ...request(cwd, executionsDir),
      prompt: 'Do the thing CURSOR_CHAT_E2E_UNHOOKED_TOOL',
    },
    {
      launch: { command: process.execPath, prefix: [FIXTURE] },
      target,
      baseEnvironment: { ...process.env },
    },
  );
  assert.equal(result.status, 'failure');
  assert.equal(result.failure?.provider, 'cursor');
  assert.match(
    String(result.failure?.message),
    /without reaching the approval hook/,
  );
});

test('the shared runner refuses an MCP call from a server the step was never given', async (context) => {
  // Headless steps supply no MCP servers, so any MCP call comes from a server
  // the runtime found on its own. The fixture models that call with no ACP
  // permission request, leaving the preToolUse hook as its only gate, and with
  // an effect outside the worktree that the integrity anchor cannot see.
  const target = requireTarget(context);
  const dataDir = await workspace(context);
  const cwd = await workspace(context);
  const executionsDir = await workspace(context);
  withDataDir(context, dataDir);
  for (const permissionPreset of [
    'read_only',
    'plan',
    'dangerous_all',
  ] as const) {
    const result = await runCursorPromptWithDriver(
      {
        ...request(cwd, executionsDir),
        permissionPreset,
        executionId: `cli-exec-${permissionPreset.replace('_', '-')}`,
        prompt: 'Send it CURSOR_CHAT_E2E_MCP_UNSUPPLIED',
      },
      {
        launch: { command: process.execPath, prefix: [FIXTURE] },
        target,
        baseEnvironment: { ...process.env },
      },
    );
    // The fixture writes into its CURSOR_DATA_DIR, which is the step's
    // profile directory under the execution, not the app data directory.
    const ran = [
      ...(await readdir(executionsDir, { recursive: true })),
      ...(await readdir(dataDir, { recursive: true })),
    ].filter((entry) => entry.endsWith('fixture-unsupplied-mcp-ran.json'));
    assert.deepEqual(ran, [], `${permissionPreset}: the MCP tool never ran`);
    assert.ok(
      !result.transcript.includes('UNSUPPLIED_MCP_RAN'),
      `${permissionPreset}: no MCP result reached the transcript`,
    );
  }
});

/** Rebuilds each streamed text block from its creation and appendText patches. */
function reconstructBlocks(lines: readonly string[]): string[] {
  const order: string[] = [];
  const texts = new Map<string, string>();
  const record = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value))
      : undefined;
  for (const line of lines) {
    const event = record(JSON.parse(line));
    if (!event || event.type !== 'canopy_assistant_patch') continue;
    const patches: unknown = event.patches;
    if (!Array.isArray(patches)) continue;
    for (const item of patches) {
      const patch = record(item);
      if (!patch) continue;
      const key = `${String(event.messageId)}#${String(patch.index)}`;
      const block = record(patch.block);
      if (typeof block?.text === 'string') {
        if (!texts.has(key)) order.push(key);
        texts.set(key, block.text);
      } else if (typeof patch.appendText === 'string') {
        texts.set(key, (texts.get(key) ?? '') + patch.appendText);
      }
    }
  }
  return order.map((key) => texts.get(key) ?? '');
}

test('the shared runner masks a configured value streamed across chunks', async (context) => {
  // Every chunk is its own complete transcript record, so masking each record
  // on its own never sees a value split between chunks. The joined block text
  // is what a viewer shows, so that is what must be masked — while unrelated
  // text, including a partial value cut off at the end of the turn, survives
  // exactly.
  const target = requireTarget(context);
  const dataDir = await workspace(context);
  const cwd = await workspace(context);
  const executionsDir = await workspace(context);
  withDataDir(context, dataDir);
  const lines: string[] = [];
  const result = await runCursorPromptWithDriver(
    {
      ...request(cwd, executionsDir),
      prompt: 'Echo it CURSOR_CHAT_E2E_SPLIT_SECRET',
      secretValues: ['sk-live-FAKE-0123456789abcdef'],
      onTranscriptLine: (line) => lines.push(line),
    },
    {
      launch: { command: process.execPath, prefix: [FIXTURE] },
      target,
      baseEnvironment: { ...process.env },
    },
  );
  assert.equal(result.status, 'success');
  assert.deepEqual(reconstructBlocks(lines), [
    'Reading *** from the env.',
    'The key is ***. Unrelated tail.',
    'Again: ***.',
    'Whole *** here, then a trailing *** and a cut-off sk-li',
  ]);
  for (const line of lines)
    assert.ok(!line.includes('FAKE-0123'), `no fragment in ${line}`);
});

test('the shared runner fails a Cursor step whose turn exceeds the projection limit', async (context) => {
  // The shared projection bounds one turn at 8 MiB of notification JSON or
  // 4,096 blocks, for chat and steps alike. A step that crosses it must fail —
  // never report success over a truncated transcript — and say so in words
  // that fit a pipeline step rather than a chat.
  const target = requireTarget(context);
  const dataDir = await workspace(context);
  const cwd = await workspace(context);
  const executionsDir = await workspace(context);
  withDataDir(context, dataDir);
  const result = await runCursorPromptWithDriver(
    {
      ...request(cwd, executionsDir),
      prompt: 'Write a lot CURSOR_CHAT_E2E_OUTPUT_FLOOD',
    },
    {
      launch: { command: process.execPath, prefix: [FIXTURE] },
      target,
      baseEnvironment: { ...process.env },
    },
  );
  assert.equal(result.status, 'failure');
  assert.equal(result.failure?.provider, 'cursor');
  assert.equal(result.failure?.had_agent_activity, true);
  assert.equal(
    result.failure?.message,
    'Cursor wrote more than one step can hold (8 MiB or 4,096 blocks in a turn), so the step was stopped.',
  );
});

test('the shared runner reports a structured failure for a missing runtime', async (context) => {
  const target = requireTarget(context);
  const cwd = await workspace(context);
  const executionsDir = await workspace(context);
  const result = await runCursorPromptWithDriver(request(cwd, executionsDir), {
    launch: {
      command: path.join(cwd, 'definitely-not-installed'),
      prefix: [],
    },
    target,
    baseEnvironment: { ...process.env },
  });
  assert.equal(result.status, 'failure');
  assert.equal(result.failure?.provider, 'cursor');
  assert.equal(result.failure?.agent_harness, 'cursor');
  assert.equal(result.failure?.had_agent_activity, false);
});

/**
 * Integration coverage for the CLI RUNTIME path, not just the shared body.
 *
 * These go through `createCliExecutionRuntime(...).cursorPromptRunner`, which is
 * `runCliCursorPrompt`, so they exercise what the two direct tests above do not:
 * the CLI `cursorEnabled` preference read, `cursorRuntimeInstalled()` presence
 * detection, `resolveCursorLaunch` against the pinned version layout, and the
 * CLI's own `getEnhancedEnv` base environment. The installed runtime is a shim
 * that execs the pinned ACP fixture, so no production code is bypassed and no
 * cloud request is made.
 *
 * Boundary stated honestly: this covers the shared CLI runtime FACTORY and its
 * Cursor runner. It does NOT cover `apps/desktop-cli`'s argv/command layer —
 * and that layer DOES participate in Cursor step execution, contrary to what
 * this note used to claim. It is covered directly, by spawning the real CLI,
 * in `apps/desktop-cli/src/__tests__/run-pipeline.test.ts`
 * ("Cursor pipeline steps through the CLI argv/command layer").
 */
async function installFixtureRuntime(
  dataDir: string,
  target: { required: readonly string[]; hookRuntime: string },
): Promise<void> {
  const versionDir = path.join(
    dataDir,
    'cursor-runtime',
    CURSOR_RUNTIME_VERSION,
  );
  await mkdir(versionDir, { recursive: true });
  for (const name of target.required) {
    const shim = path.join(versionDir, name);
    await writeFile(
      shim,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FIXTURE)} "$@"\n`,
    );
    await chmod(shim, 0o755);
  }
  // The approval hook runs as `<dirname(launch.command)>/<hookRuntime>`, a
  // real installed-layout path. Without it the hook exits 127, its empty
  // output fails to parse, and the fixture denies EVERY tool — which a test
  // asserting only success cannot tell apart from an enforced preset.
  const hookRuntime = path.join(versionDir, target.hookRuntime);
  await writeFile(
    hookRuntime,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
  );
  await chmod(hookRuntime, 0o755);
}

function withDataDir(context: TestContext, dataDir: string): void {
  const previous = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = dataDir;
  context.after(() => {
    if (previous === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = previous;
  });
}

/** Preferences exactly as the desktop's `writePreferencesDataFile` writes them. */
function desktopPreferences(cursorEnabled: boolean): string {
  return JSON.stringify(
    { version: 1, preferences: { cursorEnabled } },
    null,
    2,
  );
}

/**
 * The runtime's host, plus the digest the staged fixture tree must match: the
 * tree as it is NOW is the "pinned" install, the way the desktop's E2E archive
 * carries its own digests. The runner still hashes the tree and compares.
 */
async function runtimeDependencies(
  target: CursorRuntimeTarget,
  dataDir: string,
): Promise<{
  cursorHost: { platform: string; arch: string };
  cursorRuntimeDigest?: string;
}> {
  const cursorHost = {
    platform: target.os === 'windows' ? 'win32' : target.os,
    arch: target.arch,
  };
  const versionDir = path.join(
    dataDir,
    'cursor-runtime',
    CURSOR_RUNTIME_VERSION,
  );
  const digest = await fingerprintCursorRuntime(
    versionDir,
    target.executables,
    new AbortController().signal,
  ).catch(() => undefined);
  return digest ? { cursorHost, cursorRuntimeDigest: digest } : { cursorHost };
}

for (const [permissionPreset, expectWritten] of [
  ['read_only', false],
  ['dangerous_all', true],
] as const) {
  test(`the CLI runtime enforces ${permissionPreset} on the file the agent writes`, async (context) => {
    // The fixture asks the approval hook for Write and writes `result.txt`
    // only when the hook allows it, so the file IS the decision.
    const target = requireTarget(context);
    const dataDir = await workspace(context);
    const cwd = await workspace(context);
    const executionsDir = await workspace(context);
    withDataDir(context, dataDir);
    await writeFile(
      path.join(dataDir, 'preferences.json'),
      desktopPreferences(true),
    );
    await installFixtureRuntime(dataDir, target);

    const runtime = createCliExecutionRuntime(
      { cwd, executionsDir },
      await runtimeDependencies(target, dataDir),
    );
    assert.ok(
      runtime.cursorPromptRunner,
      'the CLI runtime exposes a Cursor runner',
    );
    const result = await runtime.cursorPromptRunner.runCursorPrompt({
      ...request(cwd, executionsDir),
      permissionPreset,
    });
    assert.equal(result.status, 'success');
    const written = await readFile(path.join(cwd, 'result.txt'), 'utf8').catch(
      () => undefined,
    );
    assert.equal(written, expectWritten ? 'CURSOR_APPROVAL_OK\n' : undefined);
  });
}

test('the CLI runtime tells a CLI user how to replace a mismatched runtime', async (context) => {
  // The version probe's recovery sentence used to name desktop Settings, a
  // place a CLI user is not in. The CLI reuses the desktop installation, so
  // that is where the fix is — said in CLI terms.
  const target = requireTarget(context);
  const dataDir = await workspace(context);
  const cwd = await workspace(context);
  const executionsDir = await workspace(context);
  withDataDir(context, dataDir);
  await writeFile(
    path.join(dataDir, 'preferences.json'),
    desktopPreferences(true),
  );
  await installFixtureRuntime(dataDir, target);
  // Same layout, but the runtime answers `--version` with the wrong version.
  const versionDir = path.join(
    dataDir,
    'cursor-runtime',
    CURSOR_RUNTIME_VERSION,
  );
  for (const name of target.required)
    await writeFile(
      path.join(versionDir, name),
      '#!/bin/sh\nfor arg in "$@"; do if [ "$arg" = "--version" ]; then echo 0.0.0; exit 0; fi; done\nexit 1\n',
    );
  const runtime = createCliExecutionRuntime(
    { cwd, executionsDir },
    await runtimeDependencies(target, dataDir),
  );
  const result = await runtime.cursorPromptRunner?.runCursorPrompt(
    request(cwd, executionsDir),
  );
  assert.equal(result?.status, 'failure');
  assert.equal(
    result?.failure?.message,
    `Cursor CLI ${CURSOR_RUNTIME_VERSION} is required. Reconnect Cursor in the desktop app to reinstall it; the CLI reuses that installation.`,
  );
});

test('the CLI runtime reports a structured failure when the runtime is not installed', async (context) => {
  const target = requireTarget(context);
  const dataDir = await workspace(context);
  const cwd = await workspace(context);
  const executionsDir = await workspace(context);
  withDataDir(context, dataDir);
  await writeFile(
    path.join(dataDir, 'preferences.json'),
    desktopPreferences(true),
  );

  const runtime = createCliExecutionRuntime(
    { cwd, executionsDir },
    await runtimeDependencies(target, dataDir),
  );
  const result = await runtime.cursorPromptRunner?.runCursorPrompt(
    request(cwd, executionsDir),
  );
  assert.equal(result?.status, 'failure');
  assert.equal(result?.failure?.provider, 'cursor');
  assert.match(
    String(result?.failure?.message),
    /Connect Cursor|not available/,
  );
});

test('the CLI runtime refuses a Cursor step when the preference is off', async (context) => {
  const target = requireTarget(context);
  const dataDir = await workspace(context);
  const cwd = await workspace(context);
  const executionsDir = await workspace(context);
  withDataDir(context, dataDir);
  await writeFile(
    path.join(dataDir, 'preferences.json'),
    desktopPreferences(false),
  );
  await installFixtureRuntime(dataDir, target);

  const runtime = createCliExecutionRuntime(
    { cwd, executionsDir },
    await runtimeDependencies(target, dataDir),
  );
  const result = await runtime.cursorPromptRunner?.runCursorPrompt(
    request(cwd, executionsDir),
  );
  assert.equal(result?.status, 'failure');
  assert.equal(result?.failure?.provider, 'cursor');
});

test('the CLI runtime runs nothing from a runtime tree that no longer matches its digest', async (context) => {
  // Presence, modes and the pinned `--version` answer are not integrity: the
  // tree is hashed before anything in it runs. Every file here records being
  // executed, so a launch before verification cannot go unnoticed.
  const target = requireTarget(context);
  const dataDir = await workspace(context);
  const cwd = await workspace(context);
  const executionsDir = await workspace(context);
  withDataDir(context, dataDir);
  await writeFile(
    path.join(dataDir, 'preferences.json'),
    desktopPreferences(true),
  );
  await installFixtureRuntime(dataDir, target);
  const versionDir = path.join(
    dataDir,
    'cursor-runtime',
    CURSOR_RUNTIME_VERSION,
  );
  const ran = path.join(dataDir, 'ran');
  const recording = `#!/bin/sh\necho "$0" >> ${JSON.stringify(ran)}\nif [ "$1" = "--version" ]; then echo ${CURSOR_RUNTIME_VERSION}; fi\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FIXTURE)} "$@"\n`;
  for (const name of [...target.required, target.hookRuntime])
    await writeFile(path.join(versionDir, name), recording);
  const pinned = await runtimeDependencies(target, dataDir);
  // Changed after pinning: one byte in the launcher.
  const launcher = path.join(versionDir, target.required[0] ?? '');
  await writeFile(launcher, `${await readFile(launcher, 'utf8')}#\n`);

  const runtime = createCliExecutionRuntime({ cwd, executionsDir }, pinned);
  const result = await runtime.cursorPromptRunner?.runCursorPrompt(
    request(cwd, executionsDir),
  );
  assert.equal(result?.status, 'failure');
  assert.equal(
    result?.failure?.message,
    'Cursor runtime verification failed. Reconnect Cursor in the desktop app to restore it; the CLI reuses that installation.',
  );
  assert.equal(await readFile(ran, 'utf8').catch(() => undefined), undefined);
});

test('the CLI runtime refuses a legacy flat preferences file', async (context) => {
  // The desktop never writes this shape and recovers it when it finds one,
  // without reading `cursorEnabled` from it; the CLI stays closed too.
  const target = requireTarget(context);
  const dataDir = await workspace(context);
  const cwd = await workspace(context);
  const executionsDir = await workspace(context);
  withDataDir(context, dataDir);
  await writeFile(
    path.join(dataDir, 'preferences.json'),
    JSON.stringify({ cursorEnabled: true }),
  );
  await installFixtureRuntime(dataDir, target);
  const runtime = createCliExecutionRuntime(
    { cwd, executionsDir },
    await runtimeDependencies(target, dataDir),
  );
  const result = await runtime.cursorPromptRunner?.runCursorPrompt(
    request(cwd, executionsDir),
  );
  assert.equal(result?.status, 'failure');
  assert.match(
    String(result?.failure?.message),
    /Connect Cursor in the desktop app first/,
  );
});

for (const stop of ['cancel', 'deadline'] as const) {
  test(`the CLI runtime settles and runs nothing when a step is stopped by ${stop} during verification`, async (context) => {
    // A large file keeps the full-tree hash busy long enough to stop it
    // part way through.
    const target = requireTarget(context);
    const dataDir = await workspace(context);
    const cwd = await workspace(context);
    const executionsDir = await workspace(context);
    withDataDir(context, dataDir);
    await writeFile(
      path.join(dataDir, 'preferences.json'),
      desktopPreferences(true),
    );
    await installFixtureRuntime(dataDir, target);
    const versionDir = path.join(
      dataDir,
      'cursor-runtime',
      CURSOR_RUNTIME_VERSION,
    );
    const ran = path.join(dataDir, 'ran');
    const recording = `#!/bin/sh\necho "$0" >> ${JSON.stringify(ran)}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FIXTURE)} "$@"\n`;
    for (const name of [...target.required, target.hookRuntime])
      await writeFile(path.join(versionDir, name), recording);
    await writeFile(
      path.join(versionDir, 'large.bin'),
      Buffer.alloc(64 * 1024 * 1024, 7),
    );
    const pinned = await runtimeDependencies(target, dataDir);
    const runtime = createCliExecutionRuntime({ cwd, executionsDir }, pinned);
    const controller = new AbortController();
    const started = Date.now();
    const running = runtime.cursorPromptRunner?.runCursorPrompt({
      ...request(cwd, executionsDir),
      signal: controller.signal,
      totalTimeoutMs: stop === 'deadline' ? 5 : 60_000,
    });
    if (stop === 'cancel') setTimeout(() => controller.abort(), 5);
    const result = await running;
    assert.equal(result?.status, stop === 'cancel' ? 'cancelled' : 'failure');
    assert.ok(Date.now() - started < 5_000, 'settled promptly');
    assert.equal(await readFile(ran, 'utf8').catch(() => undefined), undefined);
    // The stopped verification does not hold up the next one.
    const next = await createCliExecutionRuntime(
      { cwd, executionsDir },
      pinned,
    ).cursorPromptRunner?.runCursorPrompt(request(cwd, executionsDir));
    assert.equal(next?.status, 'success');
  });
}
