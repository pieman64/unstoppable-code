// Hidden, disposable Electron shell for the Browser Lab interaction smoke.
import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';

const root = process.env.BROWSER_LAB_INTERACTION_ROOT;
if (!root) throw new Error('Missing Browser Lab interaction fixture root');

app.setPath('userData', join(root, 'user-data'));
app.setPath('sessionData', join(root, 'session-data'));
app.on('window-all-closed', () => app.quit());

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 1100,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  window.webContents.session.setPermissionCheckHandler(() => false);
  await window.loadURL('about:blank');
});
