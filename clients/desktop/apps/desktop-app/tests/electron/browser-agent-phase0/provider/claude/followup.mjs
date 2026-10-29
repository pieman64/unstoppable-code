// October 2 follow-up for the Claude provider probe. Run ONLY through
// `provider-probe.mjs --follow-up` (the orchestrator dispatches here, writes the
// manifest and wraps this process in the macOS loopback + securityd/keychain
// deny sandbox). Native execution is serialized by the root; unit tests import
// the helper modules, never this entry script.
//
// Arms (see followup-arms.mjs): unrestricted memory positive control, flag-only,
// options-only, production-equivalent, safe mode, targeted controls, scripted
// 125k context plumbing, and two synthetic-OAuth credential-shape arms.
// Evidence only: loopback mock model, synthetic HOME/config, no real credential
// is read, no external network. Real OAuth acceptance is not inferred.
import {
  createSdkMcpServer,
  query,
  tool,
} from '@anthropic-ai/claude-agent-sdk';
import { mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { readRecorderInvocations } from '../shared/canaries.mjs';
import {
  armChildDeadline,
  buildReport,
  loadChildContext,
  writeArtifact,
} from '../shared/child-runtime.mjs';
import { EXIT, EXPECTED_PINS } from '../shared/constants.mjs';
import {
  evaluateCanary,
  clearScenario,
  registerScenario,
  writeSnapshot,
} from '../shared/capture.mjs';
import {
  CONTEXT_CHECKPOINT_TOKENS,
  SYNTHETIC_OAUTH_TOKEN,
} from '../shared/followup-policy.mjs';
import { STATUS, createLedger } from '../shared/ledger.mjs';
import { descendantsOf, listProcesses } from '../shared/process-guard.mjs';
import { listFiles } from '../shared/synthetic-root.mjs';
import { startAuthObservedCapture } from './auth-listener.mjs';
import { startArrivalPoller } from './arrival-poller.mjs';
import {
  ARM_BY_ID,
  BROWSER_LOOP,
  FOLLOWUP_ARMS,
  armEnvironmentParams,
  armOptions,
  armSteps,
  armVerifyParams,
  scriptedInputTokens,
} from './followup-arms.mjs';
import {
  SOURCE_CANARY_IDS,
  billedUsage,
  callableEvidence,
  controlLiveness,
  evaluateAuth,
  evaluateContextSignals,
  evaluateMemoryMatrix,
  evaluateMemoryFlagPair,
  evaluateSourceCanaries,
  fixedOverhead,
  hookRecorderStatus,
  initInventory,
  evaluateToolLoop,
} from './followup-analysis.mjs';
import {
  checkManagedPolicyPaths,
  isFixtureLive,
  managedPolicyPaths,
  writeClaudeFixtures,
  writeKeychainShim,
  writeMemoryFixture,
} from './fixtures.mjs';
import { createBrowserGateway, newSentinel } from './gateway.mjs';
import {
  REQUESTED_MODEL,
  buildProviderEnvironment,
  loadProductionSeams,
  verifyPins,
  verifyProviderEnvironment,
} from './probe-env.mjs';
import { driveQuery } from './query-driver.mjs';
import { startRefusingProxy } from './refusing-proxy.mjs';
import { probeUserPrompt, scenarioKey } from './scripts.mjs';

const PROBE_VERSION = 'claude-phase0-followup/1';
const SOFT_MARGIN_MS = 35_000;
const MIN_ARM_MS = 8_000;
const TRAILING_TRAFFIC_MS = 500;
const CONTAINMENT = 'securityd-and-host-keychain-deny';

const startedAt = Date.now();
const ledger = createLedger('claude', { followUp: true });
const notes = [];
const artifacts = [];
const listenPorts = [];
const arms = {};
let capture = null;
let proxy = null;
let ctx = null;
let binaryPath = null;
const trackedPids = new Map();
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

function summarizeAttempts(attempts) {
  const byHost = {};
  for (const attempt of attempts) {
    const key = `${attempt.host ?? '(unparsed)'}${attempt.port ? `:${attempt.port}` : ''}`;
    byHost[key] ??= { count: 0, loopback: attempt.loopback };
    byHost[key].count += 1;
  }
  return {
    total: attempts.length,
    external: attempts.filter((attempt) => !attempt.loopback).length,
    byHost,
  };
}

async function runArm({ arm, built }) {
  const remainingMs = startedAt + ctx.deadlineMs - 30_000 - Date.now();
  if (remainingMs < MIN_ARM_MS)
    return {
      id: arm.id,
      label: arm.label,
      skipped: 'time budget: not enough time left for this arm',
    };
  const timeoutMs = Math.max(MIN_ARM_MS, Math.min(arm.timeoutMs, remainingMs));
  const { layout, canaries } = ctx;
  const cwd = arm.isolated
    ? await layout.newEpochDir(`fu-${arm.id.toLowerCase()}`)
    : layout.project;
  if (arm.isolated) await writeMemoryFixture({ layout, canaries, cwd });
  const epoch = 20 + FOLLOWUP_ARMS.indexOf(arm);
  const sentinel = arm.isolated ? newSentinel(epoch) : null;
  const gateway = arm.isolated
    ? createBrowserGateway({ createSdkMcpServer, tool }, { epoch, sentinel })
    : null;
  const denials = [];
  const options = armOptions(arm, { gateway, denials, env: built.env });
  const steps = armSteps(arm);
  const key = scenarioKey(`fu${arm.id.replace(/[^A-Za-z0-9]/g, '')}`);
  if (steps) registerScenario(key, { llm: { steps } });
  capture.capture.reset();
  capture.auth.reset();
  const poller = startArrivalPoller(capture.capture);
  const recordersBefore = await recorderCounts();
  const proxyBefore = proxy.attempts().length;
  const cwdBefore = arm.isolated
    ? (await listFiles(cwd)).map((entry) => entry.path)
    : null;
  const driven = await driveQuery({
    query,
    prompt: probeUserPrompt(key),
    options: {
      ...options,
      cwd,
      env: built.env,
      pathToClaudeCodeExecutable: binaryPath,
      model: REQUESTED_MODEL,
    },
    timeoutMs,
    stopAfterInit: arm.initOnly ? { settleMs: 2_500 } : null,
    contextUsage: arm.contextUsage ?? null,
    findProcesses: findClaudeProcesses,
  });
  for (const proc of driven.processes) trackedPids.set(proc.pid, proc);
  const exit = await waitForNoClaude(3_000);
  await sleep(TRAILING_TRAFFIC_MS);
  poller.stop();
  const snapshot = capture.capture.snapshot();
  const authSummary = capture.auth.summarize();
  capture.capture.reset();
  clearScenario(key);
  const recorderDelta = countDelta(recordersBefore, await recorderCounts());
  const keychainAttempts = recorderDelta.security ?? 0;
  delete recorderDelta.security;
  const cwdAfter = arm.isolated
    ? (await listFiles(cwd)).map((entry) => entry.path)
    : null;
  const artifact = `capture-followup-${arm.id.toLowerCase()}.json`;
  await writeSnapshot(path.join(ctx.outputDir, artifact), snapshot);
  artifacts.push(artifact);
  return {
    id: arm.id,
    label: arm.label,
    role: arm.role,
    isolated: arm.isolated,
    key,
    cwd,
    driven,
    snapshot,
    authSummary,
    recorderDelta,
    keychainAttempts,
    cwdBefore,
    cwdAfter,
    artifact,
    leakedProcesses: exit.leaked,
    gatewayEvents: gateway ? gateway.events() : [],
    denials,
    initOnly: Boolean(arm.initOnly),
    scriptedInputTokens: scriptedInputTokens(arm),
    proxyAttempts: summarizeAttempts(proxy.attempts().slice(proxyBefore)),
    envDelta: built.delta,
    sdkOptionKeys: Object.keys(options).sort(),
    extraArgs: options.extraArgs ?? null,
    settingsOption: options.settings ?? null,
    sentinelUsed: sentinel !== null,
  };
}

function summarizeArm(arm) {
  if (!arm || arm.skipped || arm.error)
    return {
      id: arm?.id,
      label: arm?.label,
      skipped: arm?.skipped ?? null,
      error: arm?.error ?? null,
    };
  const result = arm.driven?.result;
  return {
    id: arm.id,
    label: arm.label,
    role: arm.role,
    isolated: arm.isolated,
    envDelta: arm.envDelta,
    sdkOptionKeys: arm.sdkOptionKeys,
    extraArgs: arm.extraArgs,
    settingsOption: arm.settingsOption,
    init: initInventory(arm.driven?.init),
    callable: callableEvidence(arm),
    resultSubtype: result?.subtype ?? null,
    resultIsError: result?.is_error ?? null,
    apiErrorStatus: result?.api_error_status ?? null,
    numTurns: result?.num_turns ?? null,
    billed: billedUsage(result),
    messageCounts: arm.driven?.messageCounts ?? null,
    timedOut: arm.driven?.timedOut ?? null,
    error: arm.driven?.error ?? null,
    stderrTail: arm.driven?.stderrTail?.slice(-1_000) ?? '',
    systemMessages: arm.driven?.systemMessages ?? [],
    captureCounts: arm.snapshot?.counts ?? null,
    overhead: fixedOverhead(arm),
    recorderDelta: arm.recorderDelta,
    keychainAttempts: arm.keychainAttempts,
    proxyAttempts: arm.proxyAttempts,
    authSummary: arm.authSummary,
    denials: arm.denials,
    artifact: arm.artifact,
  };
}

async function guarded(arm, fn) {
  if (Date.now() > startedAt + ctx.deadlineMs - SOFT_MARGIN_MS) {
    arms[arm.id] = {
      id: arm.id,
      label: arm.label,
      skipped: 'time budget: arm not started before the soft deadline',
    };
    notes.push(`Arm ${arm.id} was skipped: soft deadline reached.`);
    return;
  }
  try {
    arms[arm.id] = await fn();
  } catch (error) {
    arms[arm.id] = {
      id: arm.id,
      label: arm.label,
      error: String(error?.stack ?? error).slice(0, 1_500),
    };
    notes.push(
      `Arm ${arm.id} crashed inside followup.mjs: ${String(error?.message ?? error).slice(0, 300)}`,
    );
  }
}

async function finalizeReport(exitCode, extra = {}) {
  if (reportWritten) return exitCode;
  reportWritten = true;
  const report = buildReport({
    provider: 'claude',
    ledger: ledger.finalize(extra.unreachedReason ?? 'not reached in this run'),
    listenPorts,
    identity: {
      probeVersion: PROBE_VERSION,
      followUp: true,
      ...extra.identity,
    },
    s02: extra.s02 ?? {
      label: 'follow-up arms; mock/loopback, not release performance',
      note: 'see identity.followUp',
    },
    artifacts: [...artifacts, 'report.json'],
    notes: [...notes],
  });
  await writeArtifact(ctx.outputDir, 'report.json', report);
  return exitCode;
}

function statusFromParts(parts) {
  if (parts.includes(STATUS.fail)) return STATUS.fail;
  if (parts.includes(STATUS.blocked)) return STATUS.blocked;
  if (parts.includes(STATUS.unobserved)) return STATUS.unobserved;
  return STATUS.pass;
}

async function main() {
  ctx = loadChildContext('claude');
  const { layout, canaries, outputDir, manifest } = ctx;
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
  const clearDeadline = armChildDeadline(ctx.deadlineMs, async () => {
    notes.push('Child deadline reached; partial report written.');
    await killStragglers();
    await finalizeReport(EXIT.crash, {
      unreachedReason: 'child deadline reached before this step',
    });
  });
  let preconditionFailed = false;
  const precondition = (id, ok, evidence) => {
    ledger.record(id, 'launch', ok ? STATUS.pass : STATUS.fail, evidence);
    if (!ok) preconditionFailed = true;
  };
  if (manifest.followUp !== true) {
    notes.push(
      'Manifest is not a follow-up manifest; run through provider-probe.mjs --follow-up.',
    );
    clearDeadline();
    return finalizeReport(EXIT.preconditionFailed, {
      unreachedReason: 'not a follow-up manifest; nothing was sent',
    });
  }
  const contained = manifest.credentialIsolation === CONTAINMENT;

  capture = await startAuthObservedCapture();
  proxy = await startRefusingProxy();
  listenPorts.push(capture.port, proxy.port);

  let seams = null;
  let pins = null;
  let fixtures = [];
  let managedPolicy = [];
  const built = {};
  const verifications = {};
  try {
    seams = await loadProductionSeams();
    binaryPath = seams.getBundledClaudeBinaryPath();
  } catch (error) {
    notes.push(
      `Production seams failed to load: ${String(error?.message ?? error).slice(0, 300)}`,
    );
    precondition('canonical.pins', false, {
      reason: 'bundled Claude binary not resolved',
      error: String(error?.message ?? error).slice(0, 300),
    });
  }

  if (seams) {
    const claudeTmp = path.join(layout.tmp, 'claude-code-tmp');
    await mkdir(claudeTmp, { recursive: true, mode: 0o700 });
    const shim = await writeKeychainShim({ layout });
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
        'Auto-memory path inferred from the pinned CLI; the U-mem control decides liveness.',
    });
    managedPolicy = await checkManagedPolicyPaths(managedPolicyPaths());
    const common = {
      seams,
      layout,
      baseUrl: capture.baseUrl,
      proxyUrl: proxy.url,
      shimDir: shim.dir,
      claudeTmpDir: claudeTmp,
    };
    for (const arm of FOLLOWUP_ARMS) {
      built[arm.id] = buildProviderEnvironment({
        ...common,
        ...armEnvironmentParams(arm),
      });
      verifications[arm.id] = verifyProviderEnvironment({
        ...built[arm.id],
        layout,
        baseUrl: capture.baseUrl,
        proxyUrl: proxy.url,
        ...armVerifyParams(arm),
      });
    }
    pins = await verifyPins({
      binaryPath,
      env: built['I-prod'].env,
      cwd: layout.root,
    });
    const failing = Object.entries(verifications)
      .filter(([, v]) => !v.ok)
      .map(([id]) => id);
    precondition('canonical.home', failing.length === 0, {
      failingArms: failing,
      note: 'every arm environment verified: synthetic HOME/config/tmp, explicit name allowlist, placeholder credentials only',
    });
    precondition('canonical.pins', pins.ok, pins);
    ledger.record(
      'canonical.no-credentials',
      'launch',
      failing.length === 0 ? STATUS.pass : STATUS.fail,
      {
        credentialVariables:
          'api-key arms: placeholder ANTHROPIC_API_KEY + loopback base URL; OAuth arms: only the synthetic placeholder CLAUDE_CODE_OAUTH_TOKEN; no credential file is read or copied',
        containment: manifest.credentialIsolation,
      },
    );
  }
  if (preconditionFailed) {
    notes.push('Canonical-state verification failed: no turn was sent.');
    clearDeadline();
    await cleanup();
    return finalizeReport(EXIT.preconditionFailed, {
      unreachedReason: 'canonical-state precondition failed; nothing was sent',
      identity: {
        preconditions: { pins, verifications, binaryPath },
        managedPolicy,
      },
    });
  }

  for (const arm of FOLLOWUP_ARMS) {
    if (arm.credential !== 'api-key' && !contained) {
      arms[arm.id] = {
        id: arm.id,
        label: arm.label,
        skipped:
          'blocked: the securityd/host-keychain containment is not confirmed in the manifest; OAuth arms refused',
      };
      notes.push(`Arm ${arm.id} refused: missing credential containment.`);
      continue;
    }
    await guarded(arm, () => runArm({ arm, built: built[arm.id] }));
  }

  // ── Analysis ───────────────────────────────────────────────────────────────
  const evaluate = evaluateCanary;
  const liveness = controlLiveness({
    fixtures,
    control: arms['U-mem']?.snapshot ? arms['U-mem'] : null,
    tokens: canaries,
    evaluate,
    isLive: isFixtureLive,
  });
  const memoryMatrix = evaluateMemoryMatrix({
    arms,
    token: canaries.memory,
    evaluate,
  });
  const memoryFlagPair = evaluateMemoryFlagPair({
    arms,
    token: canaries.memory,
    evaluate,
  });
  if (memoryFlagPair.removedHits > 0)
    liveness.memory = {
      live: true,
      basis: 'memory canary observed in isolated flag-removal control',
    };
  const candidateIds = ['I-prod', 'I-safe', 'I-targeted'];
  const perArm = {};
  const expectedLoop = BROWSER_LOOP.map(([name]) => name);
  for (const arm of FOLLOWUP_ARMS) {
    const data = arms[arm.id];
    perArm[arm.id] = {
      toolLoop:
        arm.script === 'loop' || arm.script === 'context'
          ? evaluateToolLoop(data, { expected: expectedLoop })
          : null,
      sources:
        arm.isolated && data?.snapshot
          ? evaluateSourceCanaries({
              arm: data,
              tokens: canaries,
              evaluate,
              liveness,
              ids: SOURCE_CANARY_IDS,
            })
          : null,
      hooks: arm.isolated && data?.snapshot ? hookRecorderStatus(data) : null,
    };
  }
  const candidateParts = candidateIds.flatMap((id) => {
    const row = perArm[id];
    if (!row?.sources) return [STATUS.unobserved];
    return [
      row.toolLoop?.status ?? STATUS.unobserved,
      row.hooks?.status ?? STATUS.unobserved,
      ...Object.values(row.sources).map((entry) => entry.status),
    ];
  });
  ledger.record(
    'followup.claude-controls',
    'run',
    statusFromParts([memoryFlagPair.status, ...candidateParts]),
    {
      memoryMatrix,
      memoryFlagPair,
      candidates: Object.fromEntries(
        candidateIds.map((id) => [id, perArm[id]]),
      ),
      note: 'pass means the synthetic arm set met its criteria; managed-policy accounts, real OAuth and production binding remain unqualified',
    },
  );
  const authInit = evaluateAuth(arms['O-init'], {
    proxy: arms['O-init']?.proxyAttempts,
  });
  const authLoop = evaluateAuth(arms['O-loop'], {
    proxy: arms['O-loop']?.proxyAttempts,
    auth: arms['O-loop']?.authSummary,
  });
  const loopTool = perArm['O-loop']?.toolLoop ?? null;
  const safeAuthInit = evaluateAuth(arms['O-safe-init'], {
    proxy: arms['O-safe-init']?.proxyAttempts,
  });
  const safeAuthLoop = evaluateAuth(arms['O-safe-loop'], {
    proxy: arms['O-safe-loop']?.proxyAttempts,
    auth: arms['O-safe-loop']?.authSummary,
  });
  ledger.record(
    'followup.claude-auth',
    'run',
    !contained
      ? STATUS.blocked
      : authInit.status === 'measured'
        ? STATUS.measured
        : STATUS.unobserved,
    {
      containment: contained ? CONTAINMENT : 'missing: OAuth arms refused',
      syntheticOAuthToken: `placeholder (${SYNTHETIC_OAUTH_TOKEN.length} characters, never a real credential)`,
      productionShapedInitOnly: authInit,
      loopbackNonProduction: { ...authLoop, toolLoop: loopTool },
      safeModeProductionShapedInitOnly: safeAuthInit,
      safeModeLoopbackNonProduction: {
        ...safeAuthLoop,
        toolLoop: perArm['O-safe-loop']?.toolLoop ?? null,
      },
      note: 'inference and tool calls for the production-shaped arm are unobserved; real OAuth acceptance is a separate account check',
    },
  );
  const context = evaluateContextSignals(arms['I-context']);
  ledger.record(
    'followup.context',
    'run',
    context.status === 'measured' ? STATUS.measured : STATUS.unobserved,
    {
      ...context,
      checkpointTokens: CONTEXT_CHECKPOINT_TOKENS,
    },
  );
  ledger.record('phase.compaction', 'compaction', STATUS.unobserved, {
    reason:
      'No arm drives history near the autocompact threshold; any compact_boundary message is counted under followup.context but compaction behavior is not qualified.',
  });
  ledger.record('phase.restart', 'restart', STATUS.unobserved, {
    reason:
      'Arms never resume a session (persistSession false, no resume/continue); cross-epoch native resume is forbidden and restart retention is not proven here.',
  });

  clearDeadline();
  const cleanupResult = await cleanup();
  ledger.record(
    'hygiene.cleanup',
    'completion',
    cleanupResult.claudeProcessesRemaining === 0 ? STATUS.pass : STATUS.fail,
    cleanupResult,
  );
  ledger.record('hygiene.no-external-requests', 'run', STATUS.measured, {
    refusingProxy: proxy.summary(),
    note: 'Probe-side evidence only: the orchestrator sampling is authoritative.',
  });

  const failed = ledger.finalize().failed;
  return finalizeReport(failed ? EXIT.requirementFailed : EXIT.ok, {
    identity: {
      pins: { expected: EXPECTED_PINS, verified: pins },
      model: { requested: REQUESTED_MODEL },
      containment: manifest.credentialIsolation,
      managedPolicy,
      followUp: {
        arms: Object.fromEntries(
          FOLLOWUP_ARMS.map((arm) => [arm.id, summarizeArm(arms[arm.id])]),
        ),
        liveness,
        memoryMatrix,
        perArm,
        context,
        auth: { init: authInit, loopback: authLoop },
        armCatalog: FOLLOWUP_ARMS.map(
          ({ id, label, role, options, memoryFlag, credential }) => ({
            id,
            label,
            role,
            options,
            memoryFlag,
            credential,
          }),
        ),
        armCatalogById: Object.keys(ARM_BY_ID),
      },
      runDurationMs: Date.now() - startedAt,
    },
  });
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

// Entry point. Exit codes follow shared/constants.mjs EXIT.
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
