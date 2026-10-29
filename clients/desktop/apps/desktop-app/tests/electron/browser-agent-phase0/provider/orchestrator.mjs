#!/usr/bin/env node
// Browser-agent Phase 0 provider probe (S0.1 isolated launch/outbound capture,
// S0.2 rotation cost and page growth). Planning evidence only: it proves
// nothing about release readiness, performance or model quality.
//
//   node --import tsx scripts/probes/browser-agent-phase0/provider-probe.mjs \
//     [--provider codex|claude|all] [--out <dir>] [--deadline-ms <n>] \
//     [--self-check] [--keep-root]
//
// --self-check performs only static checks (pins, resolver paths, derived
// schemas, synthetic page, synthetic root and environment); it starts no
// provider binary. Without it, each provider runs in its own child process
// with a synthetic HOME/CODEX_HOME/CLAUDE_CONFIG_DIR/CANOPY_DATA_DIR, a
// from-scratch environment, its own process group and a hard deadline. All
// inference goes to a loopback capture listener inside the child.
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CHILD_ENV,
  DEFAULT_CHILD_DEADLINE_MS,
  DEFAULT_OUTPUT_ROOT,
  EXIT,
  EXPECTED_PINS,
  PROBE_DIR,
  REPO_ROOT,
} from './shared/constants.mjs';
import { createCanarySet } from './shared/canaries.mjs';
import {
  buildProbeChildEnv,
  checkProbeEnv,
  countWithheldHostCredentials,
} from './shared/child-env.mjs';
import { checkPortsClosed, runProbeChild } from './shared/process-guard.mjs';
import {
  createSyntheticRoot,
  layoutManifest,
} from './shared/synthetic-root.mjs';
import { STATUS } from './shared/ledger.mjs';

const PROVIDERS = ['codex', 'claude'];

function parseArgs(argv) {
  const options = {
    provider: 'all',
    out: null,
    deadlineMs: DEFAULT_CHILD_DEADLINE_MS,
    selfCheck: false,
    keepRoot: false,
    followUp: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--provider') options.provider = argv[++index];
    else if (arg === '--out') options.out = path.resolve(argv[++index]);
    else if (arg === '--deadline-ms')
      options.deadlineMs = Number(argv[++index]);
    else if (arg === '--self-check') options.selfCheck = true;
    else if (arg === '--keep-root') options.keepRoot = true;
    else if (arg === '--follow-up') options.followUp = true;
    else throw new Error(`Unknown argument ${arg}`);
  }
  if (!['all', ...PROVIDERS].includes(options.provider))
    throw new Error(`--provider must be codex, claude or all`);
  if (!(options.deadlineMs >= 30_000 && options.deadlineMs <= 900_000))
    throw new Error('--deadline-ms must be 30000..900000');
  return options;
}

function bundledTarget() {
  if (process.platform === 'darwin') return `darwin-${process.arch}`;
  if (process.platform === 'win32') return 'win32-x64';
  return null;
}

