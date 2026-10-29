'use client';

import {
  createContext,
  useContext,
  useMemo,
  type JSX,
  type ReactNode,
} from 'react';
import type { GitHubCloudRepositoryListingInput } from '@canopy/protocol/settings/github-cloud-repository-listing';
import type { RetryAfterHeaders } from '@canopy/protocol/settings/cloud-retry-after';
// Schema-free imports: web's signed-in layout mounts this host provider.
import { settingsRouteToPath } from '@canopy/protocol/settings/route-paths';
import { useSettingsHost } from '../host/settings-host';

// ---------------------------------------------------------------------------
// GitHub-local host ports for the "GitHub for cloud" UI (CAN-4386).
//
// The shared settings host (`../host`) carries everything the GitHub UI needs
// except the two things only a browser page that owns the sign-in session can
// do: link the GitHub identity in place (web's Better Auth `linkSocial`, which
// redirects this tab to GitHub and back) and read the repository listing
// routes, whose typed failure envelope and `Retry-After` the fixed settings
// table does not carry. A host that can do both mounts
// `GitHubCloudHostProvider`; web does so from its settings host provider.
//
// Without a provider (desktop today), `useGitHubCloudHost` returns the browser
// handoff, built only from the settings host ports: Connect, Reconnect,
// Install and Add account open the web Integrations page in the browser, the
// views say "Continue in your browser." with a Check again that re-reads the
// connection, and the repository listing is unavailable. Status, the live
// check and Disconnect keep running through the settings client on every
// host. Shared code never asks which host it runs in, only which of these two
// it was given.
// ---------------------------------------------------------------------------

/** The callback paths of one in-place GitHub link (same-origin path and query). */
export interface GitHubCloudLinkRequest {
  /** Where the provider returns after linking, carrying the link marker. */
  readonly callbackPath: string;
  /** Where the provider returns after a failed link. */
  readonly errorCallbackPath: string;
}

/**
 * The sign-in client's answer. `url` is the provider address this tab must
 * follow (null: nothing to follow); `ok: false` is a reported link error.
 */
export type GitHubCloudLinkStart =
  | { readonly ok: true; readonly url: string | null }
  | { readonly ok: false };

/** One of the two fixed repository routes; never an arbitrary address. */
export type GitHubCloudRepositoryRoute =
  | { readonly kind: 'page'; readonly input: GitHubCloudRepositoryListingInput }
  | { readonly kind: 'creationCapability'; readonly installationId: string };

/** The parts of a fetch `Response` the repository client reads. */
export interface GitHubCloudRepositoryResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: RetryAfterHeaders;
  json(): Promise<unknown>;
}

/** Sends one repository route with the session; rejects when unanswered. */
export interface GitHubCloudRepositoryTransport {
  request(
    route: GitHubCloudRepositoryRoute,
    signal?: AbortSignal,
  ): Promise<GitHubCloudRepositoryResponse>;
}

/** What a host that runs GitHub sign-in on this page supplies. */
export interface GitHubCloudHostPorts {
  /**
   * Links the GitHub identity with redirects disabled: resolves the provider
   * URL to follow (the controller follows it only while its flow is still
   * current), or a reported link error. Rejects when unanswered.
   */
  readonly linkGitHubAccount: (
    request: GitHubCloudLinkRequest,
  ) => Promise<GitHubCloudLinkStart>;
  readonly repositories: GitHubCloudRepositoryTransport;
}

/** Connect runs on this page: link in place, follow GitHub in this tab. */
export interface GitHubCloudInlineHost extends GitHubCloudHostPorts {
  readonly kind: 'inline';
}

/** Connect continues on the web Integrations page in the browser. */
export interface GitHubCloudBrowserHost {
  readonly kind: 'browser';
  /** Opens the web Integrations page in the browser. */
  readonly continueInBrowser: () => void;
  /** No repository listing here. */
  readonly repositories: null;
}

/** The GitHub ports shared views and the controller read. */
export type GitHubCloudHost = GitHubCloudInlineHost | GitHubCloudBrowserHost;

const GitHubCloudHostContext = createContext<GitHubCloudInlineHost | null>(
  null,
);

export interface GitHubCloudHostProviderProps {
  /** Created once by the host; never swapped while mounted. */
  readonly ports: GitHubCloudHostPorts;
  readonly children: ReactNode;
}

export function GitHubCloudHostProvider({
  ports,
  children,
}: GitHubCloudHostProviderProps): JSX.Element {
  const host = useMemo(
    (): GitHubCloudInlineHost => ({
      kind: 'inline',
      linkGitHubAccount: ports.linkGitHubAccount,
      repositories: ports.repositories,
    }),
    [ports],
  );
  return (
    <GitHubCloudHostContext.Provider value={host}>
      {children}
    </GitHubCloudHostContext.Provider>
  );
}

/** The web Integrations page, where a browser handoff continues. */
const INTEGRATIONS_PATH = settingsRouteToPath({
  scope: 'account',
  page: 'integrations',
});

function useBrowserHandoffHost(): GitHubCloudBrowserHost {
  const host = useSettingsHost();
  const navigation = host.useNavigation();
  return useMemo(
    (): GitHubCloudBrowserHost => ({
      kind: 'browser',
      continueInBrowser: (): void => {
        navigation.openExternal(`${host.webOrigin()}${INTEGRATIONS_PATH}`);
      },
      repositories: null,
    }),
    [host, navigation],
  );
}

/** Stands in for the handoff where a provider is mounted; never used there. */
const UNUSED_HANDOFF: GitHubCloudBrowserHost = {
  kind: 'browser',
  continueInBrowser: (): void => undefined,
  repositories: null,
};

function useProvidedHostHandoff(): GitHubCloudBrowserHost {
  return UNUSED_HANDOFF;
}

/**
 * The GitHub ports for this surface: the mounted provider's, else the
 * browser handoff. A provider is mounted once by its host and never added or
 * removed above a mounted view (the same contract as the settings host's
 * hook ports), so which handoff hook runs is stable for a mount. With a
 * provider, nothing here reads the settings host's navigation.
 */
export function useGitHubCloudHost(): GitHubCloudHost {
  const provided = useContext(GitHubCloudHostContext);
  const useHandoff =
    provided === null ? useBrowserHandoffHost : useProvidedHostHandoff;
  const handoff = useHandoff();
  return provided ?? handoff;
}

/**
 * The repository transport alone, or null without a GitHub host provider.
 * Reads no settings host port, so a listing hook mounted beside (not under)
 * a connection scope stays inert there instead of requiring one.
 */
export function useGitHubCloudRepositoryTransport(): GitHubCloudRepositoryTransport | null {
  return useContext(GitHubCloudHostContext)?.repositories ?? null;
}
