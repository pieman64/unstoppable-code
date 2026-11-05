import {
  createGitHubStarPromptStore,
  type GitHubStarPromptStore,
} from '@canopy/app-state';
import { normalizeGitHubStarPromptRecord } from '@canopy/protocol/onboarding';
import { getBrandSourceRepository } from './brand';
import { isExternalBrowserOpenAvailable } from './remote-control/in-app-browser-availability';
import { reportRendererConsoleError } from './renderer-error-logging';

let store: GitHubStarPromptStore | null = null;

/**
 * One renderer scope, sharing the main-owned preference authority across
 * windows. Null on a brand without a source repository, and in a window that
 * cannot open the system browser (one showing another computer, whose
 * preferences would also take the counts): nothing counts or shows, and no
 * store is created.
 */
export function getGitHubStarPromptStore(): GitHubStarPromptStore | null {
  if (store !== null) return store;
  if (getBrandSourceRepository() === null) return null;
  if (!isExternalBrowserOpenAvailable()) return null;
  let initialized = false;
  const scope = createGitHubStarPromptStore({
    load: async () => {
      const prefs = await window.api.loadPreferences();
      if (prefs.__error)
        throw new Error('Unable to read GitHub star prompt preferences.');
      const record = normalizeGitHubStarPromptRecord(prefs.githubStarPrompt);
      if (!record)
        throw new Error('GitHub star prompt preferences are unavailable.');
      // Main defaults the record on read. Saving through its merge queue
      // commits initialization without replacing prefs.
      return { record, persisted: initialized };
    },
    save: async (record) => {
      const prefs = await window.api.savePreferences({
        githubStarPrompt: record,
      });
      const stored = normalizeGitHubStarPromptRecord(prefs.githubStarPrompt);
      if (!stored)
        throw new Error('GitHub star prompt preferences were not saved.');
      initialized = true;
      return stored;
    },
    onError: (_error, operation) =>
      reportRendererConsoleError('GitHub star prompt persistence failed', {
        operation,
      }),
  });
  store = scope;
  window.api.onPreferencesSynced?.((prefs) => {
    const record = normalizeGitHubStarPromptRecord(prefs.githubStarPrompt);
    if (record) {
      initialized = true;
      scope.getState().reconcile(record);
      void scope.getState().hydrate();
    }
  });
  window.addEventListener('focus', () => {
    void scope.getState().hydrate();
  });
  void scope.getState().hydrate();
  return scope;
}
