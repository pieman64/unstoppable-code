/**
 * Remove opaque citation annotations emitted by provider-hosted tools.
 *
 * Markers such as `citeturn0forecast0` refer to source metadata that is not
 * included in the Codex app-server transcript. Rendering them as text exposes
 * the private-use delimiters as missing-glyph boxes. Keep the persisted
 * transcript provider-accurate and sanitize only the display string.
 *
 * The closing delimiter is optional so a marker stays hidden while the
 * assistant response is still streaming.
 */
export function stripOpaqueAgentCitationMarkers(text: string): string {
  return text.replace(/\uE200[^\uE201]*(?:\uE201|$)/gu, '');
}
