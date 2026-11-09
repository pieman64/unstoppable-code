import {
  type JSX,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  ShareRunBlockedReason,
  ShareRunEligibilityResponse,
  ShareRunResponse,
  SharedRunMetadata,
} from '@canopy/desktop-shared/types';
import type { RunShareScope } from '@canopy/protocol/runs';
import { formatOrgNameList } from '@canopy/ui-shared/lib/org-lapse-sentence';
import type {
  ShareResourceOutcome,
  ShareDialogLink,
  ShareResourceExistingShare,
  ShareResourcePreflightResult,
  ShareResourceScope,
  ShareResourceShareInput,
} from '@canopy/ui-app/sharing';
import { resolveSharedRunUrl } from '@/lib/share-links';
import { DesktopShareResourceDialog } from './share/DesktopShareResourceDialog';

const SHARE_SCOPES: readonly ShareResourceScope[] = ['team', 'organization'];
const SHARED_RUN_DISCLOSURE =
  'This shared session is redacted, may be truncated, stays synchronized as the session continues, and can be unshared at any time.';

function unavailableDescription(retentionDays: number | undefined): string {
  const window =
    retentionDays !== undefined && retentionDays > 0
      ? `which is kept for ${retentionDays} days. This session falls outside that ${retentionDays}-day window, so`
      : 'which is kept only for a limited window. This session falls outside it, so';
  return `A shared run is built from this session's recorded activity, ${window} there is nothing left to publish — its messages stay available here. More recent sessions can still be shared, and you can widen the window under Settings → General → Agent observability.`;
}

function blockedDescription(organizationNames: string[] | undefined): string {
  const names = organizationNames ?? [];
  const who =
    names.length > 0
      ? formatOrgNameList(names)
      : 'an organization you belong to';
  return `A shared run publishes this session's full conversation, and sharing that data is blocked by ${who}. The session stays on your machine and remains available here. Only an organization admin can change this.`;
}

function billingBlockedDescription(
  organizationNames: string[] | undefined,
): string {
  const names = organizationNames ?? [];
  if (names.length > 1) {
    return `${formatOrgNameList(names)} do not have active plans, so shared runs cannot be published to them right now. Pick a different destination, or ask an organization admin to update billing.`;
  }
  const who = names.length === 1 ? names[0] : 'That organization';
  return `${who} does not have an active plan, so shared runs cannot be published to it right now. Pick a different destination, or ask an organization admin to update billing.`;
}

type ShareUnavailableState =
  | { reason: 'no-activity'; retentionDays?: number }
  | { reason: 'blocked-by-org-policy'; organizationNames?: string[] }
  | { reason: 'blocked-by-org-billing'; organizationNames?: string[] };

function unavailableFromRefusal(refusal: {
  reason?: ShareRunBlockedReason;
  auditRetentionDays?: number;
  blockedByOrganizationNames?: string[];
}): ShareUnavailableState | null {
  if (refusal.reason === 'blocked-by-org-policy') {
    return {
      reason: 'blocked-by-org-policy',
      ...(refusal.blockedByOrganizationNames
        ? { organizationNames: refusal.blockedByOrganizationNames }
        : {}),
    };
  }
  if (refusal.reason === 'no-activity') {
    return {
      reason: 'no-activity',
      ...(refusal.auditRetentionDays !== undefined
        ? { retentionDays: refusal.auditRetentionDays }
        : {}),
    };
  }
  if (refusal.reason === 'blocked-by-org-billing') {
    return {
      reason: 'blocked-by-org-billing',
      ...(refusal.blockedByOrganizationNames
        ? { organizationNames: refusal.blockedByOrganizationNames }
        : {}),
    };
  }
  return null;
}

function unavailableBody(state: ShareUnavailableState): JSX.Element {
  const billingOrganizations =
    state.reason === 'blocked-by-org-billing'
      ? (state.organizationNames ?? [])
      : [];
  return (
    <div className="flex flex-col text-center gap-2">
      <p className="text-m font-semibold fg-primary">
        {state.reason === 'no-activity'
          ? 'This session can no longer be shared'
          : state.reason === 'blocked-by-org-billing'
            ? billingOrganizations.length > 1
              ? 'These organizations have no active plans'
              : 'This organization has no active plan'
            : 'This session cannot be shared'}
      </p>
      <p className="text-s fg-secondary">
        {state.reason === 'blocked-by-org-policy'
          ? blockedDescription(state.organizationNames)
          : state.reason === 'blocked-by-org-billing'
            ? billingBlockedDescription(state.organizationNames)
            : unavailableDescription(state.retentionDays)}
      </p>
    </div>
  );
}

export interface ShareRunShareRequest {
  shareScope: Exclude<RunShareScope, 'private'>;
  teamId?: string;
  organizationId?: string;
}

export interface ShareRunSuccess {
  externalId: string;
  teamId?: string;
  teamName?: string;
  organizationId?: string;
  organizationName?: string;
  shareScope: RunShareScope;
}

