/**
 * `window.__canopyUsageLimitResumeTestApi` — the UI-automation hook for the
 * account-change usage-limit resume modal (`UsageLimitResumeModal`). Gated
 * HARD on the build-time `__CANOPY_E2E__` constant, same posture as
 * `window.__canopyPanelTestApi` (`lib/panels/test-api.ts`) and
 * `window.__CANOPY_E2E_WORKER_ACTIONS__` (`stores/workersStore.ts`):
 * production builds inline `__CANOPY_E2E__` to `false` and dead-code-eliminate
 * the installer body, so the API can never exist outside an E2E build.
 *
 * The modal is normally opened by the account-change detector in
 * `AuthLoginModal`, which requires a real provider CLI login the Electron
 * Playwright harness cannot perform. `open()` calls the exact same store
 * method (`useUsageLimitResumePromptStore.getState().open`) that trigger
 * calls, so the list/resume IPC path is exercised end-to-end in a spec —
 * only the account-change detection itself is bypassed.
 */
import { useUsageLimitResumePromptStore } from '@/stores/usageLimitResumePromptStore';

interface CanopyUsageLimitResumeTestApi {
  open(provider: 'claude' | 'codex'): void;
}

declare global {
  interface Window {
    __canopyUsageLimitResumeTestApi?: CanopyUsageLimitResumeTestApi;
  }
}

/**
 * Installs the test API. Returns an uninstaller (for the hosting effect's
 * cleanup), or `undefined` outside E2E builds where nothing was installed.
 */
export function installUsageLimitResumeTestApi(): (() => void) | undefined {
  if (!__CANOPY_E2E__) {
    return undefined;
  }

  const api: CanopyUsageLimitResumeTestApi = {
    open: (provider): void => {
      useUsageLimitResumePromptStore.getState().open(provider);
    },
  };

  window.__canopyUsageLimitResumeTestApi = api;
  return (): void => {
    if (window.__canopyUsageLimitResumeTestApi === api) {
      delete window.__canopyUsageLimitResumeTestApi;
    }
  };
}
