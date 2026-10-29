// Claude half of the browser-agent Phase 0 probe (spikes S0.1 and S0.2).
//
// Run ONLY through provider-probe.mjs, which serializes native runs and
// supplies the synthetic root, manifest and canary tokens:
//   node --import tsx scripts/probes/browser-agent-phase0/provider/claude/run.mjs
//
// Variants (each a separate SDK query(), own epoch dir, scenario marker):
//   A positive control (NOT an isolated launch)   B isolated launch (05 1.4)
//   C isolated + CLAUDE_CODE_DISABLE_CLAUDE_MDS   D1-D3 rotation epochs
//   E induced launch failure                      F PostToolBatch budget-hook experiment
//
// Planning evidence only: loopback mock model, synthetic HOME/config, no real
// credentials, no external network. Nothing here is a production contract.
import {
  createSdkMcpServer,
  HOOK_EVENTS,
  query,
  tool,
} from '@anthropic-ai/claude-agent-sdk';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { canariesFor, readRecorderInvocations } from '../shared/canaries.mjs';
import {
  armChildDeadline,
  buildReport,
  loadChildContext,
  writeArtifact,
} from '../shared/child-runtime.mjs';
import { EXPECTED_PINS, EXIT } from '../shared/constants.mjs';
import {
  clearScenario,
  evaluateCanary,
  registerScenario,
  startCapture,
  writeSnapshot,
} from '../shared/capture.mjs';
import { STATUS, createLedger } from '../shared/ledger.mjs';
import { descendantsOf, listProcesses } from '../shared/process-guard.mjs';
import { listFiles } from '../shared/synthetic-root.mjs';
import {
  deriveBrowserToolSchemas,
  schemaOverheadSummary,
} from '../shared/tool-schemas.mjs';
import { analyze } from './analysis.mjs';
import { startArrivalPoller } from './arrival-poller.mjs';
import {
  checkManagedPolicyPaths,
  managedPolicyPaths,
  writeClaudeFixtures,
  writeKeychainShim,
  writeMemoryFixture,
} from './fixtures.mjs';
import { createBrowserGateway, newSentinel } from './gateway.mjs';
import {
  ISOLATED_OPTIONS_SUMMARY,
  controlOptions,
  isolatedOptions,
} from './launch-options.mjs';
import {
  PRODUCTION_BUILDER_SOURCE,
  REQUESTED_MODEL,
  buildProviderEnvironment,
  loadProductionSeams,
  verifyPins,
  verifyProviderEnvironment,
} from './probe-env.mjs';
import { driveQuery } from './query-driver.mjs';
import { startRefusingProxy } from './refusing-proxy.mjs';
import {
  PROBE_PROMPT_VERSION,
  PROBE_SYSTEM_PROMPT,
  browserToolName,
  budgetHookSteps,
  controlSteps,
  isolatedSteps,
  launchFailureSteps,
  probeUserPrompt,
  rotationSteps,
  scenarioKey,
} from './scripts.mjs';
import { STATIC_FINDINGS } from './static-findings.mjs';

const PROBE_VERSION = 'claude-phase0-probe/1';
const VARIANT_TIMEOUT_MS = 50_000;
const SOFT_MARGIN_MS = 35_000;
const TRAILING_TRAFFIC_MS = 500;

const startedAt = Date.now();
const ledger = createLedger('claude');
const notes = [];
const artifacts = [];
const listenPorts = [];
const variants = {};
let capture = null;
let proxy = null;
let ctx = null;
let binaryPath = null;
let trackedPids = new Map();
let identityExtras = {};
let reportWritten = false;

async function findClaudeProcesses() {
  if (!binaryPath) return [];
  const processes = await listProcesses();
  return descendantsOf(processes, process.pid).filter((proc) =>
    proc.command.includes(binaryPath),
  );
}

