import { useCallback, useSyncExternalStore } from 'react';
import {
  isGitHubStarPromptAvailable,
  type GitHubStarPromptStore,
} from '@canopy/app-state';
import { readRemoteControlContext } from '@/stores/remoteControlStore';
import { useGitHubCliStatus } from './useGitHubCliStatus';

const NO_STORE_SUBSCRIPTION = (): (() => void) => () => undefined;

/**
 * The GitHub CLI login the star prompt stars as, or null. Checks the CLI
 * only once the prompt is available, so a composer mount never spawns `gh`
 * before the fifth prompt. A remote-control window gets null: its CLI status
 * is the controlled computer's, while the star runs on this one. Its store is
 * already null there, so this is defense in depth against naming the wrong
 * account.
 */
export function useGitHubStarPromptLogin(
  store: GitHubStarPromptStore | null,
): string | null {
  const local = readRemoteControlContext().mode === 'local';
  const subscribe = useCallback(
    (listener: () => void): (() => void) =>
      store === null ? (): void => undefined : store.subscribe(listener),
    [store],
  );
  const available = useSyncExternalStore(
    store === null ? NO_STORE_SUBSCRIPTION : subscribe,
    () => store !== null && isGitHubStarPromptAvailable(store.getState()),
    () => false,
  );
  const status = useGitHubCliStatus(0, local && available);
  return local && status?.authenticated ? status.username : null;
}
