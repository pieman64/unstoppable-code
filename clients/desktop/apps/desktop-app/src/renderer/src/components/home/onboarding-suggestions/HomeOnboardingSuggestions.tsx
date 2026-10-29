import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import {
  isCursorHarnessReleased,
  getCursorSettingsSection,
} from '@/lib/cursor-settings';
import { useCursorChatAvailable } from '@/hooks/useCursorChatAvailable';
import { createPortal } from 'react-dom';
import type { CuratedMcpServerEntry } from '@canopy/protocol/mcp-catalog';
import { normalizeCapabilityName } from '@canopy/protocol/capability-name';
import { installOnboardingPlugin } from './installOnboardingPlugin';
import { OnboardingToolSetup } from './OnboardingToolSetup';
import { OnboardingMobileAppDialog } from './OnboardingMobileAppDialog';
import { useMobileAppPromo } from '@/hooks/useMobileAppPromo';
import {
  Button,
  ErrorBanner,
  OnboardingCategoryPicker,
  OnboardingChoiceTile,
  OnboardingNavigationControls,
  SuggestionRow,
  type OnboardingNextAction,
} from '@canopy/ui-shared/components';
import { useOnboardingSuggestionSurfaces } from '@/stores/onboardingSuggestionSurfacesStore';
import {
  checklistProgress,
  countsProjectStep,
} from '@canopy/ui-shared/lib/checklist-progress';
import { OnboardingSuggestionSidebar } from './OnboardingSuggestionSidebar';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import type {
  AuthTerminalProvider,
  HomeOnboardingSuggestionsPreferences,
  SidebarItem,
  WorkspaceReadinessIssue,
} from '@canopy/desktop-shared/types';
import type { ProfileRoleId } from '@canopy/protocol/plugin-catalog';
import { CursorLogo, LinearLogo } from '@canopy/ui-shared/icons';
import {
  AssignmentAddIcon,
  BackIcon,
  CheckIcon,
  ClaudeIcon,
  CloseIcon,
  CodexIcon,
  CommandIcon,
  DownloadIcon,
  FolderPlusIcon,
  GitHubIcon,
  LoginIcon,
  OllamaIcon,
  Smartphone,
  SparkleIcon,
  ThinkingIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { useDailyCreditDripOptIn } from '@/hooks/useDailyCreditDripOptIn';
import {
  formatGlobalFocusShortcutForDisplay,
  useGlobalFocusShortcutStatus,
  useGlobalFocusShortcutStore,
} from '@/stores/globalFocusShortcutStore';
import { GLOBAL_FOCUS_SHORTCUT_SETTINGS_TARGET } from '@/lib/globalFocusShortcut';
import {
  useLaunchAtLoginStatus,
  useLaunchAtLoginStore,
} from '@/stores/launchAtLoginStore';
import { LoadingSpinner } from '@/components/shared/loading';
import { BrandLogo } from '@/components/BrandLogo';
import { McpServerLogo } from '@/components/shared/McpServerLogo';
import { useCuratedMcpServers } from '@/hooks/useCuratedMcpServers';
import { AuthLoginModal } from '@/components/settings/AuthLoginModal';
import { openOnboardingAuthorizationUrl } from './openOnboardingAuthorizationUrl';
import type { AuthProviderId } from '@/components/auth/ProviderAuthPanel';
import {
  invalidateClaudeAuthStatusCache,
  useClaudeAuthStatus,
} from '@/hooks/useClaudeAuthStatus';
import {
  invalidateCodexAuthStatusCache,
  useCodexAuthStatus,
} from '@/hooks/useCodexAuthStatus';
import { useGitHubCliStatus } from '@/hooks/useGitHubCliStatus';
import { useLinearAvailability } from '@/hooks/useLinearStatus';
import { useAiCreditsAvailability } from '@/hooks/useAiCreditsAvailability';
import {
  GITHUB_CONNECTION_CHANGED_EVENT,
  subscribeToConnectionChange,
} from '@/lib/integrationConnectionEvents';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { brandText } from '@/lib/brand';
import { agentConnectionsIntro } from '@/lib/onboarding/agent-connections-copy';
import {
  agentProviderConnectionState,
  gitHubConnectionState,
  linearConnectionState,
  PROVIDER_CONNECTION_STATE_LABELS,
  type ProviderConnectionState,
} from '@/lib/onboarding/provider-connection-status';
import { useNavigationStore } from '@/stores/navigationStore';
import { useObservabilityStore } from '@/stores/observabilityStore';
import { openImportProjectsModal } from '@/stores/importProjectsModalStore';
import { openRepoRulesModal } from '@/stores/repoRulesModalStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useHomeComposerStore } from '@/stores/homeComposerStore';
import {
  INSERT_CHAT_TEXT_EVENT,
  type InsertChatTextDetail,
} from '@/lib/editorSelectionContext';
import {
  addRepoTryPrompt,
  deriveOnboardingSuggestionQueue,
  isRepoDependentStep,
  isResolvedSuggestion,
  LINEAR_TRY_PROMPT,
  onboardingChecklistSteps,
  strictlyNontechnical,
  withEntryDismissed,
  withEntryCompleted,
  type OnboardingSuggestionView,
  type OnboardingChecklistView,
  type OnboardingToolRecommendation,
} from './queue';
import {
  armOnboardingSuggestion,
  disarmOnboardingSuggestion,
} from './completionWriter';
import { usePluginSuggestions } from './usePluginSuggestions';
import { launchWorkspaceReadinessFix } from '@/lib/workspaceReadinessLauncher';
import { workspaceReadinessIssueKey } from '@/lib/workspaceReadinessIssueKey';
import {
  trackOnboardingSuggestionCtaClick,
  trackOnboardingSuggestionDismiss,
  trackOnboardingCategoryToggle,
  trackOnboardingSuggestionsImpression,
} from './telemetry';
import { openIntegrationSettings } from '@/lib/navigation/settings-destinations';

/**
 * Dynamic "Getting started" module under the Home composer: the merged
 * successor of the CAN-2411 connections card and the Home instance of the
 * CAN-1809 suggested prompts. Renders one focused step or up to three interchangeable alternatives from a durable queue.
 * The sidebar shows its next action; advanced examples join after completion.
 *
 * Mount only while `useHomeOnboardingSuggestionsState` reports `visible`:
 * the provider status probes here are scoped to still-onboarding users by
 * that gate.
 */

/** Stable empty queue while the project list is still hydrating. */
const EMPTY_VIEWS: readonly OnboardingChecklistView[] = [];
const EMPTY_ROLES: readonly ProfileRoleId[] = [];

/**
 * Steady-state examples are never numbered steps and render without the
 * counter. Readiness fixes, which also join only once setup is done, are
 * steps the user walks through with Next, so they take the numbers after
 * the last setup step instead of repeating its total.
 */
function isSteadyStateView(view: OnboardingChecklistView): boolean {
  return view.step.kind === 'advanced-prompt';
}

type PromptTarget = 'home' | 'chat';

const STATE_CHIP_CLASSES: Record<ProviderConnectionState, string> = {
  checking: 'fg-secondary',
  connected: 'fg-success',
  'not-connected': 'fg-secondary',
  'needs-attention': 'fg-warning',
};

const ONBOARDING_COMPLEX_ROW_BUTTON_CLASS =
  'focus-ring flex w-full items-center gap-2 rounded-full px-2 py-2 pr-10 text-left text-sm fg-secondary transition-colors group-hover:fg-primary disabled:pointer-events-none disabled:fg-disabled';
const ONBOARDING_SECONDARY_TEXT_BUTTON_CLASS =
  'focus-ring shrink-0 rounded-md bg-transparent px-2 py-1 text-xs fg-tertiary transition-colors hover:fg-primary';

interface OnboardingSuggestionRowShellProps {
  heading?: string;
  /** Muted progress text displayed immediately before the navigation arrows. */
  headingMeta?: string;
  /** Whether the heading uses the standard inset applied above action rows. */
  headingInset?: boolean;
  /** Exact inset override for layouts whose body uses a compact rail. */
  headingClassName?: string;
  leadingAction?: ReactNode;
  hideDismiss?: boolean;
  entryId: string;
  stepKind: string;
  status: string;
  entering: boolean;
  rowClassName?: string;
  dismissLabel: string;
  onDismiss: () => void;
  onPrevious: () => void;
  previousDisabled: boolean;
  /** Relabels the forward arrow Next once the step's own action is ready. */
  nextAction?: OnboardingNextAction;
  children: ReactNode;
}

function OnboardingSuggestionRowShell({
  heading,
  headingMeta,
  headingInset = true,
  headingClassName,
  leadingAction,
  hideDismiss = false,
  entryId,
  stepKind,
  status,
  entering,
  rowClassName = 'group relative flex items-center rounded-full transition-colors hover:bg-subtle',
  dismissLabel,
  onDismiss,
  onPrevious,
  previousDisabled,
  nextAction,
  children,
}: OnboardingSuggestionRowShellProps): JSX.Element {
  const controls = (
    <OnboardingNavigationControls
      previousDisabled={previousDisabled}
      skipLabel={dismissLabel}
      testId={`home-onboarding-suggestion-dismiss-${entryId}`}
      onPrevious={onPrevious}
      onSkip={onDismiss}
      next={nextAction}
    />
  );
  return (
    <li
      data-testid={`home-onboarding-suggestion-${entryId}`}
      data-step={stepKind}
      data-status={status}
      className={entering ? 'onboarding-suggestion-enter' : undefined}
    >
      {heading ? (
        <div
          className={`mb-3 flex min-h-7 items-center gap-2 ${headingClassName ?? (headingInset ? 'px-4' : 'px-0')}`}
        >
          {leadingAction}
          <h2 className="min-w-0 flex-1 text-left text-m font-medium fg-primary">
            <span>{heading}</span>
          </h2>
          {!hideDismiss || nextAction ? (
            <span className="flex shrink-0 items-center gap-2">
              {headingMeta ? (
                <span
                  data-testid="home-onboarding-checklist-progress"
                  className="text-s font-normal tabular-nums fg-tertiary"
                  aria-label={`Step ${headingMeta.replace('/', ' of ')}`}
                >
                  {headingMeta}
                </span>
              ) : null}
              {controls}
            </span>
          ) : null}
        </div>
      ) : null}
      <div className={rowClassName}>
        {children}
        {!heading && !hideDismiss ? (
          <span className="absolute right-2 top-1/2 -translate-y-1/2">
            {controls}
          </span>
        ) : null}
      </div>
    </li>
  );
}

interface OnboardingComplexActionRowProps {
  icon: ReactNode;
  ariaLabel: string;
  testId: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}

function OnboardingComplexActionRow({
  icon,
  ariaLabel,
  testId,
  onClick,
  disabled,
  className = '',
  children,
}: OnboardingComplexActionRowProps): JSX.Element {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      className={`${ONBOARDING_COMPLEX_ROW_BUTTON_CLASS} ${className}`.trim()}
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center fg-tertiary">
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        {children}
      </span>
    </button>
  );
}

export interface HomeOnboardingSuggestionsProps {
  homeHost?: HTMLElement | null;
  chatHost?: HTMLElement | null;
  sidebarHost?: HTMLElement | null;
  /** Layout spacing owned by the host surface. */
  className?: string;
  /** From {@link useHomeOnboardingSuggestionsState}; non-null while mounted. */
  persisted: HomeOnboardingSuggestionsPreferences;
  /** The gate hook's `update` — applies a reducer and persists. */
  onUpdatePersisted: (
    updater: (
      previous: HomeOnboardingSuggestionsPreferences,
    ) => HomeOnboardingSuggestionsPreferences,
  ) => void;
  /** Replaces the Home composer draft with the given prompt text. */
  onInjectPrompt: (text: string) => void;
  /** Categories picked on the tools step; null until first answered. */
  selectedRoles: readonly ProfileRoleId[] | null;
  /** The gate hook's `changeRoles` — saves the picked categories. */
  onChangeRoles: (roles: readonly ProfileRoleId[]) => void;
}

/** Name of the newest code workspace (sidebar appends new entries last). */
function latestCodeWorkspace(
  projects: readonly SidebarItem[],
): SidebarItem | null {
  for (let index = projects.length - 1; index >= 0; index -= 1) {
    if (projects[index].type !== 'cowork') {
      return projects[index];
    }
  }
  return null;
}

/**
 * The most code workspaces whose Cursor rules presence the checklist probes
 * (CAN-2053), newest first. The review stays reachable from Settings for
 * older projects.
 */
