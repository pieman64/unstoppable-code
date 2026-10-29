// S0.3 per-tab enforcement probe: Electron main entry. Planning-only.
//
// Launched only by scripts/probes/browser-agent-phase0/browser-probe.mjs with
// S03_PROBE_CONFIG. Every window is hidden; every profile lives under the
// runner's disposable work directory; every listener is a probe-owned loopback
// listener; Chromium's own DNS is disabled so nothing can egress. The user's
// profiles, browser, clipboard, and files are never read.

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { app, session } from 'electron';
import { createCanaryServer } from '../fixtures/canary-server.mjs';
import { createVectorServer } from '../fixtures/vector-server.mjs';
import { aggregate, VECTORS } from '../vectors.mjs';
import { createBinding } from './binding.mjs';
import { runBindingCases, withTimeout } from './cases.mjs';
import { createBrowserLabServer, runLabChecks } from './lab.mjs';

const config = JSON.parse(process.env.S03_PROBE_CONFIG ?? 'null');
if (
  !config ||
  typeof config.reportPath !== 'string' ||
  typeof config.workDir !== 'string'
) {
  console.error('S03_PROBE_CONFIG with reportPath and workDir is required.');
  process.exit(2);
}
const startedAt = Date.now();
const deadlineAt = startedAt + config.deadlineMs;
const runId = config.runId;

// ── Isolation before ready ──
app.setName('canopy-s03-probe');
for (const name of ['userData', 'sessionData', 'logs', 'crashDumps']) {
  app.setPath(name, path.join(config.workDir, name));
}
app.commandLine.appendSwitch(
  'host-resolver-rules',
  'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE [::1]',
);
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
if (process.platform === 'linux')
  app.commandLine.appendSwitch('password-store', 'gnome-libsecret');
if (process.platform === 'darwin')
  app.commandLine.appendSwitch('use-mock-keychain');
app.on('window-all-closed', () => {});

const report = {
  schema: 's03-tab-enforcement-probe/v1',
  runId,
  startedAt: new Date(startedAt).toISOString(),
  finishedAt: null,
  outcome: 'running',
  environment: {
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    expectedElectron: config.expectedElectron ?? null,
  },
  limits: {
    deadlineMs: config.deadlineMs,
    caseTimeoutMs: config.caseTimeoutMs,
    settleMs: config.settleMs,
  },
  vectors: VECTORS,
  bindings: {},
  lab: null,
  summary: null,
  notes: [],
  errors: [],
};

const owned = { servers: [], bindings: [] };
let finished = false;

