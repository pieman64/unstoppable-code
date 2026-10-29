// Durable UI-automation coverage for a `builtin/agent-prompt` pipeline step
// running on `cursor-default`. Exercises the real desktop flow: connect
// Cursor in Settings, dispatch a stored pipeline from the workspace activity
// panel, and confirm the run card, execution-state JSON, and the fixture's
// on-disk file effect all agree. Two scenarios drive the same default-prompt
// path in `fixtures/cursor-acp-agent.mjs` (a Read hook then a Write hook for
// `result.txt` in the step cwd) through the headless permission-preset host:
// `read_only` denies the Write (no file), `dangerous_all` allows it (file
// written). A third scenario runs with Cursor never connected, so the step
// must fail fast with the desktop runner's Connect-Cursor guidance instead of
// spawning the agent at all.
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { openWorkspaceAndRun } from './codexPipelineRuntime.mjs';
import {
  cleanupDemoWorkspaces,
  seedDemoWorkspaces,
} from './demoWorkspaces.mjs';
import { cursorRuntimeFixture } from './fixtures/cursor-runtime.mjs';
import { expectCursorConnected } from './fixtures/cursor-tile.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  configureGlobalPipelineSecret,
  reopenCompletedStep,
  showPipelineJobList,
} from './pipelineUi.mjs';
import { seedStoredPipeline } from './seeders/seedStoredPipeline.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';

function pipelineYaml(name, preset, prompt = 'Create the result file.') {
  return [
    `name: ${name}`,
    'on: dispatch',
    'jobs:',
    '  verify:',
    '    name: Verify Cursor runtime',
    '    steps:',
    '      - id: cursor',
    '        name: Run Cursor',
    '        uses: builtin/agent-prompt',
    '        timeout_minutes: 2',
    '        with:',
    '          model: cursor-default',
    `          permission_preset: ${preset}`,
    `          prompt: ${prompt}`,
    '',
  ].join('\n');
}

async function connectCursor(window) {
  const app = new CanopyAppDriver(window);
  await app.openSettings();
  await app.openSettingsSection('experiments');
  await window.getByTestId('cursor-connect').click();
  await expectCursorConnected(window);
  await app.closeSettings();
}

function executionState(userDataDir) {
  const dir = path.join(userDataDir, 'pipeline-executions');
  const file = readdirSync(dir).find((entry) => entry.endsWith('.json'));
  if (!file) {
    throw new Error(`No pipeline execution JSON file found under ${dir}`);
  }
  return JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
}

function worktreePathFor(seeded) {
  const workspace = seeded.workspaces.find(
    (candidate) => candidate.id === WORKSPACE_ID,
  );
  return workspace?.worktreePath;
}

for (const scenario of [
  {
    preset: 'read_only',
    expectFile: false,
    label: 'denies the Write under read_only',
  },
  {
    preset: 'dangerous_all',
    expectFile: true,
    label: 'allows the Write under dangerous_all',
  },
]) {
  test(`Cursor pipeline step ${scenario.label}`, async () => {
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'cursor-pipeline-'));
    const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    const name = `E2E Cursor ${scenario.preset}`;
    seedStoredPipeline({
      userDataDir,
      id: `cursor-${scenario.preset}`,
      name,
      yaml: pipelineYaml(name, scenario.preset),
    });
    const managed = await cursorRuntimeFixture();
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: managed.env,
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await connectCursor(window);
      const card = await openWorkspaceAndRun(window, name);
      await expect(card).toContainText('success', { timeout: 90_000 });
      const state = executionState(userDataDir);
      expect(state.jobs.verify.steps.cursor.status).toBe('success');
      const worktreeDir = worktreePathFor(seeded);
      const resultPath = path.join(worktreeDir, 'result.txt');
      expect(existsSync(resultPath)).toBe(scenario.expectFile);
      if (scenario.expectFile) {
        // The binding constraint is not just presence but exact content: the
        // fixture only writes this literal string on an allowed Write
        // (fixtures/cursor-acp-agent.mjs).
        expect(readFileSync(resultPath, 'utf8')).toBe('CURSOR_APPROVAL_OK\n');
      }
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await managed.close();
      cleanupDemoWorkspaces(seeded);
    }
  });
}

