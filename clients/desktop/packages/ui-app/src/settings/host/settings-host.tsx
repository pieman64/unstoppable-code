'use client';

import {
  createContext,
  useContext,
  type AnchorHTMLAttributes,
  type ComponentType,
  type CSSProperties,
  type ImgHTMLAttributes,
  type JSX,
  type ReactNode,
  type Ref,
} from 'react';
import type {
  AccountOrganizationSettingsClient,
  SettingsNavigationPort,
  SettingsReplayPrivacy,
  SettingsSelectionStorage,
} from '@canopy/app-core/settings';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';

/**
 * Host ports for the hosted account and organization settings UI.
 *
 * Shared settings components never import a framework router, a host's
 * transport, its stores or its brand provider. Each host supplies one
 * {@link SettingsUiHost} through {@link SettingsHostProvider}: web over Next
 * (`next/link`, `next/image`, `next/navigation`, its brand context and the
 * browser settings client), desktop over its navigation store, preload bridge
 * and IPC settings client.
 *
 * Route-dependent ports are hooks (`useRouter`, `usePathname`, ...). A host
 * object is created once and never swaps its hook implementations, so calling
 * them from shared hooks keeps React's hook order stable. Shared components
 * call the exported wrappers below, never `host.useX()` directly.
 *
 * Shared code must not branch on which host it runs in. Capability
 * differences are explicit fields (`inlineCheckout`, payment handoff).
 */

/** The anchor props shared links accept, mirroring `next/link`'s subset in use. */
export interface SettingsLinkProps extends Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  'href'
> {
  /** A same-origin web path (`/organization/<id>/members`) or absolute URL. */
  readonly href: string;
  readonly prefetch?: boolean | null;
  readonly replace?: boolean;
  readonly scroll?: boolean;
  readonly ref?: Ref<HTMLAnchorElement>;
  readonly children?: ReactNode;
}

export type SettingsLinkComponent = ComponentType<SettingsLinkProps>;

/** The image props shared components use, mirroring `next/image`'s subset. */
export interface SettingsImageProps {
  readonly src: string;
  readonly alt: string;
  readonly width?: number;
  readonly height?: number;
  readonly fill?: boolean;
  readonly sizes?: string;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly unoptimized?: boolean;
  readonly priority?: boolean;
  readonly referrerPolicy?: ImgHTMLAttributes<HTMLImageElement>['referrerPolicy'];
  readonly onError?: () => void;
  readonly 'data-testid'?: string;
}

export type SettingsImageComponent = ComponentType<SettingsImageProps>;

/** Router operations over web paths, mirroring `next/navigation`'s router. */
export interface SettingsRouter {
  push(href: string, options?: { scroll?: boolean }): void;
  /** Replace the current entry, for page-owned query state and subtabs. */
  replace(href: string, options?: { scroll?: boolean }): void;
  /** Re-read the current page's first-screen data. */
  refresh(): void;
  back(): void;
}

/** The read-only search-param surface shared components use. */
export interface SettingsSearchParams {
  get(name: string): string | null;
  getAll(name: string): string[];
  has(name: string): boolean;
  toString(): string;
  forEach(callback: (value: string, key: string) => void): void;
}

/** Brand values shared settings copy may name. */
export interface SettingsBrand {
  readonly id: string;
  readonly displayName: string;
  readonly internalName: string;
}

/**
 * The viewer's workspace context. Browsing settings never changes it; only
 * explicitly choosing an organization (opening, creating or joining it) does.
 */
export interface SettingsWorkspaceContext {
  /** The workspace-context feature is on for this viewer. */
  readonly enabled: boolean;
  /** Stable key for the signed-in account, or `null` when signed out. */
  readonly accountKey: string | null;
  readonly workspaceContext: WorkspaceContext;
  /**
   * Select the organization in the main sidebar as soon as the host's
   * membership list includes it, so a just-created or just-joined
   * organization is selected once its refresh lands. Best-effort: a host
   * drops a request it cannot satisfy and never reports it as a failure.
   */
  readonly selectOrganization: (organizationId: string) => void;
}

