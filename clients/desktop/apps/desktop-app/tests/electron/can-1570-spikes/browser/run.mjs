#!/usr/bin/env node
// CAN-1570 technical spikes probe runner body (planning-only evidence).
//
// Run through the documented entry wrapper
// scripts/probes/can-1570-spikes/spike-probe.mjs, which spawns this
// file by path. Options: [--prepare-only] [--measure-cost-on-lab-heavy]
// [--out-dir=.playwright/can-1570-spikes] [--deadline-ms=900000]
// [--case-timeout-ms=12000] [--settle-ms=400]
//
// Step 1 prepares the pinned Electron binary through the central
// scripts/lib/electron-binary.mjs helper. That is the only step that may use
// the network (a toolchain download), and it finishes before any probe
// listener exists. Step 2 launches the probe app (./app) with hidden windows,
// a disposable work directory, a minimal environment, and Chromium external DNS
// disabled (loopback names excepted), then enforces a whole-probe deadline by killing the process
// group. The raw JSON report is written under .playwright/ (not committed).
//
// RELOCATION: this file imports electron/package.json and the probe app
// imports electron, so the whole browser/ tree must live under
// apps/desktop-app (check:electron-boundary). When it moves to
// apps/desktop-app/tests/electron/can-1570-spikes/browser/, update the
// electron-binary import below; repoRoot is found by walking up.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureElectronBinaryInstalled } from '../../../../../../scripts/lib/electron-binary.mjs';
import { listenPairedBrowserLabServers } from '../../mock-server/routes/browser-lab.mjs';
import {
  buildChildEnv,
  parseProbeArgs,
  PINNED_ELECTRON,
  PROBE_ENTRY,
  summarizeReport,
} from './runner-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = findRepoRoot(here);
const appDir = path.join(here, 'app');
const require = createRequire(import.meta.url);

/** The nearest ancestor that owns scripts/lib/electron-binary.mjs. */
function findRepoRoot(start) {
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, 'scripts', 'lib', 'electron-binary.mjs'))) {
      return dir;
    }
    if (path.dirname(dir) === dir) {
      throw new Error('Cannot find the repository root from the probe.');
    }
  }
}

function electronVersion() {
  return JSON.parse(
    readFileSync(require.resolve('electron/package.json'), 'utf8'),
  ).version;
}

async function main() {
  const options = parseProbeArgs(process.argv.slice(2));
  const runId = `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;
  const command = ['node', PROBE_ENTRY, ...process.argv.slice(2)].join(' ');

  // ── Step 1: toolchain (separate from probe egress) ──
  const version = electronVersion();
  if (version !== PINNED_ELECTRON) {
    throw new Error(
      `electron package is ${version}; the probe qualifies only the pinned ${PINNED_ELECTRON}.`,
    );
  }
  const toolchainStartedAt = Date.now();
  ensureElectronBinaryInstalled();
  const electronPath = process.env.ELECTRON_EXEC_PATH;
  if (!electronPath || !existsSync(electronPath))
    throw new Error('Electron binary is unavailable after preparation.');
  const toolchain = {
    electronPackage: version,
    electronPath: path.relative(repoRoot, electronPath),
    prepareMs: Date.now() - toolchainStartedAt,
  };
  console.log(
    `toolchain ready: electron ${version} (${toolchain.electronPath})`,
  );
  if (options.prepareOnly) return 0;

  // ── Step 2: the probe itself ──
  const outDir = path.join(repoRoot, options.outDir);
  mkdirSync(outDir, { recursive: true });
  const workDir = mkdtempSync(path.join(tmpdir(), 'can1570-probe-'));
  const home = path.join(workDir, 'home');
  const tmp = path.join(workDir, 'tmp');
  mkdirSync(home);
  mkdirSync(tmp);
  const rawReportPath = path.join(workDir, 'app-report.json');
  // The S2 cost run measures the Browser Lab `heavy` case. Its paired
  // 127.0.0.1 and localhost listeners make the cross-site frames
  // out-of-process, and they live in this process, not in the probe app.
  const lab = options.labHeavy ? await listenPairedBrowserLabServers() : null;
  const externalPageUrl = lab
    ? `${lab.primary.origin}/browser-lab/heavy`
    : options.externalPageUrl;
  const config = {
    runId,
    workDir,
    reportPath: rawReportPath,
    deadlineMs: options.deadlineMs,
    caseTimeoutMs: options.caseTimeoutMs,
    settleMs: options.settleMs,
    externalPageUrl,
    costSamples: options.costSamples,
    measureCost: options.measureCost,
    expectedElectron: PINNED_ELECTRON,
  };
  const args = [
    appDir,
    `--user-data-dir=${path.join(workDir, 'chromium-user-data')}`,
  ];
  console.log(
    `probe ${runId}: launching hidden Electron probe (deadline ${options.deadlineMs} ms)`,
  );

  const startedAt = Date.now();
  const child = spawn(electronPath, args, {
    cwd: workDir,
    env: buildChildEnv(process.env, { workDir, home, tmp, config }),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  const logTail = [];
  const keep = (chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (!line.trim()) continue;
      logTail.push(line.slice(0, 400));
      if (logTail.length > 200) logTail.shift();
    }
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);

  let killedByRunner = false;
  const killTree = () => {
    killedByRunner = true;
    try {
      if (process.platform === 'win32')
        spawn('taskkill', ['/pid', String(child.pid), '/t', '/f']);
      else process.kill(-child.pid, 'SIGKILL');
    } catch {
      // already gone
    }
  };
  const hardDeadline = setTimeout(
    killTree,
    options.deadlineMs + options.killGraceMs,
  );
  const forwardSignal = () => {
    killTree();
  };
  process.once('SIGINT', forwardSignal);
  process.once('SIGTERM', forwardSignal);
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(hardDeadline);
  if (lab) await lab.close();
  // Kill any orphaned helpers left in the probe's process group.
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // group already empty
    }
  }

  let report;
  if (existsSync(rawReportPath)) {
    report = JSON.parse(readFileSync(rawReportPath, 'utf8'));
  } else {
    report = {
      schema: 'can1570-spikes/v1',
      runId,
      outcome: killedByRunner ? 'killed-at-deadline' : 'no-report',
      summary: null,
      errors: ['the probe app did not write a report'],
    };
  }
  report.runner = {
    command,
    toolchain,
    exit,
    killedByRunner,
    wallMs: Date.now() - startedAt,
    childLogTail: logTail,
    qualification:
      report.outcome === 'completed' ? 'qualified' : 'not-qualified',
  };
  if (killedByRunner) report.outcome = 'killed-at-deadline';

  const reportPath = path.join(outDir, `can1570-spikes-${runId}.json`);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  rmSync(workDir, { recursive: true, force: true });

  for (const line of summarizeReport(report)) console.log(line);
  console.log(`report: ${path.relative(repoRoot, reportPath)}`);
  return report.outcome === 'completed' ? 0 : 2;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(String(error?.stack ?? error));
    process.exit(1);
  },
);
