import type { BrowserWindow } from 'electron';
import type {
  ChatInterestDeclaration,
  ChatInterestRunRef,
} from '@canopy/desktop-shared/types';
import { logMainProcessError } from '../lib/main-process-logging';

type ChatInterestLookup = (
  contents: BrowserWindow['webContents'],
) => ChatInterestDeclaration | undefined;

let installedLookup: ChatInterestLookup | null = null;
type RunsEnteringInterestListener = (
  runs: readonly ChatInterestRunRef[],
) => void;

let installedRunsEnteringInterestListener: RunsEnteringInterestListener | null =
  null;

/**
 * The chat interest a window's renderer declared on `chat:set-interest`, or
 * `undefined` when it declared none (it then receives everything). Main-side
 * readers such as remote access push accounting use this; it is `undefined`
 * before the chat state handlers are registered.
 */
export function recordedChatInterest(
  contents: BrowserWindow['webContents'],
): ChatInterestDeclaration | undefined {
  return installedLookup?.(contents);
}

/** Installed by the chat state handlers; returns the uninstall. */
export function installChatInterestLookup(
  lookup: ChatInterestLookup,
): () => void {
  installedLookup = lookup;
  return (): void => {
    if (installedLookup === lookup) installedLookup = null;
  };
}

/** Installed by the entering-run consumer; returns the uninstall. */
export function installRunsEnteringInterestListener(
  listener: RunsEnteringInterestListener,
): () => void {
  installedRunsEnteringInterestListener = listener;
  return (): void => {
    if (installedRunsEnteringInterestListener === listener) {
      installedRunsEnteringInterestListener = null;
    }
  };
}

/** Notify the installed consumer without letting it break chat interest IPC. */
export function notifyRunsEnteringInterest(
  runs: readonly ChatInterestRunRef[],
): void {
  const listener = installedRunsEnteringInterestListener;
  if (!listener) return;
  try {
    listener(runs);
  } catch (error) {
    logMainProcessError('Chat interest listener failed', error);
  }
}