export interface SettingsLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface SettingsUiHost {
  /** Fixed-table hosted settings data access. */
  readonly client: AccountOrganizationSettingsClient;
  /**
   * The host can mount inline browser checkout (card fields, Stripe). When
   * `false`, payment CTAs hand off to the web through
   * `SettingsNavigationPort.openPaymentHandoff`.
   */
  readonly inlineCheckout: boolean;
  readonly Link: SettingsLinkComponent;
  readonly Image: SettingsImageComponent;
  /** Account-scoped persistence of the browsed organization. */
  readonly storage: SettingsSelectionStorage;
  /** Session-replay privacy class names (inert on web). */
  readonly privacy: SettingsReplayPrivacy;
  /**
   * Absolute origin of the web app, for links that leave the host (share
   * URLs, public profiles, auth callbacks). Never a desktop file origin.
   */
  webOrigin(): string;
  /** A scoped logger; hosts redact and route it. */
  logger(scope: string): SettingsLogger;
  useRouter(): SettingsRouter;
  /** The current web path equivalent (`/organization/<id>/settings`). */
  usePathname(): string;
  /** Current query parameters, including page-owned query state. */
  useSearchParams(): SettingsSearchParams;
  useNavigation(): SettingsNavigationPort;
  useBrand(): SettingsBrand;
  /** The element that scrolls the settings content, when the host has one. */
  useScrollElement(): HTMLElement | null;
  /** Effective top-up service fee percent. */
  useTopUpFeePercent(): number;
  useWorkspaceContext(): SettingsWorkspaceContext;
  /**
   * Whether an authenticated payment handoff can open right now. Hosts with
   * inline checkout return `false`. `null` while the host is still checking.
   */
  usePaymentHandoffAvailable(): boolean | null;
}

const SettingsHostContext = createContext<SettingsUiHost | null>(null);

export interface SettingsHostProviderProps {
  readonly host: SettingsUiHost;
  readonly children: ReactNode;
}

export function SettingsHostProvider({
  host,
  children,
}: SettingsHostProviderProps): JSX.Element {
  return (
    <SettingsHostContext.Provider value={host}>
      {children}
    </SettingsHostContext.Provider>
  );
}

/** The current settings host. Throws outside a {@link SettingsHostProvider}. */
export function useSettingsHost(): SettingsUiHost {
  const host = useContext(SettingsHostContext);
  if (host === null)
    throw new Error(
      'Shared settings UI must render inside a <SettingsHostProvider>.',
    );
  return host;
}

/** The current settings host, or `null` outside a provider. */
export function useOptionalSettingsHost(): SettingsUiHost | null {
  return useContext(SettingsHostContext);
}

export function useSettingsClient(): AccountOrganizationSettingsClient {
  return useSettingsHost().client;
}

export function useSettingsRouter(): SettingsRouter {
  return useSettingsHost().useRouter();
}

export function useSettingsPathname(): string {
  return useSettingsHost().usePathname();
}

export function useSettingsSearchParams(): SettingsSearchParams {
  return useSettingsHost().useSearchParams();
}

export function useSettingsNavigation(): SettingsNavigationPort {
  return useSettingsHost().useNavigation();
}

export function useSettingsBrand(): SettingsBrand {
  return useSettingsHost().useBrand();
}

export function useSettingsScrollElement(): HTMLElement | null {
  return useSettingsHost().useScrollElement();
}

export function useSettingsTopUpFeePercent(): number {
  return useSettingsHost().useTopUpFeePercent();
}

export function useSettingsWorkspaceContext(): SettingsWorkspaceContext {
  return useSettingsHost().useWorkspaceContext();
}

export function useSettingsPaymentHandoffAvailable(): boolean | null {
  return useSettingsHost().usePaymentHandoffAvailable();
}

export function useSettingsPrivacy(): SettingsReplayPrivacy {
  return useSettingsHost().privacy;
}

/** The host's link, for internal settings paths and guarded external URLs. */
export function SettingsLink(props: SettingsLinkProps): JSX.Element {
  const { Link } = useSettingsHost();
  return <Link {...props} />;
}

/** The host's image component (`next/image` on web, `<img>` on desktop). */
export function SettingsImage(props: SettingsImageProps): JSX.Element {
  const { Image } = useSettingsHost();
  return <Image {...props} />;
}
