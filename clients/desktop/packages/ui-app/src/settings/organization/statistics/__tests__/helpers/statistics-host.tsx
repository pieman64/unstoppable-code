import { act } from 'react';
import type { SettingsOperationName } from '@canopy/protocol/settings';
import type { SettingsUiHost } from '../../../../host';
import {
  createFakeSettingsClient,
  createTestSettingsHost,
  type FakeSettingsClient,
  type FakeSettingsHandler,
} from '../../../../__tests__/helpers/test-settings-host';

/**
 * Settings host for the Statistics tests. View state lives in the URL, so
 * `router.replace` writes the shared `searchParams` that the host's
 * `useSearchParams` reads back; tests re-render after an interaction to
 * reflect the new URL, the way a real navigation would. `replace` is a spy
 * for call assertions.
 */
export interface StatisticsTestHost {
  readonly host: SettingsUiHost;
  readonly client: FakeSettingsClient;
  readonly replace: jest.Mock<void, [string, { scroll?: boolean }?]>;
  /** Reset the URL query to `queryString`. */
  setParams(queryString: string): void;
}

export interface StatisticsTestHostOptions {
  readonly pathname?: string;
  /**
   * Answers `organization.statistics.usage`. Every default handler (usage and
   * the viewer's data-sharing status) stays pending forever.
   */
  readonly usage?: (input: unknown) => unknown;
  readonly handlers?: Partial<
    Record<SettingsOperationName, FakeSettingsHandler>
  >;
  readonly privacy?: { blockClassName: string; maskClassName: string };
}

export function createStatisticsTestHost(
  options: StatisticsTestHostOptions = {},
): StatisticsTestHost {
  const searchParams = new URLSearchParams();
  const setParams = (queryString: string): void => {
    for (const key of Array.from(searchParams.keys())) {
      searchParams.delete(key);
    }
    new URLSearchParams(queryString).forEach((value, key) => {
      searchParams.set(key, value);
    });
  };
  const replace = jest.fn<void, [string, { scroll?: boolean }?]>(
    (url: string): void => {
      setParams(url.includes('?') ? url.slice(url.indexOf('?') + 1) : '');
    },
  );
  const pending = (): Promise<never> => new Promise<never>(() => {});
  const client = createFakeSettingsClient({
    'organization.statistics.usage': options.usage ?? pending,
    // The People-tab hint's viewer status; pending unless a test answers it.
    'organization.dataSharing.viewer': pending,
    ...options.handlers,
  });
  const base = createTestSettingsHost({
    client,
    pathname: options.pathname ?? '/organization/org-1/statistics',
    router: { replace },
    ...(options.privacy ? { privacy: options.privacy } : {}),
  }).host;
  const host: SettingsUiHost = {
    ...base,
    useSearchParams: () => searchParams,
  };
  return { host, client, replace, setParams };
}

/** Usage requests the section sent, in order. */
export function usageCalls(client: FakeSettingsClient): unknown[] {
  return client.calls
    .filter((call) => call.operation === 'organization.statistics.usage')
    .map((call) => call.input);
}

/** Settle the usage read and the lazy chart chunk. */
export async function flushStatistics(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
}
