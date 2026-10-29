import type { JSX, ReactNode } from 'react';
import type {
  AccountOrganizationSettingsClient,
  SettingsNavigationPort,
} from '@canopy/app-core/settings';
import {
  SettingsOperationError,
  type SettingsEvent,
  type SettingsOperationName,
  type SettingsSubscriptionScope,
} from '@canopy/protocol/settings';
import {
  SettingsHostProvider,
  type SettingsLinkProps,
  type SettingsImageProps,
  type SettingsRouter,
  type SettingsUiHost,
} from '../../host';

/**
 * Test doubles for shared settings components. Tests render components
 * inside {@link TestSettingsHost} and stub only the operations they exercise.
 */

export type FakeSettingsHandler = (input: unknown) => unknown;

export interface FakeSettingsClient extends AccountOrganizationSettingsClient {
  /** Every call, in order. */
  readonly calls: Array<{ operation: SettingsOperationName; input: unknown }>;
  /** Push an event to every active subscription. */
  emit(event: SettingsEvent): void;
  readonly subscriptions: SettingsSubscriptionScope[];
}

/**
 * A settings client that answers from `handlers`. An operation without a
 * handler rejects with a `failed` `SettingsOperationError`, so a test notices
 * an unexpected call.
 */
export function createFakeSettingsClient(
  handlers: Partial<Record<SettingsOperationName, FakeSettingsHandler>> = {},
): FakeSettingsClient {
  const calls: Array<{ operation: SettingsOperationName; input: unknown }> = [];
  const listeners = new Set<(event: SettingsEvent) => void>();
  const subscriptions: SettingsSubscriptionScope[] = [];
  const run = async (
    operation: SettingsOperationName,
    input: unknown,
  ): Promise<never> => {
    calls.push({ operation, input });
    const handler = handlers[operation];
    if (handler === undefined)
      throw new SettingsOperationError({
        code: 'failed',
        message: `No fake handler for ${operation}`,
      });
    // The fake returns whatever the test's handler supplies for the entry.
    return (await handler(input)) as never;
  };
  return {
    calls,
    subscriptions,
    read: (operation, input) => run(operation, input),
    write: (operation, input) => run(operation, input),
    subscribe(scope, listener) {
      subscriptions.push(scope);
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
    emit(event): void {
      listeners.forEach((listener) => listener(event));
    },
  };
}

function TestLink({
  href,
  children,
  prefetch,
  replace,
  scroll,
  ...rest
}: SettingsLinkProps): JSX.Element {
  // Router-only props are not anchor attributes; tests can read them back.
  const routing = JSON.stringify({ prefetch, replace, scroll });
  return (
    <a href={href} data-test-link-routing={routing} {...rest}>
      {children}
    </a>
  );
}

function TestImage({
  src,
  alt,
  width,
  height,
  className,
  'data-testid': testId,
}: SettingsImageProps): JSX.Element {
  return (
    <img
      src={src}
      alt={alt}
      width={width}
      height={height}
      className={className}
      data-testid={testId}
    />
  );
}

export interface TestSettingsHostOptions {
  readonly client?: AccountOrganizationSettingsClient;
  readonly inlineCheckout?: boolean;
  readonly pathname?: string;
  readonly search?: string;
  readonly router?: Partial<SettingsRouter>;
  readonly navigation?: Partial<SettingsNavigationPort>;
  readonly paymentHandoffAvailable?: boolean | null;
  readonly topUpFeePercent?: number;
  readonly privacy?: { blockClassName: string; maskClassName: string };
  readonly brand?: { id: string; displayName: string; internalName: string };
  readonly selectOrganization?: (organizationId: string) => void;
}

export interface TestSettingsHostHandle {
  readonly host: SettingsUiHost;
  readonly router: SettingsRouter;
  readonly navigation: SettingsNavigationPort;
}

const noop = (): void => {};

export function createTestSettingsHost(
  options: TestSettingsHostOptions = {},
): TestSettingsHostHandle {
  const router: SettingsRouter = {
    push: noop,
    replace: noop,
    refresh: noop,
    back: noop,
    ...options.router,
  };
  const navigation: SettingsNavigationPort = {
    navigate: noop,
    replaceQuery: noop,
    back: noop,
    href: () => '/',
    openExternal: noop,
    openOAuth: noop,
    openPaymentHandoff: () => Promise.resolve({ ok: true }),
    ...options.navigation,
  };
  const searchParams = new URLSearchParams(options.search ?? '');
  const brand = options.brand ?? {
    id: 'canopy',
    displayName: 'Canopy',
    internalName: 'canopy',
  };
  const host: SettingsUiHost = {
    client: options.client ?? createFakeSettingsClient(),
    inlineCheckout: options.inlineCheckout ?? true,
    Link: TestLink,
    Image: TestImage,
    storage: { readOrganizationId: () => null, writeOrganizationId: noop },
    privacy: options.privacy ?? { blockClassName: '', maskClassName: '' },
    webOrigin: () => 'https://canopy.test',
    logger: () => ({ debug: noop, info: noop, warn: noop, error: noop }),
    useRouter: () => router,
    usePathname: () => options.pathname ?? '/account',
    useSearchParams: () => searchParams,
    useNavigation: () => navigation,
    useBrand: () => brand,
    useScrollElement: () => null,
    useTopUpFeePercent: () => options.topUpFeePercent ?? 0,
    useWorkspaceContext: () => ({
      enabled: true,
      accountKey: 'account-1',
      workspaceContext: { kind: 'personal' },
      selectOrganization: options.selectOrganization ?? noop,
    }),
    usePaymentHandoffAvailable: () =>
      options.paymentHandoffAvailable === undefined
        ? false
        : options.paymentHandoffAvailable,
  };
  return { host, router, navigation };
}

export function TestSettingsHost({
  host,
  children,
}: {
  host?: SettingsUiHost;
  children: ReactNode;
}): JSX.Element {
  return (
    <SettingsHostProvider host={host ?? createTestSettingsHost().host}>
      {children}
    </SettingsHostProvider>
  );
}
