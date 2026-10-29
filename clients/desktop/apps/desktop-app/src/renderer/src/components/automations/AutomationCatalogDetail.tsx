import { requestAutomationProjectCreation } from '@/stores/automationInstallContinuationStore';
import { type JSX, useCallback, useEffect, useRef, useState } from 'react';
import { Notice, NoticeButton } from '@canopy/ui-shared';
import { DetailPageActions, BusyLabel } from '@canopy/ui-shared/components';
import { AutomationDefinitionSummary } from '@canopy/ui-shared/components/AutomationDefinitionSummary';
import { describeFiveFieldCron } from '@canopy/ui-shared/lib/cron-description';
import { SECONDARY_ACTION_BUTTON_CLASS } from '@canopy/ui-shared/lib/row-chips';
import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import { getAutomationTriggerLabel } from '@canopy/desktop-shared/lib/automations';
import type {
  SharedAutomationDetail,
  SharedAutomationInstallSource,
} from '@canopy/protocol/automations';
import {
  toCuratedAutomationInstallSource,
  type CuratedAutomationDetail,
} from '@canopy/protocol/automation-catalog';
import { CUSTOMIZE_LABEL } from '@canopy/protocol/ui-labels';
import { useInstallWorkspaces } from '@/hooks/useInstallWorkspaces';
import {
  installedCopiesOf,
  localBadgeForSummary,
  staleCopiesOf,
  type AutomationInstallSourceKind,
} from '@/lib/automationShareRelationship';
import { resolveSharedResourceErrorMessage } from '@/lib/sharedResourceErrors';
import { LoadingPlaceholder } from '../shared';
import { McpServerLogo } from '../shared/McpServerLogo';
import { InstallSharedAutomationModal } from './InstallSharedAutomationModal';
import { SharedAutomationPreview } from './SharedAutomationPreview';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  curatedAutomationInstallLink,
  sharedResourceInstallLink,
} from '@/lib/sharedResourceInstallLink';

/**
 * Marketplace detail surfaces for the three automation sources: a local
 * automation, a team-shared one, and a curated catalog entry. Each is a read
 * view plus one next step. Editing stays on the Workflows page. Adding opens
 * the shared install review (CAN-3710). Updating, which may pick among
 * several stale copies, and "Install another copy" still open the wizard
 * here until the review can collect those inputs.
 */

const PRIMARY_ACTION_CLASS =
  'focus-ring inline-flex h-7 shrink-0 items-center rounded-md bg-accent px-3 text-xs font-medium fg-emphasis transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50';

/** Sources a Marketplace install or update can read from. */
type MarketplaceAutomationSourceKind = Exclude<
  AutomationInstallSourceKind,
  'public'
>;

function describeTrigger(activity: ScheduledActivity): string {
  const label = getAutomationTriggerLabel(activity.schedule);
  if (activity.schedule.kind === 'cron') {
    return `${label} · ${
      describeFiveFieldCron(activity.schedule.expression) ??
      activity.schedule.expression
    }`;
  }
  if (activity.schedule.kind === 'one_time') {
    return `${label} · ${new Date(activity.schedule.runAt).toLocaleString()}`;
  }
  return label;
}

function describeOrigin(activity: ScheduledActivity): string {
  if (activity.installedFrom) {
    switch (activity.installedFrom.sourceKind ?? 'shared') {
      case 'curated':
        return `Added from ${CUSTOMIZE_LABEL}`;
      case 'public':
        return 'Added from a public link';
      case 'shared':
        return 'Added from a shared automation';
    }
  }
  return activity.remote ? 'Shared by you' : 'Local';
}

/** The Marketplace source a local copy can be updated from, if it has one. */
function updateSourceOf(
  activity: ScheduledActivity,
): { sourceKind: MarketplaceAutomationSourceKind; remoteId: string } | null {
  if (!activity.installedFrom) return null;
  const sourceKind = activity.installedFrom.sourceKind ?? 'shared';
  if (sourceKind === 'public') return null;
  return { sourceKind, remoteId: activity.installedFrom.remoteId };
}

