import type { BrowserWindow } from 'electron';
import type { ChatInterestDeclaration } from '@canopy/desktop-shared/types';

type ChatInterestLookup = (
  contents: BrowserWindow['webContents'],
) => ChatInterestDeclaration | undefined;

let installedLookup: ChatInterestLookup | null = null;

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