for (const tool of ['Grep', 'Glob']) {
  for (const preset of ['read_only', 'none']) {
    test(`Cursor pipeline native ${tool} honors ${preset}`, async () => {
      const userDataDir = mkdtempSync(
        path.join(os.tmpdir(), 'cursor-pipeline-search-'),
      );
      const seeded = seedDemoWorkspaces({
        userDataDir,
        apps: ['ts-pnpm-vite'],
      });
      const cwd = worktreePathFor(seeded);
      writeFileSync(
        path.join(cwd, 'cursor-native-source.txt'),
        'native search needle\n',
      );
      const name = `Native ${tool} ${preset}`;
      seedStoredPipeline({
        userDataDir,
        id: `cursor-${tool}-${preset}`,
        name,
        yaml: pipelineYaml(name, preset, `CURSOR_CHAT_E2E_NATIVE_${tool}`),
      });
      const managed = await cursorRuntimeFixture();
      const { electronApp } = await launchCanopy({
        userDataDir,
        env: managed.env,
      });
      try {
        const window = await electronApp.firstWindow();
        await new CanopyAppDriver(window).waitForShell();
        await connectCursor(window);
        const card = await openWorkspaceAndRun(window, name);
        await expect(card).toContainText('success', { timeout: 90_000 });
        expect(
          executionState(userDataDir).jobs.verify.steps.cursor.status,
        ).toBe('success');
        expect(
          existsSync(path.join(cwd, `cursor-native-executed-${tool}`)),
        ).toBe(preset === 'read_only');
      } finally {
        await closeCanopy(electronApp, userDataDir);
        await managed.close();
        cleanupDemoWorkspaces(seeded);
      }
    });
  }
}

/** Each streamed text block's final text, rebuilt from its patches. */
function streamedBlocks(lines) {
  const order = [];
  const texts = new Map();
  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type !== 'canopy_assistant_patch') continue;
    for (const patch of event.patches ?? []) {
      const key = `${event.messageId}#${patch.index}`;
      if (typeof patch.block?.text === 'string') {
        if (!texts.has(key)) order.push(key);
        texts.set(key, patch.block.text);
      } else if (typeof patch.appendText === 'string') {
        texts.set(key, (texts.get(key) ?? '') + patch.appendText);
      }
    }
  }
  return order.map((key) => texts.get(key) ?? '');
}

test('Cursor pipeline step masks a configured value streamed across message and thought chunks', async () => {
  // The fixture streams a synthetic configured value in token-sized pieces
  // across interleaved message and thought blocks, and once cut off at the end
  // of the turn. Each piece is its own transcript record, so masking records
  // one at a time let the whole value through to the saved transcript and the
  // step's output view even though `text_response` was masked.
  test.setTimeout(180_000);
  const secret = 'sk-live-FAKE-0123456789abcdef';
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'cursor-pipeline-'));
  const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const name = 'E2E Cursor split secret';
  seedStoredPipeline({
    userDataDir,
    id: 'cursor-split-secret',
    name,
    yaml: pipelineYaml(
      name,
      'read_only',
      'Echo it CURSOR_CHAT_E2E_SPLIT_SECRET',
    ),
  });
  const managed = await cursorRuntimeFixture();
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: managed.env,
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await connectCursor(window);
    await configureGlobalPipelineSecret(
      window,
      'E2E_CURSOR_SPLIT_SECRET',
      secret,
    );
    const card = await openWorkspaceAndRun(window, name);
    await expect(card).toContainText('success', { timeout: 90_000 });
    const state = executionState(userDataDir);
    const step = state.jobs.verify.steps.cursor;
    expect(step.status).toBe('success');

    // The saved transcript, read off disk and rebuilt block by block.
    const saved = readFileSync(step.log_file, 'utf8');
    expect(streamedBlocks(saved.split('\n'))).toEqual([
      'Reading *** from the env.',
      'The key is ***. Unrelated tail.',
      'Again: ***.',
      'Whole *** here, then a trailing *** and a cut-off sk-li',
    ]);
    expect(saved).not.toContain('FAKE-0123');
    expect(step.outputs.text_response).not.toContain('FAKE-0123');

    // And what the step's output view renders, in both modes.
    const detail = await reopenCompletedStep(window, card, 'verify', 'cursor');
    const output = detail.getByTestId('pipeline-step-log-output-cursor');
    await expect(output).toContainText('The key is ***. Unrelated tail.');
    await expect(output).not.toContainText('FAKE-0123');
    await detail.getByTestId('pipeline-step-log-mode-raw-cursor').click();
    await expect(output).toContainText('Unrelated tail.');
    await expect(output).not.toContainText('FAKE-0123');
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await managed.close();
    cleanupDemoWorkspaces(seeded);
  }
});

