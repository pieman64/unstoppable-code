import { createContext, useContext, type RefObject } from 'react';
import type {
  AccountOrganizationSettingsApi,
  CanopyApi,
  CanopyCloudAccountPublicState,
} from '@canopy/desktop-shared/types';
import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  hostedSettingsPathname,
  resolveHostedSettingsHref,
} from './hosted-settings-location';
import type { PersistedSettingsNavModel } from './hosted-settings-model';

/**
 * State the desktop settings host shares with the Settings overlay's hosted
 * rail and content: the signed-in account, the configured web origin, the
 * content scroller and the preload bridge. `DesktopHostedSettingsProvider`
 * supplies it.
 */

/** The signed-in cloud account, as hosted settings sees it. */
export type HostedSettingsAccount =
  | { readonly status: 'loading' }
  | { readonly status: 'signed_out' }
  | { readonly status: 'signed_in'; readonly accountId: string };

const LOADING_ACCOUNT: HostedSettingsAccount = { status: 'loading' };
const SIGNED_OUT_ACCOUNT: HostedSettingsAccount = { status: 'signed_out' };

/** Mirrors the settings client's own account rule: a guest is signed out. */
export function hostedSettingsAccountFrom(
  account: CanopyCloudAccountPublicState | null,
): HostedSettingsAccount {
  if (account === null) return LOADING_ACCOUNT;
  if (!account.hasApiKey || isGuestAccount(account)) return SIGNED_OUT_ACCOUNT;
  const accountId = account.account?.id;
  return accountId ? { status: 'signed_in', accountId } : SIGNED_OUT_ACCOUNT;
}

export interface DesktopSettingsHostContextValue {
  readonly account: HostedSettingsAccount;
  /** The configured web origin, `''` until main has answered. */
  readonly webOrigin: string;
  readonly scrollElementRef: RefObject<HTMLElement | null>;
  readonly settingsApi: AccountOrganizationSettingsApi | null;
  /**
   * The signed-in account's persisted rail entry, read when the Settings
   * session starts, or `null`. Drawn only until a bootstrap is known.
   */
  readonly persistedNavModel: PersistedSettingsNavModel | null;
}

export const DesktopSettingsHostContext =
  createContext<DesktopSettingsHostContextValue | null>(null);

export function useDesktopSettingsHostContext(): DesktopSettingsHostContextValue {
  const value = useContext(DesktopSettingsHostContext);
  if (value === null)
    throw new Error(
      'Desktop settings host hooks must render inside <DesktopHostedSettingsProvider>.',
    );
  return value;
}

/** The signed-in account hosted settings is scoped to. */
export function useHostedSettingsAccount(): HostedSettingsAccount {
  return useDesktopSettingsHostContext().account;
}

/** The signed-in account's persisted rail entry, or `null`. */
export function useHostedSettingsPersistedNavModel(): PersistedSettingsNavModel | null {
  return useDesktopSettingsHostContext().persistedNavModel;
}

/** The configured web origin (`''` until known). */
export function useHostedSettingsWebOrigin(): string {
  return useDesktopSettingsHostContext().webOrigin;
}

/** Open a URL through main's guarded external-open path. */
export function openHostedSettingsExternalUrl(url: string): void {
  const api: Partial<CanopyApi> | undefined = window.api;
  const browser = api?.browser;
  if (browser === undefined) return;
  void browser.openExternal({ url }).catch(() => {
    // Failing to open the browser is not surfaced, as elsewhere on desktop.
  });
}

/**
 * Follow an `href` from shared settings UI: settings pages navigate inside
 * the overlay; anything else opens on the web.
 */
export function followHostedSettingsHref(
  href: string,
  webOrigin: string,
  options: { readonly replace?: boolean } = {},
): void {
  const navigation = useNavigationStore.getState();
  const current = navigation.settingsHostedLocation;
  const currentPath =
    current === null ? '/' : hostedSettingsPathname(current.route);
  const target = resolveHostedSettingsHref(href, webOrigin, currentPath);
  switch (target.kind) {
    case 'settings': {
      const { route, search, hash } = target.location;
      // A fragment-only link keeps the page's own query.
      const keepSearch = href.startsWith('#') && current !== null;
      navigation.openAccountOrganizationSettings(route, {
        search: keepSearch ? current.search : search,
        hash,
        ...(options.replace === true ? { replace: true } : {}),
      });
      return;
    }
    case 'external':
      openHostedSettingsExternalUrl(target.url);
      return;
    case 'none':
      return;
  }
}
