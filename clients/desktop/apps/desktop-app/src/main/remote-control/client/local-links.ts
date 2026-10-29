import { IPC_CHANNELS } from '@canopy/desktop-shared/types';

const LOCAL_LINK_CHANNELS = new Set<string>([
  IPC_CHANNELS.browserOpenLink,
  IPC_CHANNELS.browserOpenExternal,
]);

/**
 * The in-app browser runs on the controlled computer's screen, so a link a
 * remote window asks to open goes to this computer's default browser instead.
 * Returns the http(s) URL to open, or null when the call is not a link open.
 */
export function linkUrlForLocalOpen(
  channel: string,
  args: ReadonlyArray<unknown>,
): string | null {
  if (!LOCAL_LINK_CHANNELS.has(channel)) return null;
  const request = args[0];
  if (
    typeof request !== 'object' ||
    request === null ||
    !('url' in request) ||
    typeof request.url !== 'string'
  ) {
    return null;
  }
  try {
    const protocol = new URL(request.url).protocol;
    return protocol === 'http:' || protocol === 'https:' ? request.url : null;
  } catch {
    return null;
  }
}
