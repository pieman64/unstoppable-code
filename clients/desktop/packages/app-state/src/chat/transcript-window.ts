/**
 * The transcript window a history page belongs to. Hosts choose both values:
 * `chatId` names the chat (and, when the host can replace a chat in place,
 * that instance of it), and `generation` changes whenever the window is
 * discarded, for example on a transcript reset or epoch change. Row ordinals
 * and cursors from different windows can name different rows, so a page is
 * only valid for the window it was requested for.
 */
export interface TranscriptWindowIdentity {
  readonly chatId: string;
  readonly generation: number;
}

/**
 * Whether a history page requested for `requested` may still be applied.
 * `current` is the host's window now, or `undefined` when it has none.
 * Cursors, transports and merging stay per host; only this decision is shared.
 */
export function isTranscriptPageForCurrentWindow(
  requested: TranscriptWindowIdentity,
  current: TranscriptWindowIdentity | undefined,
): boolean {
  return (
    current !== undefined &&
    current.chatId === requested.chatId &&
    current.generation === requested.generation
  );
}