const CURSOR_RULES_PROBE_LIMIT = 20;
const WORKSPACE_ID_KEY_SEPARATOR = '\n';

/** Code workspace ids, newest first, joined into a stable selector value. */
function codeWorkspaceIdsKey(projects: readonly SidebarItem[]): string {
  const ids: string[] = [];
  for (let index = projects.length - 1; index >= 0; index -= 1) {
    if (projects[index].type !== 'cowork') ids.push(projects[index].id);
    if (ids.length === CURSOR_RULES_PROBE_LIMIT) break;
  }
  return ids.join(WORKSPACE_ID_KEY_SEPARATOR);
}

interface CursorRulesPresenceProbe {
  present: boolean;
  /** False when a probe failed or was cancelled; such answers are not cached. */
  settled: boolean;
}

/**
 * Asks each code workspace in turn whether it has Cursor rules, stopping at
 * the first that does. A metadata hint only: no rule contents are read, and
 * a failed probe counts as no rules.
 */
async function probeCursorRulesPresence(
  workspaceIds: readonly string[],
  isCancelled: () => boolean,
): Promise<CursorRulesPresenceProbe> {
  let settled = true;
  for (const workspaceId of workspaceIds) {
    if (isCancelled()) return { present: false, settled: false };
    try {
      const result = await window.api.editorSetup.presence({ workspaceId });
      if (result.cursorRulesPresent === true) {
        return { present: true, settled: true };
      }
    } catch {
      settled = false;
    }
  }
  return { present: false, settled };
}

function onboardingHeading(
  view: OnboardingChecklistView | undefined,
  selectedToolKey: string | null,
): string {
  if (!view) return 'Finding your next step';
  if (view.status === 'deferred') return 'Add a repo';
  // Items tailored to the active project template name it (CAN-3032).
  if (view.blueprint) return `Get started with ${view.blueprint.name}`;
  const { step } = view;
  switch (step.kind) {
    case 'import-projects-cta':
      return 'Import chats and projects from Claude and Codex';
    case 'import-editor-setup-cta':
      return EDITOR_SETUP_TITLE;
    case 'add-repo-cta':
      return 'Add a project';
    case 'connect-tools': {
      if (!selectedToolKey) return 'Connect your tools';
      const selectedTool = step.tools.find(
        (tool) => tool.key === selectedToolKey,
      );
      return selectedTool
        ? `Try the ${selectedTool.displayName} plugin`
        : 'Try a connected plugin';
    }
    case 'plugin-examples-preview':
      return 'Try your connected tools';
    case 'connect-agents':
      return 'Add your AI providers';
    case 'create-plan':
      return 'Try out plan mode';
    case 'enable-focus-shortcut':
    case 'focus-shortcut-blocked':
      return `Global hotkey for the ${brandText.appName} app`;
    case 'enable-launch-at-login':
    case 'launch-at-login-needs-approval':
      return `Open ${brandText.appName} when you sign in`;
    case 'get-mobile-app':
      return 'Get the mobile app';
    case 'advanced-prompt':
    case 'advanced-readiness':
      return 'Try an advanced example';
    default:
      return 'Try your next task';
  }
}

