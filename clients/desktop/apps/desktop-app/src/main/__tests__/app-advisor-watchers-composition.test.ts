import type { AppAdvisorWindowState } from '@canopy/desktop-shared/types';
import { resetResolvedCanopyDataDirForTests } from '@canopy/desktop-shared/canopy-paths';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WindowAccessors } from '../ipc';

function windowState(): AppAdvisorWindowState {
  return { open: false, focused: false };
}

function accessors(): WindowAccessors {
  return {
    getMainWindow: () => null,
    getAppAdvisorWindow: () => null,
    openAppAdvisorWindow: () => Promise.resolve(windowState()),
    ensureAppAdvisorWindow: () => Promise.resolve(windowState()),
    closeAppAdvisorWindow: () => Promise.resolve(windowState()),
    toggleAppAdvisorWindow: () => Promise.resolve(windowState()),
    getAppAdvisorWindowState: windowState,
    markAppAdvisorWindowRendererReady: windowState,
    setAppAdvisorFloatingSize: windowState,
    sendAppAdvisorWindowCommand: () => undefined,
    sendChatWindowCommand: () => true,
    notifyStartupUnlocked: () => undefined,
  };
}

describe('App Advisor watcher host composition', () => {
  it('installs the lazy managed reader at IPC registration and defers recovery until renderer unlock', async () => {
    const previousDataDir = process.env.CANOPY_DATA_DIR;
    const testRoot = await mkdtemp(join(tmpdir(), 'app-advisor-watchers-'));
    process.env.CANOPY_DATA_DIR = join(testRoot, 'data');
    resetResolvedCanopyDataDirForTests();
    let cleanupModules = (): Promise<void> => Promise.resolve();
    try {
      const chatStateModule = await import('../services/chat-state-service');
      const getChatStateService = jest.spyOn(
        chatStateModule,
        'getChatStateService',
      );
      const { ChatStateV2Backend } =
        await import('../services/chat-state-v2-backend');
      const repositoryLoad = jest.spyOn(ChatStateV2Backend.prototype, 'load');

      // Main obtains this service while constructing IPC registration
      // accessors. Use that real getter as the baseline, rather than claiming
      // composition never constructs ChatStateService.
      const chatState = chatStateModule.getChatStateService();
      const baselineGetterCalls = getChatStateService.mock.calls.length;
      const baselineRepositoryLoads = repositoryLoad.mock.calls.length;
      expect(baselineGetterCalls).toBe(1);
      cleanupModules = async (): Promise<void> => {
        await chatState.drain();
        chatStateModule.resetChatStateServiceForTests();
        jest.restoreAllMocks();
      };

      const { getAppAdvisorWatcherService } =
        await import('../app-advisor/watchers');
      const service = getAppAdvisorWatcherService();
      const configure = jest.spyOn(service, 'configure');
      const reconcileAtStartup = jest.spyOn(service, 'reconcileAtStartup');
      cleanupModules = async (): Promise<void> => {
        service.shutdown();
        await service.drain();
        await chatState.drain();
        chatStateModule.resetChatStateServiceForTests();
        jest.restoreAllMocks();
      };
      const { registerAppAdvisorWatcherHandlers } =
        await import('../ipc/app-advisor-watchers');

      registerAppAdvisorWatcherHandlers(accessors());

      expect(configure).toHaveBeenCalledTimes(1);
      const firstConfigure = configure.mock.calls[0];
      if (!firstConfigure) {
        throw new Error(
          'The IPC registration did not configure App Advisor watchers.',
        );
      }

      expect(firstConfigure[1]?.deferStartupRecovery).toBe(true);

      // Registration runs before index.ts's renderer-unlock callback. The
      // service is already constructed by the host; composition must not add
      // a getter or repository load or start reconciliation before unlock.
      expect(reconcileAtStartup).not.toHaveBeenCalled();
      expect(getChatStateService).toHaveBeenCalledTimes(baselineGetterCalls);
      expect(repositoryLoad).toHaveBeenCalledTimes(baselineRepositoryLoads);

      // Exercise the watcher-side action issued by index.ts's startup-unlocked
      // callback; the integration of that full main callback is covered by the
      // root's cold-start proof.
      await service.reconcileAtStartup();
      expect(reconcileAtStartup).toHaveBeenCalledTimes(1);
    } finally {
      await cleanupModules();
      if (previousDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
      else process.env.CANOPY_DATA_DIR = previousDataDir;
      resetResolvedCanopyDataDirForTests();
      await rm(testRoot, { recursive: true, force: true });
    }
  });
});