async function killStragglers() {
  const survivors = await findClaudeProcesses();
  for (const proc of survivors) {
    trackedPids.set(proc.pid, {
      pid: proc.pid,
      command: proc.command.slice(0, 200),
    });
    try {
      process.kill(proc.pid, 'SIGKILL');
    } catch {
      /* exited */
    }
  }
  return survivors.map((proc) => proc.pid);
}

async function waitForNoClaude(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if ((await findClaudeProcesses()).length === 0) return { leaked: [] };
    await sleep(100);
  }
  return { leaked: await killStragglers() };
}

async function recorderCounts() {
  const invocations = await readRecorderInvocations(ctx.layout.records);
  return Object.fromEntries(
    Object.entries(invocations).map(([name, lines]) => [name, lines.length]),
  );
}

function countDelta(before, after) {
  const out = {};
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const change = (after[name] ?? 0) - (before[name] ?? 0);
    if (change !== 0) out[name] = change;
  }
  return out;
}

function toolNamesExpected() {
  return deriveBrowserToolSchemas().map(({ name }) => browserToolName(name));
}

// ── Variant runner ───────────────────────────────────────────────────────────
async function runVariant(spec) {
  const {
    id,
    label,
    isolated,
    steps,
    cwd,
    env,
    options,
    markerLabel,
    snapshotFile,
    gateway,
    sentinel,
    optionsSummary,
    envDelta,
    extraState,
  } = spec;
  // Every await stays inside the child deadline: clamp to the time left minus cleanup and report writing.
  const remainingMs = startedAt + ctx.deadlineMs - 30_000 - Date.now();
  const timeoutMs = Math.max(8_000, Math.min(spec.timeoutMs, remainingMs));
  const key = scenarioKey(markerLabel);
  registerScenario(key, { llm: { steps } });
  capture.capture.reset();
  const poller = startArrivalPoller(capture.capture);
  const recordersBefore = await recorderCounts();
  const cwdBefore = isolated
    ? (await listFiles(cwd)).map((entry) => entry.path)
    : null;
  const driven = await driveQuery({
    query,
    prompt: probeUserPrompt(key),
    options: {
      ...options,
      cwd,
      env,
      pathToClaudeCodeExecutable: binaryPath,
      model: REQUESTED_MODEL,
    },
    timeoutMs,
    findProcesses: findClaudeProcesses,
  });
  for (const proc of driven.processes) trackedPids.set(proc.pid, proc);
  const exit = await waitForNoClaude(3_000);
  await sleep(TRAILING_TRAFFIC_MS);
  poller.stop();
  const snapshot = capture.capture.snapshot();
  const arrivals = poller.arrivals();
  capture.capture.reset();
  clearScenario(key);
  const recordersAfter = await recorderCounts();
  const recorderDelta = countDelta(recordersBefore, recordersAfter);
  const keychainAttempts = recorderDelta.security ?? 0;
  delete recorderDelta.security;
  const cwdAfter = isolated
    ? (await listFiles(cwd)).map((entry) => entry.path)
    : null;

  // The last arrival detected no later than the result message (plus one polling step) is the final pre-result item.
  let resultSeq = null;
  if (driven.timeline.resultAtMs !== null) {
    const before = arrivals.filter(
      (arrival) =>
        arrival.atMs <= driven.timeline.resultAtMs + poller.resolutionMs,
    ).length;
    resultSeq = before > 0 ? (snapshot.records[before - 1]?.seq ?? null) : null;
  }
  const artifact = snapshotFile;
  await writeSnapshot(path.join(ctx.outputDir, artifact), snapshot);
  artifacts.push(artifact);
  const variant = {
    id,
    label,
    isolated,
    key,
    cwd,
    driven,
    snapshot,
    arrivals,
    resultSeq,
    recorderDelta,
    keychainAttempts,
    cwdBefore,
    cwdAfter,
    artifact,
    optionsSummary,
    envDelta,
    sentinel,
    leakedProcesses: exit.leaked,
    gatewayEvents: gateway ? gateway.events() : [],
    denials: spec.denials ?? [],
    ...(extraState ? extraState() : {}),
  };
  variants[id] = variant;
  return variant;
}

