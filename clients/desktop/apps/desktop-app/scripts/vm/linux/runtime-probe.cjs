// Seed-owned probe, executed by the checkout's matching Electron after rebuild.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const [repository, destination] = process.argv.slice(2);
const repo = fs.realpathSync(repository);
const output = fs.realpathSync(destination);
app.setPath('userData', path.join(output, 'electron-data'));
app.disableHardwareAcceleration();
let terminal;
let window;
let finished = false;
let stage = 'startup';
const timeout = setTimeout(
  () => finish({ status: 'failed', detail: 'Runtime probe timed out' }),
  60000,
);

function finish(result) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  try {
    terminal?.kill();
  } catch {
    /* The PTY may already have exited. */
  }
  try {
    window?.destroy();
  } catch {
    /* The renderer may already have exited. */
  }
  const record = {
    schema: 1,
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    node: process.versions.node,
    stage,
    ...result,
  };
  fs.writeFileSync(
    path.join(output, 'runtime.json.tmp'),
    JSON.stringify(record, null, 2),
  );
  fs.renameSync(
    path.join(output, 'runtime.json.tmp'),
    path.join(output, 'runtime.json'),
  );
  app.exit(result.status === 'passed' ? 0 : 1);
}

app
  .whenReady()
  .then(async () => {
    if (process.platform !== 'linux' || process.arch !== 'arm64')
      throw Error('Runtime probe requires Linux ARM64');
    stage = 'native-module';
    const addon = fs.realpathSync(
      path.join(repo, 'node_modules/node-pty/build/Release/pty.node'),
    );
    if (!addon.startsWith(repo + path.sep))
      throw Error('Native module escapes the checkout');
    const pty = require(path.join(repo, 'node_modules/node-pty'));
    stage = 'pty';
    const ptyResult = await new Promise((resolve, reject) => {
      let text = '';
      terminal = pty.spawn('/bin/sh', ['-c', 'printf canopy-pty-runtime-ok'], {
        cols: 80,
        rows: 24,
        cwd: output,
        env: process.env,
      });
      terminal.onData((data) => {
        text = (text + data).slice(-4096);
      });
      terminal.onExit(({ exitCode }) => {
        terminal = undefined;
        if (exitCode === 0 && text.includes('canopy-pty-runtime-ok'))
          resolve({ exitCode, marker: true });
        else reject(Error('Rebuilt PTY command failed'));
      });
    });
    if (!require.cache[addon])
      throw Error('Rebuilt native addon was not loaded');
    stage = 'renderer';
    window = new BrowserWindow({
      show: false,
      width: 640,
      height: 480,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    window.webContents.on('render-process-gone', (_event, details) =>
      finish({
        status: 'failed',
        detail: `Renderer exited: ${details.reason}`,
      }),
    );
    await window.loadURL(
      'data:text/html,<title>VM runtime probe</title><h1>Linux Electron renderer ready</h1>',
    );
    const title = await window.webContents.executeJavaScript('document.title');
    if (title !== 'VM runtime probe' || window.isVisible())
      throw Error('Hidden renderer probe failed');
    stage = 'screenshot';
    const screenshot = await window.webContents.capturePage();
    if (screenshot.isEmpty()) throw Error('Renderer screenshot is empty');
    fs.writeFileSync(path.join(output, 'runtime.png'), screenshot.toPNG());
    stage = 'complete';
    finish({
      status: 'passed',
      pty: ptyResult,
      addons: [addon],
      hiddenRenderer: true,
    });
  })
  .catch((error) => finish({ status: 'failed', detail: error.message }));