/** Each tool block's input, display input and output, decoded once more. */
function toolValues(lines) {
  const values = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    for (const patch of event.patches ?? []) {
      const block = patch.block;
      if (block?.type !== 'tool_use' && block?.type !== 'tool_result') continue;
      for (const field of [block.input, block.display?.input, block.output])
        if (typeof field === 'string') values.push(JSON.parse(field));
    }
  }
  return values;
}

test('Cursor pipeline step masks a configured value reflowed, split around a tool, and nested in tool values', async () => {
  // The fixture echoes a synthetic configured value with its spacing
  // reflowed across thought deltas, splits it around a Read tool call, and
  // passes it inside that tool's input and output. Each is a shape masking
  // records one at a time let through to the saved transcript and the step's
  // output view even though `text_response` was masked.
  test.setTimeout(180_000);
  const secret = 'sk-live  "Q\\Z"  0123456';
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'cursor-pipeline-'));
  const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const name = 'E2E Cursor nested secret';
  seedStoredPipeline({
    userDataDir,
    id: 'cursor-nested-secret',
    name,
    yaml: pipelineYaml(
      name,
      'read_only',
      'Find it CURSOR_CHAT_E2E_NESTED_SECRET',
    ),
  });
  const managed = await cursorRuntimeFixture();
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: managed.env,
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await connectCursor(window);
    await configureGlobalPipelineSecret(
      window,
      'E2E_CURSOR_NESTED_SECRET',
      secret,
    );
    const card = await openWorkspaceAndRun(window, name);
    await expect(card).toContainText('success', { timeout: 90_000 });
    const state = executionState(userDataDir);
    const step = state.jobs.verify.steps.cursor;
    expect(step.status).toBe('success');

    // The saved transcript, rebuilt the way the renderer reads it.
    const saved = readFileSync(step.log_file, 'utf8').split('\n');
    // Soft, so a failure reports every shape that leaked, not just the first.
    expect
      .soft(streamedBlocks(saved))
      .toEqual(['Looking for *** now.', 'Found ***', ' in the file.']);
    const input = {
      path: expect.stringMatching(/notes\.txt$/),
      pattern: '***',
    };
    expect
      .soft(toolValues(saved))
      .toEqual([
        input,
        { pattern: '***', file_path: expect.stringMatching(/notes\.txt$/) },
        input,
        { pattern: '***', file_path: expect.stringMatching(/notes\.txt$/) },
        { content: 'token=***' },
      ]);
    expect(saved.join('\n')).not.toContain('0123456');
    expect(step.outputs.text_response).not.toContain('0123456');

    // And what the step's output view renders, in both modes.
    const detail = await reopenCompletedStep(window, card, 'verify', 'cursor');
    const output = detail.getByTestId('pipeline-step-log-output-cursor');
    await expect(output).toContainText('in the file.');
    await expect(output).not.toContainText('0123456');
    await detail.getByTestId('pipeline-step-log-mode-raw-cursor').click();
    await expect(output).toContainText('in the file.');
    await expect(output).not.toContainText('0123456');
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await managed.close();
    cleanupDemoWorkspaces(seeded);
  }
});

test('Cursor pipeline step masks a whole configured URL whose password is configured too', async () => {
  // Masking the password as soon as it completed released the URL's head and
  // tail to the saved transcript and the output view, though `text_response`
  // masked the whole URL.
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'cursor-pipeline-'));
  const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const name = 'E2E Cursor contained secret';
  seedStoredPipeline({
    userDataDir,
    id: 'cursor-contained-secret',
    name,
    yaml: pipelineYaml(
      name,
      'read_only',
      'Connect CURSOR_CHAT_E2E_CONTAINED_SECRET',
    ),
  });
  const managed = await cursorRuntimeFixture();
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: managed.env,
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await connectCursor(window);
    await configureGlobalPipelineSecret(
      window,
      'E2E_CURSOR_DB_URL',
      'postgres://admin:S3cretPass@db.internal:5432/app',
    );
    await configureGlobalPipelineSecret(
      window,
      'E2E_CURSOR_DB_PASSWORD',
      'S3cretPass',
    );
    const card = await openWorkspaceAndRun(window, name);
    await expect(card).toContainText('success', { timeout: 90_000 });
    const step = executionState(userDataDir).jobs.verify.steps.cursor;
    expect(step.status).toBe('success');

    const saved = readFileSync(step.log_file, 'utf8').split('\n');
    expect(streamedBlocks(saved)).toEqual([
      'Connecting with *** now.',
      'DB is ***',
      ' is up.',
    ]);
    expect(saved.join('\n')).not.toContain('db.internal');
    expect(step.outputs.text_response).not.toContain('db.internal');

    const detail = await reopenCompletedStep(window, card, 'verify', 'cursor');
    const output = detail.getByTestId('pipeline-step-log-output-cursor');
    await expect(output).toContainText('is up.');
    await expect(output).not.toContainText('db.internal');
    await detail.getByTestId('pipeline-step-log-mode-raw-cursor').click();
    await expect(output).toContainText('is up.');
    await expect(output).not.toContainText('db.internal');
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await managed.close();
    cleanupDemoWorkspaces(seeded);
  }
});

