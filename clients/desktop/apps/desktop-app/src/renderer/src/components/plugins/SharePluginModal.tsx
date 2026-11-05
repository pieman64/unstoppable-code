import { type JSX, useCallback, useMemo, useRef, useState } from 'react';
import { getShareablePluginRefKey } from '@canopy/protocol/plugins';
import { useResourceContext } from '@canopy/ui-app/capability';
import { CANOPY_CLOUD_SERVER_ID } from '@canopy/desktop-shared/constants/canopy-cloud';
import {
  shareablePluginSourceLabel,
  type ShareablePluginRef,
} from '@canopy/desktop-shared/plugin-refs';
import type { SharedPluginDetail } from '@canopy/desktop-shared/types/plugins';
import {
  classifyShareFailure,
  deriveExistingShare,
  existingShareLoadFailure,
  publicAudienceLocked,
  ShareFailureError,
  shareOwnerFields,
  type ShareDialogLink,
  type ShareResourceOutcome,
  type ShareResourceScope,
  type ShareResourceShareInput,
} from '@canopy/ui-app/sharing';
import {
  createShareLinkResolver,
  resolveSharedPluginUrl,
} from '@/lib/share-links';
import { DesktopShareResourceDialog } from '@/components/shared/share/DesktopShareResourceDialog';
import type { CapabilityPackageSharePort } from '@canopy/ui-app/sharing';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { SHARED_PLUGINS_CHANGED_EVENT } from '@/hooks/useSharedMarketplaceShares';
import type { PipelinePackageAnalysisSummary } from '@canopy/protocol/pipelines';

const SHARE_SCOPES: readonly ShareResourceScope[] = [
  'team',
  'organization',
  'public',
];
const pluginLinks = createShareLinkResolver(
  (id) => `/portal/plugins/plugins/shared/${encodeURIComponent(id)}`,
  resolveSharedPluginUrl,
  'plugin',
);

/**
 * Whether a share the server returned already has the requested audience. A
 * response without a scope is a personal share, as the catalog path reads it.
 */
function hasRequestedOwner(
  detail: SharedPluginDetail,
  owner: ReturnType<typeof shareOwnerFields>,
): boolean {
  if ((detail.shareScope ?? 'private') !== owner.shareScope) return false;
  if (owner.shareScope === 'team')
    return detail.owner?.type === 'team' && detail.owner.id === owner.teamId;
  if (owner.shareScope === 'organization')
    return (
      detail.owner?.type === 'organization' &&
      detail.owner.id === owner.organizationId
    );
  return true;
}

interface SharePluginModalProps {
  pluginRef: ShareablePluginRef;
  name: string;
  description?: string | null;
  onClose: () => void;
  /**
   * Called after a share actually succeeded, before the dialog closes.
   * Closing, a failed share and removing the public link never call it.
   */
  onShared?: (detail: SharedPluginDetail) => void;
  /** Document the dialog opens in; a popped-out chat passes its own. */
  ownerDocument?: Document;
}