async function finish(outcome) {
  if (finished) return;
  finished = true;
  report.outcome = outcome;
  const results = Object.values(report.bindings).flatMap(
    (binding) => binding.cases ?? [],
  );
  report.summary = aggregate(results, {
    platform: process.platform,
    windowsEvidence: false,
  });
  if (report.environment.electron !== report.environment.expectedElectron) {
    report.summary.qualified = false;
    report.summary.reasons.push(
      `Electron ${report.environment.electron} is not the pinned ${report.environment.expectedElectron}`,
    );
  }
  if (outcome !== 'completed') {
    report.summary.qualified = false;
    report.summary.reasons.push(`probe outcome ${outcome}`);
  }
  report.finishedAt = new Date().toISOString();
  // Release owned resources with their own bound; the report is written even
  // if teardown hangs, and the runner kills the process tree at its deadline.
  await withTimeout(teardown(), 10000, 'teardown').catch((error) => {
    report.errors.push(`teardown: ${String(error?.message ?? error)}`);
  });
  writeFileSync(config.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  app.exit(outcome === 'completed' ? 0 : 3);
}

async function teardown() {
  for (const binding of owned.bindings.splice(0)) {
    await binding
      .dispose()
      .catch((error) =>
        report.errors.push(`dispose ${binding.kind}: ${String(error)}`),
      );
  }
  for (const server of owned.servers.splice(0)) {
    await server
      .close()
      .catch((error) => report.errors.push(`close: ${String(error)}`));
  }
}

process.on('uncaughtException', (error) => {
  report.errors.push(
    `uncaught: ${String(error?.stack ?? error).slice(0, 500)}`,
  );
  void finish('crashed');
});
process.on('unhandledRejection', (error) => {
  report.errors.push(
    `unhandled: ${String(error?.stack ?? error).slice(0, 500)}`,
  );
  void finish('crashed');
});
setTimeout(() => {
  report.errors.push('whole-probe deadline reached');
  void finish('deadline');
}, config.deadlineMs);

async function listen(server, label) {
  owned.servers.push(server);
  const { port, origin } = await server.listen(0, '127.0.0.1');
  return { server, port, origin, label };
}

async function listenLab(lab) {
  owned.servers.push({
    close: () =>
      new Promise((resolve) => {
        lab.closeAllConnections();
        lab.close(() => resolve());
      }),
  });
  await new Promise((resolve, reject) => {
    lab.once('error', reject);
    lab.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${lab.address().port}`;
}

async function runBinding(kind, partition, env) {
  const binding = await createBinding({
    kind,
    partition,
    workDir: config.workDir,
    ports: { local: env.local.port, public: env.public.port },
    deniedOrigins: [env.recorder.origin],
  });
  owned.bindings.push(binding);
  const leased = await binding.openTab('leased', env.vector.origin);
  const control =
    kind === 'shared' ? await binding.openTab('control', null) : null;
  const cases = await runBindingCases({
    binding,
    leased,
    control,
    canaries: {
      local: env.local.server,
      public: env.public.server,
      user: env.user.server,
      recorder: env.recorder.server,
    },
    ports: {
      local: env.local.port,
      user: env.user.port,
      recorder: env.recorder.port,
    },
    vectorOrigin: env.vector.origin,
    caseTimeoutMs: config.caseTimeoutMs,
    settleMs: config.settleMs,
    deadlineAt: deadlineAt - 20000,
  });
  report.bindings[kind] = {
    profile:
      kind === 'shared'
        ? 'named shared disposable profile (persist: partition under the run work directory)'
        : 'task disposable profile (in-memory partition)',
    partition,
    tabs: { leased: leased.id, control: control ? control.id : null },
    exceptionOrigin: env.vector.origin,
    deniedOrigins: [env.recorder.origin],
    gateway: {
      port: binding.gatewayPort,
      logEntries: binding.gateway.log.length,
      logTruncated: binding.gateway.logTruncated,
    },
    proxyResolution: binding.proxyResolution,
    resolverLookups: binding.resolver.lookups.length,
    attributionSummary: attributionSummary(binding.listenerEvents),
    setupNotes: binding.setupNotes,
    cases,
  };
  await binding.dispose();
  owned.bindings.splice(owned.bindings.indexOf(binding), 1);
}

/** How often each resourceType arrived with or without a webContentsId. */
function attributionSummary(events) {
  const summary = {};
  for (const event of events) {
    const entry = (summary[event.resourceType] ??= {
      withWebContentsId: 0,
      withoutWebContentsId: 0,
    });
    if (event.webContentsId === null) entry.withoutWebContentsId += 1;
    else entry.withWebContentsId += 1;
  }
  return summary;
}

async function main() {
  await app.whenReady();
  if (process.platform === 'darwin') app.dock?.hide();
  // The default session is never used; point it at a closed port so any
  // stray request fails instead of egressing.
  await session.defaultSession.setProxy({
    proxyRules: 'http://127.0.0.1:9',
    proxyBypassRules: '<-loopback>',
  });

  const env = {
    local: await listen(createCanaryServer({ role: 'local-canary' }), 'local'),
    public: await listen(
      createCanaryServer({ role: 'public-canary' }),
      'public',
    ),
    user: await listen(createCanaryServer({ role: 'user-service' }), 'user'),
    recorder: await listen(
      createCanaryServer({ role: 'recorder' }),
      'recorder',
    ),
    exfil: await listen(createCanaryServer({ role: 'exfil-sink' }), 'exfil'),
    vector: await listen(createVectorServer(), 'vector'),
  };
  report.listeners = Object.fromEntries(
    Object.entries(env).map(([key, value]) => [key, value.origin]),
  );

  await runBinding('shared', `persist:s03-shared-${runId}`, env);
  await runBinding('task', `s03-task-${runId}`, env);

  // Browser Lab A3 functional checks: a dedicated createBrowserLabServer
  // listener, attack origins on separate disposable listeners, no shared mock
  // control plane, in a fresh task profile whose only exception is the lab.
  if (Date.now() + 60000 < deadlineAt) {
    const labOrigin = await listenLab(
      createBrowserLabServer({
        attackOrigins: {
          localService: env.local.origin,
          exfiltrationSink: env.exfil.origin,
        },
      }),
    );
    const binding = await createBinding({
      kind: 'task',
      partition: `s03-lab-${runId}`,
      workDir: config.workDir,
      ports: { local: env.local.port, public: env.public.port },
      deniedOrigins: [env.recorder.origin],
    });
    owned.bindings.push(binding);
    const tab = await binding.openTab('leased', labOrigin);
    report.lab = {
      origin: labOrigin,
      ...(await runLabChecks({
        contents: tab.contents,
        origin: labOrigin,
        attackCanaries: { local: env.local.server, exfil: env.exfil.server },
        binding,
        deadlineAt: deadlineAt - 15000,
      })),
    };
  } else {
    report.lab = {
      cases: [],
      attacks: [],
      skipped: 'probe deadline reached before Browser Lab checks',
    };
  }
  await finish('completed');
}

main().catch((error) => {
  report.errors.push(`main: ${String(error?.stack ?? error).slice(0, 800)}`);
  void finish('failed');
});
