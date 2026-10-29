import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DeepLinkResolveShareResponse,
  DeepLinkShareOpenEvent,
  PublicShareSnapshot,
  ScheduledActivity,
} from '@canopy/desktop-shared/types';
import type { CollectionConfig } from '@canopy/desktop-shared/types/collections';
import type { PipelinePackageReadiness } from '@canopy/desktop-shared/types/pipeline';
import {
  formatPipelinePackageInstalledStatus,
  formatPipelinePackageTransferLabel,
} from '@canopy/ui-shared/lib/pipeline-package-display';
import {
  CUSTOM_SKILL_SOURCE_ID,
  findInstalledSkillByContentHash,
  describeSharedSkillImportNotice,
  importSharedSkill,
} from '@/lib/sharedSkillImport';
import { findInstalledPipelineByContent } from '@/lib/publicShareInstallState';
import { findInstalledAutomationByOrigin } from '@/lib/publicAutomationInstallState';
import { buildSkillStarterPrompt } from '@/lib/publicShareExamplePrompt';
import { stageSkillStarterPrompt } from '@/lib/publicShareTryNowStaging';
import { parseSkillSource } from '@/lib/skillFrontmatter';
import { formatUnresolvedCapabilitiesNotice } from '@/lib/unresolvedCapabilities';
import { tryParseAndValidateYaml } from '@/lib/pipeline-yaml';
import { useNavigationStore } from '@/stores/navigationStore';
import { useChatStore } from '@/stores/chatStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { useProjectsStore } from '@/stores/projectsStore';
import {
  findInstalledSharedPluginTarget,
  installSharedPluginRef,
} from '@/lib/publicSharePluginInstall';
import { resolveSharedCollectionImport } from '@/lib/sharedCollectionImport';

/**
 * Shell-agnostic state machine for the public-share landing surface
 * (CAN-2361 v2): resolve the pinned snapshot → detect installed state → one
 * adaptive primary action (Install → Try now) plus kebab actions
 * (Manage/Uninstall). Deliberately contains no modal (or any other chrome)
 * coupling so the same logic drives today's deep-link modal and, later, a
 * routed unified detail page — swapping the shell must not touch the parser,
 * IPC, resolve endpoints, or this hook. Nothing here auto-submits, and nothing
 * installs without a click (CAN-3710): every install is the review's one
 * primary action, whatever the link's intent.
 *
 * `intent=try` is behavioral (PR2b): when the arrival detection finds THIS
 * pinned version already installed, the landing auto-invokes the same
 * staging `tryNow` performs — a prefilled composer draft for skills, the
 * preselected dispatch modal (or editor fallback) for pipelines — and closes
 * itself via `onAutoNavigate`. Staging only: nothing is ever auto-submitted
 * or auto-run. When the entity is NOT installed, `try` degrades to the
 * normal Install review state, exactly like the default intent.
 */

// Same literal the App Advisor dispatcher broadcasts after skill mutations so
// the Skills tab refreshes (`dispatcher.ts` keeps its own private copy).
const SKILLS_CHANGED_EVENT = 'canopy:skills-changed';

/**
 * Shown when a package share resolves but this build cannot install packages.
 * Deliberately not a YAML-only fallback: installing the definition alone would
 * present an incomplete pipeline as a successful install.
 */
const PACKAGE_UPGRADE_REQUIRED_MESSAGE =
  'This shared pipeline includes dependencies that this version cannot install. Update the desktop app to continue.';
const DEFINITION_ONLY_INSTALLED_STATUS =
  'Pipeline definition installed without dependencies.';

type ResolveFailure = Extract<
  DeepLinkResolveShareResponse,
  { ok: false }
>['reason'];

export type PublicShareLandingPhase =
  | { phase: 'loading' }
  | { phase: 'error'; reason: ResolveFailure }
  | { phase: 'ready'; snapshot: PublicShareSnapshot };

export type PublicShareInstalledTarget =
  | { entity: 'skill'; sourceId: string; skillName: string }
  | {
      entity: 'pipeline';
      pipelineId: string;
      /** Package digest recorded in the local install ledger, when packaged. */
      packageDigest?: string;
      /** True when the share was republished with newer packaged content. */
      updateAvailable?: boolean;
    }
  | {
      entity: 'plugin';
      marketplaceId: string;
      pluginName: string;
      entryId: string;
    }
  | { entity: 'agent'; agentId: string }
  | { entity: 'workspace'; projectId: string }
  | { entity: 'collection'; collectionId: string }
  | {
      entity: 'automation';
      activityId: string;
      /** True when the share was republished with a changed document. */
      updateAvailable?: boolean;
    };

/** What one finished install produced, for the review to land on. */
export interface PublicShareInstallResult {
  target: PublicShareInstalledTarget;
  /** The install's terminal status (a partial success), or empty. */
  status: string;
  /** Something the share carries did not land; the notice warns. */
  partial: boolean;
}

