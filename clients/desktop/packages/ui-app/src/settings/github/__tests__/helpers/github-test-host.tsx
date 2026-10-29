import type { JSX, ReactNode } from 'react';
import type {
  AccountOrganizationSettingsClient,
  SettingsNavigationPort,
} from '@canopy/app-core/settings';
import {
  SettingsOperationError,
  settingsErrorCodeForStatus,
  settingsOperationRequest,
  validateSettingsOperationInput,
  validateSettingsOperationResult,
  type SettingsOperationName,
} from '@canopy/protocol/settings';
import {
  createTestSettingsHost,
  TestSettingsHost,
} from '../../../__tests__/helpers/test-settings-host';
import type { SettingsBrand } from '../../../host';
import { gitHubCloudRepositoryRoutePath } from '../../github-cloud-api';
import {
  GitHubCloudHostProvider,
  type GitHubCloudHostPorts,
  type GitHubCloudLinkStart,
} from '../../github-cloud-host';

/**
 * Harness for the GitHub for cloud suites. They used to stub the web
 * `fetchBackendUrl` by path and Better Auth's `authClient.linkSocial`; the
 * shared UI now reaches those through the settings client and the GitHub
 * host. These doubles keep the suites' fixtures (path-keyed fake backends,
 * a `linkSocial` mock) and their assertions:
 *
 * - `createFetchBackedSettingsClient` runs each settings operation as the
 *   web settings client does (the entry's path after `/api`, the session
 *   included, the status and the body's `code`/`error` on a failure);
 * - `createFetchBackedGitHubPorts` mirrors the web GitHub host: `linkSocial`
 *   with redirects disabled and absolute callback URLs on this origin, and
 *   the repository routes through the same backend fetch.
 */

/** A backend fetch keyed by the path after `/api`, like `fetchBackendUrl`. */
export type TestBackendFetch = (
  path: string,
  init?: RequestInit,
) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorDetails(body: unknown): {
  message?: string;
  serverCode?: string;
} {
  if (!isRecord(body)) return {};
  const message =
    typeof body.error === 'string'
      ? body.error
      : typeof body.message === 'string'
        ? body.message
        : undefined;
  const serverCode = typeof body.code === 'string' ? body.code : undefined;
  return {
    ...(message === undefined ? {} : { message }),
    ...(serverCode === undefined ? {} : { serverCode }),
  };
}

const NO_BODY: unique symbol = Symbol('no JSON body');

async function readBody(response: Response): Promise<unknown> {
  try {
    const body: unknown = await response.json();
    return body;
  } catch {
    return NO_BODY;
  }
}

export function createFetchBackedSettingsClient(
  fetchBackend: TestBackendFetch,
): AccountOrganizationSettingsClient {
  async function run(
    name: SettingsOperationName,
    input: unknown,
    write: boolean,
  ): Promise<unknown> {
    const validation = validateSettingsOperationInput(name, input);
    if (!validation.ok)
      throw new SettingsOperationError({
        code: 'failed',
        serverCode: 'invalid_input',
      });
    const request = settingsOperationRequest(name, validation.input);
    const withBody = request.body !== undefined;
    let response: Response;
    try {
      response = await fetchBackend(request.path.slice('/api'.length), {
        method: request.method,
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          ...(withBody ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(withBody ? { body: JSON.stringify(request.body) } : {}),
      });
    } catch {
      throw new SettingsOperationError({
        code: write ? 'uncertain' : 'offline',
      });
    }
    const body = await readBody(response);
    if (!response.ok)
      throw new SettingsOperationError({
        code: settingsErrorCodeForStatus(response.status, { write }),
        status: response.status,
        ...(body === NO_BODY ? {} : errorDetails(body)),
      });
    if (body === NO_BODY)
      throw new SettingsOperationError({
        code: 'invalid_response',
        status: response.status,
      });
    const result = validateSettingsOperationResult(name, body);
    if (!result.ok)
      throw new SettingsOperationError({
        code: 'invalid_response',
        status: response.status,
      });
    return result.result;
  }
  return {
    // Test double: the entry's result schema already accepted the body, as
    // in the web client; `as never` mirrors `createFakeSettingsClient`.
    read: async (operation, input) =>
      (await run(operation, input, false)) as never,
    write: async (operation, input) =>
      (await run(operation, input, true)) as never,
    subscribe: () => () => undefined,
  };
}

/** The `authClient.linkSocial` subset the web GitHub host calls. */
export type TestLinkSocial = (options: {
  provider: 'github';
  callbackURL: string;
  errorCallbackURL: string;
  disableRedirect: true;
}) => Promise<
  | { data: { url?: string; redirect?: boolean }; error: null }
  | { data: null; error: { message?: string } }
>;

export function createFetchBackedGitHubPorts(
  fetchBackend: TestBackendFetch,
  linkSocial: TestLinkSocial,
): GitHubCloudHostPorts {
  return {
    linkGitHubAccount: async ({
      callbackPath,
      errorCallbackPath,
    }): Promise<GitHubCloudLinkStart> => {
      const origin = window.location.origin;
      const result = await linkSocial({
        provider: 'github',
        callbackURL: new URL(callbackPath, origin).toString(),
        errorCallbackURL: new URL(errorCallbackPath, origin).toString(),
        disableRedirect: true,
      });
      if (result.error !== null) return { ok: false };
      return { ok: true, url: result.data.url ? result.data.url : null };
    },
    repositories: {
      request: (route, signal) =>
        fetchBackend(gitHubCloudRepositoryRoutePath(route), {
          method: 'GET',
          headers: { Accept: 'application/json' },
          cache: 'no-store',
          signal,
        }),
    },
  };
}

export interface GitHubTestHostProps {
  readonly client?: AccountOrganizationSettingsClient;
  /** The GitHub host's ports; `null` mounts none (the browser handoff). */
  readonly github?: GitHubCloudHostPorts | null;
  readonly brand?: SettingsBrand;
  readonly navigation?: Partial<SettingsNavigationPort>;
  readonly privacy?: { blockClassName: string; maskClassName: string };
  readonly children: ReactNode;
}

/** The settings host plus (unless `github` is null) the GitHub host. */
export function GitHubTestHost({
  client,
  github,
  brand,
  navigation,
  privacy,
  children,
}: GitHubTestHostProps): JSX.Element {
  const { host } = createTestSettingsHost({
    client,
    brand,
    navigation,
    privacy,
  });
  return (
    <TestSettingsHost host={host}>
      {github === null || github === undefined ? (
        children
      ) : (
        <GitHubCloudHostProvider ports={github}>
          {children}
        </GitHubCloudHostProvider>
      )}
    </TestSettingsHost>
  );
}