export function HomeOnboardingSuggestions({
  className,
  persisted,
  onUpdatePersisted,
  onInjectPrompt,
  selectedRoles,
  onChangeRoles,
  homeHost,
  chatHost,
  sidebarHost,
}: HomeOnboardingSuggestionsProps): JSX.Element | null {
  const cursorReleased = useFeatureFlagsStore(isCursorHarnessReleased);
  const cursorAvailable = useCursorChatAvailable(cursorReleased);
  const [claudeRefreshKey, setClaudeRefreshKey] = useState(0);
  const [codexRefreshKey, setCodexRefreshKey] = useState(0);
  const [ghRefreshKey, setGhRefreshKey] = useState(0);
  const [patConfigured, setPatConfigured] = useState<boolean | null>(null);
  const [loginProvider, setLoginProvider] = useState<AuthProviderId | null>(
    null,
  );
  const [readinessLaunchKey, setReadinessLaunchKey] = useState<string | null>(
    null,
  );
  const [readinessLaunchError, setReadinessLaunchError] = useState<
    string | null
  >(null);
  const [selectedToolKey, setSelectedToolKey] = useState<string | null>(null);
  const [reviewEntryId, setReviewEntryId] = useState<string | null>(null);
  const refreshProviderUsageDetails = useObservabilityStore(
    (s) => s.refreshProviderUsageDetails,
  );

  // Glanceable surface: the shared status caches are enough on mount for
  // every provider (a forced Claude probe would spawn the bundled binary and
  // a forced Codex probe an app-server, per mount, now that every install
  // mounts this); each refreshes explicitly when its login modal closes.
  const claudeStatus = useClaudeAuthStatus(claudeRefreshKey);
  const codexStatus = useCodexAuthStatus(codexRefreshKey);
  const ghStatus = useGitHubCliStatus(ghRefreshKey);
  const linear = useLinearAvailability();
  const credits = useAiCreditsAvailability();

  useEffect(
    () =>
      subscribeToConnectionChange(GITHUB_CONNECTION_CHANGED_EVENT, () =>
        setGhRefreshKey((key) => key + 1),
      ),
    [],
  );

  // GitHub is also satisfied by a saved PAT; re-check alongside every CLI
  // status refresh.
  useEffect(() => {
    let cancelled = false;
    window.api
      .loadGitHubPat()
      .then((token) => {
        if (!cancelled)
          setPatConfigured(
            typeof token === 'string' && token.trim().length > 0,
          );
      })
      .catch(() => {
        if (!cancelled) setPatConfigured(false);
      });
    return (): void => {
      cancelled = true;
    };
  }, [ghRefreshKey]);

  // Impression telemetry fires once when the checklist mounts.

  const codeWorkspaceId = useProjectsStore(
    (s) => latestCodeWorkspace(s.projects)?.id ?? null,
  );
  const latestRepoName = useProjectsStore(
    (s) => latestCodeWorkspace(s.projects)?.name ?? null,
  );
  const hasCodeWorkspace = codeWorkspaceId !== null;
  const readinessWorkspaceId = strictlyNontechnical(selectedRoles)
    ? null
    : codeWorkspaceId;
  const [readinessResult, setReadinessResult] = useState<{
    workspaceId: string;
    issues: WorkspaceReadinessIssue[];
  } | null>(null);
  useEffect(() => {
    if (!readinessWorkspaceId) return;
    let cancelled = false;
    void window.api
      .getWorkspaceReadiness({ workspaceId: readinessWorkspaceId })
      .then((result) => {
        if (!cancelled)
          setReadinessResult({
            workspaceId: readinessWorkspaceId,
            issues: result.issues,
          });
      })
      .catch(() => {
        // An unavailable audit must not stall the rest of onboarding.
        if (!cancelled)
          setReadinessResult({ workspaceId: readinessWorkspaceId, issues: [] });
      });
    return (): void => {
      cancelled = true;
    };
  }, [readinessWorkspaceId]);
  const readinessReady =
    readinessWorkspaceId === null ||
    readinessResult?.workspaceId === readinessWorkspaceId;
  // Until the project list has hydrated, `hasCodeWorkspace` is unknown: an
  // existing user must not see the add-repo CTA or deferred rows for the
  // moment the watchdog escape path renders the shell early.
  const hasHydratedProjects = useProjectsStore((s) => s.hasHydratedProjects);
  // A project added while the project step is live is that step's
  // completion: record it so the step keeps its number like any other done
  // step. A project that was already there when the list hydrated is not
  // recorded and takes no number (`countsProjectStep`).
  const lastKnownHasCodeWorkspace = useRef<boolean | null>(null);
  useEffect(() => {
    if (!hasHydratedProjects) return;
    const before = lastKnownHasCodeWorkspace.current;
    lastKnownHasCodeWorkspace.current = hasCodeWorkspace;
    if (before !== false || !hasCodeWorkspace) return;
    const entry = persisted.entries['add-repo'];
    if (entry?.completedAt !== undefined || entry?.dismissedAt !== undefined)
      return;
    const at = new Date().toISOString();
    onUpdatePersisted((state) => withEntryCompleted(state, 'add-repo', at));
  }, [
    hasHydratedProjects,
    hasCodeWorkspace,
    persisted.entries,
    onUpdatePersisted,
  ]);
  const githubState = gitHubConnectionState(ghStatus, patConfigured);
  const claudeState = agentProviderConnectionState(claudeStatus);
  const codexState = agentProviderConnectionState(codexStatus);
  const linearState = linearConnectionState(linear);
  // The active empty chat's project template (CAN-3032), published by the
  // chat host while it is mounted. Its bundled plugins join the catalog read
  // so they can be enabled from here, and its items lead the queue.
  const chatBlueprint = useOnboardingSuggestionSurfaces((s) => s.chatBlueprint);
  const chatBlueprintPending = useOnboardingSuggestionSurfaces(
    (s) => s.chatBlueprintPending,
  );
  const homeResumePending = useOnboardingSuggestionSurfaces(
    (s) => s.homeResumePending,
  );
  const pluginSuggestionsSource = usePluginSuggestions(
    selectedRoles,
    chatBlueprint
      ? {
          blueprintPluginRefs: chatBlueprint.pluginRefs,
          projectSelections: chatBlueprint.projectSelections,
        }
      : undefined,
  );
  const blueprintLive = useMemo(
    () =>
      chatBlueprint
        ? {
            projectId: chatBlueprint.projectId,
            name: chatBlueprint.name,
            plugins: pluginSuggestionsSource.blueprintSuggestions,
            starterPrompts: chatBlueprint.starterPrompts,
          }
        : undefined,
    [chatBlueprint, pluginSuggestionsSource.blueprintSuggestions],
  );

  const dailyCreditDrip = useDailyCreditDripOptIn();
  const mobilePromo = useMobileAppPromo();
  const [mobileDialogOpen, setMobileDialogOpen] = useState(false);
  useEffect(() => {
    if (!mobilePromo.showPromotional) setMobileDialogOpen(false);
  }, [mobilePromo.showPromotional]);
  const handleGetMobileApp = (): void => setMobileDialogOpen(true);
  const focusShortcut = useGlobalFocusShortcutStatus();
  const focusShortcutStatus = focusShortcut.status;
  const focusShortcutLive = useMemo(
    () => ({
      enabled: focusShortcutStatus?.enabled ?? false,
      registered: focusShortcutStatus?.registered ?? false,
      shortcut: formatGlobalFocusShortcutForDisplay(focusShortcutStatus),
    }),
    [focusShortcutStatus],
  );
  // Launch at sign-in (CAN-3449) is the OS's read-back. Until it answers the
  // entry is unknown, so the queue waits rather than drawing without it.
  const launchAtLogin = useLaunchAtLoginStatus();
  const launchAtLoginStatus = launchAtLogin.status;
  const launchAtLoginLive = useMemo(
    () =>
      launchAtLoginStatus === null
        ? undefined
        : {
            supported: launchAtLoginStatus.supported,
            enabled: launchAtLoginStatus.enabled,
            pendingApproval: launchAtLoginStatus.pendingApproval,
          },
    [launchAtLoginStatus],
  );

  // Whether a Claude or Codex store exists locally gates the import entry
  // (CAN-2439). A cheap existence probe, resolved once per mount and
  // remembered across mounts so only the very first Home render can see the
  // entry arrive after the list has drawn.
  const [providerStoresPresent, setProviderStoresPresent] = useState(
    lastKnownProviderStoresPresent,
  );
  // The queue must not be judged empty (and that judgement persisted) while
  // this probe is still in flight: `import-projects` is filtered out until
  // it answers, so a pending answer can be the only unresolved row.
  const [providerPresenceResolved, setProviderPresenceResolved] =
    useState(false);
  useEffect(() => {
    let cancelled = false;
    const api = window.api.externalProjects;
    if (!api) {
      setProviderPresenceResolved(true);
      return undefined;
    }
    void api
      .readProviderPresence()
      .then((state) => {
        lastKnownProviderStoresPresent = state.providerStoresPresent;
        if (!cancelled) setProviderStoresPresent(state.providerStoresPresent);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setProviderPresenceResolved(true);
      });
    return (): void => {
      cancelled = true;
    };
  }, []);

  // Whether any code project has Cursor rules gates the rules entry
  // (CAN-2053). Probed once the project list hydrates and again when the set
  // of code projects changes; the entry stays hidden until an answer lands.
  const cursorRulesWorkspaceKey = useProjectsStore((s) =>
    codeWorkspaceIdsKey(s.projects),
  );
  const [cursorRulesPresence, setCursorRulesPresence] = useState(
    lastKnownCursorRulesPresence,
  );
  useEffect(() => {
    // Without a code project there is nothing to probe (answered below).
    if (!hasHydratedProjects || cursorRulesWorkspaceKey === '') {
      return undefined;
    }
    const known = lastKnownCursorRulesPresence;
    if (known?.key === cursorRulesWorkspaceKey) {
      setCursorRulesPresence(known);
      return undefined;
    }
    let cancelled = false;
    const workspaceIds = cursorRulesWorkspaceKey.split(
      WORKSPACE_ID_KEY_SEPARATOR,
    );
    void probeCursorRulesPresence(workspaceIds, () => cancelled).then(
      (probe) => {
        const answer = { key: cursorRulesWorkspaceKey, present: probe.present };
        if (probe.settled) lastKnownCursorRulesPresence = answer;
        if (!cancelled) setCursorRulesPresence(answer);
      },
    );
    return (): void => {
      cancelled = true;
    };
  }, [hasHydratedProjects, cursorRulesWorkspaceKey]);
  const cursorRulesAnswered =
    cursorRulesPresence?.key === cursorRulesWorkspaceKey;
  const cursorRulesPresenceResolved =
    cursorRulesAnswered ||
    (hasHydratedProjects && cursorRulesWorkspaceKey === '');
  const cursorRulesPresent = cursorRulesAnswered
    ? cursorRulesPresence.present
    : undefined;

  const liveInputs = useMemo(
    () => ({
      hasCodeWorkspace,
      latestRepoName,
      github: githubState,
      claude: claudeState,
      codex: codexState,
      linear: linearState,
      aiCreditsEligible: credits.eligible,
      selectedRoles,
      pluginSuggestions: pluginSuggestionsSource.suggestions,
      focusShortcut: focusShortcutLive,
      launchAtLogin: launchAtLoginLive,
      providerStoresPresent,
      cursorRulesPresent,
      dailyCreditDrip: dailyCreditDrip.live,
      mobileAppPromoEligible: mobilePromo.showPromotional,
      readiness:
        readinessResult?.workspaceId === readinessWorkspaceId
          ? readinessResult
          : undefined,
      blueprint: blueprintLive,
    }),
    [
      blueprintLive,
      hasCodeWorkspace,
      latestRepoName,
      githubState,
      claudeState,
      codexState,
      linearState,
      credits.eligible,
      selectedRoles,
      pluginSuggestionsSource.suggestions,
      focusShortcutLive,
      launchAtLoginLive,
      providerStoresPresent,
      cursorRulesPresent,
      dailyCreditDrip.live,
      mobilePromo.showPromotional,
      readinessResult,
      readinessWorkspaceId,
    ],
  );

  const recommendationsReady = pluginSuggestionsSource.ready && readinessReady;

  const { checklist, visible: hydratedViews } = useMemo(
    () =>
      deriveOnboardingSuggestionQueue(
        persisted,
        liveInputs,
        recommendationsReady,
      ),
    [persisted, liveInputs, recommendationsReady],
  );
  // Project import is the first eligible lesson. Do not briefly render the
  // role picker ahead of it while the local Claude/Codex presence probe is
  // still deciding whether that lesson belongs in this checklist.
  // The arrows move between steps: one entry, or a project template's
  // group of rows (CAN-3032), revisited together.
  const checklistSteps = useMemo(
    () => onboardingChecklistSteps(checklist),
    [checklist],
  );
  const reviewedStep = reviewEntryId
    ? checklistSteps.find((step) =>
        step.some((view) => view.entryId === reviewEntryId),
      )
    : undefined;
  // Likewise a seeded project's template, still being read for its new chat
  // (CAN-3032), and its plugin rows, which join only once the plugin source
  // has settled: the general rows must not draw and then swap. The source
  // settles well under a second; past the bound the rows draw with whatever
  // has settled rather than hide the checklist behind a hung probe.
  const [pluginSourceHoldExpired, setPluginSourceHoldExpired] = useState(false);
  useEffect(() => {
    if (chatBlueprint === null || pluginSuggestionsSource.ready) {
      setPluginSourceHoldExpired(false);
      return;
    }
    const timer = window.setTimeout(
      () => setPluginSourceHoldExpired(true),
      TEMPLATE_PLUGIN_SOURCE_HOLD_MS,
    );
    return (): void => window.clearTimeout(timer);
  }, [chatBlueprint, pluginSuggestionsSource.ready]);
  const templateRowsSettled =
    chatBlueprint === null ||
    pluginSuggestionsSource.ready ||
    pluginSourceHoldExpired;
  const views = useMemo(
    () =>
      hasHydratedProjects &&
      providerPresenceResolved &&
      launchAtLogin.hydrated &&
      !chatBlueprintPending &&
      templateRowsSettled
        ? (reviewedStep ?? hydratedViews)
        : EMPTY_VIEWS,
    [
      chatBlueprintPending,
      hasHydratedProjects,
      hydratedViews,
      launchAtLogin.hydrated,
      providerPresenceResolved,
      reviewedStep,
      templateRowsSettled,
    ],
  );
  useEffect(() => {
    if (reviewEntryId !== null && reviewedStep === undefined) {
      setReviewEntryId(null);
    }
  }, [reviewEntryId, reviewedStep]);
  useEffect(() => setReviewEntryId(null), [persisted.startedAt]);
  // Registers with the OS before saving; completion follows the live status.
  const handleEnableFocusShortcut = useCallback((): void => {
    useGlobalFocusShortcutStore
      .getState()
      .update({ enabled: true })
      .catch(() => {
        // Deliberately quiet: the row re-derives from the live status on the
        // next push, so a failed write simply leaves it asking again, and
        // the Settings section carries the explanation for anyone who
        // retries there.
      });
  }, []);
  // Another app holds the chord: only a different chord fixes that, and the
  // recorder lives in Settings.
  const handleChangeFocusShortcut = useCallback((): void => {
    useNavigationStore.getState().openSettings('shortcuts', {
      scrollTo: GLOBAL_FOCUS_SHORTCUT_SETTINGS_TARGET,
    });
  }, []);
  // Asks the OS; completion follows its read-back, not the click.
  const handleEnableLaunchAtLogin = useCallback((): void => {
    useLaunchAtLoginStore
      .getState()
      .setEnabled(true)
      .catch(() => {
        // Deliberately quiet, like the focus shortcut: the row re-derives
        // from the next status, so a refusal leaves it asking again, and
        // Settings carries the explanation for anyone who retries there.
      });
  }, []);
  // Registered but waiting on the user: only System Settings can finish it.
  const handleOpenLaunchAtLoginSettings = useCallback((): void => {
    void useLaunchAtLoginStore.getState().openSystemSettings();
  }, []);
  // Advanced examples belong only beside a composer, never in the sidebar.
  const sidebarView = views.find(
    (view) => !view.step.kind.startsWith('advanced-'),
  );
  const sidebarHasRows = sidebarView !== undefined;
  // A template step's arrow skips every row its window shows, so its name
  // says so (CAN-3032); a single remaining row keeps the row's own name.
  const leadView = views[0];
  const templateStepSkipLabel =
    views.length > 1 && leadView?.blueprint !== undefined
      ? `Skip ${leadView.blueprint.name} ${leadView.step.kind === 'plugin-add' ? 'plugins' : 'prompts'}`
      : undefined;
  // Every input that can hide a row while it is still being probed must have
  // answered before the queue is judged empty: the catalog, the project
  // list, provider presence (`import-projects`), Cursor rules presence
  // (`import-editor-setup`), and the GitHub/Linear connection probes (their
  // advanced examples exist only once connected).
  const queueSettled =
    recommendationsReady &&
    hasHydratedProjects &&
    providerPresenceResolved &&
    cursorRulesPresenceResolved &&
    launchAtLogin.hydrated &&
    !chatBlueprintPending &&
    githubState !== 'checking' &&
    linearState !== 'checking';
  // Composer examples can remain after the sidebar setup steps finish.
  const homeHasRows = views.length > 0 || !queueSettled;
  const queueStatus =
    views.length > 0 ? 'has-rows' : queueSettled ? 'exhausted' : 'loading';
  useLayoutEffect(() => {
    useOnboardingSuggestionSurfaces.setState({
      sidebarHasRows,
      homeHasRows,
      queueStatus,
    });
  }, [sidebarHasRows, homeHasRows, queueStatus]);
  useLayoutEffect(
    () => (): void =>
      // Unmount only: a dependency change must not publish a transient
      // "no rows" state.
      useOnboardingSuggestionSurfaces.setState({
        sidebarHasRows: false,
        homeHasRows: false,
        queueStatus: 'loading',
      }),
    [],
  );
  const nontechnical = strictlyNontechnical(selectedRoles);
  const activeTools =
    views[0]?.step.kind === 'connect-tools' ? views[0].step.tools : null;
  // A template context trims its own plugins out of the tools step, so the
  // list is not the global lesson's; it must not retire that lesson.
  const connectedToolsEntryId =
    recommendationsReady &&
    chatBlueprint === null &&
    activeTools !== null &&
    activeTools.length > 0 &&
    activeTools.every((tool) => tool.connected)
      ? views[0]?.entryId
      : undefined;
  useEffect(() => {
    if (!connectedToolsEntryId) return;
    const completedAt = new Date().toISOString();
    onUpdatePersisted((previous) => {
      const entry = previous.entries[connectedToolsEntryId];
      if (entry?.completedAt || entry?.dismissedAt) return previous;
      return withEntryCompleted(previous, connectedToolsEntryId, completedAt);
    });
  }, [connectedToolsEntryId, onUpdatePersisted]);
  useEffect(() => {
    if (
      selectedToolKey !== null &&
      !activeTools?.some((tool) => tool.key === selectedToolKey)
    ) {
      setSelectedToolKey(null);
    }
  }, [activeTools, selectedToolKey]);
  const cardHeading = onboardingHeading(views[0], selectedToolKey);
  const showingAgentConnections = views.some(
    (view) => view.step.kind === 'connect-agents',
  );
  useEffect(() => {
    if (showingAgentConnections) return;
    if (
      useOnboardingSuggestionSurfaces.getState().modelPickerHighlightTarget !==
      null
    ) {
      useOnboardingSuggestionSurfaces.setState({
        modelPickerHighlightTarget: null,
      });
    }
  }, [showingAgentConnections]);
  // A template window is one step; completed steps precede remaining ones so
  // finishing a step advances the number by one even when another was done
  // out of band. Project readiness fixes are numbered after the last setup
  // step; the steady-state examples follow the numbered steps in navigation
  // and are never numbered. The views of a window come from one template
  // step and share its kind, so the first view classifies the whole window.
  const onboardingSteps = useMemo(
    () => checklistSteps.filter((step) => !isSteadyStateView(step[0])),
    [checklistSteps],
  );
  const progress = useMemo(
    () =>
      checklistProgress({
        entries: onboardingSteps,
        isResolved: (step) => step.every(isResolvedSuggestion),
        isCounted: (step) =>
          step.some((view) => {
            const recorded =
              persisted.entries[view.entryId]?.completedAt !== undefined ||
              persisted.entries[view.entryId]?.dismissedAt !== undefined;
            // A project that was already there asks nothing of the user, so
            // the checklist leads with the first step that does.
            if (view.entryId === 'add-repo') {
              return countsProjectStep({
                satisfied: hasCodeWorkspace,
                recorded,
              });
            }
            return (
              !isRepoDependentStep(view.step) || hasCodeWorkspace || recorded
            );
          }),
      }),
    [onboardingSteps, hasCodeWorkspace, persisted.entries],
  );
  const navigationSteps = useMemo(
    () => [
      ...progress.order,
      ...checklistSteps.filter((step) => isSteadyStateView(step[0])),
    ],
    [checklistSteps, progress],
  );
  const displayedStep = checklistSteps.find((step) =>
    step.some((view) => view.entryId === views[0]?.entryId),
  );
  const currentStep =
    displayedStep && !isSteadyStateView(displayedStep[0])
      ? progress.stepNumber(displayedStep)
      : progress.total;
  const progressLabel = `${currentStep}/${progress.total}`;
  const focusEntry = useOnboardingSuggestionSurfaces((s) => s.focusEntry);
  useEffect(() => {
    if (!homeHost || !focusEntry) return;
    // Home navigation schedules composer autofocus on the next frame.
    // Apply the explicit role-selection target after that navigation settles.
    let focusFrame = 0;
    const navigationFrame = requestAnimationFrame(() => {
      focusFrame = requestAnimationFrame(() => {
        const row = homeHost.querySelector(
          `[data-testid="home-onboarding-suggestion-${CSS.escape(focusEntry)}"]`,
        );
        const control = row?.querySelector<HTMLElement>(
          'button:not([disabled]):not([data-checklist-navigation])',
        );
        if (!row) return;
        row.scrollIntoView({ block: 'nearest' });
        control?.focus();
        useOnboardingSuggestionSurfaces.setState({ focusEntry: null });
      });
    });
    return (): void => {
      cancelAnimationFrame(navigationFrame);
      cancelAnimationFrame(focusFrame);
    };
  }, [homeHost, focusEntry, views]);
  // The impression means a suggestion was actually shown; neither a mount
  // that only finds an empty queue nor the loading placeholder counts.
  const impressionRef = useRef(false);
  useEffect(() => {
    if (impressionRef.current || views.length === 0) return;
    impressionRef.current = true;
    trackOnboardingSuggestionsImpression();
  }, [views.length]);

  // Newly discovered plugin activities slide into place; rows present
  // on the previous pass (and the initial mount) render still. Ref updates
  // in an effect so re-renders without membership changes animate nothing.
  const previousEntryIdsRef = useRef<ReadonlySet<string> | null>(null);
  const enteringEntryIds = ((): ReadonlySet<string> => {
    const previous = previousEntryIdsRef.current;
    if (previous === null) return new Set();
    return new Set(
      views
        .map((view) => view.entryId)
        .filter((entryId) => !previous.has(entryId)),
    );
  })();
  useEffect(() => {
    previousEntryIdsRef.current = new Set(views.map((view) => view.entryId));
  }, [views]);

  // Curated MCP logos double as plugin-suggestion logos: the plugin's stable
  // name joins the curated MCP catalog key (same heuristic the try-step
  // prompt lookup uses), with a monogram fallback.
  const { entries: curatedMcpEntries } = useCuratedMcpServers();
  const mcpLogoByKey = useMemo(() => {
    const map = new Map<string, string | undefined>();
    for (const entry of curatedMcpEntries) map.set(entry.key, entry.logoUrl);
    return map;
  }, [curatedMcpEntries]);

  useCurrentUiStateReporter(
    'home.onboardingSuggestions',
    useMemo(
      () => ({
        open: true,
        entries: views.map((view) => `${view.entryId}:${view.step.kind}`),
      }),
      [views],
    ),
  );

  const dismissEntries = useCallback(
    (entryIds: readonly string[]): void => {
      for (const entryId of entryIds) {
        // Targeted: dismissing an unrelated row must not cancel another
        // row's pending armed completion.
        disarmOnboardingSuggestion(entryId);
      }
      // Timestamp hoisted OUT of the updater: the gate hook replays the
      // delta against freshly-read persisted state, and the optimistic
      // apply and the replayed write must record the same instant. One
      // write per step, however many rows it skips.
      const dismissedAt = new Date().toISOString();
      onUpdatePersisted((previous) =>
        entryIds.reduce(
          (state, entryId) => withEntryDismissed(state, entryId, dismissedAt),
          previous,
        ),
      );
    },
    [onUpdatePersisted],
  );

  const stepIndexOf = useCallback(
    (view: OnboardingChecklistView): number =>
      checklistSteps.findIndex((step) =>
        step.some((candidate) => candidate.entryId === view.entryId),
      ),
    [checklistSteps],
  );
  /** First row of the step before this row's step. */
  const previousEntry = useCallback(
    (view: OnboardingChecklistView): OnboardingChecklistView | undefined => {
      const index = navigationSteps.findIndex((step) =>
        step.some((candidate) => candidate.entryId === view.entryId),
      );
      return index > 0 ? navigationSteps[index - 1][0] : undefined;
    },
    [navigationSteps],
  );
  const showPreviousEntry = useCallback(
    (view: OnboardingChecklistView): void => {
      const previous = previousEntry(view);
      if (previous) {
        setSelectedToolKey(null);
        setReviewEntryId(previous.entryId);
      }
    },
    [previousEntry],
  );
  /** From a revisited step: the next one, or back to the live queue. */
  const advanceReview = useCallback(
    (view: OnboardingChecklistView): void => {
      const index = navigationSteps.findIndex((step) =>
        step.some((candidate) => candidate.entryId === view.entryId),
      );
      const next = index >= 0 ? navigationSteps[index + 1] : undefined;
      setSelectedToolKey(null);
      if (
        next &&
        !next.some((candidate) =>
          hydratedViews.some((live) => live.entryId === candidate.entryId),
        )
      ) {
        setReviewEntryId(next[0].entryId);
      } else {
        setReviewEntryId(null);
      }
    },
    [navigationSteps, hydratedViews],
  );
  const skipOrAdvance = useCallback(
    (view: OnboardingChecklistView, singleRow = false): void => {
      if (reviewEntryId !== null) {
        advanceReview(view);
        return;
      }
      // Skipping a step skips every row it still shows; telemetry records
      // the one click, not each row.
      trackOnboardingSuggestionDismiss(view.entryId);
      const index = stepIndexOf(view);
      const step = !singleRow && index >= 0 ? checklistSteps[index] : [view];
      dismissEntries(
        step
          .filter(
            (candidate) =>
              candidate.entryId === view.entryId ||
              !isResolvedSuggestion(candidate),
          )
          .map((candidate) => candidate.entryId),
      );
    },
    [advanceReview, checklistSteps, dismissEntries, reviewEntryId, stepIndexOf],
  );

  const handleFixReadiness = useCallback(
    (entryId: string, workspaceId: string, issue: WorkspaceReadinessIssue) => {
      if (readinessLaunchKey !== null) return;
      trackOnboardingSuggestionCtaClick(entryId, 'advanced-readiness');
      setReadinessLaunchKey(
        `${workspaceId}:${workspaceReadinessIssueKey(issue)}`,
      );
      setReadinessLaunchError(null);
      void launchWorkspaceReadinessFix(workspaceId, issue)
        .then((result) => {
          if (result.ok) {
            const at = new Date().toISOString();
            onUpdatePersisted((state) =>
              withEntryCompleted(state, entryId, at),
            );
          } else {
            setReadinessLaunchError(result.message);
          }
        })
        .catch(() => {
          setReadinessLaunchError(
            'Could not start this project fix. Try again.',
          );
        })
        .finally(() => setReadinessLaunchKey(null));
    },
    [onUpdatePersisted, readinessLaunchKey],
  );

  /**
   * Repo-dependent CTAs act on the composer's SELECTED workspace, while the
   * queue only knows a code workspace exists somewhere. If the composer is
   * targeting Cowork (readily reachable — every install has a default
   * Cowork entry), retarget it to a code workspace first so the advertised
   * flow can actually run.
   */
  const ensureCodeWorkspaceTarget = useCallback((): boolean => {
    const composer = useHomeComposerStore.getState();
    const allProjects = useProjectsStore.getState().projects;
    const current = allProjects.find(
      (project) => project.id === composer.workspaceId,
    );
    if (current && current.type !== 'cowork') return true;
    // Newest code workspace (sidebar appends last) — the same notion of
    // "the user's repo" queue copy is worded around.
    let codeWorkspace: SidebarItem | null = null;
    for (let index = allProjects.length - 1; index >= 0; index -= 1) {
      if (allProjects[index].type !== 'cowork') {
        codeWorkspace = allProjects[index];
        break;
      }
    }
    if (!codeWorkspace) return false;
    composer.selectWorkspace(codeWorkspace.id);
    return true;
  }, []);

  const injectPromptForTarget = useCallback(
    (promptText: string, target: PromptTarget): void => {
      if (target === 'chat') {
        const targetTabId =
          useOnboardingSuggestionSurfaces.getState().chatPromptTargetId;
        const detail: InsertChatTextDetail = {
          text: promptText,
          ...(targetTabId ? { targetTabId } : {}),
        };
        document.dispatchEvent(
          new CustomEvent(INSERT_CHAT_TEXT_EVENT, { detail }),
        );
        return;
      }
      onInjectPrompt(promptText);
    },
    [onInjectPrompt],
  );

  // Prompt-style CTAs "arm" their entry: the entry completes on the next
  // successful Home send (deliberately even if the user edits the injected
  // text first — they still ran a task from the suggestion). Arming and the
  // completion write live at module scope (`completionWriter.ts`) because
  // every navigating send unmounts this component before a local subscriber
  // could persist anything.
  const armWithPrompt = useCallback(
    (
      entryId: string,
      stepKind: string,
      promptText: string,
      target: PromptTarget = 'home',
    ): void => {
      trackOnboardingSuggestionCtaClick(entryId, stepKind);
      // Only repo-referencing prompts (the add-repo TODO, its consolidated
      // GitHub equivalent, and the Linear ticket plan) need a code-workspace
      // target. The nontechnical agents prompt and other plugin prompts can
      // also run in Cowork.
      const isRepoToolPrompt =
        stepKind === 'connect-tools-prompt' &&
        (promptText === addRepoTryPrompt(latestRepoName) ||
          promptText === LINEAR_TRY_PROMPT);
      if (
        ((stepKind === 'prompt' && entryId === 'add-repo') ||
          stepKind === 'linear-try-prompt' ||
          (isRepoToolPrompt && latestRepoName !== null)) &&
        target === 'home' &&
        !ensureCodeWorkspaceTarget()
      ) {
        return;
      }
      // Arm for the surface the prompt lands in: a chat-targeted prompt
      // completes only on a send from that tab, a Home one only from Home.
      // A chat target that has already gone means nothing can complete the
      // item; leave it unarmed rather than arm it for a Home send.
      if (target === 'chat') {
        const chatId =
          useOnboardingSuggestionSurfaces.getState().chatPromptTargetId;
        if (chatId) armOnboardingSuggestion(entryId, { chatId });
      } else {
        armOnboardingSuggestion(entryId);
      }
      injectPromptForTarget(promptText, target);
    },
    [ensureCodeWorkspaceTarget, injectPromptForTarget, latestRepoName],
  );

  // A prompt chosen inside a connected tool is a preview of that tool, not
  // completion of the broader "Connect your tools" lesson. Inject it through
  // the same repo-targeting path, but leave the parent entry pending so Home
  // returns to the complete tool grid after the task is sent.
  const injectConnectedToolPrompt = useCallback(
    (
      entryId: string,
      promptText: string,
      target: PromptTarget = 'home',
    ): void => {
      trackOnboardingSuggestionCtaClick(entryId, 'connect-tools-prompt');
      const isRepoToolPrompt =
        promptText === addRepoTryPrompt(latestRepoName) ||
        promptText === LINEAR_TRY_PROMPT;
      if (
        isRepoToolPrompt &&
        latestRepoName !== null &&
        target === 'home' &&
        !ensureCodeWorkspaceTarget()
      ) {
        return;
      }
      injectPromptForTarget(promptText, target);
    },
    [ensureCodeWorkspaceTarget, injectPromptForTarget, latestRepoName],
  );

  const handleAddRepo = useCallback((): void => {
    trackOnboardingSuggestionCtaClick('add-repo', 'add-repo-cta');
    useNavigationStore.getState().openAddWorkspaceModal();
  }, []);

  const handleImportProjects = useCallback((): void => {
    trackOnboardingSuggestionCtaClick('import-projects', 'import-projects-cta');
    openImportProjectsModal({ source: 'checklist' });
  }, []);

  // Opening the review never completes the entry: the review itself marks it
  // done only after an apply that leaves rules on. No workspace is passed, so
  // the review asks which project to use instead of guessing.
  const handleImportEditorSetup = useCallback((): void => {
    trackOnboardingSuggestionCtaClick(
      'import-editor-setup',
      'import-editor-setup-cta',
    );
    openRepoRulesModal({ source: 'checklist' });
  }, []);

  const handleCreatePlan = useCallback((): void => {
    trackOnboardingSuggestionCtaClick('plan-mode', 'create-plan');
    // Plan mode is worktree-scoped, so point the composer at the user's latest
    // code workspace before drawing attention to its toggle.
    if (!ensureCodeWorkspaceTarget()) return;
    useHomeComposerStore.getState().setMode('chat');
    useOnboardingSuggestionSurfaces.setState({ planModeHighlight: true });
    useNavigationStore.getState().navigate('home');
  }, [ensureCodeWorkspaceTarget]);

  // Two quick toggles can land before the picked roles come back through
  // props, so the toggle reads and updates this mirror rather than the
  // prop, which may still show the state before the previous click.
  const selectedRolesMirror = useRef(selectedRoles);
  useEffect(() => {
    selectedRolesMirror.current = selectedRoles;
  }, [selectedRoles]);
  const handleToggleRole = useCallback(
    (role: ProfileRoleId): void => {
      const current = selectedRolesMirror.current ?? [];
      const selected = !current.includes(role);
      const next = selected
        ? [...current, role]
        : current.filter((id) => id !== role);
      selectedRolesMirror.current = next;
      trackOnboardingCategoryToggle(role, selected, next.length);
      onChangeRoles(next);
    },
    [onChangeRoles],
  );

  const { enablePlugins } = pluginSuggestionsSource;
  const [toolInstallError, setToolInstallError] = useState<string | null>(null);
  const [installingToolKey, setInstallingToolKey] = useState<string | null>(
    null,
  );
  const toolInstallInFlight = useRef(false);
  const [toolSetup, setToolSetup] = useState<{
    entry: CuratedMcpServerEntry;
    keys: readonly string[];
  } | null>(null);

  const installTool = useCallback(
    async (keys: readonly string[], key: string): Promise<void> => {
      if (toolInstallInFlight.current) return;
      toolInstallInFlight.current = true;
      setInstallingToolKey(key);
      setToolInstallError(null);
      try {
        const plugin = await installOnboardingPlugin(keys);
        const installedKeys = [
          `${plugin.marketplaceId}/${plugin.name}`.toLowerCase(),
        ];
        const entry = curatedMcpEntries.find(
          (candidate) =>
            candidate.key.toLowerCase() === plugin.name.toLowerCase() ||
            normalizeCapabilityName(candidate.name) ===
              normalizeCapabilityName(plugin.displayName ?? plugin.name),
        );
        if (entry) setToolSetup({ entry, keys: installedKeys });
        else if (!(await enablePlugins(installedKeys)))
          throw new Error('Could not enable this plugin. Try again.');
      } catch (error) {
        setToolInstallError(
          error instanceof Error
            ? error.message
            : 'Could not install this plugin. Try again.',
        );
      } finally {
        toolInstallInFlight.current = false;
        setInstallingToolKey(null);
      }
    },
    [curatedMcpEntries, enablePlugins],
  );

  const finishToolSetup = useCallback(async (): Promise<void> => {
    if (!toolSetup) return;
    try {
      if (!(await enablePlugins(toolSetup.keys)))
        throw new Error('Could not enable this plugin. Try again.');
      setToolSetup(null);
    } catch (error) {
      setToolInstallError(
        error instanceof Error
          ? error.message
          : 'Could not enable this plugin. Try again.',
      );
      setToolSetup(null);
    }
  }, [toolSetup, enablePlugins]);
  const handleAddPlugin = useCallback(
    (entryId: string, enableKeys: readonly string[]): void => {
      trackOnboardingSuggestionCtaClick(entryId, 'plugin-add');
      void installTool(enableKeys, entryId);
    },
    [installTool],
  );

  const handleConnect = useCallback((provider: AuthProviderId): void => {
    trackOnboardingSuggestionCtaClick(
      provider === 'github' ? 'github' : 'agent-connections',
      `connect-${provider}`,
    );
    setLoginProvider(provider);
  }, []);

  const handleConnectLinear = useCallback((): void => {
    trackOnboardingSuggestionCtaClick('linear', 'connect-linear');
    // The Linear API-key field sits below other rows on its Settings page;
    // land on it directly instead of the top of the page.
    openIntegrationSettings({ scrollTo: 'settings-linear-token-input' });
  }, []);

  const handleOpenOllamaSettings = useCallback((): void => {
    trackOnboardingSuggestionCtaClick(
      'agent-connections',
      'open-ollama-settings',
    );
    useNavigationStore.getState().openSettings('ollama');
  }, []);

  const handleHighlightModelPicker = useCallback(
    (promptTarget: PromptTarget): void => {
      trackOnboardingSuggestionCtaClick(
        'agent-connections',
        'highlight-model-picker',
      );
      const chatId =
        useOnboardingSuggestionSurfaces.getState().chatPromptTargetId;
      useOnboardingSuggestionSurfaces.setState({
        modelPickerHighlightTarget:
          promptTarget === 'chat' && chatId
            ? { scope: 'chat', chatId }
            : { scope: 'home' },
      });
    },
    [],
  );

  const handleAuthorizationUrl = useCallback(
    (url: string): boolean | Promise<boolean> => {
      const target =
        useOnboardingSuggestionSurfaces.getState().chatBrowserTarget;
      if (!target) return false;
      return openOnboardingAuthorizationUrl(target, url);
    },
    [],
  );

  const handleOpenTool = useCallback(
    (tool: OnboardingToolRecommendation): void => {
      trackOnboardingSuggestionCtaClick(
        'github',
        tool.connected ? 'open-tool-prompts' : `connect-${tool.kind}`,
      );
      if (tool.connected) {
        setSelectedToolKey(tool.key);
        return;
      }
      if (tool.kind === 'linear') {
        handleConnectLinear();
        return;
      }
      void installTool(tool.enableKeys ?? [], tool.key);
    },
    [handleConnectLinear, installTool],
  );

  const handleCloseLogin = useCallback((): void => {
    const provider = loginProvider;
    setLoginProvider(null);
    if (provider === 'claude') {
      invalidateClaudeAuthStatusCache();
      setClaudeRefreshKey((k) => k + 1);
      void refreshProviderUsageDetails('claude');
      return;
    }
    if (provider === 'codex') {
      invalidateCodexAuthStatusCache();
      setCodexRefreshKey((k) => k + 1);
      void refreshProviderUsageDetails('codex');
    }
  }, [loginProvider, refreshProviderUsageDetails]);

  const loginModalProvider: AuthTerminalProvider | null = loginProvider;

  // While page Home shows the startup resume row above this card, Home
  // displays only the lead suggestion (CAN-4746). Display only: the queue,
  // progress, navigation and the chat surface keep the full window.
  const homeViews = homeResumePending ? views.slice(0, 1) : views;
  const renderCard = (promptTarget: PromptTarget): JSX.Element => (
    <section
      data-testid="home-onboarding-suggestions"
      aria-label={cardHeading}
      className={`flex w-full flex-col gap-3 ${className ?? ''}`}
    >
      <ul
        className="flex flex-col"
        data-testid={
          (promptTarget === 'home' ? homeViews : views).some(
            (view) =>
              view.step.kind === 'advanced-prompt' ||
              view.step.kind === 'advanced-readiness',
          )
            ? 'home-onboarding-advanced-prompts'
            : 'home-onboarding-active-suggestions'
        }
      >
        {(promptTarget === 'home' ? homeViews : views).map((view, index) => {
          const hasSpecificHeading =
            view.step.kind === 'add-repo-cta' ||
            view.step.kind === 'connect-tools' ||
            view.step.kind === 'plugin-examples-preview' ||
            view.step.kind === 'connect-agents' ||
            view.step.kind === 'enable-focus-shortcut' ||
            view.step.kind === 'focus-shortcut-blocked' ||
            view.step.kind === 'enable-launch-at-login' ||
            view.step.kind === 'launch-at-login-needs-approval';
          const isSteadyStateRecommendation =
            view.step.kind === 'advanced-prompt';
          return (
            <OnboardingSuggestionRow
              key={view.entryId}
              installingToolKey={installingToolKey}
              // Rows tailored to a project template share a window like other
              // grouped rows, so only the first carries the template heading.
              heading={
                isSteadyStateRecommendation
                  ? undefined
                  : hasSpecificHeading
                    ? cardHeading
                    : index === 0
                      ? view.blueprint !== undefined
                        ? cardHeading
                        : 'Getting started'
                      : undefined
              }
              headingMeta={
                !isSteadyStateRecommendation && index === 0
                  ? progressLabel
                  : undefined
              }
              // A template step's rows move together under the first row's
              // arrows; arrows on a later row would act on that row alone.
              hideNavigation={index > 0 && view.blueprint !== undefined}
              skipLabel={
                index === 0 && !(promptTarget === 'home' && homeResumePending)
                  ? templateStepSkipLabel
                  : undefined
              }
              view={view}
              nontechnical={nontechnical}
              onGetMobileApp={handleGetMobileApp}
              onDismiss={(): void =>
                skipOrAdvance(
                  view,
                  promptTarget === 'home' && homeResumePending,
                )
              }
              onPrevious={(): void => showPreviousEntry(view)}
              previousDisabled={previousEntry(view) === undefined}
              onArmWithPrompt={(entryId, stepKind, promptText): void =>
                armWithPrompt(entryId, stepKind, promptText, promptTarget)
              }
              onInjectConnectedToolPrompt={(entryId, promptText): void =>
                injectConnectedToolPrompt(entryId, promptText, promptTarget)
              }
              onAdvancedPrompt={(
                entryId,
                promptText,
                requiresCodeWorkspace,
              ): void => {
                if (requiresCodeWorkspace && !ensureCodeWorkspaceTarget())
                  return;
                armWithPrompt(
                  entryId,
                  'advanced-prompt',
                  promptText,
                  promptTarget,
                );
              }}
              onFixReadiness={handleFixReadiness}
              readinessLaunchKey={readinessLaunchKey}
              onAddRepo={handleAddRepo}
              onImportProjects={handleImportProjects}
              onImportEditorSetup={handleImportEditorSetup}
              onCreatePlan={handleCreatePlan}
              onConnect={handleConnect}
              onHighlightModelPicker={(): void =>
                handleHighlightModelPicker(promptTarget)
              }
              onOpenOllamaSettings={handleOpenOllamaSettings}
              onConnectLinear={handleConnectLinear}
              selectedRoles={selectedRoles ?? EMPTY_ROLES}
              onToggleRole={handleToggleRole}
              onAddPlugin={handleAddPlugin}
              selectedToolKey={selectedToolKey}
              onOpenTool={handleOpenTool}
              onCloseToolPrompts={(): void => setSelectedToolKey(null)}
              entering={enteringEntryIds.has(view.entryId)}
              mcpLogoByKey={mcpLogoByKey}
              githubState={githubState}
              claudeState={claudeState}
              codexState={codexState}
              cursorState={
                cursorReleased
                  ? cursorAvailable
                    ? 'connected'
                    : 'not-connected'
                  : undefined
              }
              onOpenCursorSettings={(): void =>
                useNavigationStore
                  .getState()
                  .openSettings(getCursorSettingsSection())
              }
              linearState={linearState}
              onEnableFocusShortcut={handleEnableFocusShortcut}
              onChangeFocusShortcut={handleChangeFocusShortcut}
              focusShortcutBusy={focusShortcut.busy}
              onEnableLaunchAtLogin={handleEnableLaunchAtLogin}
              onOpenLaunchAtLoginSettings={handleOpenLaunchAtLoginSettings}
              launchAtLoginBusy={launchAtLogin.busy}
              onDailyCreditsTurnOn={dailyCreditDrip.turnOn}
              onDailyCreditsNotNow={dailyCreditDrip.notNow}
              dailyCreditsBusy={dailyCreditDrip.busy}
              dailyCreditsError={dailyCreditDrip.error}
            />
          );
        })}
      </ul>
      {/* Install failures can quote CLI output. */}
      {toolInstallError && (
        <ErrorBanner error={toolInstallError} blockMessageFromReplay />
      )}

      {readinessLaunchError && (
        <p className="mt-2 text-xs fg-destructive" role="alert">
          {readinessLaunchError}
        </p>
      )}

      {views.length === 0 && (
        <p
          data-testid="home-onboarding-checking-recommendations"
          className="px-4 text-s fg-secondary"
        >
          Checking recommendations…
        </p>
      )}
    </section>
  );

  const activateNext = (): void => {
    const next = sidebarView;
    if (!next) return;
    const { entryId, step } = next;
    if (next.status === 'deferred') {
      handleAddRepo();
      return;
    }
    switch (step.kind) {
      case 'enable-daily-credits':
        void dailyCreditDrip.turnOn();
        break;
      case 'import-projects-cta':
        handleImportProjects();
        break;
      case 'import-editor-setup-cta':
        handleImportEditorSetup();
        break;
      case 'get-mobile-app':
        handleGetMobileApp();
        break;
      case 'add-repo-cta':
        handleAddRepo();
        break;
      case 'connect-github':
        useNavigationStore.getState().openSettings('account');
        break;
      case 'connect-tools':
        useNavigationStore
          .getState()
          .openPluginsNavigation({ kind: 'discovery' });
        break;
      case 'plugin-examples-preview':
        useOnboardingSuggestionSurfaces.setState({ focusEntry: entryId });
        useNavigationStore.getState().navigate('home');
        break;
      case 'connect-linear':
        handleConnectLinear();
        break;
      case 'connect-agents':
        useOnboardingSuggestionSurfaces.setState({ focusEntry: entryId });
        useNavigationStore.getState().navigate('home');
        break;
      case 'create-plan':
        handleCreatePlan();
        break;
      case 'advanced-readiness':
        handleFixReadiness(entryId, step.workspaceId, step.issue);
        break;
      case 'enable-focus-shortcut':
        handleEnableFocusShortcut();
        break;
      case 'focus-shortcut-blocked':
        handleChangeFocusShortcut();
        break;
      case 'enable-launch-at-login':
        handleEnableLaunchAtLogin();
        break;
      case 'launch-at-login-needs-approval':
        handleOpenLaunchAtLoginSettings();
        break;
      case 'plugin-add':
        handleAddPlugin(entryId, step.enableKeys);
        break;
      case 'advanced-prompt':
        if (step.requiresCodeWorkspace && !ensureCodeWorkspaceTarget()) return;
        armWithPrompt(entryId, step.kind, step.promptText);
        break;
      case 'prompt':
      case 'github-try':
      case 'linear-try-prompt':
      case 'plugin-try': {
        // A template prompt belongs in the project's chat that is showing
        // it; everything else runs from Home, as before.
        const chatTarget =
          next.blueprint !== undefined &&
          useOnboardingSuggestionSurfaces.getState().chatPromptTargetId !==
            null;
        armWithPrompt(
          entryId,
          step.kind,
          step.promptText,
          chatTarget ? 'chat' : 'home',
        );
        break;
      }
    }
  };

  return (
    <>
      {homeHost === undefined
        ? homeHasRows
          ? renderCard('home')
          : null
        : homeHost && homeHasRows
          ? createPortal(renderCard('home'), homeHost)
          : null}
      {chatHost && homeHasRows && createPortal(renderCard('chat'), chatHost)}
      {sidebarHost &&
        sidebarHasRows &&
        createPortal(
          <OnboardingSuggestionSidebar
            view={sidebarView}
            nontechnical={nontechnical}
            onActivate={activateNext}
            onSkip={(): void => {
              if (sidebarView) skipOrAdvance(sidebarView);
            }}
            // Its × skips the whole template step, like Home's arrow.
            skipLabel={
              sidebarView === leadView ? templateStepSkipLabel : undefined
            }
            upcoming={Math.max(0, progress.total - currentStep)}
            focusShortcutBusy={focusShortcut.busy}
            dailyCreditsBusy={dailyCreditDrip.busy}
            launchAtLoginBusy={launchAtLogin.busy}
          />,
          sidebarHost,
        )}
      {loginModalProvider !== null && (
        <AuthLoginModal
          provider={loginModalProvider}
          onClose={handleCloseLogin}
          onAuthorizationUrl={handleAuthorizationUrl}
        />
      )}
      {toolSetup && (
        <OnboardingToolSetup
          key={toolSetup.entry.key}
          entry={toolSetup.entry}
          onClose={(): void => setToolSetup(null)}
          onConfigured={finishToolSetup}
        />
      )}
      {mobileDialogOpen && mobilePromo.showPromotional && (
        <OnboardingMobileAppDialog
          links={mobilePromo.links}
          onClose={(): void => setMobileDialogOpen(false)}
        />
      )}
    </>
  );
}