export interface PublicShareLanding {
  state: PublicShareLandingPhase;
  snapshot: PublicShareSnapshot | null;
  /** True while the arrival installed-state detection is running. */
  detecting: boolean;
  installed: PublicShareInstalledTarget | null;
  installing: boolean;
  installError: string;
  uninstalling: boolean;
  /**
   * Progress label while a packaged install transfers dependencies
   * (`Installing 2 of 5 dependencies…`), otherwise empty.
   */
  installProgress: string;
  /** Terminal status after an install, e.g. `Installed with 5 dependencies.` */
  installStatus: string;
  /** Machine-specific setup state for a packaged public Agent. */
  agentReadiness: PipelinePackageReadiness | null;
  agentReadinessLoading: boolean;
  /**
   * True while a team or organization agent's snapshot is read for the
   * review; Install waits for it, since it installs exactly that snapshot.
   */
  agentReviewLoading: boolean;
  /** Machine-specific setup state for a packaged public Blueprint. */
  workspaceReadiness: PipelinePackageReadiness | null;
  workspaceReadinessLoading: boolean;
  /**
   * Explicit install: local skill import / local pipeline save. Idempotent.
   * Resolves the installed target, or null when nothing was installed (a
   * failure, or an automation install opening its review).
   */
  install: () => Promise<PublicShareInstallResult | null>;
  /**
   * Explicit "Try now": stages an example task, ready for the user to
   * submit — skills prefill a chat composer (new tab in the active worktree,
   * or the Home composer when none is selected); pipelines open the saved
   * pipeline's editor, whose Run affordance is one click away (dispatch-modal
   * prefill lands in the follow-up PR). Never auto-submits.
   */
  tryNow: (onNavigate?: () => void) => void;
  /** Opens the installed entity's management surface (viewer/editor). */
  manage: (onNavigate?: () => void) => void;
  /** Removes the local installed copy; resolves whether it was removed. */
  uninstall: () => Promise<boolean>;
  /**
   * Set when an automation install is under review. Installing an automation
   * is a rebind — the recipient picks a workspace, a branch, and confirms the
   * capability package — so it opens the wizard instead of writing anything.
   */
  installReview: {
    entity: 'automation';
    externalId: string;
    staleActivity?: ScheduledActivity;
  } | null;
  /**
   * True while an automation link is on its way into the install review:
   * the snapshot resolved and either detection is still running or the
   * review is about to open. The shell shows a loading state instead of the
   * landing so the preview never flashes before the review.
   */
  openingInstallReview: boolean;
  /** Dismiss the review without installing. */
  closeInstallReview: () => void;
  /** Record a completed wizard install and report the INSTALLED leg. */
  completeInstallReview: (activityId: string) => void;
}

async function detectInstalled(
  snapshot: PublicShareSnapshot,
  audience?: DeepLinkShareOpenEvent['audience'],
): Promise<PublicShareInstalledTarget | null> {
  if (snapshot.entity === 'automation') {
    const { activities } = await window.api.automations.list();
    const scoped = audience === 'TEAM' || audience === 'ORGANIZATION';
    const sourceKind =
      snapshot.sourceKind === 'curated'
        ? 'curated'
        : scoped
          ? 'shared'
          : 'public';
    const found = findInstalledAutomationByOrigin(
      activities,
      {
        sourceKind,
        remoteId: snapshot.externalId,
      },
      snapshot.contentHash,
    );
    return found
      ? {
          entity: 'automation',
          activityId: found.activityId,
          updateAvailable: found.updateAvailable,
        }
      : null;
  }
  if (snapshot.entity === 'skill') {
    const found = await findInstalledSkillByContentHash(snapshot.contentHash);
    // Publisher folders need their supporting package, not just an identical
    // SKILL.md left by an interrupted download. The native catalog joins the
    // completed package ledger to this context's visible local inventory.
    if (
      found &&
      snapshot.publisher &&
      snapshot.distributionMode === 'package'
    ) {
      const catalog = await window.skills.listMarketplace();
      if (
        !catalog.some(
          (skill) =>
            skill.externalId === snapshot.externalId &&
            skill.installedSkillName === found.skillName &&
            skill.installedPackageDigest === snapshot.package?.digest,
        )
      )
        return null;
    }
    return found
      ? {
          entity: 'skill',
          sourceId: found.sourceId,
          skillName: found.skillName,
        }
      : null;
  }
  if (snapshot.entity === 'plugin') {
    return findInstalledSharedPluginTarget(snapshot.ref);
  }
  if (snapshot.entity === 'workspace') {
    const projects = await window.api.chatProject.list();
    const found = projects.projects.find(
      (project) =>
        project.installedFromTemplateExternalId === snapshot.externalId &&
        project.installedFromTemplateContentHash !== undefined,
    );
    return found ? { entity: 'workspace', projectId: found.id } : null;
  }
  if (snapshot.entity === 'agent') {
    if (snapshot.sourceRemoteId) {
      const { agents } = await window.agents.list();
      const found = agents.find(
        (agent) =>
          agent.importedFromRemoteId === snapshot.sourceRemoteId &&
          agent.remoteId === snapshot.sourceRemoteId &&
          agent.remoteContentHash === snapshot.contentHash &&
          agent.importedContentHash !== undefined &&
          agent.contentHash === agent.importedContentHash,
      );
      return found ? { entity: 'agent', agentId: found.id } : null;
    }
    const found = await window.agents.detectPublic({
      agent: snapshot.agent,
      externalId: snapshot.externalId,
      contentHash: snapshot.contentHash,
      ...(snapshot.package ? { package: snapshot.package } : {}),
    });
    return found ? { entity: 'agent', agentId: found.id } : null;
  }
  if (snapshot.entity === 'collection') {
    const index = await window.collections.loadIndex();
    for (const row of index) {
      const collection = await window.collections.loadCollection(row.id);
      const source = collection?.sharedSource;
      // A Public install pins the snapshot it verified, so a republished share
      // offers Install again. Scoped imports carry no hash and match by id.
      if (
        collection &&
        source?.remoteId === snapshot.externalId &&
        (source.contentHash === undefined ||
          source.contentHash === snapshot.contentHash)
      ) {
        return { entity: 'collection', collectionId: collection.id };
      }
    }
    return null;
  }
  // Package shares are identified by share + YAML hash + package digest
  // together, so a republished package reads as "update available" rather
  // than as already installed.
  const found = await findInstalledPipelineByContent(
    snapshot.rawPipeline,
    snapshot.distributionMode === 'package'
      ? snapshot.package?.digest
      : undefined,
    snapshot.externalId,
    snapshot.contentHash,
  );
  if (!found) return null;
  return {
    entity: 'pipeline',
    pipelineId: found.pipelineId,
    ...(found.installedPackageDigest
      ? { packageDigest: found.installedPackageDigest }
      : {}),
    ...(found.updateAvailable !== undefined
      ? { updateAvailable: found.updateAvailable }
      : {}),
  };
}