async function guarded(id, label, fn) {
  if (Date.now() > startedAt + ctx.deadlineMs - SOFT_MARGIN_MS) {
    variants[id] = {
      id,
      label,
      skipped: 'time budget: variant not started before the soft deadline',
    };
    notes.push(`Variant ${id} (${label}) was skipped: soft deadline reached.`);
    return;
  }
  try {
    await fn();
  } catch (error) {
    variants[id] = {
      id,
      label,
      error: String(error?.stack ?? error).slice(0, 1_500),
    };
    notes.push(
      `Variant ${id} (${label}) crashed inside run.mjs: ${String(error?.message ?? error).slice(0, 300)}`,
    );
  }
}

async function isolatedVariant({
  id,
  label,
  epochName,
  markerLabel,
  steps,
  snapshotFile,
  epochNumber,
  envKey,
  forcePhase,
  extraOptions,
  gatewaySentinel = true,
  timeoutMs = VARIANT_TIMEOUT_MS,
  extraState,
  describe = {},
}) {
  const cwd = await ctx.layout.newEpochDir(epochName);
  const memory = await writeMemoryFixture({
    layout: ctx.layout,
    canaries: ctx.canaries,
    cwd,
  });
  const sentinel = gatewaySentinel ? newSentinel(epochNumber) : null;
  const gateway = createBrowserGateway(
    { createSdkMcpServer, tool },
    { epoch: epochNumber, sentinel: sentinel ?? newSentinel(epochNumber) },
  );
  const denials = [];
  const { env, envDelta } = identityExtras.envs[envKey];
  return runVariant({
    id,
    label,
    isolated: true,
    steps,
    cwd,
    env,
    markerLabel,
    snapshotFile,
    timeoutMs,
    gateway,
    sentinel,
    forcePhase,
    denials,
    options: isolatedOptions({ gateway, denials, extra: extraOptions }),
    optionsSummary: {
      ...ISOLATED_OPTIONS_SUMMARY,
      ...describe,
      memoryFixtureKey: memory.key,
    },
    envDelta,
    extraState,
  });
}

