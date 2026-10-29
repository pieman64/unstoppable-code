import type { DesktopOrgProjectDeepLink } from '@canopy/protocol';
import type { OrgProjectDeepLinkOpenEvent } from '@canopy/protocol/org-projects';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { getFeatureFlagService } from '../feature-flags';
import { getCanopyCloudCredentials } from '../lib/canopy-cloud-account-store';
import { getWorkspaceContextService } from '../lib/workspace-context-service';
import { readAllSidebarItems } from '../lib/sidebar-items';
import { getOrgProjectCatalogService } from '../services/org-project-catalog-service';
import { openOrgProjectDeepLink } from './org-project-deep-link';

let pending: Promise<void> = Promise.resolve();

/** Returns true only when the event reached a live window. */
export type OrgProjectDeepLinkSender = (
  event: OrgProjectDeepLinkOpenEvent,
) => boolean;

let sender: OrgProjectDeepLinkSender | null = null;
/**
 * Authorization runs for as long as a forced catalog refresh takes, so the
 * window that was alive when the link arrived may be gone by the time there is
 * a result. The deep-link service has already dropped the link by then (its
 * sender contract is synchronous), so the RESULT is what gets buffered here,
 * and it is delivered to whatever window is current when one is ready.
 */
let undelivered: OrgProjectDeepLinkOpenEvent | null = null;

function flush(): void {
  if (sender === null || undelivered === null) return;
  const event = undelivered;
  if (sender(event) && undelivered === event) undelivered = null;
}

/** Injects delivery. The sender must resolve the current window per call. */
export function setOrgProjectDeepLinkSender(
  next: OrgProjectDeepLinkSender,
): void {
  sender = next;
  flush();
}

/** Wired to the renderer's startup-unlocked signal, like buffered links. */
export function flushPendingOrgProjectDeepLink(): void {
  flush();
}

/** Test-only: resets module state between Jest cases. */
export function resetOrgProjectDeepLinkHostForTests(): void {
  sender = null;
  undelivered = null;
  pending = Promise.resolve();
}

function send(event: OrgProjectDeepLinkOpenEvent): void {
  undelivered = event;
  flush();
}

/** Main owns the whole serialized operation, independently of renderer mounts. */
export function handleOrgProjectDeepLink(
  link: DesktopOrgProjectDeepLink,
): void {
  pending = pending
    .then(() =>
      openOrgProjectDeepLink(link.projectId, link.organizationId, {
        accountId: async (): Promise<string> =>
          (await getCanopyCloudCredentials()).account?.id ?? '',
        accountEpoch: (): number => getWorkspaceContextService().accountEpoch(),
        enabled: (): boolean =>
          getFeatureFlagService().isEnabled(
            CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
          ),
        projects: async (organizationId) => {
          const snapshot = await getOrgProjectCatalogService().refresh(
            { kind: 'organization', organizationId },
            { force: true },
          );
          return snapshot.error === null &&
            snapshot.context === `org:${organizationId}`
            ? snapshot.projects
            : [];
        },
        workspaceId: async (
          organizationId,
          projectId,
        ): Promise<string | null> => {
          const { items } = await readAllSidebarItems();
          return (
            items.find(
              (item) =>
                item.owner?.type === 'organization' &&
                item.owner.organizationId === organizationId &&
                item.owner.projectId === projectId,
            )?.id ?? null
          );
        },
        switchContext: async (organizationId): Promise<void> => {
          await getWorkspaceContextService().setContext({
            kind: 'organization',
            organizationId,
          });
        },
        deliver: (target): void => send({ ok: true, ...target }),
        unavailable: (): void => send({ ok: false }),
      }),
    )
    .catch((): void => send({ ok: false }));
}