/**
 * A pipeline snapshot is packaged when the server explicitly says so. Missing
 * `distributionMode` is legacy definition-only data — never a package whose
 * fields were dropped, because a server that knows the share is packaged
 * answers `426` to an incapable client instead of omitting them.
 */
function isPackageSnapshot(snapshot: PublicShareSnapshot): snapshot is Extract<
  PublicShareSnapshot,
  { entity: 'pipeline' }
> & {
  distributionMode: 'package';
} {
  return (
    snapshot.entity === 'pipeline' && snapshot.distributionMode === 'package'
  );
}

export interface PublicShareLandingOptions {
  /**
   * Report the web handoff funnel (INSTALLED, TRY_NOW). Only a link that came
   * from the web belongs in that funnel; in-app installs and the Marketplace
   * skill page leave it off.
   */
  reportHandoffEvents?: boolean;
  /**
   * Shell-close callback for the behavioral `intent=try` auto-stage: invoked
   * after the auto `tryNow` dispatches its navigation, so the hosting shell
   * (today's modal) can dismiss itself. Omitting it disables auto-try — the
   * landing then presents the normal adaptive state for `try` links.
   */
  onAutoNavigate?: () => void;
}

export function usePublicShareLanding(
  link: DeepLinkShareOpenEvent,
  options?: PublicShareLandingOptions,
): PublicShareLanding {
  const [state, setState] = useState<PublicShareLandingPhase>({
    phase: 'loading',
  });
  const [detecting, setDetecting] = useState(false);
  const [installed, setInstalledState] =
    useState<PublicShareInstalledTarget | null>(null);
  const installedRef = useRef<PublicShareInstalledTarget | null>(null);
  const setInstalled = useCallback(
    (target: PublicShareInstalledTarget | null): void => {
      installedRef.current = target;
      setInstalledState(target);
    },
    [],
  );
  const [installing, setInstalling] = useState(false);
  const installInFlightRef = useRef(false);
  const [installError, setInstallError] = useState('');
  const [uninstalling, setUninstalling] = useState(false);
  const [installProgress, setInstallProgress] = useState('');
  const [installStatus, setInstallStatus] = useState('');
  const [agentReadiness, setAgentReadiness] =
    useState<PipelinePackageReadiness | null>(null);
  const [agentReadinessLoading, setAgentReadinessLoading] = useState(false);
  const [agentReviewLoading, setAgentReviewLoading] = useState(false);
  // A team or organization agent's Cloud snapshot, read when the review
  // opens: Install imports exactly what was shown, so a share edited while
  // the review was open is never installed unseen.
  const reviewedSharedAgentRef = useRef<{
    agentId: string;
    reviewed: Promise<
      Awaited<ReturnType<typeof window.agents.inspectImport>>['agent']
    >;
  } | null>(null);
  const [workspaceReadiness, setWorkspaceReadiness] =
    useState<PipelinePackageReadiness | null>(null);
  const [workspaceReadinessLoading, setWorkspaceReadinessLoading] =
    useState(false);
  const [installReview, setInstallReview] = useState<{
    entity: 'automation';
    externalId: string;
    staleActivity?: ScheduledActivity;
  } | null>(null);
  const reportHandoffEvents = options?.reportHandoffEvents === true;
  const reportHandoff = useCallback(
    (
      event: Parameters<typeof window.api.deepLinkReportHandoffEvent>[0],
    ): void => {
      if (!reportHandoffEvents) return;
      void window.api.deepLinkReportHandoffEvent(event);
    },
    [reportHandoffEvents],
  );

  useEffect(() => {
    let cancelled = false;
    setState({ phase: 'loading' });
    setInstalled(null);
    setInstallError('');
    setInstallProgress('');
    setInstallStatus('');
    setAgentReadiness(null);
    setAgentReadinessLoading(false);
    reviewedSharedAgentRef.current = null;
    setAgentReviewLoading(false);
    setWorkspaceReadiness(null);
    setWorkspaceReadinessLoading(false);
    void window.api
      .deepLinkResolveShare({
        entity: link.entity,
        externalId: link.externalId,
        ...(link.automationSource !== undefined
          ? { automationSource: link.automationSource }
          : {}),
        ...(link.audience !== undefined ? { audience: link.audience } : {}),
        // Forward the pin the recipient reviewed on the web page verbatim so
        // the server can answer 409 rather than hand back different content.
        ...(link.packageVersion !== undefined
          ? { packageVersion: link.packageVersion }
          : {}),
        ...(link.expectedPipelineContentHash !== undefined
          ? { expectedPipelineContentHash: link.expectedPipelineContentHash }
          : {}),
        ...(link.expectedDistributionMode !== undefined
          ? { expectedDistributionMode: link.expectedDistributionMode }
          : {}),
        ...(link.expectedPackageDigest !== undefined
          ? { expectedPackageDigest: link.expectedPackageDigest }
          : {}),
        ...(link.expectedCollectionContentHash !== undefined
          ? {
              expectedCollectionContentHash: link.expectedCollectionContentHash,
            }
          : {}),
        ...(link.expectedWorkspaceTemplateContentHash !== undefined
          ? {
              expectedWorkspaceTemplateContentHash:
                link.expectedWorkspaceTemplateContentHash,
            }
          : {}),
        ...(link.expectedAutomationContentHash !== undefined
          ? {
              expectedAutomationContentHash: link.expectedAutomationContentHash,
            }
          : {}),
      })
      .then(async (result): Promise<void> => {
        if (cancelled) return;
        if (!result.ok) {
          setState({ phase: 'error', reason: result.reason });
          return;
        }
        setState({ phase: 'ready', snapshot: result.snapshot });
        if (
          result.snapshot.entity === 'agent' &&
          result.snapshot.sourceRemoteId
        ) {
          const agentId = result.snapshot.sourceRemoteId;
          const reviewed = window.agents
            .inspectImport(agentId)
            .then((review) => review.agent);
          reviewedSharedAgentRef.current = { agentId, reviewed };
          setAgentReviewLoading(true);
          // Install awaits it; a failed read surfaces there, not here.
          void reviewed
            .catch(() => undefined)
            .finally(() => {
              if (!cancelled) setAgentReviewLoading(false);
            });
        }
        if (
          result.snapshot.entity === 'agent' &&
          result.snapshot.distributionMode === 'package' &&
          result.snapshot.package
        ) {
          const agentSnapshot = result.snapshot;
          const agentPackage = agentSnapshot.package;
          if (!agentPackage) return;
          setAgentReadinessLoading(true);
          void window.agents
            .inspectPublic({
              agent: agentSnapshot.agent,
              externalId: agentSnapshot.externalId,
              contentHash: agentSnapshot.contentHash,
              package: agentPackage,
            })
            .then((readiness) => {
              if (!cancelled) setAgentReadiness(readiness);
            })
            .catch(() => {
              if (cancelled) return;
              setAgentReadiness({
                status: 'ready',
                distributionMode: 'package',
                requirements: agentPackage.environmentRequirements.map(
                  (requirement) => ({
                    ...requirement,
                    status: 'unknown' as const,
                    detail: 'Availability could not be verified automatically.',
                  }),
                ),
                includedResources: agentPackage.resources.map(
                  ({ id, displayName, kind, executableFiles }) => ({
                    id,
                    displayName,
                    kind,
                    ...(executableFiles ? { executableFiles } : {}),
                  }),
                ),
              });
            })
            .finally(() => {
              if (!cancelled) setAgentReadinessLoading(false);
            });
        }
        if (result.snapshot.entity === 'workspace') {
          const packages = [
            ...(result.snapshot.package ? [result.snapshot.package] : []),
            ...(result.snapshot.skillPackages ?? []).map(
              (entry) => entry.package,
            ),
          ];
          if (packages.length > 0) {
            setWorkspaceReadinessLoading(true);
            void window.api.chatProject
              .inspectTemplateCapabilityPackages({ packages })
              .then((readiness) => {
                if (!cancelled) setWorkspaceReadiness(readiness);
              })
              .catch(() => {
                if (cancelled) return;
                setWorkspaceReadiness({
                  status: 'ready',
                  distributionMode: 'package',
                  requirements: packages
                    .flatMap((item) => item.environmentRequirements)
                    .map((requirement) => ({
                      ...requirement,
                      status: 'unknown' as const,
                      detail:
                        'Availability could not be verified automatically.',
                    })),
                });
              })
              .finally(() => {
                if (!cancelled) setWorkspaceReadinessLoading(false);
              });
          }
        }
        // Arrival installed-state detection: flips the primary action to
        // "Try now" when this exact pinned content is already installed.
        setDetecting(true);
        try {
          const found = await detectInstalled(result.snapshot, link.audience);
          if (!cancelled) setInstalled(found);
        } catch {
          // Detection is best-effort; fall back to the Install state.
        } finally {
          if (!cancelled) setDetecting(false);
        }
      })
      .catch((): void => {
        if (!cancelled) {
          setState({ phase: 'error', reason: 'cloud-unreachable' });
        }
      });
    return (): void => {
      cancelled = true;
    };
  }, [
    link.audience,
    link.automationSource,
    link.entity,
    link.externalId,
    link.packageVersion,
    link.expectedCollectionContentHash,
    link.expectedPipelineContentHash,
    link.expectedDistributionMode,
    link.expectedPackageDigest,
    link.expectedWorkspaceTemplateContentHash,
    link.expectedAutomationContentHash,
    setInstalled,
  ]);

  const snapshot = state.phase === 'ready' ? state.snapshot : null;

  // Packaged installs stream per-dependency transfer progress; the label is
  // cleared the moment the operation settles.
  useEffect(() => {
    const subscribe = window.pipelines.onPackageProgress?.bind(
      window.pipelines,
    );
    if (!subscribe) return undefined;
    return subscribe((event) => {
      if (event.completed === undefined || event.total === undefined) return;
      setInstallProgress(
        formatPipelinePackageTransferLabel(event.completed, event.total),
      );
    });
  }, []);

  const install =
    useCallback(async (): Promise<PublicShareInstallResult | null> => {
      if (!snapshot || installInFlightRef.current) return null;
      if (snapshot.entity === 'automation') {
        // A rebind, not a write: the wizard owns workspace selection, branch
        // confirmation, and the capability-package review. INSTALLED is
        // reported from `completeInstallReview`, once something actually
        // exists locally.
        setInstallError('');
        const installedAutomation = installedRef.current;
        let staleActivity: ScheduledActivity | undefined;
        if (
          installedAutomation?.entity === 'automation' &&
          installedAutomation.updateAvailable === true
        ) {
          let activities: ScheduledActivity[];
          try {
            ({ activities } = await window.api.automations.list());
          } catch (error) {
            setInstallError(
              error instanceof Error
                ? error.message
                : 'Failed to install this share.',
            );
            return null;
          }
          staleActivity = activities.find(
            (activity) => activity.id === installedAutomation.activityId,
          );
        }
        setInstallReview({
          entity: 'automation',
          externalId: snapshot.externalId,
          ...(staleActivity ? { staleActivity } : {}),
        });
        return null;
      }
      installInFlightRef.current = true;
      setInstalling(true);
      // The target this install produced; every success path records it here,
      // and the review lands on it.
      let landed: PublicShareInstalledTarget | null = null;
      let landedStatus = '';
      let landedPartial = false;
      const succeed = (target: PublicShareInstalledTarget): void => {
        landed = target;
        setInstalled(target);
      };
      const reportStatus = (status: string, partial = false): void => {
        landedStatus = status;
        landedPartial = partial;
        setInstallStatus(status);
      };
      setInstallError('');
      const reconcileFailedPackageValidation = async (): Promise<void> => {
        // Exact-package validation can detach a stale ledger record before a
        // later download fails. Preserve a republished share's older target only
        // when main-process readiness has validated its exact YAML bytes/cache
        // and the same provenance record still exists.
        const current = installedRef.current;
        let validated: PublicShareInstalledTarget | null = null;
        if (
          current?.entity === 'pipeline' &&
          current.updateAvailable === true &&
          current.packageDigest
        ) {
          try {
            const readiness = await window.pipelines.getPackageReadiness({
              pipeline: current.pipelineId,
            });
            const installs = await window.pipelines.listPackageInstalls();
            const record = installs.data?.find(
              (candidate) =>
                candidate.localPipelineId === current.pipelineId &&
                candidate.originExternalId === link.externalId &&
                candidate.packageDigest === current.packageDigest,
            );
            if (
              readiness.success &&
              readiness.data?.distributionMode === 'package' &&
              readiness.data.status !== 'invalid' &&
              installs.success &&
              record
            ) {
              validated = current;
            }
          } catch {
            // Failed validation is not evidence that stale actions are safe.
          }
        }
        setInstalled(validated);
        setInstallStatus('');
      };
      try {
        if (snapshot.entity === 'plugin') {
          const installedPlugin = await installSharedPluginRef(snapshot.ref);
          succeed(installedPlugin);
          reportHandoff({
            entity: 'plugin',
            externalId: link.externalId,
            eventType: 'INSTALLED',
            audience: link.audience,
          });
        } else if (snapshot.entity === 'collection') {
          const refreshed = await window.api.deepLinkResolveShare({
            entity: 'collection',
            externalId: snapshot.externalId,
            ...(link.audience ? { audience: link.audience } : {}),
            expectedCollectionContentHash: snapshot.contentHash,
            expectedDistributionMode: snapshot.package
              ? 'package'
              : 'definition_only',
            ...(snapshot.package
              ? { expectedPackageDigest: snapshot.package.digest }
              : {}),
          });
          if (!refreshed.ok || refreshed.snapshot.entity !== 'collection') {
            throw new Error(
              'The shared collection changed or is no longer available. Open the link again.',
            );
          }
          const verified = refreshed.snapshot;
          const fromPublicShare =
            link.audience !== 'TEAM' && link.audience !== 'ORGANIZATION';
          const source = {
            remoteId: snapshot.externalId,
            fetchedAt: new Date().toISOString(),
            ...(fromPublicShare
              ? { fromPublicShare, contentHash: verified.contentHash }
              : {}),
          };
          let saved: CollectionConfig;
          let unavailable = 0;
          // Packaged resources that failed and environment requirements left
          // unmet count as unavailable, as the Collections tab's import did.
          let packageUnavailable = 0;
          if (verified.package) {
            const installedPackage =
              await window.collections.installCapabilityPackage({
                collectionId: snapshot.externalId,
                createCollection: {
                  name: verified.collection.name,
                  description: verified.collection.description,
                  sharedSource: source,
                },
                packageRef: {
                  version: verified.package.version,
                  digest: verified.package.digest,
                },
                fromPublicShare,
              });
            saved = installedPackage.collection;
            packageUnavailable =
              installedPackage.uninstalledResourceLabels.length +
              installedPackage.unmetRequirements.length;
          } else {
            // Commit the authorized definition before any independent member writes.
            saved = await window.collections.saveCollection({
              name: verified.collection.name,
              description: verified.collection.description,
              skills: [],
              plugins: [],
              mcpServers: [],
              sharedSource: source,
            });
          }
          // The collection is committed. Members retain the existing best-effort
          // semantics; a linking failure does not undo an installed collection.
          try {
            const resolved = await resolveSharedCollectionImport({
              collection: verified.collection,
              // A Public collection pins its custom skills in its own snapshot,
              // so main verifies each one against that snapshot.
              customSkills: verified.customSkills.map((skill) => ({
                ...skill,
                fromPublicShare,
                ...(fromPublicShare
                  ? {
                      publicCollection: {
                        externalId: verified.externalId,
                        contentHash: verified.contentHash,
                      },
                    }
                  : {}),
              })),
            });
            const skills = new Map(
              saved.skills.map((skill) => [
                `${skill.sourceId}/${skill.skillName}`,
                skill,
              ]),
            );
            for (const skill of resolved.skills)
              skills.set(`${skill.sourceId}/${skill.skillName}`, skill);
            saved = await window.collections.saveCollection({
              ...saved,
              skills: Array.from(skills.values()),
              plugins: resolved.plugins,
            });
            unavailable = packageUnavailable + resolved.failures.length;
          } catch {
            unavailable =
              packageUnavailable +
              Math.max(1, verified.collection.items.length);
          }
          succeed({ entity: 'collection', collectionId: saved.id });
          reportStatus(
            unavailable === 0
              ? 'Collection installed.'
              : `Collection installed with ${unavailable} item${unavailable === 1 ? '' : 's'} unavailable.`,
            unavailable > 0,
          );
          reportHandoff({
            entity: 'collection',
            externalId: link.externalId,
            eventType: 'INSTALLED',
            audience: link.audience,
          });
        } else if (snapshot.entity === 'workspace') {
          const created = await window.api.chatProject.createFromTemplate({
            seed: 'shared',
            sourceTemplate: {
              externalId: snapshot.externalId,
              contentHash: snapshot.contentHash,
              ...(snapshot.package ? { package: snapshot.package } : {}),
              ...(snapshot.skillPackages
                ? { skillPackages: snapshot.skillPackages }
                : {}),
            },
          });
          await Promise.all([
            useStandaloneChatStore.getState().loadChatProjects(),
            useProjectsStore.getState().loadProjects({ silent: true }),
          ]);
          succeed({
            entity: 'workspace',
            projectId: created.project.id,
          });
          // Refs the resolver could not map (an unavailable marketplace, a
          // curated capability this install does not carry) are reported, never
          // fatal — the workspace still lands with everything that did resolve.
          reportStatus(
            created.unresolvedRefs.length > 0
              ? formatUnresolvedCapabilitiesNotice(
                  created.unresolvedRefs.length,
                )
              : '',
            created.unresolvedRefs.length > 0,
          );
          reportHandoff({
            entity: 'workspace',
            externalId: link.externalId,
            eventType: 'INSTALLED',
            audience: link.audience,
          });
        } else if (snapshot.entity === 'agent') {
          let imported: Awaited<ReturnType<typeof window.agents.importPublic>>;
          if (snapshot.sourceRemoteId) {
            // A team or organization agent installs the exact Cloud snapshot
            // read when the review opened, so a share edited in between is
            // refused rather than installed unseen. A failed read is retried
            // here, since a retry is a fresh review of the share.
            const agentId = snapshot.sourceRemoteId;
            const pending = reviewedSharedAgentRef.current;
            reviewedSharedAgentRef.current = null;
            const reviewedAgent =
              pending !== null && pending.agentId === agentId
                ? await pending.reviewed.catch(
                    async () =>
                      (await window.agents.inspectImport(agentId)).agent,
                  )
                : (await window.agents.inspectImport(agentId)).agent;
            const response = await window.agents.importShared({
              agentId,
              installMissing: true,
              reviewedAgent,
            });
            imported = response.agent;
            if (response.idChanged) {
              reportStatus(
                `Agent installed as ${response.finalId} because ${response.requestedId} already exists locally.`,
                true,
              );
            }
          } else {
            imported = await window.agents.importPublic({
              agent: snapshot.agent,
              externalId: snapshot.externalId,
              contentHash: snapshot.contentHash,
              ...(snapshot.package ? { package: snapshot.package } : {}),
              installMissing: true,
            });
          }
          succeed({ entity: 'agent', agentId: imported.id });
          reportHandoff({
            entity: 'agent',
            externalId: link.externalId,
            eventType: 'INSTALLED',
            audience: link.audience,
          });
        } else if (snapshot.entity === 'skill') {
          const imported = await importSharedSkill({
            ...(snapshot.sourceRemoteId
              ? { sourceRemoteId: snapshot.sourceRemoteId }
              : {}),
            name: snapshot.name,
            rawSkill: snapshot.rawSkill,
            contentHash: snapshot.contentHash,
            // A public share's package hangs off the SHARE, so the install
            // reads it through the public endpoints keyed by the share's
            // external id. A team or organization skill resolved through the
            // scoped fallback has no public share: its package hangs off the
            // skill (whose id is this same external id), and the public
            // endpoints 404 for it.
            id: link.externalId,
            fromPublicShare: snapshot.scopedShare !== true,
            ...(snapshot.distributionMode !== undefined
              ? { distributionMode: snapshot.distributionMode }
              : {}),
            ...(snapshot.package !== undefined
              ? { package: snapshot.package }
              : {}),
          });
          if (snapshot.publisher && imported.packageInstallError) {
            setInstalled(null);
            reportStatus('');
            setInstallError(
              describeSharedSkillImportNotice(imported) ??
                imported.packageInstallError,
            );
            window.dispatchEvent(new Event(SKILLS_CHANGED_EVENT));
            return null;
          }
          succeed({
            entity: 'skill',
            sourceId: CUSTOM_SKILL_SOURCE_ID,
            skillName: imported.skillName,
          });
          // Partial success has to reach the user. The skill landed, but if its
          // supporting files did not, saying nothing would leave the recipient
          // believing they received the whole thing.
          reportStatus(
            describeSharedSkillImportNotice(imported) ?? '',
            imported.packageInstallError !== undefined ||
              (imported.packageInstall?.uninstalledResourceLabels.length ?? 0) >
                0,
          );
          window.dispatchEvent(new Event(SKILLS_CHANGED_EVENT));
          reportHandoff({
            entity: 'skill',
            externalId: link.externalId,
            eventType: 'INSTALLED',
            audience: link.audience,
          });
        } else if (isPackageSnapshot(snapshot)) {
          // Package installs are all-or-nothing and run entirely in the main
          // process: download + verify every blob against the pinned digest
          // BEFORE any local write. A build without the package installer must
          // say so rather than quietly saving the YAML alone.
          const installPackageShare =
            window.pipelines.installPackageShare?.bind(window.pipelines);
          if (!installPackageShare || !snapshot.package) {
            await reconcileFailedPackageValidation();
            setInstallError(PACKAGE_UPGRADE_REQUIRED_MESSAGE);
            return null;
          }
          const result = await installPackageShare({
            externalId: snapshot.externalId,
            expectedPipelineContentHash: snapshot.contentHash,
            expectedDistributionMode: 'package',
            expectedPackageDigest: snapshot.package.digest,
          });
          if (
            !result.success ||
            !result.data ||
            result.data.distributionMode !== 'package'
          ) {
            await reconcileFailedPackageValidation();
            setInstallError(
              result.error ?? 'Failed to install this shared pipeline.',
            );
            return null;
          }
          succeed({
            entity: 'pipeline',
            pipelineId: result.data.localPipelineId,
            packageDigest: result.data.packageDigest,
            updateAvailable: false,
          });
          reportStatus(
            formatPipelinePackageInstalledStatus(result.data.resourceCount),
          );
          reportHandoff({
            entity: 'pipeline',
            externalId: link.externalId,
            eventType: 'INSTALLED',
            audience: link.audience,
          });
        } else {
          const installDefinitionOnlyShare =
            window.pipelines.installPackageShare?.bind(window.pipelines);
          if (installDefinitionOnlyShare) {
            const result = await installDefinitionOnlyShare({
              externalId: snapshot.externalId,
              expectedPipelineContentHash: snapshot.contentHash,
              expectedDistributionMode: 'definition_only',
            });
            if (
              !result.success ||
              !result.data ||
              result.data.distributionMode !== 'definition_only'
            ) {
              setInstallError(
                result.error ?? 'Failed to install this shared pipeline.',
              );
              return null;
            }
            succeed({
              entity: 'pipeline',
              pipelineId: result.data.localPipelineId,
            });
            reportStatus(DEFINITION_ONLY_INSTALLED_STATUS);
            reportHandoff({
              entity: 'pipeline',
              externalId: link.externalId,
              eventType: 'INSTALLED',
              audience: link.audience,
            });
          } else {
            const parsed = tryParseAndValidateYaml(snapshot.rawPipeline);
            if (!parsed.success) {
              setInstallError(
                `This pipeline could not be parsed: ${parsed.error}`,
              );
              return null;
            }
            const result = await window.pipelines.save({
              ...(snapshot.sourceRemoteId
                ? { sourceRemoteId: snapshot.sourceRemoteId }
                : {}),
              name: parsed.pipeline.name,
              description: parsed.pipeline.description ?? snapshot.description,
              icon: parsed.pipeline.icon ?? '',
              content: parsed.pipeline,
            });
            if (!result.success || !result.data) {
              setInstallError(result.error ?? 'Failed to save the pipeline.');
              return null;
            }
            succeed({ entity: 'pipeline', pipelineId: result.data.id });
            reportStatus(DEFINITION_ONLY_INSTALLED_STATUS);
            reportHandoff({
              entity: 'pipeline',
              externalId: link.externalId,
              eventType: 'INSTALLED',
              audience: link.audience,
            });
          }
        }
      } catch (error) {
        if (isPackageSnapshot(snapshot)) {
          await reconcileFailedPackageValidation();
        }
        setInstallError(
          error instanceof Error
            ? error.message
            : 'Failed to install this share.',
        );
      } finally {
        installInFlightRef.current = false;
        setInstalling(false);
        setInstallProgress('');
      }
      if (landed === null) return null;
      return { target: landed, status: landedStatus, partial: landedPartial };
    }, [snapshot, link.externalId, link.audience, setInstalled, reportHandoff]);

  // CAN-3651: an automation link opens straight into the install review,
  // whatever its intent. The review is the inspectable preview (schedule,
  // bindings, packages, and file paths) and its single explicit click
  // installs and enables the copy, so the landing would only add a click.
  // A copy that is already installed and current stays on the landing.
  const [autoReview, setAutoReview] = useState<'idle' | 'opening' | 'settled'>(
    'idle',
  );
  useEffect(() => {
    setAutoReview('idle');
  }, [link.entity, link.externalId]);
  const automationReviewable =
    snapshot?.entity === 'automation' && state.phase === 'ready';
  const autoReviewEligible =
    automationReviewable &&
    !detecting &&
    (installed === null ||
      (installed.entity === 'automation' &&
        installed.updateAvailable === true));
  useEffect(() => {
    if (!autoReviewEligible || autoReview !== 'idle') return;
    setAutoReview('opening');
    install()
      .catch((error: unknown) => {
        setInstallError(
          error instanceof Error
            ? error.message
            : 'Failed to open the install review.',
        );
      })
      .finally(() => {
        setAutoReview('settled');
      });
  }, [autoReviewEligible, autoReview, install]);
  const openingInstallReview =
    installReview === null &&
    automationReviewable &&
    (detecting || (autoReviewEligible && autoReview !== 'settled'));

  const tryNow = useCallback(
    (onNavigate?: () => void): void => {
      if (
        !snapshot ||
        !installed ||
        installInFlightRef.current ||
        installedRef.current !== installed
      ) {
        return;
      }
      reportHandoff({
        entity: snapshot.entity,
        externalId: link.externalId,
        eventType: 'TRY_NOW',
        audience: link.audience,
      });
      if (installed.entity === 'automation') {
        // An automation has no prompt to stage, so `try` degrades to opening
        // the installed copy in its editor.
        useNavigationStore
          .getState()
          .openAutomationEdit({ activityId: installed.activityId });
      } else if (installed.entity === 'plugin') {
        useNavigationStore.getState().openPluginsNavigation({
          kind: 'entry-detail',
          entryId: installed.entryId,
        });
      } else if (installed.entity === 'agent') {
        // An agent has no prompt to stage, so `try` opens its editor.
        useNavigationStore
          .getState()
          .openAgentReveal({ agentId: installed.agentId, mode: 'edit' });
      } else if (installed.entity === 'workspace') {
        // A workspace has no example task to stage, so `try` degrades to
        // opening the workspace the install just created.
        void useStandaloneChatStore
          .getState()
          .switchChatProject(installed.projectId);
        useNavigationStore.getState().navigate('chat');
      } else if (installed.entity === 'collection') {
        useNavigationStore.getState().navigate('plugins');
      } else if (installed.entity === 'skill') {
        if (snapshot.entity !== 'skill') return;
        // Stage a prefilled NEW chat tab in the active worktree (or the Home
        // composer when none is selected) — draft only, the user sends.
        stageSkillStarterPrompt(
          buildSkillStarterPrompt({
            name: snapshot.name,
            description: snapshot.description ?? '',
            frontmatter: parseSkillSource(snapshot.rawSkill).frontmatter,
          }),
        );
      } else {
        // Pipelines: with a worktree selected, stage the dispatch modal with
        // this pipeline preselected (Run stays an explicit click inside the
        // modal). Without a worktree there is no dispatch context, so fall
        // back to the saved pipeline's editor and its Run affordance.
        const worktree = useChatStore.getState().selectedWorktree;
        if (worktree) {
          useNavigationStore.getState().openPipelineDispatch({
            pipelineId: installed.pipelineId,
            projectId: worktree.projectId,
            worktreeId: worktree.worktreeId,
          });
        } else {
          useNavigationStore
            .getState()
            .openPipelineEdit({ pipelineId: installed.pipelineId });
        }
      }
      onNavigate?.();
    },
    [snapshot, installed, link.externalId, link.audience, reportHandoff],
  );

  // Behavioral `intent=try` (PR2b): once `installed` is known — from the
  // arrival detection, or right after an explicit Install on a try-intent
  // arrival (deliberate: the link promised "lands ready to stage", so the
  // staging continues after the one required click) — auto-invoke the same
  // staging `tryNow` performs and dismiss the shell. At most once per link
  // arrival; requires a shell-provided onAutoNavigate; a not-installed
  // arrival stays on the normal Install review state. Staging only — nothing
  // auto-submits.
  const autoTriedRef = useRef(false);
  useEffect(() => {
    autoTriedRef.current = false;
  }, [link.entity, link.externalId]);
  const onAutoNavigate = options?.onAutoNavigate;
  useEffect(() => {
    if (
      link.intent !== 'try' ||
      link.entity === 'agent' ||
      link.entity === 'workspace' ||
      link.entity === 'collection' ||
      !onAutoNavigate ||
      autoTriedRef.current ||
      state.phase !== 'ready' ||
      detecting ||
      !installed
    ) {
      return;
    }
    autoTriedRef.current = true;
    tryNow(onAutoNavigate);
  }, [
    link.entity,
    link.intent,
    onAutoNavigate,
    state.phase,
    detecting,
    installed,
    tryNow,
  ]);

  const manage = useCallback(
    (onNavigate?: () => void): void => {
      if (
        !installed ||
        installInFlightRef.current ||
        installedRef.current !== installed
      ) {
        return;
      }
      const navigation = useNavigationStore.getState();
      if (installed.entity === 'automation') {
        navigation.openAutomationEdit({ activityId: installed.activityId });
      } else if (installed.entity === 'agent') {
        navigation.openAgentReveal({
          agentId: installed.agentId,
          mode: 'highlight',
        });
      } else if (installed.entity === 'workspace') {
        void useStandaloneChatStore
          .getState()
          .switchChatProject(installed.projectId);
        navigation.navigate('chat');
      } else if (installed.entity === 'collection') {
        navigation.navigate('plugins');
      } else if (installed.entity === 'skill') {
        navigation.openSkillViewer({
          kind: 'installed',
          sourceId: installed.sourceId,
          skillName: installed.skillName,
        });
      } else if (installed.entity === 'pipeline') {
        navigation.openPipelineEdit({ pipelineId: installed.pipelineId });
      } else if (installed.entity === 'plugin') {
        navigation.openPluginsNavigation({
          kind: 'entry-detail',
          entryId: installed.entryId,
        });
      }
      onNavigate?.();
    },
    [installed],
  );

  const uninstall = useCallback(async (): Promise<boolean> => {
    if (
      !installed ||
      uninstalling ||
      installInFlightRef.current ||
      installedRef.current !== installed
    ) {
      return false;
    }
    // Marketplace plugin removal is intentionally owned by the Plugins page:
    // removing a marketplace can affect multiple plugins. The landing offers
    // Manage instead of an unsafe one-click uninstall for plugin targets.
    if (installed.entity === 'plugin') return false;
    // A workspace is user data once it exists — chats, notes, and attachments
    // can already live in it — so removal stays in the sidebar's own delete
    // flow rather than behind a one-click Uninstall on a share landing.
    if (installed.entity === 'workspace') return false;
    setUninstalling(true);
    setInstallError('');
    try {
      if (installed.entity === 'skill') {
        const result = await window.skills.removeSkill(
          installed.sourceId,
          installed.skillName,
        );
        if (!result.success) {
          setInstallError(result.error ?? 'Failed to uninstall the skill.');
          return false;
        }
        window.dispatchEvent(new Event(SKILLS_CHANGED_EVENT));
      } else if (installed.entity === 'automation') {
        // Explicit branch: without it the `else` below falls through to
        // `window.pipelines.delete` with an activity id.
        const result = await window.api.automations.delete({
          id: installed.activityId,
        });
        if (!result.ok) {
          setInstallError(result.error || 'Failed to remove the automation.');
          return false;
        }
      } else if (installed.entity === 'agent') {
        if (snapshot?.entity !== 'agent') return false;
        if (snapshot.sourceRemoteId) {
          await window.agents.delete({
            id: installed.agentId,
            importedShare: {
              remoteId: snapshot.sourceRemoteId,
              contentHash: snapshot.contentHash,
            },
          });
        } else {
          await window.agents.uninstallPublic({
            agentId: installed.agentId,
            externalId: snapshot.externalId,
            contentHash: snapshot.contentHash,
          });
        }
      } else if (installed.entity === 'collection') {
        await window.collections.deleteCollection(installed.collectionId);
      } else {
        const result = await window.pipelines.delete(installed.pipelineId);
        if (!result.success) {
          setInstallError(result.error ?? 'Failed to uninstall the pipeline.');
          return false;
        }
      }
      setInstalled(null);
      return true;
    } catch (error) {
      setInstallError(
        error instanceof Error
          ? error.message
          : 'Failed to uninstall this share.',
      );
      return false;
    } finally {
      setUninstalling(false);
    }
  }, [installed, uninstalling, setInstalled, snapshot]);

  const closeInstallReview = useCallback((): void => {
    setInstallReview(null);
  }, []);

  const completeInstallReview = useCallback(
    (activityId: string): void => {
      setInstallReview(null);
      setInstalled({ entity: 'automation', activityId });
      if (link.automationSource === undefined) {
        reportHandoff({
          entity: 'automation',
          externalId: link.externalId,
          eventType: 'INSTALLED',
          audience: link.audience,
        });
      }
    },
    [
      link.audience,
      link.automationSource,
      link.externalId,
      setInstalled,
      reportHandoff,
    ],
  );

  return {
    state,
    snapshot,
    detecting,
    installed,
    installing,
    installError,
    uninstalling,
    installProgress,
    installStatus,
    agentReadiness,
    agentReadinessLoading,
    agentReviewLoading,
    workspaceReadiness,
    workspaceReadinessLoading,
    install,
    tryNow,
    manage,
    uninstall,
    installReview,
    openingInstallReview,
    closeInstallReview,
    completeInstallReview,
  };
}