interface AutomationCatalogDetailProps {
  activity: ScheduledActivity;
  /** One line saying when the automation runs and what it does. */
  summary: string;
  /** The source this copy was installed from has changed since. */
  updateAvailable: boolean;
  onOpenInAutomations: () => void;
}

/** Read-only Marketplace summary of a local automation. */
export function AutomationCatalogDetail({
  activity,
  summary,
  updateAvailable,
  onOpenInAutomations,
}: AutomationCatalogDetailProps): JSX.Element {
  const workspaces = useInstallWorkspaces();
  const [updateSource, setUpdateSource] = useState<{
    sourceKind: MarketplaceAutomationSourceKind;
    detail: SharedAutomationInstallSource;
  } | null>(null);
  const [loadingUpdate, setLoadingUpdate] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const requestRef = useRef(0);
  useEffect(
    () => (): void => {
      requestRef.current += 1;
    },
    [],
  );

  const source = updateSourceOf(activity);
  const sourceKind = source?.sourceKind ?? null;
  const sourceRemoteId = source?.remoteId ?? null;
  const openUpdate = useCallback(async (): Promise<void> => {
    if (sourceKind === null || sourceRemoteId === null) return;
    const request = ++requestRef.current;
    setLoadingUpdate(true);
    setUpdateError(null);
    try {
      const detail =
        sourceKind === 'curated'
          ? toCuratedAutomationInstallSource(
              await window.api.automations.getCurated(sourceRemoteId),
            )
          : await window.api.automations.getShared(sourceRemoteId);
      if (requestRef.current !== request) return;
      setUpdateSource({ sourceKind, detail });
    } catch (error: unknown) {
      if (requestRef.current !== request) return;
      setUpdateError(
        resolveSharedResourceErrorMessage(error, {
          unsupportedResource: 'automations',
        }),
      );
    } finally {
      if (requestRef.current === request) setLoadingUpdate(false);
    }
  }, [sourceKind, sourceRemoteId]);

  const canUpdate = updateAvailable && source !== null;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-6"
      data-testid="automation-catalog-detail"
    >
      <div className="flex items-start gap-3">
        <McpServerLogo
          size={40}
          fallback="monogram"
          name={activity.name}
          shape="circle"
          fit="contain"
        />
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold fg-primary">
            {activity.name}
          </h2>
          <p
            className="mt-0.5 text-xs fg-secondary"
            data-testid="automation-catalog-origin"
          >
            {describeOrigin(activity)}
          </p>
        </div>
        {/* Page actions join the detail's action bar: Update is primary when
            it applies, with Open beside it as a secondary. */}
        <DetailPageActions
          secondary={
            canUpdate ? (
              <button
                type="button"
                onClick={onOpenInAutomations}
                data-testid="automation-catalog-open"
                className={SECONDARY_ACTION_BUTTON_CLASS}
              >
                Open in Workflows
              </button>
            ) : undefined
          }
          primary={
            canUpdate ? (
              <button
                type="button"
                onClick={() => void openUpdate()}
                disabled={loadingUpdate}
                data-testid="automation-catalog-update"
                className={PRIMARY_ACTION_CLASS}
              >
                <BusyLabel busy={loadingUpdate}>Update</BusyLabel>
              </button>
            ) : (
              <button
                type="button"
                onClick={onOpenInAutomations}
                data-testid="automation-catalog-open"
                className={PRIMARY_ACTION_CLASS}
              >
                Open in Workflows
              </button>
            )
          }
        />
      </div>

      {canUpdate && (
        <Notice
          intent="neutral"
          role="none"
          title="Update available."
          data-testid="automation-catalog-update-available"
        >
          The automation this copy came from has changed. Updating keeps your
          project and inputs.
        </Notice>
      )}

      {updateError !== null && (
        <Notice
          intent="destructive"
          title="Couldn't load the update."
          data-testid="automation-catalog-update-error"
          actions={
            <NoticeButton onClick={() => void openUpdate()}>Retry</NoticeButton>
          }
        >
          {updateError}
        </Notice>
      )}

      {/* The entry description quotes the automation's prompt: blocked. */}
      <p
        className={`${POSTHOG_REPLAY_BLOCK_CLASS} text-sm fg-secondary`}
        data-testid="automation-catalog-summary"
      >
        {summary}
      </p>

      <dl className="grid gap-4 border-t pt-4 text-s sm:grid-cols-2">
        <div>
          <dt className="text-xs fg-secondary">Trigger</dt>
          <dd className="fg-primary" data-testid="automation-catalog-trigger">
            {describeTrigger(activity)}
          </dd>
        </div>
        <div>
          <dt className="text-xs fg-secondary">Status</dt>
          <dd className="fg-primary" data-testid="automation-catalog-status">
            {activity.enabled ? 'Enabled' : 'Disabled'}
          </dd>
        </div>
      </dl>

      {updateSource && (
        <InstallSharedAutomationModal
          onCreateProject={requestAutomationProjectCreation}
          detail={updateSource.detail}
          source={updateSource.sourceKind}
          staleActivities={[activity]}
          workspaces={workspaces}
          onClose={(): void => setUpdateSource(null)}
          onDone={(): void => {
            // The automations store refreshes through the service broadcast,
            // and the Marketplace row recomputes from it.
          }}
        />
      )}
    </div>
  );
}