interface OnboardingSuggestionRowProps {
  installingToolKey: string | null;
  heading?: string;
  headingMeta?: string;
  /** A later row of a window whose first row carries the step arrows. */
  hideNavigation?: boolean;
  /** Names what the skip arrow leaves when it is more than this row. */
  skipLabel?: string;
  view: OnboardingChecklistView;
  nontechnical: boolean;
  onAdvancedPrompt: (
    entryId: string,
    promptText: string,
    requiresCodeWorkspace: boolean,
  ) => void;
  onFixReadiness: (
    entryId: string,
    workspaceId: string,
    issue: WorkspaceReadinessIssue,
  ) => void;
  readinessLaunchKey: string | null;
  onDismiss: () => void;
  onPrevious: () => void;
  previousDisabled: boolean;
  onGetMobileApp: () => void;
  onArmWithPrompt: (
    entryId: string,
    stepKind: string,
    promptText: string,
  ) => void;
  onInjectConnectedToolPrompt: (entryId: string, promptText: string) => void;
  onAddRepo: () => void;
  onImportProjects: () => void;
  onImportEditorSetup: () => void;
  onCreatePlan: () => void;
  onConnect: (provider: AuthProviderId) => void;
  onHighlightModelPicker: () => void;
  onOpenOllamaSettings: () => void;
  onConnectLinear: () => void;
  /** Categories shown picked in the tools step's category row. */
  selectedRoles: readonly ProfileRoleId[];
  onToggleRole: (role: ProfileRoleId) => void;
  onAddPlugin: (entryId: string, enableKeys: readonly string[]) => void;
  selectedToolKey: string | null;
  onOpenTool: (tool: OnboardingToolRecommendation) => void;
  onCloseToolPrompts: () => void;
  onEnableFocusShortcut: () => void;
  onChangeFocusShortcut: () => void;
  /** True while the OS focus shortcut update is in flight. */
  focusShortcutBusy: boolean;
  /** Saves the daily free AI Credits opt-in as on. */
  onDailyCreditsTurnOn: () => Promise<void>;
  /** Saves the daily free AI Credits opt-in as off (still answered). */
  onDailyCreditsNotNow: () => Promise<void>;
  /** True while the daily free AI Credits save is in flight. */
  dailyCreditsBusy: boolean;
  /** Inline error after a failed daily free AI Credits save. */
  dailyCreditsError: string | null;
  onEnableLaunchAtLogin: () => void;
  onOpenLaunchAtLoginSettings: () => void;
  /** True while a launch at sign-in change is in flight. */
  launchAtLoginBusy: boolean;
  /** True when this activity was just discovered. */
  entering: boolean;
  /** Curated MCP catalog key → logo URL, for plugin-suggestion rows. */
  mcpLogoByKey: ReadonlyMap<string, string | undefined>;
  githubState: ProviderConnectionState;
  claudeState: ProviderConnectionState;
  codexState: ProviderConnectionState;
  cursorState?: ProviderConnectionState;
  onOpenCursorSettings: () => void;
  linearState: ProviderConnectionState;
}