/** Static checks; starts no provider binary. */
export async function selfCheck() {
  const pkg = JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
  );
  const lock = readFileSync(path.join(REPO_ROOT, 'pnpm-lock.yaml'), 'utf8');
  const sdkLocked =
    lock.match(/^ {2}'@anthropic-ai\/claude-agent-sdk@(\d[^':(]*)'?:$/m)?.[1] ??
    null;
  const sdkInstalled = JSON.parse(
    readFileSync(
      path.join(
        REPO_ROOT,
        'node_modules/@anthropic-ai/claude-agent-sdk/package.json',
      ),
      'utf8',
    ),
  ).version;
  const target = bundledTarget();
  const binDir = target ? path.join(REPO_ROOT, '.cache', 'bin', target) : null;
  const { deriveBrowserToolSchemas, schemaOverheadSummary } =
    await import('./shared/tool-schemas.mjs');
  const { buildSyntheticObservation, observationToolText } =
    await import('./shared/synthetic-page.mjs');
  const tools = deriveBrowserToolSchemas();
  const observation = buildSyntheticObservation({
    sentinel: 'BAP0_PAGE_SELFCHECK_0001',
    epoch: 1,
    step: 1,
  });
  const root = await createSyntheticRoot('selfcheck');
  let envCheck;
  try {
    const env = buildProbeChildEnv(root, {
      hostEnvCanary: 'BAP0_HOSTENVIRONMENT_selfcheck',
    });
    envCheck = checkProbeEnv(env, { root: root.root });
  } finally {
    await root.cleanup();
  }
  const pins = {
    codexCli: {
      expected: EXPECTED_PINS.codexCli,
      packageJson: pkg.codex?.version ?? null,
    },
    claudeCli: {
      expected: EXPECTED_PINS.claudeCli,
      packageJson: pkg['claude-code']?.version ?? null,
    },
    claudeAgentSdk: {
      expected: EXPECTED_PINS.claudeAgentSdk,
      lockfile: sdkLocked,
      installed: sdkInstalled,
    },
  };
  const pinsOk =
    pins.codexCli.packageJson === EXPECTED_PINS.codexCli &&
    pins.claudeCli.packageJson === EXPECTED_PINS.claudeCli &&
    sdkLocked === EXPECTED_PINS.claudeAgentSdk &&
    sdkInstalled === EXPECTED_PINS.claudeAgentSdk;
  const binaries = binDir
    ? {
        binDir,
        codex: existsSync(path.join(binDir, 'codex')),
        claude: existsSync(path.join(binDir, 'claude')),
      }
    : { binDir: null, codex: false, claude: false };
  return {
    ok:
      process.platform === 'darwin' &&
      existsSync('/usr/bin/sandbox-exec') &&
      pinsOk &&
      binaries.codex &&
      binaries.claude &&
      envCheck.ok &&
      existsSync(root.root) === false,
    networkContainment: {
      available:
        process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec'),
      mechanism:
        'macOS sandbox-exec; native regression proves loopback allowed and non-loopback EPERM',
    },
    pins,
    pinsOk,
    binaries,
    tools: schemaOverheadSummary(tools),
    observation: {
      controls: observation.controls.length,
      textCharacters: observation.visibleText.text.length,
      serializedBytes: Buffer.byteLength(observationToolText(observation)),
    },
    env: envCheck,
    withheldHostCredentialVariables: countWithheldHostCredentials(),
    rootRemoved: !existsSync(root.root),
  };
}

