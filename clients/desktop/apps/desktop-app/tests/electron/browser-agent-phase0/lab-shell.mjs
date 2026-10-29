// Hidden, disposable Electron shell for the Phase A fixture smoke.
import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';

if (!process.env.BROWSER_LAB_SMOKE_ROOT)
  throw new Error('Missing fixture root');
app.setPath('userData', join(process.env.BROWSER_LAB_SMOKE_ROOT, 'electron'));
app.on('window-all-closed', () => app.quit());
app.whenReady().then(() => {
  const window = new BrowserWindow({
    show: false,
    width: 1100,
    height: 800,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.session.setPermissionRequestHandler(
    (_wc, _permission, cb) => cb(false),
  );
  window.webContents.session.setPermissionCheckHandler(() => false);
  void window.loadURL('about:blank');
});