/**
 * Human-readable row name for assistive tech — persisted entry ids like
 * `plugin:universal:google` must never reach a screen reader.
 */
function suggestionDisplayLabel(view: OnboardingSuggestionView): string {
  const { step } = view;
  if (step.kind === 'advanced-prompt' || step.kind === 'advanced-readiness')
    return step.label;
  if (step.kind === 'plugin-add' || step.kind === 'plugin-try') {
    return step.displayName;
  }
  if (view.blueprint && step.kind === 'prompt') {
    return step.label ?? step.promptText;
  }
  switch (view.entryId) {
    case 'daily-credits':
      return 'daily free AI Credits';
    case 'import-projects':
      return 'import projects';
    case 'import-editor-setup':
      return 'Cursor rules';
    case 'mobile-app':
      return 'Get the mobile app';
    case 'add-repo':
      return 'add project';
    case 'github':
      return 'GitHub';
    case 'plugin-examples-preview':
      return 'connected tool examples';
    case 'agent-connections':
      return 'Claude, Codex, or Ollama';
    case 'plan-mode':
      return 'plan mode';
    case 'linear':
      return 'Linear';
    case 'focus-shortcut':
      return 'focus shortcut';
    case 'launch-at-login':
      return 'open at sign-in';
    default:
      return 'getting started';
  }
}