/**
 * What the detail offers next for a team-shared or curated automation:
 * add it, update the installed copies, or open the copy that already exists.
 */
type SourceNextStep =
  | { kind: 'add' }
  | { kind: 'update'; staleActivities: ScheduledActivity[] }
  | { kind: 'open'; activityId: string };

function nextStepFor(
  activities: readonly ScheduledActivity[],
  source: {
    sourceKind: MarketplaceAutomationSourceKind;
    remoteId: string;
    contentHash: string;
  },
  sharedByActivityId: string | null,
): SourceNextStep {
  if (sharedByActivityId !== null) {
    return { kind: 'open', activityId: sharedByActivityId };
  }
  const stale = staleCopiesOf(activities, source);
  if (stale.length > 0) return { kind: 'update', staleActivities: stale };
  const installed = installedCopiesOf(activities, source)[0];
  return installed
    ? { kind: 'open', activityId: installed.id }
    : { kind: 'add' };
}

interface SourceActionProps {
  step: SourceNextStep;
  onInstall: () => void;
  /**
   * Installs an independent new copy while one already exists (or the user
   * shared this automation), the way the retired Shared tab's Install did.
   */
  onInstallAnotherCopy: () => void;
  onOpenInAutomations: (activityId: string) => void;
}

function SourceAction({
  step,
  onInstall,
  onInstallAnotherCopy,
  onOpenInAutomations,
}: SourceActionProps): JSX.Element {
  // The detail's primary action, in its action bar at the top right.
  if (step.kind === 'open') {
    return (
      <DetailPageActions
        secondary={
          <button
            type="button"
            onClick={onInstallAnotherCopy}
            data-testid="automation-catalog-install-another-copy"
            className={SECONDARY_ACTION_BUTTON_CLASS}
          >
            Install another copy
          </button>
        }
        primary={
          <button
            type="button"
            onClick={() => onOpenInAutomations(step.activityId)}
            data-testid="automation-source-open"
            className={PRIMARY_ACTION_CLASS}
          >
            Open in Workflows
          </button>
        }
      />
    );
  }
  return (
    <DetailPageActions
      primary={
        <button
          type="button"
          onClick={onInstall}
          data-testid="automation-source-install"
          className={PRIMARY_ACTION_CLASS}
        >
          {step.kind === 'update' ? 'Update' : 'Add'}
        </button>
      }
    />
  );
}

interface SharedAutomationMarketplaceDetailProps {
  automationId: string;
  /** Every local automation, used to tell whether this share is installed. */
  activities: readonly ScheduledActivity[];
  onOpenInAutomations: (activityId: string) => void;
  /**
   * Reports the share's name once it loads, for a host that opened the
   * detail by id before its inventory listed the share.
   */
  onNameLoaded?: (name: string) => void;
}

