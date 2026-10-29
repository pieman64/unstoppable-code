import type { ChatPluginOverlayOptions } from './global-plugin-overlay';

/**
 * The same overlay request, additionally asking for the chat's tombstones
 * (`includeChatTombstones`), for a harness that layers its own inherited
 * plugins on top of the selection and must honor what the chat turned off
 * even when no default layer applies. A draft has no chat state to read, and
 * an overlay that is off stays off.
 */
export function requestChatTombstones(
  overlay: ChatPluginOverlayOptions,
): ChatPluginOverlayOptions {
  if (overlay === true) return { includeChatTombstones: true };
  if (typeof overlay === 'object' && overlay.draft !== true)
    return { ...overlay, includeChatTombstones: true };
  return overlay;
}