/** Last presence answer, so a remounted Home draws the settled list at once. */
let lastKnownProviderStoresPresent = false;
/**
 * Last Cursor rules answer per code workspace set (CAN-2053), so a remounted
 * Home does not re-probe or redraw. Keyed by the sorted workspace ids.
 */
let lastKnownCursorRulesPresence: {
  key: string;
  present: boolean;
} | null = null;

/** Clears the remembered Cursor rules answer between tests. */
export function resetCursorRulesPresenceCacheForTests(): void {
  lastKnownCursorRulesPresence = null;
}

const EDITOR_SETUP_TITLE = 'Use your Cursor rules';
const EDITOR_SETUP_DESCRIPTION =
  "Bring a project's Cursor rules into new chats. You review each rule first.";

/**
 * How long a template context's rows wait for the plugin source before they
 * draw regardless (CAN-3032): long enough for a normal catalog and
 * connector read, short enough that a hung probe never hides the checklist.
 */
const TEMPLATE_PLUGIN_SOURCE_HOLD_MS = 3_000;

function checklistDisplayLabel(view: OnboardingSuggestionView): string {
  switch (view.entryId) {
    case 'daily-credits':
      return view.step.kind === 'enable-daily-credits'
        ? `Claim ${view.step.capCredits} free AI Credits every day`
        : 'Claim free AI Credits every day';
    case 'import-projects':
      return 'Import your Claude and Codex projects';
    case 'import-editor-setup':
      return EDITOR_SETUP_TITLE;
    case 'mobile-app':
      return 'Get the mobile app';
    case 'focus-shortcut':
      return 'Turn on the focus shortcut';
    case 'launch-at-login':
      return `Open ${brandText.appName} when you sign in`;
    case 'add-repo':
      return 'Try a task in your project';
    case 'github':
      return 'Connect your tools';
    case 'plugin-examples-preview':
      return 'Try your connected tools';
    case 'agent-connections':
      return 'Connect AI providers';
    case 'plan-mode':
      return view.step.kind === 'prompt'
        ? 'Plan your first project'
        : 'Try out plan mode';
    case 'linear':
      return 'Plan an assigned Linear issue';
    default:
      return view.step.kind === 'plugin-add' || view.step.kind === 'plugin-try'
        ? `Try ${view.step.displayName}`
        : 'Getting started';
  }
}

