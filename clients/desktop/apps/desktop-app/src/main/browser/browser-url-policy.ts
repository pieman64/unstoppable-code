import type { ScriptDevServerOpenTarget } from '@canopy/desktop-shared/scripts';
import {
  isAllowedInAppBrowserUrl,
  isSafeExternalBrowserUrl,
  normalizeBrowserUrlInput,
} from '@canopy/desktop-shared/lib/browser-url-policy';

export function normalizeSafeExternalBrowserUrl(rawUrl: string): string | null {
  const normalized = normalizeBrowserUrlInput(rawUrl);
  if (!isSafeExternalBrowserUrl(normalized)) {
    return null;
  }
  try {
    return new URL(normalized).href;
  } catch {
    return null;
  }
}

export {
  classifyInAppBrowserInput,
  isAllowedInAppBrowserUrl,
  isFileBrowserUrl,
  isSafeExternalBrowserUrl,
  normalizeBrowserUrlInput,
  sameBrowserUrl,
  type InAppBrowserInputVerdict,
} from '@canopy/desktop-shared/lib/browser-url-policy';

export function shouldOpenDevServerHitInApp(args: {
  url: string;
  openTarget: ScriptDevServerOpenTarget;
  localServersOnly: boolean;
}): boolean {
  if (args.openTarget === 'external') {
    return false;
  }
  return isAllowedInAppBrowserUrl(args.url, args.localServersOnly);
}

export type AppLinkTarget =
  | 'in-app'
  | 'external'
  | 'external-blocked-by-local-only'
  | 'settings';

/**
 * Resolves ordinary app-content links. Callers keep authentication and
 * explicit external-browser actions on their separate fail-closed path.
 */
export function resolveAppLinkTarget(args: {
  url: string;
  openAppLinksInBuiltInBrowser: boolean;
  localServersOnly: boolean;
  hasWorktreeContext: boolean;
}): AppLinkTarget {
  let parsed: URL;
  try {
    parsed = new URL(args.url);
  } catch {
    return 'external';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'external';
  }
  if (!args.openAppLinksInBuiltInBrowser || !args.hasWorktreeContext) {
    return 'external';
  }
  if (args.localServersOnly && !isAllowedInAppBrowserUrl(args.url, true)) {
    return 'external-blocked-by-local-only';
  }
  return 'in-app';
}
