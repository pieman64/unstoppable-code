'use client';

import type { RefObject } from 'react';
import {
  DOM_TEXT_FIND_DEBOUNCE_MS,
  DOM_TEXT_FIND_MIN_LENGTH,
  useDomTextFind,
  type DomTextFind,
  type DomTextFindSurfaceProps,
} from './useDomTextFind';

/** Keystrokes settle for this long before the transcript is scanned. */
export const CHAT_FIND_DEBOUNCE_MS = DOM_TEXT_FIND_DEBOUNCE_MS;
/** Like the file and browser searches, one character is not a search yet. */
export const CHAT_FIND_MIN_LENGTH = DOM_TEXT_FIND_MIN_LENGTH;
/** The shared transcript's scroll container inside the chat panel. */
export const CHAT_TRANSCRIPT_FIND_SELECTOR = '[data-testid="chat-transcript"]';

export interface ChatTranscriptFindOptions {
  /**
   * Register while true and the surface is shown (its panel tab and page
   * host visible); it unregisters, closing the bar, otherwise.
   */
  enabled: boolean;
  /** The chat id; the bar's scope key for this chat. */
  scopeKey: string;
  /** Scope-menu label beside other chats. */
  title: string;
  /** The chat panel root: the surface the bar anchors to and marks. */
  rootRef: RefObject<HTMLElement | null>;
}

export type ChatTranscriptFindSurfaceProps = DomTextFindSurfaceProps<'chat'>;

export type ChatTranscriptFind = DomTextFind<'chat'>;

/**
 * Find-bar chat mode for a host that renders the shared `ChatTranscript`
 * (CAN-3048): a DOM search over the rendered rows, with the CSS Custom
 * Highlight API for the match marks. Only rendered rows take part, so a
 * transcript long enough to virtualize (over 50 turn groups) reports the rows
 * on and near the screen. The desktop renderer searches its canonical
 * transcript instead and does not use this hook.
 */
export function useChatTranscriptFind(
  options: ChatTranscriptFindOptions,
): ChatTranscriptFind {
  return useDomTextFind({
    ...options,
    mode: 'chat',
    contentSelector: CHAT_TRANSCRIPT_FIND_SELECTOR,
    visibleOnly: true,
  });
}