async function finalizeReport(exitCode, extra = {}) {
  if (reportWritten) return exitCode;
  reportWritten = true;
  const notesOut = [...notes];
  const report = buildReport({
    provider: 'claude',
    ledger: ledger.finalize(extra.unreachedReason ?? 'not reached in this run'),
    listenPorts,
    identity: { probeVersion: PROBE_VERSION, ...extra.identity },
    s02: extra.s02 ?? {
      label: 'mock/loopback, not release performance',
      note: 'no S0.2 data',
    },
    artifacts: [...artifacts, 'report.json'],
    notes: notesOut,
  });
  await writeArtifact(ctx.outputDir, 'report.json', report);
  return exitCode;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  ctx = loadChildContext('claude');
  const { layout, canaries, outputDir } = ctx;
  await mkdir(outputDir, { recursive: true });
  process.once('SIGTERM', () => {
    notes.push(
      'SIGTERM received from the orchestrator; partial report written.',
    );
    void killStragglers()
      .then(() => cleanup())
      .then(() =>
        finalizeReport(EXIT.crash, {
          unreachedReason: 'terminated by the orchestrator before this step',
        }),
      )
      .finally(() => process.exit(EXIT.crash));
  });
  let clearDeadline = armChildDeadline(ctx.deadlineMs, async () => {
    notes.push('Child deadline reached; partial report written.');
    await killStragglers();
    await finalizeReport(EXIT.crash, {
      unreachedReason: 'child deadline reached before this step',
    });
  });
  let preconditionFailed = false;
  const precondition = (id, phase, ok, evidence) => {
    ledger.record(id, phase, ok ? STATUS.pass : STATUS.fail, evidence);
    if (!ok) preconditionFailed = true;
  };

  capture = await startCapture();
  proxy = await startRefusingProxy();
  listenPorts.push(capture.port, proxy.port);

  let seams = null;
  let pins = null;
  let envB = null;
  let envC = null;
  let verificationB = null;
  let verificationC = null;
  let shim = null;
  let managedPolicy = [];
  let fixtures = [];
  try {
    seams = await loadProductionSeams();
    binaryPath = seams.getBundledClaudeBinaryPath();
  } catch (error) {
    notes.push(
      `Production seams failed to load: ${String(error?.message ?? error).slice(0, 300)}`,
    );
    preconditionFailed = true;
    ledger.record('canonical.pins', 'launch', STATUS.fail, {
      reason:
        'could not resolve the bundled Claude binary through getBundledClaudeBinaryPath',
      error: String(error?.message ?? error).slice(0, 300),
    });
  }

  if (seams) {
    const claudeTmp = path.join(layout.tmp, 'claude-code-tmp');
    await mkdir(claudeTmp, { recursive: true, mode: 0o700 });
    shim = await writeKeychainShim({ layout });
    const written = await writeClaudeFixtures({ layout, canaries });
    fixtures = written.fixtures;
    const controlMemory = await writeMemoryFixture({
      layout,
      canaries,
      cwd: layout.project,
    });
    fixtures.push({
      id: 'memory',
      paths: controlMemory.paths,
      live: { request: true },
      unverified:
        'Auto-memory path inferred from the pinned CLI (projects/<cwd key>/memory/MEMORY.md); the control decides liveness.',
    });
    managedPolicy = await checkManagedPolicyPaths(managedPolicyPaths());
    if (managedPolicy.some((entry) => entry.exists))
      notes.push(
        'HOST DATA WARNING: a macOS managed Claude policy path exists on this host (see identity.managedPolicy). If the CLI loads it, host content reaches the capture recorder and the capture-*.json artifacts.',
      );

    const common = {
      seams,
      layout,
      baseUrl: capture.baseUrl,
      proxyUrl: proxy.url,
      shimDir: shim.dir,
      claudeTmpDir: claudeTmp,
    };
    envB = buildProviderEnvironment({ ...common, disableClaudeMds: false });
    envC = buildProviderEnvironment({ ...common, disableClaudeMds: true });
    verificationB = verifyProviderEnvironment({
      ...envB,
      layout,
      baseUrl: capture.baseUrl,
      proxyUrl: proxy.url,
      expectDisableMds: false,
    });
    verificationC = verifyProviderEnvironment({
      ...envC,
      layout,
      baseUrl: capture.baseUrl,
      proxyUrl: proxy.url,
      expectDisableMds: true,
    });
    identityExtras.envs = {
      B: { env: envB.env, envDelta: envB.delta },
      C: { env: envC.env, envDelta: envC.delta },
    };
    pins = await verifyPins({ binaryPath, env: envB.env, cwd: layout.root });

    precondition(
      'canonical.home',
      'launch',
      verificationB.checks
        .filter((c) =>
          ['home-synthetic', 'config-dir-synthetic', 'tmp-synthetic'].includes(
            c.id,
          ),
        )
        .every((c) => c.ok) && verificationC.ok,
      {
        B: verificationB.checks.filter((c) => c.id !== 'checkProbeEnv'),
        note: 'HOME, CLAUDE_CONFIG_DIR (distinct from home/.claude), TMPDIR and CLAUDE_CODE_TMPDIR are inside the synthetic root; the real home is never read',
      },
    );
    precondition(
      'canonical.provider-url',
      'launch',
      verificationB.checks
        .filter((c) =>
          ['base-url-loopback-capture', 'proxy-refusing-loopback'].includes(
            c.id,
          ),
        )
        .every((c) => c.ok) && verificationC.ok,
      {
        baseUrl: capture.baseUrl,
        refusingProxy: proxy.url,
        NO_PROXY: envB.env.NO_PROXY,
      },
    );
    precondition(
      'canonical.no-credentials',
      'launch',
      verificationB.ok && verificationC.ok,
      {
        envChecks: {
          B: verificationB.checks.map(({ id, ok }) => ({ id, ok })),
          C: verificationC.ok,
        },
        credentialVariables:
          'only ANTHROPIC_BASE_URL (loopback capture) and the placeholder ANTHROPIC_API_KEY; no credential files copied',
        keychain:
          'UNVERIFIED whether the pinned CLI reads the macOS keychain when ANTHROPIC_API_KEY is set (the binary contains `security find-generic-password` code paths; see staticFindings). A recorder named `security` is first on PATH and answers "item not found", so any attempt is logged and refused; attempt counts and init.apiKeySource are reported after the run.',
      },
    );
    precondition('canonical.pins', 'launch', pins.ok, pins);
  }

  if (preconditionFailed) {
    notes.push(
      'Canonical-state verification failed: no turn was sent (nothing reached the capture listener).',
    );
    clearDeadline();
    await cleanup();
    return finalizeReport(EXIT.preconditionFailed, {
      unreachedReason: 'canonical-state precondition failed; nothing was sent',
      identity: {
        preconditions: { pins, verificationB, verificationC, binaryPath },
        managedPolicy,
      },
    });
  }

  // ── Variants ───────────────────────────────────────────────────────────────
  const controlDenials = [];
  await guarded('A', 'positive control (not an isolated launch)', async () => {
    const { env, envDelta } = identityExtras.envs.B;
    await runVariant({
      id: 'A',
      label: 'positive control (not an isolated launch)',
      isolated: false,
      steps: controlSteps(),
      cwd: layout.project,
      env,
      markerLabel: 'control',
      snapshotFile: 'capture-control.json',
      timeoutMs: VARIANT_TIMEOUT_MS,
      denials: controlDenials,
      options: controlOptions({ denials: controlDenials }),
      optionsSummary: {
        label: 'NOT an isolated launch',
        settingSources: ['user', 'project', 'local'],
        systemPrompt: 'claude_code preset (maximizes fixture liveness)',
        tools: 'default (not overridden)',
        canUseTool: 'denies every call',
        cwd: layout.project,
      },
      envDelta,
    });
  });

  await guarded('B', 'isolated launch', () =>
    isolatedVariant({
      id: 'B',
      label: 'isolated launch',
      epochName: 'iso-b',
      markerLabel: 'isolated',
      steps: isolatedSteps(),
      snapshotFile: 'capture-isolated.json',
      epochNumber: 11,
      envKey: 'B',
    }),
  );
  await guarded('C', 'isolated launch + CLAUDE_CODE_DISABLE_CLAUDE_MDS=1', () =>
    isolatedVariant({
      id: 'C',
      label: 'isolated launch + CLAUDE_CODE_DISABLE_CLAUDE_MDS=1',
      epochName: 'iso-c',
      markerLabel: 'mdsoff',
      steps: isolatedSteps(),
      snapshotFile: 'capture-disable-mds.json',
      epochNumber: 12,
      envKey: 'C',
      describe: {
        CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1 (only difference from B)',
      },
    }),
  );
  for (const epoch of [1, 2, 3]) {
    await guarded(`D${epoch}`, `rotation epoch ${epoch}`, () =>
      isolatedVariant({
        id: `D${epoch}`,
        label: `rotation epoch ${epoch}`,
        epochName: `rot-e${epoch}`,
        markerLabel: `epoch${epoch}`,
        steps: rotationSteps(epoch),
        snapshotFile: `capture-epoch${epoch}.json`,
        epochNumber: epoch,
        envKey: 'B',
      }),
    );
  }
  await guarded('E', 'induced launch failure', () =>
    isolatedVariant({
      id: 'E',
      label: 'induced launch failure',
      epochName: 'fail-e',
      markerLabel: 'failure',
      steps: launchFailureSteps(),
      snapshotFile: 'capture-launch-failure.json',
      epochNumber: 14,
      envKey: 'B',
      forcePhase: 'launch-failure',
      timeoutMs: 30_000,
    }),
  );
  const budgetLog = [];
  let stoppedAtBatch = null;
  await guarded('F', 'PostToolBatch budget-hook experiment', () =>
    isolatedVariant({
      id: 'F',
      label: 'PostToolBatch budget-hook experiment',
      epochName: 'budget-f',
      markerLabel: 'budget',
      steps: budgetHookSteps(6),
      snapshotFile: 'capture-budget-hook.json',
      epochNumber: 15,
      envKey: 'B',
      timeoutMs: 40_000,
      describe: {
        hooks:
          'PostToolBatch host callback ONLY in this experiment (deliberate deviation from the launch contract)',
      },
      extraOptions: {
        hooks: {
          PostToolBatch: [
            {
              hooks: [
                async (input) => {
                  const bytes = (input?.tool_calls ?? []).reduce(
                    (sum, call) =>
                      sum +
                      Buffer.byteLength(
                        JSON.stringify(call?.tool_response ?? null),
                      ),
                    0,
                  );
                  const previous =
                    budgetLog.at(-1)?.cumulativeToolResultBytes ?? 0;
                  const entry = {
                    batch: budgetLog.length + 1,
                    atMs: Date.now() - startedAt,
                    toolNames: (input?.tool_calls ?? []).map(
                      (call) => call.tool_name,
                    ),
                    cumulativeToolResultBytes: previous + bytes,
                  };
                  budgetLog.push(entry);
                  if (entry.batch >= 3) {
                    stoppedAtBatch = entry.batch;
                    return {
                      continue: false,
                      stopReason: 'probe budget guard: synthetic bound reached',
                    };
                  }
                  return { continue: true };
                },
              ],
            },
          ],
        },
      },
      extraState: () => ({ hookLog: budgetLog.slice(), stoppedAtBatch }),
    }),
  );

  // ── Analysis ───────────────────────────────────────────────────────────────
  const schemaOverhead = schemaOverheadSummary();
  let analysis = null;
  try {
    analysis = analyze({
      ledger,
      STATUS,
      evaluate: evaluateCanary,
      catalog: canariesFor('claude'),
      tokens: canaries,
      fixtures,
      expectedToolNames: toolNamesExpected(),
      variants,
      managedPolicy,
      requestedModel: REQUESTED_MODEL,
      hookEvents: [...HOOK_EVENTS],
      extra: {
        schemaOverhead: {
          totalDefinitionBytes: schemaOverhead.totalDefinitionBytes,
          totalSchemaBytes: schemaOverhead.totalSchemaBytes,
          toolCount: schemaOverhead.toolCount,
        },
      },
    });
  } catch (error) {
    notes.push(
      `Analysis crashed: ${String(error?.stack ?? error).slice(0, 800)}`,
    );
  }

  // compaction / restart
  ledger.record('phase.compaction', 'compaction', STATUS.unobserved, {
    reason:
      'Provider compaction is not induced: the scripted mock carries no history near the model context window, and ~100 KB requests never trigger it. PreCompact/PostCompact hook events exist but no compaction happened in any variant. Canary absence after compaction therefore remains unproven.',
  });
  ledger.record('phase.restart', 'restart', STATUS.unobserved, {
    reason:
      'An application restart is a Canopy-level event. The probe never resumes (persistSession: false, no resume/continue); each epoch is a cold process, which is not equivalent to a restart-and-recover test.',
  });

  // keychain / apiKeySource evidence
  const keychainTotal = Object.values(variants).reduce(
    (sum, variant) => sum + (variant?.keychainAttempts ?? 0),
    0,
  );
  const apiKeySources = Object.fromEntries(
    Object.entries(variants)
      .filter(([, variant]) => variant?.driven?.init)
      .map(([id, variant]) => [id, variant.driven.init.apiKeySource]),
  );
  ledger.record('canonical.no-credentials', 'launch', STATUS.measured, {
    afterRun: true,
    keychainAttemptsIntercepted: keychainTotal,
    apiKeySourceByVariant: apiKeySources,
    note: 'Attempts were answered by the PATH shim (exit 44); the real keychain was never reachable. apiKeySource other than ANTHROPIC_API_KEY would indicate a different credential path.',
  });
  if (
    Object.values(apiKeySources).some(
      (source) => source !== 'ANTHROPIC_API_KEY',
    )
  )
    notes.push(
      `init.apiKeySource was not ANTHROPIC_API_KEY in every variant: ${JSON.stringify(apiKeySources)}`,
    );

  // hygiene (the orchestrator overwrites these with its own evidence)
  const proxySummary = proxy.summary();
  ledger.record('hygiene.no-external-requests', 'run', STATUS.measured, {
    refusingProxy: proxySummary,
    note: 'Probe-side evidence only: the orchestrator lsof sampling is authoritative.',
  });

  clearDeadline();
  const cleanupResult = await cleanup();
  ledger.record(
    'hygiene.cleanup',
    'completion',
    cleanupResult.claudeProcessesRemaining === 0 ? STATUS.pass : STATUS.fail,
    cleanupResult,
  );

  // ── Notes ──────────────────────────────────────────────────────────────────
  notes.push(...probeNotes({ fixtures, pins, verificationB }));
  const binaryVersionFile = await readFile(
    path.join(path.dirname(binaryPath), '.claude-version'),
    'utf8',
  ).catch(() => null);
  const failed = ledger.finalize().failed;
  return finalizeReport(failed ? EXIT.requirementFailed : EXIT.ok, {
    identity: {
      binary: {
        path: binaryPath,
        versionFile: binaryVersionFile?.split('\n').slice(0, 2) ?? null,
        sha256FromVersionFile: binaryVersionFile?.split('\n')[1] ?? null,
      },
      pins: { expected: EXPECTED_PINS, verified: pins },
      model: {
        requested: REQUESTED_MODEL,
        perVariant: analysis?.identity.models ?? null,
      },
      sessionIds: analysis?.identity.sessionIds ?? null,
      inits: analysis?.identity.inits ?? null,
      variants: analysis?.identity.variants ?? null,
      controlLiveness: analysis?.identity.controlLiveness ?? null,
      hookEventsAvailable: [...HOOK_EVENTS],
      providerEnvironment: {
        builder: PRODUCTION_BUILDER_SOURCE,
        namesOnly: Object.keys(identityExtras.envs?.B?.env ?? {}).sort(),
        deltaB: identityExtras.envs?.B?.envDelta ?? null,
        deltaC: identityExtras.envs?.C?.envDelta ?? null,
        verification: { B: verificationB?.checks, C: verificationC?.ok },
      },
      fixtures: fixtures.map((fixture) => ({
        id: fixture.id,
        paths: fixture.paths.map((file) => path.relative(layout.root, file)),
        live: fixture.live,
        unverified: fixture.unverified ?? null,
        orchestratorPlanted: fixture.orchestratorPlanted ?? false,
      })),
      managedPolicy,
      refusingProxy: {
        port: proxy.port,
        summary: proxySummary,
        attempts: proxy.attempts().slice(0, 50),
      },
      keychain: {
        shimInterceptions: keychainTotal,
        apiKeySourceByVariant: apiKeySources,
      },
      staticFindings: STATIC_FINDINGS,
      probePrompt: { version: PROBE_PROMPT_VERSION, text: PROBE_SYSTEM_PROMPT },
      runDurationMs: Date.now() - startedAt,
    },
    s02: analysis?.s02,
  });
}

