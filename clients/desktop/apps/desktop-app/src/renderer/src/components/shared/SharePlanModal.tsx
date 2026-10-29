import {
  type JSX,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { TrackedPlanData } from '@canopy/desktop-shared/types';
import type {
  ShareResourceExistingShare,
  ShareDialogLink,
  ShareResourceDialogState,
  ShareResourceOutcome,
  ShareResourceScope,
  ShareResourceShareInput,
} from '@canopy/ui-app/sharing';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { resolveSharedPlanUrl } from '@/lib/share-links';
import { DesktopShareResourceDialog } from './share/DesktopShareResourceDialog';

export type PlanShareScope = 'team' | 'organization';

const SHARE_SCOPES: readonly ShareResourceScope[] = ['team', 'organization'];

export interface SharePlanShareRequest {
  shareScope: PlanShareScope;
  teamId?: string;
  organizationId?: string;
}

interface SharePlanModalProps {
  planId?: string;
  planTitle?: string;
  existingShare?: TrackedPlanData['share'];
  onClose: () => void;
  onShare: (request: SharePlanShareRequest) => Promise<TrackedPlanData | null>;
  onShared?: (plan: TrackedPlanData) => void;
}

/** Tracked-plan upsert binding around the common share dialog. */
export function SharePlanModal({
  planId,
  planTitle,
  existingShare: planShare,
  onClose,
  onShare,
  onShared,
}: SharePlanModalProps): JSX.Element {
  const pendingPlan = useRef<TrackedPlanData | null>(null);
  const [existingLink, setExistingLink] = useState<ShareDialogLink | null>(
    null,
  );
  const [dialogState, setDialogState] = useState<ShareResourceDialogState>({
    audience:
      planShare?.shareScope === 'team' ||
      planShare?.shareScope === 'organization'
        ? planShare.shareScope
        : null,
    ...(planShare?.shareScope === 'team' && planShare.teamId
      ? { teamId: planShare.teamId }
      : {}),
    ...(planShare?.shareScope === 'organization' && planShare.organizationId
      ? { organizationId: planShare.organizationId }
      : {}),
    available: false,
    busy: false,
    status: 'idle',
    copied: false,
  });
  useEffect(() => {
    let cancelled = false;
    setExistingLink(null);
    const remoteId = planShare?.remoteId;
    if (!remoteId || planShare?.shareScope === 'private') {
      return (): void => {
        cancelled = true;
      };
    }
    void resolveSharedPlanUrl(remoteId).then((url) => {
      if (!cancelled && url) setExistingLink({ url, kind: 'scoped' });
    });
    return (): void => {
      cancelled = true;
    };
  }, [planShare?.remoteId, planShare?.shareScope]);
  const existingShare = useMemo((): ShareResourceExistingShare | undefined => {
    if (!planShare || planShare.shareScope === 'private') return undefined;
    const target =
      planShare.shareScope === 'team' && planShare.teamId
        ? { id: planShare.teamId, name: 'Current team' }
        : planShare.shareScope === 'organization' && planShare.organizationId
          ? { id: planShare.organizationId, name: 'Current organization' }
          : undefined;
    return {
      audience: planShare.shareScope,
      ...(target ? { target } : {}),
      ...(existingLink ? { link: existingLink } : {}),
    };
  }, [existingLink, planShare]);

  const share = useCallback(
    async (input: ShareResourceShareInput): Promise<ShareResourceOutcome> => {
      const plan = await onShare({
        shareScope: input.scope as PlanShareScope,
        ...(input.teamId ? { teamId: input.teamId } : {}),
        ...(input.organizationId
          ? { organizationId: input.organizationId }
          : {}),
      });
      if (!plan) throw new Error('The plan could not be shared.');
      pendingPlan.current = plan;
      // The dialog's success toast carries the link; best-effort, so the
      // toast still fires without one when the cloud base URL is unavailable.
      const remoteId = plan.share?.remoteId;
      const shareUrl = remoteId ? await resolveSharedPlanUrl(remoteId) : null;
      return shareUrl ? { shareUrl } : {};
    },
    [onShare],
  );

  const handleCompleted = useCallback((): void => {
    if (!pendingPlan.current) return;
    const plan = pendingPlan.current;
    onShared?.(plan);
    pendingPlan.current = null;
  }, [onShared]);

  useCurrentUiStateReporter('plans.shareModal', {
    open: true,
    ...(planId ? { planId } : {}),
    ...(planTitle ? { planTitle } : {}),
    ...(dialogState.audience ? { scope: dialogState.audience } : {}),
    busy: dialogState.busy,
    ...(dialogState.teamId ? { teamId: dialogState.teamId } : {}),
    ...(dialogState.organizationId
      ? { organizationId: dialogState.organizationId }
      : {}),
  });

  return (
    <DesktopShareResourceDialog
      resourceNoun="plan"
      testIdPrefix="share-plan"
      requiredCapability="plans-crud-v1"
      scopes={SHARE_SCOPES}
      subtitle={planTitle}
      {...(existingShare ? { existingShare } : {})}
      share={share}
      onClose={onClose}
      onCompleted={handleCompleted}
      onStateChange={setDialogState}
    />
  );
}