function auditDayFileEntries(userDataDir) {
  const dir = path.join(userDataDir, 'agent-observability', 'audit');
  const file = readdirSync(dir).find((entry) => entry.endsWith('.jsonl'));
  if (!file) {
    throw new Error(`No audit day file found under ${dir}`);
  }
  return readFileSync(path.join(dir, file), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

test('Cursor pipeline step usage reaches the Audit Trail with cache reads subtracted out of input tokens, not double-counted', async () => {
  // `fixtures/cursor-acp-agent.mjs` reports a fixed, deterministic usage
  // payload for this exact prompt marker: input_tokens: 12000,
  // output_tokens: 800, cache_read_tokens: 9000, cache_write_tokens: 500.
  // Per CursorReportedUsage's contract, input_tokens already INCLUDES the
  // cache portion, so the audit entry's recorded input tokens must be
  // 12000 - 9000 - 500 = 2500, not the raw, double-counted 12000.
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'cursor-pipeline-'));
  const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const name = 'E2E Cursor usage';
  seedStoredPipeline({
    userDataDir,
    id: 'cursor-usage',
    name,
    yaml: pipelineYaml(name, 'read_only').replace(
      'Create the result file.',
      'CURSOR_CHAT_E2E_USAGE',
    ),
  });
  const managed = await cursorRuntimeFixture();
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: managed.env,
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await connectCursor(window);
    const card = await openWorkspaceAndRun(window, name);
    await expect(card).toContainText('success', { timeout: 90_000 });
    const state = executionState(userDataDir);
    expect(state.jobs.verify.steps.cursor.status).toBe('success');

    const auditEntries = auditDayFileEntries(userDataDir);
    const pipelineEntry = auditEntries.find(
      (entry) =>
        entry.eventType === 'pipeline_agent_turn' &&
        entry.provider === 'cursor',
    );
    expect(pipelineEntry).toBeDefined();
    expect(pipelineEntry.tokens.input).toBe(2500);
    expect(pipelineEntry.tokens.output).toBe(800);

    // Confirm the same corrected figure reaches the Audit Trail page itself,
    // not just the persisted day file: 2500 input + 800 output = 3300,
    // formatted with a thousands separator by AuditTrailPage's formatMetric.
    await app.openAuditPage();
    await window.getByPlaceholder('Search').fill('cursor-default');
    await expect(
      window.getByTestId(`audit-tokens-${pipelineEntry.id}`),
    ).toHaveText('3,300 tokens');
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await managed.close();
    cleanupDemoWorkspaces(seeded);
  }
});

test('Cursor pipeline step fails with connect guidance when Cursor is not connected', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'cursor-pipeline-off-'),
  );
  const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const name = 'E2E Cursor disconnected';
  seedStoredPipeline({
    userDataDir,
    id: 'cursor-off',
    name,
    yaml: pipelineYaml(name, 'read_only'),
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const card = await openWorkspaceAndRun(window, name);
    await expect(card).toContainText('failure', { timeout: 60_000 });
    const state = executionState(userDataDir);
    expect(state.jobs.verify.steps.cursor.error).toContain('Connect Cursor');
    // No result.txt assertion here: this is a preflight failure before the
    // agent ever runs, so there is no write to observe either way.
  } finally {
    await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(seeded);
  }
});

