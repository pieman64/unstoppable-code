/**
 * Which computer drives each chat: the one whose window sent its latest user
 * message. A chat driven from a controlling computer runs its renderer tools
 * (App Advisor, ShowFiles, DispatchAction UI actions) in that computer's
 * windows, where the user is looking, instead of in this computer's own.
 */

const MAX_TRACKED_CHATS = 1_000;

/** `null` means this computer's own windows. */
const drivers = new Map<string, string | null>();

export function noteChatDriver(
  chatId: string,
  controllerDeviceId: string | null,
): void {
  drivers.delete(chatId);
  drivers.set(chatId, controllerDeviceId);
  if (drivers.size > MAX_TRACKED_CHATS) {
    const oldest = drivers.keys().next();
    if (!oldest.done) drivers.delete(oldest.value);
  }
}

/** The controlling computer that drives `chatId`, or null for this one. */
export function chatDriver(chatId: string): string | null {
  return drivers.get(chatId) ?? null;
}

export function resetChatDriversForTests(): void {
  drivers.clear();
}

/**
 * Replies a terminal emulator sends by itself to a program's queries:
 * cursor position, device attributes and status (CSI ... R / c / n), mode
 * reports (CSI ... $ y), window reports (CSI ... t), focus reports
 * (CSI I / O), and OSC and DCS replies. A viewer that only watches a chat's
 * terminal sends these without anyone typing.
 */
const TERMINAL_REPLIES =
  // eslint-disable-next-line no-control-regex
  /^(?:\x1b\[[\d;?>]*(?:[Rcnt]|\$y)|\x1b\[[IO]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\)+$/;

/** Whether a terminal write is only the emulator answering, not input. */
export function isTerminalReplyOnly(data: string): boolean {
  return TERMINAL_REPLIES.test(data);
}