function probeNotes({ fixtures, pins, verificationB }) {
  return [
    'Loopback mock only (capture listener answering Anthropic Messages); every token figure is a byte-ratio ESTIMATE and mock-reported usage and count_tokens values are SYNTHETIC. Not release performance.',
    'Phase windows are by arrival order: up to the first /v1/messages = before-inference; later = after-tools; after the result message = completion. The result boundary uses polled arrival times (~25 ms resolution); an item within one polling step of the result message can be mislabelled.',
    'Static-reading findings about the pinned binary are quoted in identity.staticFindings and marked static-reading-only; runtime variants confirm or contradict them.',
    'Provider env: built with the production buildDelegationClaudeEnvironment (packages/desktop-shared/src/node/delegation/environment.ts). The probe removes CLAUDE_CODE_DISABLE_AUTO_MEMORY from its output (so the memory fixture can be live; production adds it as an extra layer) and adds DISABLE_TELEMETRY and DISABLE_ERROR_REPORTING. Every variant uses the same env except C (CLAUDE_CODE_DISABLE_CLAUDE_MDS=1).',
    'Fixture locations are inferred: user skills/output-styles/CLAUDE.md/.claude.json in CLAUDE_CONFIG_DIR and ~/.claude, project files under ancestor/project, plugin via settings extraKnownMarketplaces(directory)+enabledPlugins, auto-memory at <config>/projects/<cwd key>/memory/MEMORY.md. A fixture not observed live in the positive control (A) makes its isolated-absence result blocked, never pass.',
    'The positive control uses the claude_code preset system prompt and the default tool list (every tool call denied by canUseTool); it is labelled as not an isolated launch and its results never count as isolation evidence.',
    'Variant F deliberately passes a hooks option (PostToolBatch callback) to test a pre-request bound; it is outside the launch contract and only feeds budget.pre-request.',
    'CLAUDE_CODE_DISABLE_ATTACHMENTS and --bare were NOT applied; they are candidates only if the between-tool pass or managed CLAUDE.md results need them.',
    'The mock repeats tool_use ids (toolu_mock_N) across steps; if the CLI deduplicates or reorders them, the between-tool diff will show it.',
    'close.claude-md-managed and close.org-managed are blocked by design: excluding managed files needs a host system-path edit. Existence of macOS managed paths was checked with lstat only; contents were never read.',
    'Compaction and app-restart phases were not observed.',
    `Canonical pins verification: ${pins?.ok ? 'ok' : 'FAILED'}; environment verification B: ${verificationB?.ok ? 'ok' : 'FAILED'}.`,
  ];
}

