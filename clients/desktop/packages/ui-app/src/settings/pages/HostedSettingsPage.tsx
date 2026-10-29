'use client';

import { Component, Suspense, type JSX, type ReactNode } from 'react';
import {
  useSettingsPage,
  useSettingsStoreApi,
} from '@canopy/app-state/settings';
import {
  settingsPageDataKindForRoute,
  type OrganizationSettingsRoute,
  type SettingsPageData,
  type SettingsRoute,
} from '@canopy/protocol/settings';
import { AccountSettingsFrame } from '../account/AccountSettingsFrame';
import { SettingsPageColumn } from '../layout/SettingsPageColumn';
import { OrganizationListHeader } from '../organization/organization-list-header';
import {
  OrganizationSettingsPlaceholder,
  organizationTabForRoute,
} from '../organization/organization-header';
import {
  HostedSettingsErrorState,
  type HostedSettingsErrorStateProps,
} from './HostedSettingsStates';
import {
  HOSTED_SETTINGS_PAGE_SKELETONS,
  settingsPageSkeleton,
} from './loading-skeletons';
import { HOSTED_SETTINGS_PAGES } from './registry';
import { useStalePage } from './use-stale-page';

interface ChunkBoundaryProps {
  readonly resetKey: string;
  readonly onRetry: () => void;
  readonly children: ReactNode;
}

interface ChunkBoundaryState {
  readonly failed: boolean;
}

/**
 * Contains a hosted page that failed to load its chunk or threw while
 * rendering, so the host's local settings panels keep working.
 */
class HostedSettingsChunkBoundary extends Component<
  ChunkBoundaryProps,
  ChunkBoundaryState
> {
  override state: ChunkBoundaryState = { failed: false };

  static getDerivedStateFromError(): ChunkBoundaryState {
    return { failed: true };
  }

  override componentDidUpdate(previous: ChunkBoundaryProps): void {
    // New page data (another route, or a refetch) gets a fresh attempt.
    if (this.state.failed && previous.resetKey !== this.props.resetKey)
      this.setState({ failed: false });
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <HostedSettingsErrorState
        code="failed"
        onRetry={() => {
          this.setState({ failed: false });
          this.props.onRetry();
        }}
      />
    );
  }
}

/** Renders the registry entry for the page's kind; the switch keeps the
 * component and its data correlated without widening either. */
