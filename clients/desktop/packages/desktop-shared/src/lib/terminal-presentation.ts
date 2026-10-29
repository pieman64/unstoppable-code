/** Internal submission identity; stripped when importing terminal user text. */
const TERMINAL_TURN_MARKER = /^<!-- canopy-terminal-turn:([^\s<>]+) -->\r?\n/;

export function terminalPresentationPrompt(
  text: string,
  turnId: string,
): string {
  return `<!-- canopy-terminal-turn:${encodeURIComponent(turnId)} -->\n${text}`;
}

export function terminalPresentationTurnId(
  text: string | undefined,
): string | undefined {
  const encoded = text?.match(TERMINAL_TURN_MARKER)?.[1];
  if (!encoded) return undefined;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
}

export function stripTerminalPresentationMarker(text: string): string {
  return text.replace(TERMINAL_TURN_MARKER, '');
}