async function cleanup() {
  const result = {
    claudeProcessesRemaining: 0,
    killed: [],
    epochDirsRemoved: [],
  };
  try {
    const gone = await waitForNoClaude(3_000);
    result.killed = gone.leaked;
    result.claudeProcessesRemaining = (await findClaudeProcesses()).length;
  } catch (error) {
    result.error = String(error?.message ?? error).slice(0, 200);
  }
  try {
    await proxy?.close();
  } catch {
    /* best effort */
  }
  try {
    await capture?.close();
  } catch {
    /* best effort */
  }
  try {
    for (const name of await readdir(ctx.layout.epochs).catch(() => [])) {
      await rm(path.join(ctx.layout.epochs, name), {
        recursive: true,
        force: true,
      });
      result.epochDirsRemoved.push(name);
    }
  } catch {
    /* best effort */
  }
  result.trackedProcessCount = trackedPids.size;
  return result;
}

// Entry point. Exit codes follow shared/constants.mjs EXIT. This file is an
// entry script only (spawned by provider-probe.mjs); tests import the helper modules.
main().then(
  (code) => {
    process.exitCode = code;
    setTimeout(() => process.exit(code), 250).unref();
  },
  async (error) => {
    try {
      notes.push(
        `Probe crashed: ${String(error?.stack ?? error).slice(0, 1_000)}`,
      );
      await killStragglers();
      await cleanup();
      if (ctx)
        await finalizeReport(EXIT.crash, {
          unreachedReason: 'probe crashed before this step',
        });
    } catch {
      /* report best effort */
    }
    process.exit(EXIT.crash);
  },
);