function RenderHostedPage({
  route,
  page,
}: {
  route: SettingsRoute;
  page: SettingsPageData;
}): JSX.Element {
  switch (page.kind) {
    case 'account.account': {
      const Page = HOSTED_SETTINGS_PAGES['account.account'];
      return <Page route={route} page={page} />;
    }
    case 'account.profile': {
      const Page = HOSTED_SETTINGS_PAGES['account.profile'];
      return <Page route={route} page={page} />;
    }
    case 'account.digests': {
      const Page = HOSTED_SETTINGS_PAGES['account.digests'];
      return <Page route={route} page={page} />;
    }
    case 'account.digest': {
      const Page = HOSTED_SETTINGS_PAGES['account.digest'];
      return <Page route={route} page={page} />;
    }
    case 'account.notifications': {
      const Page = HOSTED_SETTINGS_PAGES['account.notifications'];
      return <Page route={route} page={page} />;
    }
    case 'account.labs': {
      const Page = HOSTED_SETTINGS_PAGES['account.labs'];
      return <Page route={route} page={page} />;
    }
    case 'account.integrations': {
      const Page = HOSTED_SETTINGS_PAGES['account.integrations'];
      return <Page route={route} page={page} />;
    }
    case 'account.security': {
      const Page = HOSTED_SETTINGS_PAGES['account.security'];
      return <Page route={route} page={page} />;
    }
    case 'account.billing': {
      const Page = HOSTED_SETTINGS_PAGES['account.billing'];
      return <Page route={route} page={page} />;
    }
    case 'account.invoice': {
      const Page = HOSTED_SETTINGS_PAGES['account.invoice'];
      return <Page route={route} page={page} />;
    }
    case 'organization.list': {
      const Page = HOSTED_SETTINGS_PAGES['organization.list'];
      return <Page route={route} page={page} />;
    }
    case 'organization.feed': {
      const Page = HOSTED_SETTINGS_PAGES['organization.feed'];
      return <Page route={route} page={page} />;
    }
    case 'organization.feedItem': {
      const Page = HOSTED_SETTINGS_PAGES['organization.feedItem'];
      return <Page route={route} page={page} />;
    }
    case 'organization.statistics': {
      const Page = HOSTED_SETTINGS_PAGES['organization.statistics'];
      return <Page route={route} page={page} />;
    }
    case 'organization.digests': {
      const Page = HOSTED_SETTINGS_PAGES['organization.digests'];
      return <Page route={route} page={page} />;
    }
    case 'organization.digest': {
      const Page = HOSTED_SETTINGS_PAGES['organization.digest'];
      return <Page route={route} page={page} />;
    }
    case 'organization.members': {
      const Page = HOSTED_SETTINGS_PAGES['organization.members'];
      return <Page route={route} page={page} />;
    }
    case 'organization.member': {
      const Page = HOSTED_SETTINGS_PAGES['organization.member'];
      return <Page route={route} page={page} />;
    }
    case 'organization.memberDigest': {
      const Page = HOSTED_SETTINGS_PAGES['organization.memberDigest'];
      return <Page route={route} page={page} />;
    }
    case 'organization.groups': {
      const Page = HOSTED_SETTINGS_PAGES['organization.groups'];
      return <Page route={route} page={page} />;
    }
    case 'organization.projects': {
      const Page = HOSTED_SETTINGS_PAGES['organization.projects'];
      return <Page route={route} page={page} />;
    }
    case 'organization.memory.facts': {
      const Page = HOSTED_SETTINGS_PAGES['organization.memory.facts'];
      return <Page route={route} page={page} />;
    }
    case 'organization.memory.graph': {
      const Page = HOSTED_SETTINGS_PAGES['organization.memory.graph'];
      return <Page route={route} page={page} />;
    }
    case 'organization.memory.ops': {
      const Page = HOSTED_SETTINGS_PAGES['organization.memory.ops'];
      return <Page route={route} page={page} />;
    }
    case 'organization.memory.fact': {
      const Page = HOSTED_SETTINGS_PAGES['organization.memory.fact'];
      return <Page route={route} page={page} />;
    }
    case 'organization.settings': {
      const Page = HOSTED_SETTINGS_PAGES['organization.settings'];
      return <Page route={route} page={page} />;
    }
    case 'organization.invoice': {
      const Page = HOSTED_SETTINGS_PAGES['organization.invoice'];
      return <Page route={route} page={page} />;
    }
  }
}

export interface HostedSettingsPageContentProps {
  readonly route: SettingsRoute;
  /** Recovery actions the host offers around a failed page. */
  readonly recovery?: Omit<HostedSettingsErrorStateProps, 'code' | 'onRetry'>;
  /**
   * Wraps what this renders, given the route it shows: the current route, or
   * the previous one while that page is held. A host that keys its own frame
   * by page (desktop's replay classification) keys it by this route, so a
   * held page keeps its frame and its state.
   */
  readonly renderFrame?: (
    route: SettingsRoute,
    content: ReactNode,
  ) => ReactNode;
}

const renderBare = (_route: SettingsRoute, content: ReactNode): ReactNode =>
  content;

/** The organization tab a route loads under the organization header. */
function organizationTabRoute(
  route: SettingsRoute,
): OrganizationSettingsRoute | null {
  return route.scope === 'organization' &&
    organizationTabForRoute(route) !== null
    ? route
    : null;
}

/**
 * A route that is not ready yet: its page's loading skeleton (or centered
 * spinner) where the page's body will be.
 *
 * - Account routes render inside the account frame, which already draws the
 *   page header, so only the body stands in. The skeleton keeps its own
 *   height there, so this computer's sections after it stay in place.
 * - Organization tabs keep the organization header and their page header in
 *   place ({@link OrganizationSettingsPlaceholder}).
 * - The Organizations list keeps its page header above the skeleton,
 *   without its "New organization" action.
 * - Other routes (drill-downs with their own back-link header) show the
 *   skeleton in the settings column.
 */