/** A team-shared automation: the share's preview plus Add, Update, or Open. */
export function SharedAutomationMarketplaceDetail({
  automationId,
  activities,
  onOpenInAutomations,
  onNameLoaded,
}: SharedAutomationMarketplaceDetailProps): JSX.Element {
  const workspaces = useInstallWorkspaces();
  const [detail, setDetail] = useState<SharedAutomationDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [installOpen, setInstallOpen] = useState(false);
  const [anotherCopyOpen, setAnotherCopyOpen] = useState(false);
  const onNameLoadedRef = useRef(onNameLoaded);
  useEffect(() => {
    onNameLoadedRef.current = onNameLoaded;
  });
  const loadedName = detail?.name ?? null;
  useEffect(() => {
    if (loadedName !== null) onNameLoadedRef.current?.(loadedName);
  }, [loadedName]);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    window.api.automations
      .getShared(automationId)
      .then((next) => {
        if (cancelled) return;
        setDetail(next);
      })
      .catch((failure: unknown) => {
        if (cancelled) return;
        setError(
          resolveSharedResourceErrorMessage(failure, {
            unsupportedResource: 'automations',
          }),
        );
      });
    return (): void => {
      cancelled = true;
    };
  }, [automationId, reloadKey]);

  const badge = detail ? localBadgeForSummary(detail, activities) : null;
  const sharedByActivityId =
    badge === 'shared-by-you'
      ? (activities.find((activity) => activity.remote?.remoteId === detail?.id)
          ?.id ?? null)
      : null;
  const step: SourceNextStep = detail
    ? nextStepFor(
        activities,
        {
          sourceKind: 'shared',
          remoteId: detail.id,
          contentHash: detail.contentHash,
        },
        sharedByActivityId,
      )
    : { kind: 'add' };

  // A team or organization share adds through the shared review; a private
  // one resolves for nobody else, so it keeps the wizard here.
  const installLink = detail
    ? sharedResourceInstallLink({
        entity: 'automation',
        externalId: detail.id,
        scope: detail.shareScope,
      })
    : null;
  const handleInstall = (): void => {
    if (step.kind === 'update' || installLink === null) {
      setInstallOpen(true);
      return;
    }
    useNavigationStore.getState().openShareInstall(installLink, 'in-app');
  };

  if (error !== null) {
    return (
      <Notice
        intent="destructive"
        title="Couldn't load this automation."
        data-testid="automation-source-error"
        actions={
          <NoticeButton onClick={() => setReloadKey((value) => value + 1)}>
            Retry
          </NoticeButton>
        }
      >
        {error}
      </Notice>
    );
  }
  if (!detail) {
    return <LoadingPlaceholder label="Loading automation…" space="section" />;
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-4"
      data-testid="shared-automation-marketplace-detail"
    >
      <SharedAutomationPreview detail={detail} localBadge={badge} />
      <SourceAction
        step={step}
        onInstall={handleInstall}
        onInstallAnotherCopy={() => setAnotherCopyOpen(true)}
        onOpenInAutomations={onOpenInAutomations}
      />
      {installOpen && step.kind !== 'open' && (
        <InstallSharedAutomationModal
          onCreateProject={requestAutomationProjectCreation}
          detail={detail}
          source="shared"
          staleActivities={step.kind === 'update' ? step.staleActivities : []}
          workspaces={workspaces}
          onClose={(): void => setInstallOpen(false)}
          onDone={(): void => {
            // The automations store refreshes through the service broadcast;
            // the next step recomputes from the updated activities.
          }}
        />
      )}
      {anotherCopyOpen && (
        <InstallSharedAutomationModal
          onCreateProject={requestAutomationProjectCreation}
          detail={detail}
          source="shared"
          // An independent new copy: never an update of an existing one.
          staleActivities={[]}
          workspaces={workspaces}
          onClose={(): void => setAnotherCopyOpen(false)}
          onDone={(): void => {
            // The automations store refreshes through the service broadcast.
          }}
        />
      )}
    </div>
  );
}