async function runProvider(provider, options, runDir) {
  const outputDir = path.join(runDir, provider);
  await mkdir(outputDir, { recursive: true });
  const root = await createSyntheticRoot(provider);
  const canaries = createCanarySet();
  const summary = { provider, root: root.root, outputDir };
  try {
    // Shared host-file canary: planted, never referenced by the probe.
    const hostFile = path.join(root.home, 'Documents', 'private-notes.txt');
    await mkdir(path.dirname(hostFile), { recursive: true });
    await writeFile(hostFile, `Private host note ${canaries.hostFile}\n`);
    const env = buildProbeChildEnv(root, {
      hostEnvCanary: canaries.hostEnvironment,
    });
    const manifestPath = path.join(root.root, 'manifest.json');
    await writeFile(
      manifestPath,
      JSON.stringify(
        {
          provider,
          followUp: options.followUp,
          credentialIsolation: options.followUp
            ? 'securityd-and-host-keychain-deny'
            : null,
          layout: layoutManifest(root),
          canaries,
          hostFile,
          startedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    env[CHILD_ENV.manifest] = manifestPath;
    env[CHILD_ENV.output] = outputDir;
    env[CHILD_ENV.deadlineMs] = String(options.deadlineMs);
    const envCheck = checkProbeEnv(env, { root: root.root });
    summary.childEnv = { names: Object.keys(env).sort(), check: envCheck };
    if (!envCheck.ok) {
      summary.exit = { precondition: 'child environment check failed' };
      return summary;
    }
    const script = path.join(
      PROBE_DIR,
      'provider',
      provider,
      options.followUp ? 'followup.mjs' : 'run.mjs',
    );
    if (!existsSync(script)) {
      summary.exit = {
        precondition: `missing ${path.relative(REPO_ROOT, script)}`,
      };
      return summary;
    }
    const result = await runProbeChild({
      script,
      env,
      networkIsolation: true,
      credentialIsolation: options.followUp,
      deadlineMs: options.deadlineMs,
      stdoutPath: path.join(outputDir, 'child.stdout.log'),
      stderrPath: path.join(outputDir, 'child.stderr.log'),
    });
    summary.exit = {
      code: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
    };
    summary.networkIsolation = result.networkIsolation;
    summary.processes = result.trackedProcesses;
    summary.leaks = result.leaks;
    summary.nonLoopbackConnections = result.nonLoopbackConnections;
    summary.egressMethod = result.egressMethod;
    const reportPath = path.join(outputDir, 'report.json');
    if (existsSync(reportPath)) {
      const report = JSON.parse(await readFile(reportPath, 'utf8'));
      const ports = await checkPortsClosed(report.listenPorts ?? []);
      summary.portsAfterExit = ports;
      const cleanupOk =
        result.leaks.length === 0 &&
        ports.every((port) => !port.open) &&
        !result.timedOut;
      const egressOk = result.nonLoopbackConnections.length === 0;
      appendHygiene(
        report,
        'hygiene.no-external-requests',
        'run',
        egressOk ? STATUS.pass : STATUS.fail,
        {
          nonLoopbackConnections: result.nonLoopbackConnections.slice(0, 20),
          method: result.egressMethod,
        },
      );
      summary.hygiene = { cleanupOk, egressOk };
      summary.report = reportPath;
      summary.ledgerCounts = report.ledger?.counts ?? null;
      summary.pendingCleanup = {
        report,
        cleanupOk,
        leaks: result.leaks,
        ports,
        reportPath,
      };
    } else {
      summary.report = null;
    }
    return summary;
  } finally {
    if (!options.keepRoot) {
      await root.cleanup().catch((error) => {
        summary.rootCleanupError = String(error?.message ?? error);
      });
    }
    summary.rootRemoved = !existsSync(root.root);
    if (summary.pendingCleanup) {
      const { report, cleanupOk, leaks, ports, reportPath } =
        summary.pendingCleanup;
      appendHygiene(
        report,
        'hygiene.cleanup',
        'completion',
        cleanupOk && summary.rootRemoved ? STATUS.pass : STATUS.fail,
        {
          leaks,
          ports,
          rootRemoved: summary.rootRemoved,
        },
      );
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
      summary.ledgerCounts = report.ledger?.counts ?? null;
      summary.failed = Boolean(report.ledger?.failed);
      delete summary.pendingCleanup;
    }
  }
}

/** Replace the child's placeholder hygiene entry with the orchestrator's observation. */
function appendHygiene(report, id, phase, status, evidence) {
  if (!report.ledger?.entries) return;
  report.ledger.entries = report.ledger.entries.filter(
    (entry) => !(entry.id === id && entry.phase === phase),
  );
  report.ledger.entries.push({
    id,
    phase,
    status,
    evidence,
    observedBy: 'orchestrator',
  });
  const counts = {};
  for (const entry of report.ledger.entries)
    counts[entry.status] = (counts[entry.status] ?? 0) + 1;
  report.ledger.counts = counts;
  report.ledger.failed = report.ledger.entries.some(
    (entry) => entry.status === STATUS.fail,
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = options.out ?? path.join(DEFAULT_OUTPUT_ROOT, stamp);
  await mkdir(runDir, { recursive: true });
  const check = await selfCheck();
  await writeFile(
    path.join(runDir, 'self-check.json'),
    `${JSON.stringify(check, null, 2)}\n`,
  );
  if (options.selfCheck) {
    process.stdout.write(
      `${JSON.stringify({ runDir, selfCheck: check.ok }, null, 2)}\n`,
    );
    process.exitCode = check.ok ? EXIT.ok : EXIT.preconditionFailed;
    return;
  }
  if (!check.ok) {
    process.stdout.write(
      `${JSON.stringify({ runDir, selfCheck: false }, null, 2)}\n`,
    );
    process.exitCode = EXIT.preconditionFailed;
    return;
  }
  const providers = options.provider === 'all' ? PROVIDERS : [options.provider];
  const results = [];
  // Serialized: one provider at a time, each with its own synthetic root.
  for (const provider of providers)
    results.push(await runProvider(provider, options, runDir));
  const summary = {
    runDir,
    startedAt: stamp,
    selfCheck: check.ok,
    providers: results,
  };
  await writeFile(
    path.join(runDir, 'summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  process.stdout.write(
    `${JSON.stringify(
      results.map((result) => ({
        provider: result.provider,
        exit: result.exit,
        failed: result.failed ?? null,
        ledgerCounts: result.ledgerCounts ?? null,
        leaks: result.leaks?.length ?? null,
        nonLoopback: result.nonLoopbackConnections?.length ?? null,
        rootRemoved: result.rootRemoved,
      })),
      null,
      2,
    )}\nArtifacts: ${runDir}\n`,
  );
  const crashed = results.some(
    (result) =>
      result.exit?.code !== 0 && result.exit?.code !== EXIT.requirementFailed,
  );
  const failed = results.some((result) => result.failed);
  process.exitCode = crashed
    ? EXIT.crash
    : failed
      ? EXIT.requirementFailed
      : EXIT.ok;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = EXIT.crash;
  });
}