test('Cursor pipeline step stops when the runtime completes a fetch the approval hook never saw', async () => {
  // The user-reachable behaviour: a headless step has nobody to approve a tool
  // mid-turn, so a completion the approval hook never saw cannot be accounted
  // for and the step fails with the integrity message instead of continuing as
  // if the call had been vetted. This is after-the-fact detection — it stops the
  // session, it does not prevent whatever the completion reports.
  //
  // `fetch` is the realistic kind here, not a contrivance. On the pinned
  // 2026.09.08-6caf4ff macOS arm64 runtime a native Read is allowed and Grep's
  // tool result names the preToolUse hook as its blocker, so both demonstrably
  // reach the gate; a live WebFetch under `none` and `read_only` instead stops
  // the turn under this rule, which shows no MATCHING hook observation was
  // available to consume. That is weaker than "the hook was never invoked" — an
  // unmatched id or input fingerprint would look the same, and no
  // hook-transport telemetry was captured. The fixture below models the
  // no-observation case directly, which is what the rule is about.
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'cursor-pipeline-unhooked-'),
  );
  const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const name = 'E2E Cursor unhooked fetch';
  seedStoredPipeline({
    userDataDir,
    id: 'cursor-unhooked-fetch',
    name,
    yaml: pipelineYaml(
      name,
      'read_only',
      'Check CURSOR_CHAT_E2E_COMPLETION:fetch:none',
    ),
  });
  const managed = await cursorRuntimeFixture();
  const { electronApp } = await launchCanopy({ userDataDir, env: managed.env });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await connectCursor(window);
    const card = await openWorkspaceAndRun(window, name);
    await expect(card).toContainText('failure', { timeout: 120_000 });
    const state = executionState(userDataDir);
    expect(state.jobs.verify.steps.cursor.error).toContain(
      'without reaching the approval hook',
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(seeded);
  }
});

test('Cursor pipeline step cancels promptly and is reported as cancelled', async () => {
  // The user-visible behaviour this covers: stopping a Cursor run reports it as
  // CANCELLED, not as a runtime that is not connected. The desktop runner used
  // to map every setup rejection — including an abort — to the Connect-Cursor
  // sentence, which told a user who cancelled that their installation was
  // missing.
  //
  // What this CANNOT prove, stated plainly, because a passing UI test is easy
  // to over-read:
  //  - The queue-withdrawal property (a cancelled waiter settling while a
  //    PREDECESSOR still holds the same profile) needs two concurrent turns on
  //    one profile, which this single-step user flow does not create.
  //  - The cancellation-during-SETUP classification, since by the time the card
  //    reads `running` setup is already done.
  // Both are covered by the runner tests
  // (`node/pipelines/__tests__/cursor-prompt-runner.test.ts`) and the desktop
  // runner tests (`main/__tests__/cursor-prompt-runner.test.ts`). What this DOES
  // establish is that the whole cancellation path works through the real UI:
  // the run stops, it is reported as cancelled rather than as a failure or a
  // disconnected runtime, and the agent's file effect never lands.
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'cursor-pipeline-'));
  const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const name = 'E2E Cursor cancel';
  seedStoredPipeline({
    userDataDir,
    id: 'cursor-cancel',
    name,
    // The fixture acknowledges this prompt and then never finishes the turn, so
    // the run is genuinely in flight when it is cancelled.
    yaml: pipelineYaml(name, 'dangerous_all', 'Wait CURSOR_CHAT_E2E_HANG'),
  });
  const managed = await cursorRuntimeFixture();
  const { electronApp } = await launchCanopy({ userDataDir, env: managed.env });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await connectCursor(window);
    const card = await openWorkspaceAndRun(window, name);
    await expect(card).toContainText('running', { timeout: 60_000 });

    // The cancel control lives in the run's detail modal, keyed by execution id,
    // which the card carries in its own test id.
    const cardTestId = await card.getAttribute('data-testid');
    expect(cardTestId).toMatch(/^pipeline-run-card-.+/);
    const executionId = cardTestId.slice('pipeline-run-card-'.length);
    const jobDot = card.locator('[data-job-id="verify"]');
    await expect(jobDot).toHaveAttribute(
      'aria-label',
      'Verify Cursor runtime: running',
      {
        timeout: 60_000,
      },
    );
    await jobDot.click();
    await showPipelineJobList(window, { timeout: 15_000 });
    const cancelButton = window.getByTestId(
      `pipeline-detail-cancel-${executionId}`,
    );
    await expect(cancelButton).toBeEnabled({ timeout: 30_000 });
    await cancelButton.click();

    await expect(card).toContainText('cancelled', { timeout: 60_000 });
    const state = executionState(userDataDir);
    expect(state.jobs.verify.steps.cursor.status).toBe('cancelled');
    // Not misreported as a disconnected runtime.
    expect(JSON.stringify(state)).not.toContain('Connect Cursor');
    // The turn never reached its Write, so no file effect.
    const worktreeDir = worktreePathFor(seeded);
    expect(existsSync(path.join(worktreeDir, 'result.txt'))).toBe(false);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await managed.close();
    cleanupDemoWorkspaces(seeded);
  }
});