/** Plugin-reference binding around the common three-audience share dialog. */
export function SharePluginModal({
  pluginRef,
  name,
  description,
  onClose,
  onShared,
  ownerDocument,
}: SharePluginModalProps): JSX.Element {
  const policy = useResourceContext();
  useCurrentUiStateReporter('sharing.pluginDialog', {
    open: true,
    refKey: getShareablePluginRefKey(pluginRef),
  });
  const [remoteDetail, setRemoteDetail] = useState<SharedPluginDetail | null>(
    null,
  );
  const [remoteLink, setRemoteLink] = useState<ShareDialogLink | null>(null);
  const [reconciliationRevision, setReconciliationRevision] = useState(0);
  const pendingDetail = useRef<SharedPluginDetail | null>(null);
  const reconciliationTarget = useRef<{
    readonly id: string;
    readonly refKey: string;
    readonly accountId: string;
  } | null>(null);
  const packagePort = useMemo(
    (): CapabilityPackageSharePort => ({
      analyze: async (): Promise<PipelinePackageAnalysisSummary> => {
        if (typeof window.plugins.analyzeSharedReference !== 'function') {
          throw new Error(
            'Plugin requirements could not be checked. Try again.',
          );
        }
        const result = await window.plugins.analyzeSharedReference({
          ref: pluginRef,
        });
        if (!result.success || !result.data) {
          throw new Error(
            result.error ||
              'Plugin requirements could not be checked. Try again.',
          );
        }
        return result.data;
      },
      // A reference review has no package selection to commit.
      hasContent: () => false,
    }),
    [pluginRef],
  );

  const linkFromDetail = useCallback(
    (detail: SharedPluginDetail): Promise<ShareDialogLink | null> =>
      pluginLinks.linkFromDetail({
        id: detail.externalId,
        shareScope: detail.shareScope,
        publicShare: detail.publicShare,
      }),
    [],
  );

  const loadExistingShare = useCallback(
    async (assertCurrent?: () => void) => {
      void reconciliationRevision;
      assertCurrent?.();
      setRemoteDetail(null);
      assertCurrent?.();
      setRemoteLink(null);
      const [accountResult, listResult] = await Promise.all([
        window.api.loadCanopyCloudAccount(),
        window.plugins.listShared({ serverId: CANOPY_CLOUD_SERVER_ID }),
      ]);
      if (!listResult.success || !listResult.data) {
        return existingShareLoadFailure('plugin');
      }
      const accountId = accountResult.account?.id;
      const refKey = getShareablePluginRefKey(pluginRef);
      const existing = listResult.data.data.find(
        (candidate) =>
          candidate.refKey === refKey && candidate.createdBy.id === accountId,
      );
      const pending = reconciliationTarget.current;
      const remoteId =
        pending?.refKey === refKey && pending.accountId === accountId
          ? pending.id
          : existing?.externalId;
      if (!remoteId) return { status: 'ready' } as const;
      const detailResult = await window.plugins.getShared({
        serverId: CANOPY_CLOUD_SERVER_ID,
        remoteId,
      });
      if (!detailResult.success || !detailResult.data) {
        return existingShareLoadFailure('plugin');
      }
      assertCurrent?.();
      setRemoteDetail(detailResult.data);
      reconciliationTarget.current = null;
      const refreshedLink = await linkFromDetail(detailResult.data);

      assertCurrent?.();

      setRemoteLink(refreshedLink);
      return { status: 'ready' } as const;
    },
    [linkFromDetail, pluginRef, reconciliationRevision],
  );

  const share = useCallback(
    async (input: ShareResourceShareInput): Promise<ShareResourceOutcome> => {
      let revocationStarted = false;
      try {
        const owner = shareOwnerFields(input, remoteDetail);
        const request = {
          serverId: CANOPY_CLOUD_SERVER_ID,
          ref: pluginRef,
          name,
          description: description ?? null,
          ...owner,
        };
        if (
          input.scope !== 'public' &&
          !input.preservePublicLink &&
          remoteDetail?.publicShare
        ) {
          input.assertAllowed?.();
          revocationStarted = true;
          reconciliationTarget.current = {
            id: remoteDetail.externalId,
            refKey: getShareablePluginRefKey(pluginRef),
            accountId: remoteDetail.createdBy.id,
          };
          const revoked = await window.plugins.revokePublicShare(
            remoteDetail.externalId,
          );
          if (!revoked.success) {
            throw new Error(
              revoked.error ?? 'The public plugin link could not be removed.',
            );
          }
          const remaining = { ...remoteDetail, publicShare: null };
          input.assertAllowed?.();
          setRemoteDetail(remaining);
          input.assertAllowed?.();
          const nextLink = await pluginLinks.linkFromDetail({
            ...remaining,
            id: remaining.externalId,
          });
          input.assertAllowed?.();
          setRemoteLink(nextLink);
        }
        input.assertAllowed?.();
        const result = remoteDetail
          ? await window.plugins.updateShared({
              ...request,
              remoteId: remoteDetail.externalId,
            })
          : await window.plugins.createShared(request);
        if (!result.success || !result.data) {
          // Keep the structured cause so the dialog explains it and offers
          // the right recovery; older handlers send only the string.
          const failure = classifyShareFailure(result);
          if (failure) throw new ShareFailureError(failure);
          throw new Error(result.error ?? 'The plugin could not be shared.');
        }
        let detail = result.data;
        let revokedReusedLink = false;
        if (!remoteDetail) {
          // The server returns this creator's existing share for the same
          // plugin, even from a lane this dialog did not list, without applying
          // the requested audience. Apply it, as the catalog share path does.
          input.assertAllowed?.();
          // A new share already owned as requested needs no reconciliation.
          if (
            (!hasRequestedOwner(detail, owner) || detail.publicShare) &&
            (policy.context !== undefined || !policy.ready) &&
            publicAudienceLocked(
              deriveExistingShare(detail),
              policy.personalOrganizationId,
            )
          ) {
            // The create endpoint can return a share omitted by the list.
            // Adopt its ownership before any revoke, move, or publication.
            setRemoteDetail(detail);
            const link = await linkFromDetail(detail);
            input.assertAllowed?.();
            setRemoteLink(link);
            throw new Error('The sharing context changed. Try again.');
          }
          if (input.scope !== 'public' && detail.publicShare) {
            input.assertAllowed?.();
            revocationStarted = true;
            reconciliationTarget.current = {
              id: detail.externalId,
              refKey: getShareablePluginRefKey(pluginRef),
              accountId: detail.createdBy.id,
            };
            const revoked = await window.plugins.revokePublicShare(
              detail.externalId,
            );
            if (!revoked.success) {
              throw new Error(
                revoked.error ?? 'The public plugin link could not be removed.',
              );
            }
            revokedReusedLink = true;
          }
          if (!hasRequestedOwner(detail, owner)) {
            input.assertAllowed?.();
            const moved = await window.plugins.updateShared({
              ...request,
              remoteId: detail.externalId,
            });
            if (!moved.success || !moved.data) {
              const failure = classifyShareFailure(moved);
              if (failure) throw new ShareFailureError(failure);
              throw new Error(moved.error ?? 'The plugin could not be shared.');
            }
            detail = moved.data;
          }
        }
        input.assertAllowed?.();
        let shareUrl: string | undefined;
        let publicLinkFailed = false;
        if (input.scope === 'public') {
          const published = await window.plugins.publishPublicShare(
            detail.externalId,
          );
          if (!published.success || !published.data) {
            publicLinkFailed = true;
          } else {
            detail = { ...detail, publicShare: published.data };
            const link = await pluginLinks.resolveLink({
              kind: 'public',
              id: detail.externalId,
              sharePath: published.data.sharePath,
            });
            input.assertAllowed?.();
            setRemoteLink(link);
            shareUrl = link.url;
          }
        } else {
          if (
            !input.preservePublicLink &&
            (remoteDetail?.publicShare || revokedReusedLink)
          ) {
            detail = { ...detail, publicShare: null };
          }
          const link = await pluginLinks.resolveLink({
            kind: 'scoped',
            id: detail.externalId,
          });
          input.assertAllowed?.();
          setRemoteLink(link);
          shareUrl = link.url;
        }
        input.assertAllowed?.();
        pendingDetail.current = detail;
        input.assertAllowed?.();
        setRemoteDetail(detail);
        input.assertAllowed?.();
        window.dispatchEvent(new Event(SHARED_PLUGINS_CHANGED_EVENT));
        return {
          ...(shareUrl ? { shareUrl } : {}),
          ...(publicLinkFailed ? { publicLinkFailed: true } : {}),
        };
      } catch (error: unknown) {
        input.assertAllowed?.();
        if (revocationStarted)
          setReconciliationRevision((revision) => revision + 1);
        throw error;
      }
    },
    [description, linkFromDetail, name, pluginRef, policy, remoteDetail],
  );

  const retryPublicLink = useCallback(
    async (assertCurrent?: () => void): Promise<ShareResourceOutcome> => {
      assertCurrent?.();
      const detail = pendingDetail.current;
      if (!detail) return { publicLinkFailed: true };
      const published = await window.plugins.publishPublicShare(
        detail.externalId,
      );
      if (!published.success || !published.data) {
        return { publicLinkFailed: true };
      }
      const next = { ...detail, publicShare: published.data };
      assertCurrent?.();
      pendingDetail.current = next;
      assertCurrent?.();
      setRemoteDetail(next);
      const link = await pluginLinks.resolveLink({
        kind: 'public',
        id: detail.externalId,
        sharePath: published.data.sharePath,
      });
      assertCurrent?.();
      setRemoteLink(link);
      return { shareUrl: link.url };
    },
    [],
  );

  const revokePublicLink = useCallback(
    async (assertCurrent?: () => void): Promise<void> => {
      assertCurrent?.();
      if (!remoteDetail?.publicShare) return;
      reconciliationTarget.current = {
        id: remoteDetail.externalId,
        refKey: getShareablePluginRefKey(pluginRef),
        accountId: remoteDetail.createdBy.id,
      };
      try {
        const result = await window.plugins.revokePublicShare(
          remoteDetail.externalId,
        );
        if (!result.success) {
          throw new Error(
            result.error ?? 'The public plugin link could not be removed.',
          );
        }
        const remaining = { ...remoteDetail, publicShare: null };
        assertCurrent?.();
        setRemoteDetail(remaining);
        assertCurrent?.();
        const nextLink = await pluginLinks.linkFromDetail({
          ...remaining,
          id: remaining.externalId,
        });
        assertCurrent?.();
        setRemoteLink(nextLink);
      } catch (error: unknown) {
        assertCurrent?.();
        setReconciliationRevision((revision) => revision + 1);
        throw error;
      }
    },
    [remoteDetail, pluginRef],
  );

  // `pendingDetail` is written only by a successful share, so the dialog's
  // completion can report it without mistaking a close or a link removal.
  const handleCompleted = useCallback((): void => {
    const detail = pendingDetail.current;
    if (detail) onShared?.(detail);
  }, [onShared]);

  const notes = useMemo(
    () => (
      <div className="space-y-3">
        {description ? (
          <p className="text-s fg-secondary">{description}</p>
        ) : null}
        <p className="text-xs fg-secondary">
          Public source: {shareablePluginSourceLabel(pluginRef)}
        </p>
        <p
          className="text-xs fg-secondary"
          data-testid="share-plugin-reference-note"
        >
          Only a reference to this plugin is shared. Credentials, private
          configuration, and local files are never included.
        </p>
      </div>
    ),
    [description, pluginRef],
  );

  const existingShare = remoteDetail
    ? deriveExistingShare({ ...remoteDetail, link: remoteLink })
    : undefined;

  return (
    <DesktopShareResourceDialog
      marketplace={{
        kind: 'plugin',
        resourceKey: getShareablePluginRefKey(pluginRef),
      }}
      resourceNoun="plugin"
      testIdPrefix="share-plugin"
      requiredCapability="plugins-crud-v1"
      scopes={SHARE_SCOPES}
      subtitle={name}
      notes={notes}
      landing="marketplace"
      capabilityPackage={{ mode: 'reference', port: packagePort }}
      preflight={loadExistingShare}
      {...(existingShare ? { existingShare } : {})}
      share={share}
      retryPublicLink={retryPublicLink}
      {...(remoteDetail?.publicShare ? { revokePublicLink } : {})}
      onClose={onClose}
      {...(onShared ? { onCompleted: handleCompleted } : {})}
      {...(ownerDocument ? { ownerDocument } : {})}
    />
  );
}
