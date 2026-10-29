/**
 * Hands an organization project to the desktop app through its deep link,
 * as the Portal's catalog does. The browser asks before leaving for the app.
 */
export function openDesktopDeepLink(url: string): void {
  window.location.assign(url);
}