interface ShareRunModalProps {
  chatId?: string;
  runTitle?: string;
  ownerDocument?: Document;
  onClose: () => void;
  onShare: (request: ShareRunShareRequest) => Promise<ShareRunResponse>;
  onShared?: (result: ShareRunSuccess) => void | Promise<void>;
  checkEligibility?: () => Promise<ShareRunEligibilityResponse>;
  existingShare?: SharedRunMetadata;
}

function existingShareFromMetadata(
  share: SharedRunMetadata,
  link: ShareDialogLink | null,
): ShareResourceExistingShare | undefined {
  if (share.shareScope === 'private') return undefined;
  const target =
    share.shareScope === 'team' && share.teamId
      ? {
          id: share.teamId,
          name: share.teamName ?? 'Shared team',
          ...(share.organizationName
            ? { secondaryLabel: share.organizationName }
            : {}),
        }
      : share.shareScope === 'organization' && share.organizationId
        ? {
            id: share.organizationId,
            name: share.organizationName ?? 'Shared organization',
          }
        : undefined;
  return {
    audience: share.shareScope,
    ...(target ? { target } : {}),
    ...(link ? { link } : {}),
  };
}

/** Run eligibility/upsert binding around the common share dialog. */
export function ShareRunModal({
  runTitle,
  ownerDocument,
  onClose,
  onShare,
  onShared,
  checkEligibility,
  existingShare,
}: ShareRunModalProps): JSX.Element {
  const [runtimeUnavailable, setRuntimeUnavailable] =
    useState<ShareUnavailableState | null>(null);
  const [existingLink, setExistingLink] = useState<ShareDialogLink | null>(
    null,
  );
  const pending = useRef<ShareRunSuccess | null>(null);

  useEffect(() => {
    let cancelled = false;
    setExistingLink(null);
    if (!existingShare || existingShare.shareScope === 'private') {
      return (): void => {
        cancelled = true;
      };
    }
    void resolveSharedRunUrl(existingShare.externalId).then((url) => {
      if (!cancelled && url) setExistingLink({ url, kind: 'scoped' });
    });
    return (): void => {
      cancelled = true;
    };
  }, [existingShare]);

  const preflight =
    useCallback(async (): Promise<ShareResourcePreflightResult> => {
      if (runtimeUnavailable) {
        return { status: 'blocked', body: unavailableBody(runtimeUnavailable) };
      }
      if (!checkEligibility) return { status: 'ready' };
      try {
        const result = await checkEligibility();
        if (result.shareable) return { status: 'ready' };
        const unavailable = unavailableFromRefusal(result);
        return unavailable
          ? { status: 'blocked', body: unavailableBody(unavailable) }
          : { status: 'ready' };
      } catch {
        return { status: 'ready' };
      }
    }, [checkEligibility, runtimeUnavailable]);

  const share = useCallback(
    async (input: ShareResourceShareInput): Promise<ShareResourceOutcome> => {
      if (input.scope !== 'team' && input.scope !== 'organization') {
        throw new Error('Choose a team or organization for this session.');
      }
      const result = await onShare({
        shareScope: input.scope,
        ...(input.teamId ? { teamId: input.teamId } : {}),
        ...(input.organizationId
          ? { organizationId: input.organizationId }
          : {}),
      });
      if (!result.externalId) {
        if (result.reason === 'blocked-by-org-billing') {
          throw new Error(
            billingBlockedDescription(result.blockedByOrganizationNames),
          );
        }
        const unavailable = unavailableFromRefusal(result);
        if (unavailable) {
          setRuntimeUnavailable(unavailable);
          throw new Error('This session is no longer available to share.');
        }
        throw new Error('The session could not be shared.');
      }
      pending.current = {
        externalId: result.externalId,
        shareScope: input.scope,
        ...(input.scope === 'team' && input.teamId
          ? { teamId: input.teamId, teamName: input.targetName }
          : {}),
        ...(input.scope === 'organization' && input.organizationId
          ? {
              organizationId: input.organizationId,
              organizationName: input.targetName,
            }
          : {}),
      };
      return {
        shareUrl: (await resolveSharedRunUrl(result.externalId)) ?? undefined,
      };
    },
    [onShare],
  );

  const handleCompleted = useCallback(async (): Promise<void> => {
    if (!pending.current) return;
    const result = pending.current;
    await onShared?.(result);
    pending.current = null;
  }, [onShared]);

  const notes = useMemo(
    () => (
      <p className="text-xs fg-secondary" data-testid="share-run-disclaimer">
        {SHARED_RUN_DISCLOSURE}
      </p>
    ),
    [],
  );

  return (
    <DesktopShareResourceDialog
      resourceNoun="session"
      testIdPrefix="share-run"
      requiredCapability="runs-crud-v1"
      scopes={SHARE_SCOPES}
      subtitle={runTitle}
      ownerDocument={ownerDocument}
      notes={notes}
      preflight={preflight}
      {...(existingShare
        ? {
            existingShare: existingShareFromMetadata(
              existingShare,
              existingLink,
            ),
          }
        : {})}
      share={share}
      onClose={onClose}
      onCompleted={handleCompleted}
    />
  );
}