function OnboardingSuggestionRow({
  installingToolKey,
  heading,
  headingMeta,
  hideNavigation = false,
  skipLabel,
  view,
  nontechnical,
  onAdvancedPrompt,
  onFixReadiness,
  readinessLaunchKey,
  onDismiss,
  onPrevious,
  previousDisabled,
  onGetMobileApp,
  onArmWithPrompt,
  onInjectConnectedToolPrompt,
  onAddRepo,
  onImportProjects,
  onImportEditorSetup,
  onCreatePlan,
  onConnect,
  onHighlightModelPicker,
  onOpenOllamaSettings,
  onConnectLinear,
  selectedRoles,
  onToggleRole,
  onAddPlugin,
  selectedToolKey,
  onOpenTool,
  onCloseToolPrompts,
  entering,
  mcpLogoByKey,
  githubState,
  claudeState,
  codexState,
  cursorState,
  onOpenCursorSettings,
  linearState,
  onEnableFocusShortcut,
  onChangeFocusShortcut,
  focusShortcutBusy,
  onDailyCreditsTurnOn,
  onDailyCreditsNotNow,
  dailyCreditsBusy,
  dailyCreditsError,
  onEnableLaunchAtLogin,
  onOpenLaunchAtLoginSettings,
  launchAtLoginBusy,
}: OnboardingSuggestionRowProps): JSX.Element {
  const { entryId, step } = view;
  const dismissLabel = skipLabel ?? `Skip ${suggestionDisplayLabel(view)}`;
  const handleDismiss = (): void => onDismiss();
  const shellProps = {
    heading,
    headingMeta,
    entryId,
    stepKind: step.kind,
    status: view.status,
    entering,
    dismissLabel,
    onDismiss: handleDismiss,
    onPrevious,
    previousDisabled,
    hideDismiss: step.kind === 'advanced-prompt' || hideNavigation,
  };

  if (view.status === 'deferred') {
    return (
      <OnboardingSuggestionRowShell {...shellProps}>
        <SuggestionRow
          icon={<AssignmentAddIcon size={16} aria-hidden="true" />}
          aria-label={checklistDisplayLabel(view)}
          data-testid={`home-onboarding-suggestion-cta-deferred-${entryId}`}
          trailingControl
          onClick={onAddRepo}
        >
          {checklistDisplayLabel(view)}
        </SuggestionRow>
      </OnboardingSuggestionRowShell>
    );
  }

  switch (step.kind) {
    case 'enable-daily-credits':
      return (
        <OnboardingSuggestionRowShell {...shellProps}>
          <div className="flex min-w-0 flex-1 items-center gap-2 py-2 pl-2 pr-4">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center">
              <SparkleIcon size={16} className="fg-primary" aria-hidden />
            </span>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-s font-medium fg-primary">
                Free AI Credits, every single day
              </span>
              <span className="text-xs fg-secondary">
                Claim {step.capCredits} free AI Credits daily. Use them with any
                model, on top of your own plan.
              </span>
            </div>
            <div className="relative z-10 flex shrink-0 items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                data-testid="home-onboarding-daily-credits-not-now"
                disabled={dailyCreditsBusy}
                onClick={(): void => void onDailyCreditsNotNow()}
              >
                Not now
              </Button>
              <Button
                variant="primary"
                size="sm"
                data-testid="home-onboarding-daily-credits-turn-on"
                disabled={dailyCreditsBusy}
                onClick={(): void => void onDailyCreditsTurnOn()}
              >
                Claim
              </Button>
            </div>
          </div>
          {dailyCreditsError && (
            <div data-testid="home-onboarding-daily-credits-error">
              <ErrorBanner error={dailyCreditsError} />
            </div>
          )}
        </OnboardingSuggestionRowShell>
      );
    case 'get-mobile-app':
      return (
        <OnboardingSuggestionRowShell {...shellProps}>
          <SuggestionRow
            icon={<Smartphone size={16} aria-hidden="true" />}
            data-testid="home-onboarding-get-mobile-app"
            onClick={onGetMobileApp}
          >
            Keep your agents going with the mobile app
          </SuggestionRow>
        </OnboardingSuggestionRowShell>
      );
    case 'import-projects-cta':
      return (
        <OnboardingSuggestionRowShell {...shellProps}>
          <SuggestionRow
            icon={<DownloadIcon size={16} aria-hidden="true" />}
            aria-label="Import chats and projects from Claude and Codex"
            data-testid="home-onboarding-suggestion-cta-import-projects"
            trailingControl
            onClick={onImportProjects}
          >
            Import chats and projects from Claude and Codex
          </SuggestionRow>
        </OnboardingSuggestionRowShell>
      );
    case 'import-editor-setup-cta':
      return (
        <OnboardingSuggestionRowShell {...shellProps}>
          <SuggestionRow
            icon={<CursorLogo width={16} height={16} aria-hidden="true" />}
            aria-label={EDITOR_SETUP_DESCRIPTION}
            data-testid="home-onboarding-suggestion-cta-import-editor-setup"
            trailingControl
            onClick={onImportEditorSetup}
          >
            {EDITOR_SETUP_DESCRIPTION}
          </SuggestionRow>
        </OnboardingSuggestionRowShell>
      );
    case 'advanced-prompt':
      return (
        <OnboardingSuggestionRowShell {...shellProps}>
          <SuggestionRow
            icon={
              <ToolRecommendationLogo
                tool={step.tool}
                mcpLogoByKey={mcpLogoByKey}
                transparent
              />
            }
            aria-label={step.label}
            data-testid={`home-onboarding-advanced-prompt-${entryId.slice('advanced:'.length)}`}
            trailingControl
            onClick={(): void =>
              onAdvancedPrompt(
                entryId,
                step.promptText,
                step.requiresCodeWorkspace,
              )
            }
          >
            {step.label}
          </SuggestionRow>
          <button
            type="button"
            aria-label={`Skip ${step.label}`}
            title="Show another example"
            data-testid={`home-onboarding-advanced-prompt-dismiss-${entryId.slice('advanced:'.length)}`}
            onClick={onDismiss}
            className="focus-ring absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md fg-tertiary transition-colors hover:bg-base hover:fg-primary"
          >
            <CloseIcon width={14} height={14} aria-hidden="true" />
          </button>
        </OnboardingSuggestionRowShell>
      );
    case 'advanced-readiness': {
      const isLaunching =
        readinessLaunchKey ===
        `${step.workspaceId}:${workspaceReadinessIssueKey(step.issue)}`;
      return (
        <OnboardingSuggestionRowShell {...shellProps}>
          <SuggestionRow
            icon={
              <AssignmentAddIcon
                size={16}
                className="fg-accent"
                aria-hidden="true"
              />
            }
            aria-label={isLaunching ? 'Starting fix' : step.label}
            data-testid={`home-onboarding-readiness-${step.issue.code}`}
            trailingControl
            onClick={(): void =>
              onFixReadiness(entryId, step.workspaceId, step.issue)
            }
            disabled={readinessLaunchKey !== null}
          >
            <span>{step.label}</span>{' '}
            <span className="text-xs fg-secondary">
              · {step.issue.repoName}
            </span>
          </SuggestionRow>
        </OnboardingSuggestionRowShell>
      );
    }
    case 'connect-tools': {
      const selectedTool = step.tools.find(
        (tool) => tool.key === selectedToolKey,
      );
      if (selectedTool) {
        return (
          <OnboardingSuggestionRowShell
            {...shellProps}
            rowClassName="relative rounded-xl"
            hideDismiss
            leadingAction={
              <span className="flex w-9 shrink-0 items-center justify-center">
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label="Back to suggested tools"
                  data-testid="home-onboarding-tool-prompts-back"
                  onClick={onCloseToolPrompts}
                >
                  <BackIcon width={16} height={16} aria-hidden="true" />
                </Button>
              </span>
            }
          >
            <div
              data-testid="home-onboarding-tool-prompts"
              className="flex w-full flex-col gap-1 px-2"
            >
              {selectedTool.promptTexts.slice(0, 3).map((promptText) => (
                <button
                  key={promptText}
                  type="button"
                  className="focus-ring flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-s fg-secondary transition-colors hover:bg-subtle hover:fg-primary"
                  onClick={(): void => {
                    onInjectConnectedToolPrompt(entryId, promptText);
                    onCloseToolPrompts();
                  }}
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center">
                    <ToolRecommendationLogo
                      tool={selectedTool}
                      mcpLogoByKey={mcpLogoByKey}
                      transparent
                    />
                  </span>
                  <span className="min-w-0 flex-1">{promptText}</span>
                </button>
              ))}
            </div>
          </OnboardingSuggestionRowShell>
        );
      }
      return (
        <OnboardingSuggestionRowShell
          {...shellProps}
          rowClassName="relative flex flex-col gap-3 rounded-xl"
          nextAction={
            step.tools.filter((tool) => tool.connected).length >= 2
              ? { testId: 'home-onboarding-tools-next', onClick: onDismiss }
              : undefined
          }
        >
          <div className="min-w-0 px-2">
            <OnboardingCategoryPicker
              selected={selectedRoles}
              onToggle={onToggleRole}
              testIdPrefix="home-onboarding-category"
            />
          </div>
          <div
            data-testid="home-onboarding-tool-recommendations"
            className="flex min-w-0 flex-1 flex-wrap gap-2 px-2 py-1"
          >
            {step.tools.map((tool) => (
              <OnboardingChoiceTile
                key={tool.key}
                selected={tool.connected}
                variant="tool"
                aria-pressed={undefined}
                aria-label={`${tool.connected ? 'Try' : 'Connect'} ${tool.displayName}`}
                data-testid={`home-onboarding-tool-${tool.key}`}
                onClick={(): void => onOpenTool(tool)}
                disabled={installingToolKey !== null}
                aria-busy={installingToolKey === tool.key}
                icon={
                  <ToolRecommendationLogo
                    tool={tool}
                    mcpLogoByKey={mcpLogoByKey}
                  />
                }
                trailing={
                  tool.connected ? (
                    <CheckIcon
                      size={11}
                      className="shrink-0 fg-accent"
                      aria-label="Connected"
                    />
                  ) : null
                }
              >
                {installingToolKey === tool.key
                  ? 'Installing…'
                  : tool.displayName}
              </OnboardingChoiceTile>
            ))}
            <button
              type="button"
              data-testid="home-onboarding-tools-see-all"
              className={`${ONBOARDING_SECONDARY_TEXT_BUTTON_CLASS} self-center`}
              onClick={(): void =>
                useNavigationStore
                  .getState()
                  .openPluginsNavigation({ kind: 'discovery' })
              }
            >
              See all
            </button>
          </div>
        </OnboardingSuggestionRowShell>
      );
    }
    case 'plugin-examples-preview':
      return (
        <OnboardingSuggestionRowShell
          {...shellProps}
          rowClassName="relative flex w-full flex-col gap-1 rounded-xl"
          nextAction={{
            testId: 'home-onboarding-tool-examples-next',
            onClick: onDismiss,
          }}
        >
          {step.tools.map((tool) => {
            const promptText = tool.promptTexts[0];
            if (!promptText) return null;
            return (
              <SuggestionRow
                key={tool.key}
                icon={
                  <ToolRecommendationLogo
                    tool={tool}
                    mcpLogoByKey={mcpLogoByKey}
                    transparent
                  />
                }
                aria-label={promptText}
                data-testid={`home-onboarding-tool-example-${tool.key}`}
                onClick={(): void => {
                  onInjectConnectedToolPrompt(entryId, promptText);
                  onDismiss();
                }}
              >
                {promptText}
              </SuggestionRow>
            );
          })}
        </OnboardingSuggestionRowShell>
      );
    case 'plugin-add':
      return (
        <OnboardingSuggestionRowShell {...shellProps}>
          <OnboardingComplexActionRow
            icon={
              <PluginSuggestionLogo
                pluginName={step.pluginName}
                displayName={step.displayName}
                mcpLogoByKey={mcpLogoByKey}
              />
            }
            ariaLabel={`Add ${step.displayName}`}
            testId={`home-onboarding-suggestion-cta-plugin-add-${step.pluginKey}`}
            onClick={(): void => onAddPlugin(entryId, step.enableKeys)}
          >
            <span className="min-w-0 shrink-0 text-s font-medium fg-primary">
              {step.displayName}
            </span>
            <span className="min-w-0 flex-1 truncate text-xs fg-secondary">
              {step.description}
            </span>
          </OnboardingComplexActionRow>
        </OnboardingSuggestionRowShell>
      );
    case 'plugin-try':
      return (
        <OnboardingSuggestionRowShell {...shellProps}>
          <OnboardingComplexActionRow
            icon={
              <PluginSuggestionLogo
                pluginName={step.pluginName}
                displayName={step.displayName}
                mcpLogoByKey={mcpLogoByKey}
                transparent
              />
            }
            ariaLabel={`Try ${step.displayName}`}
            testId={`home-onboarding-suggestion-cta-plugin-try-${step.pluginKey}`}
            onClick={(): void =>
              onArmWithPrompt(entryId, step.kind, step.promptText)
            }
          >
            <span className="min-w-0 shrink-0 text-s font-medium fg-primary">
              {step.displayName}
            </span>
            <span className="min-w-0 flex-1 truncate text-xs fg-secondary">
              {step.promptText}
            </span>
          </OnboardingComplexActionRow>
        </OnboardingSuggestionRowShell>
      );
    case 'add-repo-cta':
      return (
        <OnboardingSuggestionRowShell {...shellProps}>
          <SuggestionRow
            icon={<FolderPlusIcon size={16} aria-hidden="true" />}
            aria-label={
              nontechnical
                ? 'Choose a local project folder to work in'
                : 'Choose a local or remote repo to work in'
            }
            data-testid="home-onboarding-suggestion-cta-add-repo"
            trailingControl
            onClick={onAddRepo}
          >
            {nontechnical
              ? 'Choose a local project folder to work in'
              : 'Choose a local or remote repo to work in'}
          </SuggestionRow>
        </OnboardingSuggestionRowShell>
      );
    case 'prompt':
      return (
        <OnboardingSuggestionRowShell {...shellProps}>
          <SuggestionRow
            icon={<ThinkingIcon size={16} aria-hidden="true" />}
            aria-label={step.label ?? step.promptText}
            data-testid="home-onboarding-suggestion-cta-prompt"
            trailingControl
            onClick={(): void =>
              onArmWithPrompt(entryId, step.kind, step.promptText)
            }
          >
            {step.label ?? step.promptText}
          </SuggestionRow>
        </OnboardingSuggestionRowShell>
      );
    case 'enable-focus-shortcut':
      return (
        <OnboardingSuggestionRowShell {...shellProps}>
          <OnboardingComplexActionRow
            icon={<CommandIcon width={16} height={16} aria-hidden="true" />}
            ariaLabel="Turn on focus shortcut"
            testId="home-onboarding-suggestion-cta-enable-focus-shortcut"
            onClick={onEnableFocusShortcut}
            disabled={focusShortcutBusy}
          >
            <span className="min-w-0 flex-1 text-s fg-secondary">
              {focusShortcutBusy
                ? 'Turning on…'
                : `Bring ${brandText.appName} to the front while using any other app`}
            </span>
          </OnboardingComplexActionRow>
        </OnboardingSuggestionRowShell>
      );
    case 'focus-shortcut-blocked':
      return (
        <OnboardingSuggestionRowShell {...shellProps}>
          <OnboardingComplexActionRow
            icon={<CommandIcon width={16} height={16} aria-hidden="true" />}
            ariaLabel="Change focus shortcut"
            testId="home-onboarding-suggestion-cta-focus-shortcut-blocked"
            onClick={onChangeFocusShortcut}
          >
            <span className="min-w-0 flex-1 truncate text-xs fg-secondary">
              Another app is using {step.shortcut}. Choose a different one
            </span>
          </OnboardingComplexActionRow>
        </OnboardingSuggestionRowShell>
      );
    case 'enable-launch-at-login':
      return (
        <OnboardingSuggestionRowShell {...shellProps}>
          <OnboardingComplexActionRow
            icon={<LoginIcon size={16} aria-hidden="true" />}
            ariaLabel={`Open ${brandText.appName} when you sign in`}
            testId="home-onboarding-suggestion-cta-enable-launch-at-login"
            onClick={onEnableLaunchAtLogin}
            disabled={launchAtLoginBusy}
          >
            <span className="min-w-0 flex-1 text-s fg-secondary">
              {launchAtLoginBusy
                ? 'Turning on…'
                : 'Pick up where you left off after a restart.'}
            </span>
          </OnboardingComplexActionRow>
        </OnboardingSuggestionRowShell>
      );
    case 'launch-at-login-needs-approval':
      return (
        <OnboardingSuggestionRowShell {...shellProps}>
          <OnboardingComplexActionRow
            icon={<LoginIcon size={16} aria-hidden="true" />}
            ariaLabel="Open System Settings"
            testId="home-onboarding-suggestion-cta-launch-at-login-needs-approval"
            onClick={onOpenLaunchAtLoginSettings}
          >
            <span className="min-w-0 flex-1 text-s fg-secondary">
              Allow {brandText.appName} in System Settings to finish turning
              this on.
            </span>
          </OnboardingComplexActionRow>
        </OnboardingSuggestionRowShell>
      );
    case 'connect-github':
      return (
        <OnboardingSuggestionRowShell {...shellProps}>
          <OnboardingComplexActionRow
            icon={<GitHubIcon className="h-4 w-4" aria-hidden="true" />}
            ariaLabel="Connect GitHub"
            testId="home-onboarding-suggestion-connect-github"
            onClick={(): void => onConnect('github')}
          >
            <span className="text-s font-medium fg-primary">GitHub</span>
            <StateChip state={githubState} provider="github" />
          </OnboardingComplexActionRow>
        </OnboardingSuggestionRowShell>
      );
    case 'github-try':
      return (
        <OnboardingSuggestionRowShell {...shellProps}>
          <OnboardingComplexActionRow
            icon={<GitHubIcon className="h-4 w-4" aria-hidden="true" />}
            ariaLabel="Try GitHub task"
            testId="home-onboarding-suggestion-cta-github-try"
            onClick={(): void =>
              onArmWithPrompt(entryId, step.kind, step.promptText)
            }
          >
            <span className="text-s font-medium fg-primary">GitHub</span>
            <StateChip state="connected" provider="github" />
            <span className="min-w-0 flex-1 truncate text-xs fg-secondary">
              Find a small TODO and implement it
            </span>
          </OnboardingComplexActionRow>
        </OnboardingSuggestionRowShell>
      );
    case 'connect-agents':
      return (
        <OnboardingSuggestionRowShell
          {...shellProps}
          rowClassName="relative rounded-xl"
          headingClassName="px-2"
          nextAction={
            claudeState === 'connected' ||
            codexState === 'connected' ||
            cursorState === 'connected'
              ? {
                  testId: 'home-onboarding-agent-connections-next',
                  onClick: onDismiss,
                }
              : undefined
          }
        >
          <div className="-mt-2 flex min-w-0 flex-1 flex-col gap-4 px-2 pt-0">
            <p
              data-testid="home-onboarding-agent-connections-subtitle"
              className="text-s leading-5 fg-secondary"
            >
              {agentConnectionsIntro()}
            </p>
            <div
              data-testid="home-onboarding-agent-connections"
              className="flex min-w-0 flex-wrap gap-2"
            >
              <button
                type="button"
                aria-label="Highlight the model picker"
                data-testid="home-onboarding-suggestion-connect-unstoppable"
                onClick={onHighlightModelPicker}
                className="focus-ring flex min-h-10 items-center gap-2 rounded-lg bg-accent-subtle px-3 py-2 text-xs font-medium fg-primary ring-1 ring-inset ring-line-accent transition-colors hover:bg-accent-subtle/80"
              >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                  <BrandLogo size={16} aria-hidden={true} />
                </span>
                <span>Unstoppable</span>
                <CheckIcon
                  width={12}
                  height={12}
                  className="fg-accent"
                  aria-hidden="true"
                />
              </button>
              {(
                [
                  {
                    id: 'claude',
                    label: 'Claude',
                    state: claudeState,
                    icon: (
                      <ClaudeIcon width={16} height={16} aria-hidden="true" />
                    ),
                  },
                  {
                    id: 'codex',
                    label: 'Codex',
                    state: codexState,
                    icon: (
                      <CodexIcon width={16} height={16} aria-hidden="true" />
                    ),
                  },
                  ...(cursorState
                    ? [
                        {
                          id: 'cursor' as const,
                          label: 'Cursor',
                          state: cursorState,
                          icon: (
                            <CursorLogo
                              width={16}
                              height={16}
                              aria-hidden="true"
                            />
                          ),
                        },
                      ]
                    : []),
                ] as const
              ).map((provider) => {
                const connected = provider.state === 'connected';
                const checking = provider.state === 'checking';
                return (
                  <button
                    key={provider.id}
                    type="button"
                    aria-label={
                      connected
                        ? `${provider.label} connected`
                        : `Connect ${provider.label}`
                    }
                    data-testid={`home-onboarding-suggestion-connect-${provider.id}`}
                    onClick={
                      connected
                        ? onHighlightModelPicker
                        : (): void => {
                            onHighlightModelPicker();
                            if (provider.id === 'cursor')
                              onOpenCursorSettings();
                            else onConnect(provider.id);
                          }
                    }
                    disabled={checking}
                    className={`focus-ring flex min-h-10 items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium ring-1 ring-inset transition-colors disabled:cursor-default ${
                      connected
                        ? 'ring-line-accent bg-accent-subtle fg-primary'
                        : 'ring-line-base bg-secondary fg-secondary hover:bg-subtle hover:fg-primary disabled:opacity-60'
                    }`}
                  >
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                      {provider.icon}
                    </span>
                    <span>{provider.label}</span>
                    {connected ? (
                      <CheckIcon
                        width={12}
                        height={12}
                        className="fg-accent"
                        aria-hidden="true"
                      />
                    ) : (
                      checking && <LoadingSpinner sizePx={12} />
                    )}
                  </button>
                );
              })}
              <button
                type="button"
                aria-label="Open Ollama settings"
                data-testid="home-onboarding-suggestion-connect-ollama"
                onClick={onOpenOllamaSettings}
                className="focus-ring flex min-h-10 items-center gap-2 rounded-lg bg-secondary px-3 py-2 text-xs font-medium fg-secondary ring-1 ring-inset ring-line-base transition-colors hover:bg-subtle hover:fg-primary"
              >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                  <OllamaIcon width={16} height={16} aria-hidden="true" />
                </span>
                <span>Ollama</span>
              </button>
            </div>
          </div>
        </OnboardingSuggestionRowShell>
      );
    case 'create-plan':
      return (
        <OnboardingSuggestionRowShell {...shellProps}>
          <SuggestionRow
            icon={<AssignmentAddIcon size={16} aria-hidden="true" />}
            aria-label="Try plan mode"
            data-testid="home-onboarding-suggestion-cta-create-plan"
            trailingControl
            onClick={onCreatePlan}
          >
            Try plan mode
          </SuggestionRow>
        </OnboardingSuggestionRowShell>
      );
    case 'connect-linear':
      return (
        <OnboardingSuggestionRowShell {...shellProps}>
          <OnboardingComplexActionRow
            icon={<LinearLogo className="h-4 w-4" aria-hidden="true" />}
            ariaLabel="Connect Linear"
            testId="home-onboarding-suggestion-connect-linear"
            onClick={onConnectLinear}
          >
            <span className="text-s font-medium fg-primary">Linear</span>
            <StateChip state={linearState} provider="linear" />
          </OnboardingComplexActionRow>
        </OnboardingSuggestionRowShell>
      );
    case 'linear-try-prompt':
      return (
        <OnboardingSuggestionRowShell {...shellProps}>
          <OnboardingComplexActionRow
            icon={<LinearLogo className="h-4 w-4" aria-hidden="true" />}
            ariaLabel="Try Linear planning prompt"
            testId="home-onboarding-suggestion-cta-linear-prompt"
            onClick={(): void =>
              onArmWithPrompt(entryId, step.kind, step.promptText)
            }
          >
            <span className="text-s font-medium fg-primary">Linear</span>
            <StateChip state="connected" provider="linear" />
            <span className="min-w-0 flex-1 truncate text-xs fg-secondary">
              Plan an assigned ticket with the agent
            </span>
          </OnboardingComplexActionRow>
        </OnboardingSuggestionRowShell>
      );
    default:
      return (
        <OnboardingSuggestionRowShell {...shellProps}>
          <SuggestionRow
            icon={<ThinkingIcon size={16} aria-hidden="true" />}
            aria-label={checklistDisplayLabel(view)}
            data-testid={`home-onboarding-suggestion-cta-${entryId}`}
            trailingControl
            onClick={(): void => undefined}
          >
            {checklistDisplayLabel(view)}
          </SuggestionRow>
        </OnboardingSuggestionRowShell>
      );
  }
}

