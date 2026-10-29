/** Installer/status boundary fixture: never opens a real macOS installer. */
export async function seedMacGitStatus(electronApp, { ready = false } = {}) {
  await electronApp.evaluate(({ ipcMain }, initialReady) => {
    const fixture = { ready: initialReady, installs: 0, probes: 0 };
    globalThis.__macGitFixture = fixture;
    const status = () => ({
      platform: 'darwin',
      required: true,
      ready: fixture.ready,
      path: fixture.ready
        ? '/Library/Developer/CommandLineTools/usr/bin/git'
        : null,
      version: fixture.ready ? 'git version 2.50.1 (Apple Git-155)' : null,
      source: fixture.ready ? 'cache' : 'not-found',
      wingetAvailable: false,
      checkedAt: new Date().toISOString(),
    });
    for (const channel of [
      'git-executable:status',
      'git-executable:redetect',
    ]) {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, () => {
        fixture.probes++;
        return status();
      });
    }
    ipcMain.removeHandler('git-executable:install-xcode');
    ipcMain.handle('git-executable:install-xcode', () => {
      fixture.installs++;
    });
  }, ready);
}