export function HostedSettingsRouteLoading({
  route,
  immediate = false,
}: {
  readonly route: SettingsRoute;
  /**
   * Show the skeleton at once: the previous page already held the screen
   * for the loading delay.
   */
  readonly immediate?: boolean;
}): JSX.Element {
  const kind = settingsPageDataKindForRoute(route);
  const delayMs = immediate ? 0 : undefined;
  if (route.scope === 'account')
    return (
      <div
        // Only a centered spinner stretches to fill the body.
        className={
          HOSTED_SETTINGS_PAGE_SKELETONS[kind] === 'spinner'
            ? 'flex flex-1 flex-col'
            : 'flex flex-col'
        }
        data-testid="hosted-settings-route-loading"
      >
        {settingsPageSkeleton(kind, undefined, delayMs)}
      </div>
    );
  const tabRoute = organizationTabRoute(route);
  if (tabRoute !== null)
    return (
      <OrganizationSettingsPlaceholder
        route={tabRoute}
        skeletonDelayMs={delayMs}
      />
    );
  return (
    <SettingsPageColumn>
      {route.scope === 'organizations' ? <OrganizationListHeader /> : null}
      <div className="contents" data-testid="hosted-settings-route-loading">
        {settingsPageSkeleton(kind, undefined, delayMs)}
      </div>
    </SettingsPageColumn>
  );
}

/**
 * The body of one hosted settings route from the shared store, without the
 * account frame: loads its page data, shows the host state while it loads or
 * fails, then renders the route's shared page from its own lazy chunk inside
 * an error boundary. Hosts that draw the account frame themselves (so it
 * stays mounted across loading, ready and error) render this inside it.
 *
 * Moving to another route of the same scope keeps the previous page in
 * place, inert, until the next one is ready or the loading delay passes
 * ({@link useStalePage}). Organization tabs load under the organization
 * header ({@link OrganizationSettingsPlaceholder}), failures included.
 */
export function HostedSettingsPageContent({
  route,
  recovery,
  renderFrame = renderBare,
}: HostedSettingsPageContentProps): JSX.Element {
  const store = useSettingsStoreApi();
  const entry = useSettingsPage(route);
  const view = useStalePage(route, entry);
  const retry = (): void => {
    void store.getState().loadPage(route, { force: true });
  };

  switch (view.status) {
    case 'loading':
      return (
        <>
          {renderFrame(
            route,
            <HostedSettingsRouteLoading
              route={route}
              immediate={view.waited}
            />,
          )}
        </>
      );
    case 'error': {
      const failure = (
        <HostedSettingsErrorState
          code={view.error.code}
          onRetry={retry}
          {...recovery}
        />
      );
      const tabRoute = organizationTabRoute(route);
      return (
        <>
          {renderFrame(
            route,
            tabRoute === null ? (
              failure
            ) : (
              <OrganizationSettingsPlaceholder
                route={tabRoute}
                body={failure}
              />
            ),
          )}
        </>
      );
    }
    case 'page': {
      const resetKey = `${view.data.kind}:${view.revision}`;
      return (
        <>
          {renderFrame(
            view.route,
            // Always this wrapper, held or not, so a page that becomes held
            // keeps its instance. `contents` adds no box to the layout.
            <div className="contents" inert={view.held}>
              <HostedSettingsChunkBoundary resetKey={resetKey} onRetry={retry}>
                <Suspense
                  fallback={<HostedSettingsRouteLoading route={view.route} />}
                >
                  <RenderHostedPage route={view.route} page={view.data} />
                </Suspense>
              </HostedSettingsChunkBoundary>
            </div>,
          )}
        </>
      );
    }
  }
}

export interface HostedSettingsPageProps extends HostedSettingsPageContentProps {
  /** Free access names Billing "AI Credits" in the account page header. */
  readonly freeAccess: boolean;
  /** Host content rendered after an account page, in every page state.
   * Organization routes have no account frame and never render it. */
  readonly accountFrameAfter?: ReactNode;
}

/**
 * Renders one hosted settings route: {@link HostedSettingsPageContent}, inside
 * the account frame for account routes.
 */
export function HostedSettingsPage({
  route,
  freeAccess,
  recovery,
  renderFrame,
  accountFrameAfter,
}: HostedSettingsPageProps): JSX.Element {
  const content = (
    <HostedSettingsPageContent
      route={route}
      recovery={recovery}
      renderFrame={renderFrame}
    />
  );
  if (route.scope === 'account')
    return (
      <AccountSettingsFrame freeAccess={freeAccess} after={accountFrameAfter}>
        {content}
      </AccountSettingsFrame>
    );
  return content;
}