interface StateChipProps {
  state: ProviderConnectionState;
  provider: string;
}

function StateChip({ state, provider }: StateChipProps): JSX.Element {
  return (
    <span
      data-testid={`home-onboarding-suggestion-status-${provider}`}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${STATE_CHIP_CLASSES[state]}`}
    >
      {state === 'checking' && <LoadingSpinner sizePx={12} />}
      {PROVIDER_CONNECTION_STATE_LABELS[state]}
    </span>
  );
}

interface PluginSuggestionLogoProps {
  pluginName: string;
  displayName: string;
  mcpLogoByKey: ReadonlyMap<string, string | undefined>;
  transparent?: boolean;
}

function ToolRecommendationLogo({
  tool,
  mcpLogoByKey,
  transparent = false,
}: {
  tool: OnboardingToolRecommendation;
  mcpLogoByKey: ReadonlyMap<string, string | undefined>;
  transparent?: boolean;
}): JSX.Element {
  if (tool.kind === 'github') {
    return <GitHubIcon className="h-5 w-5 shrink-0" aria-hidden="true" />;
  }
  if (tool.kind === 'linear') {
    return <LinearLogo className="h-5 w-5 shrink-0" aria-hidden="true" />;
  }
  return (
    <PluginSuggestionLogo
      pluginName={tool.pluginName}
      displayName={tool.displayName}
      mcpLogoByKey={mcpLogoByKey}
      transparent={transparent}
    />
  );
}

/**
 * Real brand mark for a plugin-suggestion row: the plugin's stable name
 * joins the curated MCP catalog (bundled marks resolve inside
 * {@link McpServerLogo}); anything without a match monograms from its
 * display name.
 */
function PluginSuggestionLogo({
  pluginName,
  displayName,
  mcpLogoByKey,
  transparent = false,
}: PluginSuggestionLogoProps): JSX.Element {
  const curatedKey = pluginName.toLowerCase();
  return (
    <McpServerLogo
      curatedKey={curatedKey}
      logoUrl={mcpLogoByKey.get(curatedKey)}
      size={20}
      chrome={transparent ? 'transparent' : 'default'}
      fallback="monogram"
      name={displayName}
      className="shrink-0"
      imgTestId="home-onboarding-suggestion-plugin-logo"
      fallbackTestId="home-onboarding-suggestion-plugin-logo-fallback"
    />
  );
}
