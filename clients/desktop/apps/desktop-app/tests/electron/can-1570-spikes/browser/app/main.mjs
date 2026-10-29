import { app } from 'electron';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import {
  createFixtures,
  createView,
  bounded,
  sleep,
  until,
} from './harness.mjs';
import { runS1S6 } from './s1-s6.mjs';
import { runS2S3 } from './s2-s3.mjs';
import { runS4S5 } from './s4-s5.mjs';
import { collectExecutionFailures } from './qualification.mjs';

const config = JSON.parse(process.env.CAN1570_PROBE_CONFIG ?? 'null');
if (!config?.workDir || !config?.reportPath)
  throw new Error('Runner config required');
app.setName('canopy-can1570-probe');
for (const key of ['userData', 'sessionData', 'logs', 'crashDumps'])
  app.setPath(key, path.join(config.workDir, key));
app.commandLine.appendSwitch(
  'host-resolver-rules',
  'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost, EXCLUDE [::1]',
);
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('password-store', 'basic');
if (process.platform === 'darwin')
  app.commandLine.appendSwitch('use-mock-keychain');
app.on('window-all-closed', () => {});
const report = {
  schema: 'can1570-spikes/v1',
  runId: config.runId,
  startedAt: new Date().toISOString(),
  outcome: 'running',
  environment: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
  },
  composition: {
    windowShow: false,
    preload: 'none except S5 contextBridge comparison',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      partition: 'disposable, nonpersistent',
    },
    autoAttach: {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: 'iframe', exclude: false }, { exclude: true }],
    },
  },
  spikes: {},
  errors: [],
};
const owned = [];
let server;

// Not top-level await: Electron holds `ready` until the ESM entry finishes
// evaluating, so awaiting `app.whenReady()` at module scope never resolves.
async function main() {
  try {
    await app.whenReady();
    if (app.dock) app.dock.hide();
    server = await createFixtures();
    report.fixtures = {
      mainOrigin: server.mainOrigin,
      crossOrigin: server.crossOrigin,
    };
    const ctx = {
      config,
      server,
      sleep,
      until,
      bounded,
      newView: async (...args) => {
        const view = await createView(...args);
        owned.push(view);
        return view;
      },
    };
    for (const run of [runS1S6, runS2S3, runS4S5]) {
      try {
        Object.assign(
          report.spikes,
          await bounded(run(ctx), config.measureCost ? 600000 : 280000),
        );
      } catch (error) {
        report.errors.push(`${run.name}: ${String(error?.stack ?? error)}`);
      }
    }
    report.executionFailures = collectExecutionFailures(report.spikes);
    report.outcome =
      report.errors.length || report.executionFailures.length
        ? 'incomplete'
        : 'completed';
  } catch (error) {
    report.errors.push(String(error?.stack ?? error));
    report.outcome = 'failed';
  } finally {
    for (const resource of owned) resource.dispose();
    if (server) await server.close();
    report.finishedAt = new Date().toISOString();
    writeFileSync(config.reportPath, JSON.stringify(report, null, 2));
    app.exit(report.outcome === 'completed' ? 0 : 2);
  }
}

void main();