interface CuratedAutomationMarketplaceDetailProps {
  /** Entry name shown while the catalog detail is still loading. */
  name: string;
  detail: CuratedAutomationDetail | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  activities: readonly ScheduledActivity[];
  onOpenInAutomations: (activityId: string) => void;
}

/** A curated catalog automation: what it does, plus Add, Update, or Open. */
export function CuratedAutomationMarketplaceDetail({
  name,
  detail,
  loading,
  error,
  onRetry,
  activities,
  onOpenInAutomations,
}: CuratedAutomationMarketplaceDetailProps): JSX.Element {
  const workspaces = useInstallWorkspaces();
  const [updateOpen, setUpdateOpen] = useState(false);
  const [anotherCopyOpen, setAnotherCopyOpen] = useState(false);

  const step: SourceNextStep = detail
    ? nextStepFor(
        activities,
        {
          sourceKind: 'curated',
          remoteId: detail.key,
          contentHash: detail.contentHash,
        },
        null,
      )
    : { kind: 'add' };

  if (error !== null) {
    return (
      <Notice
        intent="destructive"
        title="Couldn't load this automation."
        data-testid="automation-source-error"
        actions={<NoticeButton onClick={onRetry}>Retry</NoticeButton>}
      >
        {error}
      </Notice>
    );
  }
  if (!detail || loading) {
    return <LoadingPlaceholder label="Loading automation…" space="section" />;
  }

  const schedule =
    describeFiveFieldCron(detail.cronExpression) ?? detail.cronExpression;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-6"
      data-testid="curated-automation-marketplace-detail"
    >
      <div className="flex items-start gap-3">
        <McpServerLogo
          size={40}
          fallback="monogram"
          name={detail.name || name}
          shape="circle"
          fit="contain"
        />
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold fg-primary">{detail.name}</h2>
          <p className="mt-0.5 text-xs fg-secondary">
            {detail.authorName ? `Curated · ${detail.authorName}` : 'Curated'}
          </p>
        </div>
        <SourceAction
          step={step}
          onInstall={(): void => {
            if (step.kind === 'update') {
              setUpdateOpen(true);
              return;
            }
            useNavigationStore
              .getState()
              .openShareInstall(curatedAutomationInstallLink(detail), 'in-app');
          }}
          onInstallAnotherCopy={() => setAnotherCopyOpen(true)}
          onOpenInAutomations={onOpenInAutomations}
        />
      </div>

      {step.kind === 'update' && (
        <Notice
          intent="neutral"
          role="none"
          title="Update available."
          data-testid="automation-catalog-update-available"
        >
          This automation has changed since you added it. Updating keeps your
          project and inputs.
        </Notice>
      )}

      {detail.shortDescription && (
        <p className="text-sm fg-secondary">{detail.shortDescription}</p>
      )}

      <dl className="grid gap-4 border-t pt-4 text-s sm:grid-cols-2">
        <div>
          <dt className="text-xs fg-secondary">Schedule</dt>
          <dd className="fg-primary" data-testid="curated-automation-schedule">
            {schedule}
          </dd>
        </div>
      </dl>

      <AutomationDefinitionSummary automation={detail.automation} />

      {updateOpen && step.kind === 'update' && (
        <InstallSharedAutomationModal
          onCreateProject={requestAutomationProjectCreation}
          detail={toCuratedAutomationInstallSource(detail)}
          source="curated"
          staleActivities={step.staleActivities}
          workspaces={workspaces}
          onClose={(): void => setUpdateOpen(false)}
          onDone={(): void => {
            // The automations store refreshes through the service broadcast;
            // the next step recomputes from the updated activities.
          }}
        />
      )}
      {anotherCopyOpen && (
        <InstallSharedAutomationModal
          onCreateProject={requestAutomationProjectCreation}
          detail={toCuratedAutomationInstallSource(detail)}
          source="curated"
          // An independent new copy: never an update of an existing one.
          staleActivities={[]}
          workspaces={workspaces}
          onClose={(): void => setAnotherCopyOpen(false)}
          onDone={(): void => {
            // The automations store refreshes through the service broadcast.
          }}
        />
      )}
    </div>
  );
}
