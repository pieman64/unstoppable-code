// Runs in the matching Electron runtime, with the packaged native module.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const [repo, output] = process.argv.slice(2);
app.setPath('userData', path.join(output, 'electron-probe-data'));
let terminal;
const timeout = setTimeout(() => {
  try {
    terminal?.kill();
  } catch {
    /* The owned PTY may already have exited. */
  }
  fs.writeFileSync(
    path.join(output, 'runtime.json'),
    JSON.stringify({ status: 'failed', detail: 'Runtime probe timed out' }),
  );
  app.exit(1);
}, 60000);
app
  .whenReady()
  .then(async () => {
    const pty = require(
      path.join(
        repo,
        'dist/win-unpacked/resources/app.asar/node_modules/node-pty',
      ),
    );
    const ptyResult = await new Promise((resolve, reject) => {
      let text = '';
      terminal = pty.spawn(
        'C:\\Windows\\System32\\cmd.exe',
        ['/d', '/c', 'echo canopy-pty-runtime-ok'],
        { cols: 80, rows: 24, cwd: output, env: process.env },
      );
      terminal.onData((data) => {
        text += data;
      });
      terminal.onExit(({ exitCode }) =>
        exitCode === 0 && text.includes('canopy-pty-runtime-ok')
          ? resolve({ exitCode, marker: true })
          : reject(Error('Packaged PTY command failed')),
      );
    });
    const window = new BrowserWindow({
      show: false,
      width: 640,
      height: 480,
      webPreferences: { sandbox: true },
    });
    await window.loadURL(
      'data:text/html,<title>VM runtime probe</title><h1>Windows Electron renderer ready</h1>',
    );
    const title = await window.webContents.executeJavaScript('document.title');
    if (title !== 'VM runtime probe' || window.isVisible())
      throw Error('Hidden renderer probe failed');
    const screenshot = await window.webContents.capturePage();
    fs.writeFileSync(path.join(output, 'runtime.png'), screenshot.toPNG());
    const addons = Object.keys(require.cache).filter((file) =>
      file.endsWith('.node'),
    );
    if (!addons.length) throw Error('No packaged native addon was loaded');
    fs.writeFileSync(
      path.join(output, 'runtime.json'),
      JSON.stringify(
        {
          status: 'passed',
          electron: process.versions.electron,
          node: process.versions.node,
          arch: process.arch,
          pty: ptyResult,
          addons,
          hiddenRenderer: true,
        },
        null,
        2,
      ),
    );
    window.destroy();
    clearTimeout(timeout);
    app.quit();
  })
  .catch((error) => {
    try {
      terminal?.kill();
    } catch {
      /* The owned PTY may already have exited. */
    }
    fs.writeFileSync(
      path.join(output, 'runtime.json'),
      JSON.stringify({ status: 'failed', detail: error.message }, null, 2),
    );
    clearTimeout(timeout);
    app.exit(1);
  });
