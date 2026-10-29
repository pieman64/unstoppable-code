/**
 * Pure state machine for the dynamic "Getting started" suggestions module
 * under the Home composer. Derives each queue entry's current step from live
 * product state (connection statuses, workspace inventory, submitted roles,
 * role-recommended curated plugins) plus the persisted event latches, and
 * provides the immutable reducers the hook applies when the user dismisses,
 * completes, or advances an entry.
 *
 * The queue starts with AI providers, then import/project setup, then the
 * tools step, whose category row stands in for the old roles question: fixed
 * connectors, universal plugins, and selected-role plugins. Opt-ins and
 * other catalog picks follow. Technical project-readiness fixes join its advanced stage.
 * Completed and dismissed activities leave the visible window but still count
 * toward progress. Show the next unresolved step, or up to three consecutive
 * plugin choices or example prompts of the same kind.
 *
 * When the active surface is an empty new chat in a chat project seeded from
 * a curated project template (CAN-3032), that template's own setup leads the
 * queue: one add step per bundled plugin (already-enabled ones count as done)
 * and up to {@link MAX_BLUEPRINT_STARTER_PROMPT_ITEMS} of its starter prompts,
 * keyed per project. Its plugins, and its prompts, each form steps of up to
 * three rows that show, skip, revisit, and count together. The general
 * checklist follows unchanged. Pipeline items wait for the template contract
 * to carry pipelines (CAN-3016).
 *
 * No React and no `window.api` here — everything is unit-testable data
 * transformation; `useOnboardingSuggestions` owns wiring and persistence.
 */

import {
  HOME_ONBOARDING_BLUEPRINT_SUGGESTION_PREFIX,
  HOME_ONBOARDING_PLUGIN_SUGGESTION_PREFIX,
  HOME_ONBOARDING_SUGGESTION_ENTRY_IDS,
} from '@canopy/desktop-shared/types';
import type { ProfileRoleId } from '@canopy/protocol/plugin-catalog';
import { DEFAULT_DAILY_DRIP_CAP_CREDITS } from '@canopy/protocol/billing';
import type { WorkspaceTemplateStarterPrompt } from '@canopy/protocol';
import type { ProviderConnectionState } from '@/lib/onboarding/provider-connection-status';
import type {
  HomeOnboardingSuggestionsPreferences,
  WorkspaceReadinessIssue,
} from '@canopy/desktop-shared/types';
import { workspaceReadinessIssueKey } from '@/lib/workspaceReadinessIssueKey';
import { GENERIC_FALLBACK_PROMPTS } from '@/components/suggestions/mcpPromptIndex';
import { retainChecklistProjectStep } from '@canopy/ui-shared/lib/checklist-progress';
import { checklistConnectionTiles } from '@canopy/ui-shared/lib/onboarding-recommendations';

export const LINEAR_TRY_PROMPT =
  'Find a Linear ticket assigned to me that is ready to be worked on. Read the ticket and relevant project context, then start a Plan mode implementation plan for it. Do not make code changes yet.';

export const NONTECHNICAL_FIRST_PROMPT =
  'Help me plan a project I am working on. Ask me about the goal and constraints, then propose milestones, dependencies, and a practical first step.';

/**
 * Roles whose selection carries no developer-tooling signal. When EVERY
 * submitted role is in this set the developer-tool entries (Add repo,
 * GitHub, Linear) and technical plugin suggestions leave the queue. Add repo
 * stays as a done step when the user already has a repo or resolved it.
 *
 * Data/analytics remains technical; student and Other take the nontechnical
 * route unless the user also selected a technical role.
 */
const NONTECHNICAL_PROFILE_ROLES: ReadonlySet<ProfileRoleId> =
  new Set<ProfileRoleId>([
    'product-manager',
    'designer',
    'founder',
    'marketing-sales',
    'marketing',
    'sales',
    'operations',
    'support',
    'operations-support',
    'student',
    'other',
  ]);

/**
 * Curated plugin names that only make sense for technical users; filtered
 * from suggestions for strictly nontechnical role selections.
 */
const TECHNICAL_ONLY_PLUGIN_NAMES: ReadonlySet<string> = new Set([
  'github',
  'linear',
  'datadog',
  'vercel',
]);

export function addRepoTryPrompt(repoName: string | null): string {
  return `Find a simple TODO in ${repoName ?? 'my repo'} and implement it`;
}

export interface OnboardingToolRecommendation {
  key: string;
  kind: 'github' | 'linear' | 'plugin';
  pluginName: string;
  displayName: string;
  connected: boolean;
  promptTexts: readonly string[];
  /** Exact catalog keys, never reconstructed detail-page URLs. */
  enableKeys?: readonly string[];
  /** Discovery fallback when a catalog detail cannot be addressed directly. */
  searchQuery?: string;
  /** Role-derived tools are offered before generic universal connectors. */
  rolePriority?: boolean;
}

/** Persisted-entry id for a curated-plugin suggestion. */
export function pluginSuggestionEntryId(pluginKey: string): string {
  return `${HOME_ONBOARDING_PLUGIN_SUGGESTION_PREFIX}${pluginKey}`;
}

/** Starter prompts offered from a project template, in document order. */
export const MAX_BLUEPRINT_STARTER_PROMPT_ITEMS = 3;

/**
 * Persisted-entry id for a project-template checklist item. Keyed by the
 * chat project, not the template, so two projects seeded from the same
 * template each track their own progress (same precedent as the per-workspace
 * readiness entries).
 */
export function blueprintSuggestionEntryId(
  projectId: string,
  kind: 'plugin' | 'prompt',
  id: string,
): string {
  return `${HOME_ONBOARDING_BLUEPRINT_SUGGESTION_PREFIX}${projectId}:${kind}:${id}`;
}

/** The active chat project's curated project template, as the queue sees it. */
export interface OnboardingBlueprintInputs {
  /** Chat project the empty new chat belongs to. */
  projectId: string;
  /** Template display name, for headings and sidebar labels. */
  name: string;
  /**
   * The template's bundled plugins with their live enablement, composed by
   * `usePluginSuggestions` from the local marketplace caches. Refs this
   * device cannot resolve are omitted: an item with nothing to enable is not
   * actionable.
   */
  plugins: readonly OnboardingPluginSuggestionInput[];
  /** The project's starter prompts (its own, else the template's). */
  starterPrompts: readonly WorkspaceTemplateStarterPrompt[];
}

/** One suggested plugin (or plugin group) offered as a queue entry. */
export interface OnboardingPluginSuggestionInput {
  /**
   * Stable suggestion key: a curated plugin selection key
   * (`${marketplaceId}/${name}`, case-folded) for catalog-driven entries, or
   * `universal:<id>` for the hardcoded universally-useful entries.
   */
  key: string;
  /** Stable plugin name — technical filtering and logo lookup key. */
  name: string;
  displayName: string;
  description: string;
  /** Prompt injected by the try step (curated index or synthesized). */
  promptText: string;
  /** Three prompt choices shown after opening a connected tool. */
  promptTexts: readonly string[];
  /** Already enabled in the global plugin selections. */
  enabled: boolean;
  /**
   * Curated plugin selection keys the Add CTA enables — one for a
   * catalog-driven entry, several for a universal group (e.g. Gmail +
   * Calendar + Drive). Entries without a catalog match are not recommended.
   */
  enableKeys: readonly string[];
  /**
   * Search prefill for the Plugins-discovery fallback when nothing can be
   * enabled directly (e.g. "google", "notion").
   */
  searchQuery: string;
  /** Selected-role shortlist: after universal connectors, before opt-ins. */
  recommendationTier?: 'role';
}

/**
 * Daily free AI Credits opt-in, as the queue sees it. `unavailable` (no cloud
 * credential, an older server, or an unresolved read) and `loading` (before
 * the first read settles) remove the entry entirely; `undecided` shows it;
 * `decided` completes it whichever way the user answered.
 */
export interface OnboardingDailyCreditDripInput {
  state: 'unavailable' | 'loading' | 'undecided' | 'decided';
  enabled: boolean;
  /** Plan cap offered by the card; null falls back to the default cap. */
  capCredits: number | null;
}

/** Live product state the derivation reads. Assembled by the hook. */
export interface OnboardingSuggestionLiveInputs {
  /** Any non-cowork workspace exists (the default Cowork entry never counts). */
  hasCodeWorkspace: boolean;
  /** Name of the newest code workspace, for the first-prompt template. */
  latestRepoName: string | null;
  github: ProviderConnectionState;
  claude: ProviderConnectionState;
  codex: ProviderConnectionState;
  linear: ProviderConnectionState;
  /** Included AI Credits can already run agents without a native login. */
  aiCreditsEligible: boolean;
  /** Categories picked on the tools step; null until first answered. */
  selectedRoles: readonly ProfileRoleId[] | null;
  /** Universal connectors, selected-role picks, then other catalog picks. */
  pluginSuggestions: readonly OnboardingPluginSuggestionInput[];
  /**
   * OS focus shortcut (CAN-1963). `enabled` is the preference; `registered`
   * is the OS's answer, which stays false when another app holds the chord.
   * `shortcut` is the platform display string (`⌘⇧O`, `Ctrl Shift O`).
   */
  focusShortcut: {
    enabled: boolean;
    registered: boolean;
    shortcut: string;
  };
  /**
   * Launch at sign-in (CAN-3449), read back from the OS. Absent or
   * unsupported (Linux, a build that is not installed) leaves the entry out
   * entirely; `pendingApproval` is macOS waiting on System Settings.
   */
  launchAtLogin?: {
    supported: boolean;
    enabled: boolean;
    pendingApproval: boolean;
  };
  /**
   * Whether a Claude or Codex store exists locally (CAN-2439). Absent or
   * false hides the bulk-import entry entirely; the flow stays reachable
   * from Settings.
   */
  providerStoresPresent?: boolean;
  /**
   * Whether any code project has Cursor rules to review (CAN-2053). Absent
   * (still probing, or the probe failed) or false hides the entry unless the
   * user already resolved it; the review stays reachable from Settings.
   */
  cursorRulesPresent?: boolean;
  /** Daily free AI Credits opt-in; see {@link OnboardingDailyCreditDripInput}. */
  dailyCreditDrip: OnboardingDailyCreditDripInput;
  /** Shared mobile promo eligibility: signed in, store links, no detected activation or snooze. */
  mobileAppPromoEligible?: boolean;
  /** Current code project's actionable setup recommendations, once loaded. */
  readiness?: {
    workspaceId: string;
    issues: readonly WorkspaceReadinessIssue[];
  };
  /**
   * Set while the active surface is an empty new chat in a chat project
   * seeded from a curated project template (CAN-3032); its items lead the
   * queue. Absent on Home, in plain projects, and in code chats.
   */
  blueprint?: OnboardingBlueprintInputs;
}

export type OnboardingSuggestionStep =
  | { kind: 'get-mobile-app' }
  | {
      kind: 'advanced-prompt';
      tool: OnboardingToolRecommendation;
      label: string;
      promptText: string;
      requiresCodeWorkspace: boolean;
    }
  | { kind: 'enable-daily-credits'; capCredits: number }
  | {
      kind: 'advanced-readiness';
      label: string;
      workspaceId: string;
      issue: WorkspaceReadinessIssue;
    }
  | { kind: 'import-projects-cta' }
  | { kind: 'import-editor-setup-cta' }
  | { kind: 'enable-focus-shortcut'; shortcut: string }
  | { kind: 'focus-shortcut-blocked'; shortcut: string }
  | { kind: 'enable-launch-at-login' }
  | { kind: 'launch-at-login-needs-approval' }
  | { kind: 'add-repo-cta' }
  | { kind: 'prompt'; promptText: string; label?: string }
  | { kind: 'connect-github' }
  | { kind: 'github-try'; promptText: string }
  | { kind: 'connect-tools'; tools: readonly OnboardingToolRecommendation[] }
  | {
      kind: 'plugin-examples-preview';
      tools: readonly OnboardingToolRecommendation[];
    }
  | { kind: 'connect-agents' }
  | { kind: 'create-plan' }
  | { kind: 'connect-linear' }
  | { kind: 'linear-try-prompt'; promptText: string }
  | {
      kind: 'plugin-add';
      pluginKey: string;
      /** Stable plugin name — joins the curated MCP catalog for the logo. */
      pluginName: string;
      displayName: string;
      description: string;
      /** Curated selection keys the Add CTA enables (may be empty). */
      enableKeys: readonly string[];
      /** Discovery search prefill for the can't-enable fallback. */
      searchQuery: string;
    }
  | {
      kind: 'plugin-try';
      pluginKey: string;
      /** Stable plugin name — joins the curated MCP catalog for the logo. */
      pluginName: string;
      displayName: string;
      promptText: string;
    };

export interface OnboardingSuggestionView {
  /** Curated entry id or a `plugin:<key>` / `blueprint:<project>:…` dynamic id. */
  entryId: string;
  step: OnboardingSuggestionStep;
  /** Present only on items tailored to the active project template. */
  blueprint?: { projectId: string; name: string };
}

export interface OnboardingChecklistView extends OnboardingSuggestionView {
  status: 'pending' | 'completed' | 'dismissed' | 'deferred';
}

/** Full, role-appropriate progress, including dismissals that the UI hides. */
export function deriveOnboardingChecklist(
  persisted: Pick<HomeOnboardingSuggestionsPreferences, 'entries'>,
  live: OnboardingSuggestionLiveInputs,
): OnboardingChecklistView[] {
  const { entries } = persisted;
  const nontechnical = strictlyNontechnical(live.selectedRoles);
  const repoSetupAlreadyResolved = Boolean(
    entries['add-repo']?.completedAt || entries['add-repo']?.dismissedAt,
  );
  const retainRepoSetup = retainChecklistProjectStep({
    nontechnical,
    hasProject: live.hasCodeWorkspace,
    resolved: repoSetupAlreadyResolved,
  });
  // A contextual entry the user already resolved stays in the list as a done
  // step even when its live trigger (a connected tool, promo eligibility) is
  // absent or has not settled yet, so the step count is right from first
  // paint instead of moving when the catalog or the activation probe lands.
  const hasRecord = (id: string): boolean =>
    entries[id]?.completedAt !== undefined ||
    entries[id]?.dismissedAt !== undefined;
  const candidates: OnboardingSuggestionView[] = [
    ...HOME_ONBOARDING_SUGGESTION_ENTRY_IDS.filter(
      (id) =>
        id !== 'focus-shortcut' &&
        // Without a settled cloud answer the opt-in is neither shown nor
        // counted, so it cannot hold back progress or the advanced prompts.
        !(id === 'daily-credits' && !dailyCreditDripAnswerable(live)) &&
        id !== 'launch-at-login' &&
        id !== 'mobile-app' &&
        // GitHub now owns the single consolidated tools step. Linear and every
        // catalog recommendation render inside that step instead of becoming
        // separate queue rows.
        id !== 'linear' &&
        // This one-time interstitial is contextual, not a permanent checklist
        // obligation: only add it when there is a connected tool to try, or
        // when it was already resolved.
        !(
          id === 'plugin-examples-preview' &&
          previewToolRecommendations(live).length === 0 &&
          !hasRecord(id)
        ) &&
        // Nobody should be asked to import from a tool they never ran.
        !(id === 'import-projects' && live.providerStoresPresent !== true) &&
        // Only offer the rules review where there are rules to review. A
        // resolved entry keeps its done row while the probe is in flight.
        !(
          id === 'import-editor-setup' &&
          live.cursorRulesPresent !== true &&
          !hasRecord(id)
        ) &&
        // Categories are picked on the tools step, after this one, so a new
        // user keeps repo setup; a saved nontechnical profile (a returning
        // user, or roles changed in Settings) skips it unless the user
        // already got past it, so a resolved step never drops out of the
        // numbering.
        !(id === 'add-repo' && !retainRepoSetup),
    ).map((entryId) => ({
      entryId,
      step: curatedStepFor(entryId, live),
    })),
    // Tool recommendations are consolidated above. Continue with the global
    // shortcut, then launch at sign-in (only where the OS supports it).
    // Notifications are offered after a background completion instead
    // (CAN-4005), not as a step.
    {
      entryId: 'focus-shortcut',
      step: curatedStepFor('focus-shortcut', live),
    },
    ...(live.launchAtLogin?.supported === true
      ? [
          {
            entryId: 'launch-at-login',
            step: curatedStepFor('launch-at-login', live),
          },
        ]
      : []),
    ...(live.mobileAppPromoEligible || hasRecord('mobile-app')
      ? [{ entryId: 'mobile-app', step: curatedStepFor('mobile-app', live) }]
      : []),
  ];
  const general = candidates.map((view): OnboardingChecklistView => {
    const entry = entries[view.entryId];
    const complete =
      entry?.completedAt !== undefined ||
      // Either answer completes the opt-in; only Turn on enables the drip.
      (view.entryId === 'daily-credits' &&
        live.dailyCreditDrip.state === 'decided') ||
      (view.entryId === 'add-repo' && live.hasCodeWorkspace) ||
      // Deliberately looser than Settings' "Working" (which waits for an
      // OS-delivered press): the checklist asks the user to turn the
      // shortcut on.
      (view.entryId === 'focus-shortcut' &&
        live.focusShortcut.enabled &&
        live.focusShortcut.registered) ||
      // The OS's read-back, not a saved preference: turning it on in
      // Settings (or System Settings) completes the entry too.
      (view.entryId === 'launch-at-login' &&
        live.launchAtLogin?.enabled === true);
    // Dismissal stays hidden even if setup later completes through another surface.
    const status =
      entry?.dismissedAt !== undefined
        ? 'dismissed'
        : complete
          ? 'completed'
          : !live.hasCodeWorkspace && isRepoDependentStep(view.step)
            ? repoSetupAlreadyResolved
              ? 'dismissed'
              : 'deferred'
            : 'pending';
    return { ...view, status };
  });
  return live.blueprint
    ? [...blueprintChecklistViews(live.blueprint, entries), ...general]
    : general;
}

/**
 * The active project template's own setup, ahead of the general checklist:
 * every bundled plugin this device can enable (done once it is enabled or
 * connected, so a seeded project starts with those reflected), then its
 * first starter prompts. Dismissal and completion persist per project.
 */
function blueprintChecklistViews(
  blueprint: OnboardingBlueprintInputs,
  entries: PersistedEntries,
): OnboardingChecklistView[] {
  const origin = { projectId: blueprint.projectId, name: blueprint.name };
  const statusFor = (
    entryId: string,
    complete: boolean,
  ): OnboardingChecklistView['status'] => {
    const entry = entries[entryId];
    return entry?.dismissedAt !== undefined
      ? 'dismissed'
      : complete || entry?.completedAt !== undefined
        ? 'completed'
        : 'pending';
  };
  const seenPlugins = new Set<string>();
  const plugins: OnboardingChecklistView[] = [];
  for (const plugin of blueprint.plugins) {
    const name = plugin.name.toLowerCase();
    if (seenPlugins.has(name)) continue;
    seenPlugins.add(name);
    const entryId = blueprintSuggestionEntryId(
      blueprint.projectId,
      'plugin',
      name,
    );
    plugins.push({
      entryId,
      blueprint: origin,
      step: {
        kind: 'plugin-add',
        pluginKey: plugin.key,
        pluginName: plugin.name,
        displayName: plugin.displayName,
        description:
          plugin.description.trim().length > 0
            ? plugin.description
            : `Included in the ${blueprint.name} project template`,
        enableKeys: plugin.enableKeys,
        searchQuery: plugin.searchQuery,
      },
      status: statusFor(entryId, plugin.enabled),
    });
  }
  // A project's own prompts are editable, so repeated ids are possible;
  // one row per id keeps entry ids (and React keys) unique.
  const seenPrompts = new Set<string>();
  const prompts = blueprint.starterPrompts
    .filter((prompt) => {
      if (seenPrompts.has(prompt.id)) return false;
      seenPrompts.add(prompt.id);
      return true;
    })
    .slice(0, MAX_BLUEPRINT_STARTER_PROMPT_ITEMS)
    .map((prompt): OnboardingChecklistView => {
      const entryId = blueprintSuggestionEntryId(
        blueprint.projectId,
        'prompt',
        prompt.id,
      );
      return {
        entryId,
        blueprint: origin,
        step: { kind: 'prompt', label: prompt.text, promptText: prompt.text },
        status: statusFor(entryId, false),
      };
    });
  return [...plugins, ...prompts];
}

/** One bounded window over a durable, expandable queue shared by both surfaces. */
export function deriveOnboardingSuggestionQueue(
  persisted: Pick<HomeOnboardingSuggestionsPreferences, 'entries'>,
  live: OnboardingSuggestionLiveInputs,
  pluginsReady: boolean,
): {
  checklist: OnboardingChecklistView[];
  visible: OnboardingChecklistView[];
  completedCount: number;
} {
  const derivedChecklist = deriveOnboardingChecklist(persisted, live);
  const checklist = derivedChecklist.filter((view) => {
    // The one-time examples interstitial only exists when it has something
    // real to demonstrate; an empty placeholder must never block the flow,
    // including while the plugin source is still hydrating.
    if (view.step.kind === 'plugin-examples-preview') {
      return (
        isResolvedSuggestion(view) ||
        (pluginsReady && view.step.tools.length > 0)
      );
    }
    // The tools step also hosts the category row, the only place to answer
    // or change the categories, so it always stays: an unanswered or cleared
    // profile is offered the universal connectors, and a pick that leaves no
    // tools must not remove the row that made it.
    return true;
  });
  if (pluginsReady && checklist.every(isResolvedSuggestion)) {
    if (!strictlyNontechnical(live.selectedRoles) && live.readiness) {
      for (const issue of live.readiness.issues) {
        if (issue.fixPrompt === null) continue;
        const entryId = `advanced:readiness:${live.readiness.workspaceId}:${workspaceReadinessIssueKey(issue)}`;
        const entry = persisted.entries[entryId];
        checklist.push({
          entryId,
          step: {
            kind: 'advanced-readiness',
            label: issue.title,
            workspaceId: live.readiness.workspaceId,
            issue,
          },
          status: entry?.dismissedAt
            ? 'dismissed'
            : entry?.completedAt
              ? 'completed'
              : 'pending',
        });
      }
    }
    for (const prompt of advancedOnboardingPrompts(live, persisted.entries)) {
      const entryId = `advanced:${prompt.id}`;
      const entry = persisted.entries[entryId];
      checklist.push({
        entryId,
        step: {
          kind: 'advanced-prompt',
          tool: prompt.tool,
          label: prompt.label,
          promptText: prompt.text,
          requiresCodeWorkspace: prompt.requiresCodeWorkspace,
        },
        status: entry?.dismissedAt
          ? 'dismissed'
          : entry?.completedAt
            ? 'completed'
            : 'pending',
      });
    }
  }
  return {
    checklist,
    visible: visibleSuggestionWindow(
      checklist,
      checklist.filter((view) => !isResolvedSuggestion(view)),
    ),
    completedCount: checklist.filter(isResolvedSuggestion).length,
  };
}

/** Rows one window shows, and the most rows one template step holds. */
const SUGGESTION_WINDOW_SIZE = 3;

/**
 * The checklist as the steps its arrows move between and its progress
 * counts. A project template's plugins, and its starter prompts, form steps
 * of up to three consecutive rows (CAN-3032): the window shows a step's rows
 * together, Next leaves all of them, and Back returns to all of them. Every
 * other entry is its own step.
 */
export function onboardingChecklistSteps(
  checklist: readonly OnboardingChecklistView[],
): OnboardingChecklistView[][] {
  const steps: OnboardingChecklistView[][] = [];
  let current: OnboardingChecklistView[] = [];
  let currentKey: string | null = null;
  for (const view of checklist) {
    const key = templateStepKey(view);
    if (
      key !== null &&
      key === currentKey &&
      current.length < SUGGESTION_WINDOW_SIZE
    ) {
      current.push(view);
      continue;
    }
    current = [view];
    currentKey = key;
    steps.push(current);
  }
  return steps;
}

/** Template rows of one kind for one project share steps; others never do. */
function templateStepKey(view: OnboardingChecklistView): string | null {
  return view.blueprint === undefined
    ? null
    : `${view.blueprint.projectId}:${view.step.kind}`;
}

/** Preserve queue order; never skip a setup step to fill an alternatives group. */
function visibleSuggestionWindow(
  checklist: readonly OnboardingChecklistView[],
  pending: OnboardingChecklistView[],
): OnboardingChecklistView[] {
  const first = pending[0];
  if (!first) return [];
  // A template step shows its own remaining rows, never the next step's,
  // so the window always matches the step its arrows act on.
  if (first.blueprint !== undefined) {
    const step = onboardingChecklistSteps(checklist).find((candidate) =>
      candidate.includes(first),
    );
    return (step ?? [first]).filter((view) => !isResolvedSuggestion(view));
  }
  const group = interchangeableGroup(first);
  if (group === null) return [first];
  const visible = [first];
  for (const candidate of pending.slice(1, SUGGESTION_WINDOW_SIZE)) {
    if (interchangeableGroup(candidate) !== group) break;
    visible.push(candidate);
  }
  return visible;
}

function interchangeableGroup(
  view: OnboardingChecklistView,
): 'plugins' | 'prompts' | null {
  if (view.status === 'deferred') return null;
  switch (view.step.kind) {
    case 'connect-github':
    case 'connect-linear':
    case 'plugin-add':
      return 'plugins';
    case 'prompt':
    case 'github-try':
    case 'linear-try-prompt':
    case 'plugin-try':
    case 'advanced-prompt':
      return 'prompts';
    default:
      return null;
  }
}

/** Completed or dismissed, however that happened; shared with the host. */
export function isResolvedSuggestion(view: OnboardingChecklistView): boolean {
  return view.status === 'completed' || view.status === 'dismissed';
}

export interface AdvancedOnboardingPrompt {
  tool: OnboardingToolRecommendation;
  id: string;
  label: string;
  text: string;
  requiresCodeWorkspace: boolean;
}

/** Advanced counterparts of the basic examples, offered only for available tools. */
export function advancedOnboardingPrompts(
  live: OnboardingSuggestionLiveInputs,
  entries: HomeOnboardingSuggestionsPreferences['entries'] = {},
): AdvancedOnboardingPrompt[] {
  const connectedTools = toolRecommendations(live).filter(
    (tool) => tool.connected,
  );
  const tools =
    connectedTools.length > 0
      ? connectedTools
      : [
          {
            key: 'generic-dev',
            kind: 'plugin' as const,
            pluginName: 'unstoppable',
            displayName: 'Unstoppable',
            connected: true,
            rolePriority: true,
            promptTexts: GENERIC_FALLBACK_PROMPTS.chat.map(
              (prompt) => prompt.text,
            ),
          },
        ];
  const groups = tools
    .map((tool) => {
      const prompts = tool.promptTexts
        .map((text, index) => ({
          id: `${tool.key}:${index}`,
          tool,
          label: text,
          text,
          requiresCodeWorkspace: tool.kind === 'github' && index === 0,
        }))
        .filter(
          (prompt) => !prompt.requiresCodeWorkspace || live.hasCodeWorkspace,
        );
      const resolved = (prompt: AdvancedOnboardingPrompt): boolean => {
        const entry = entries[`advanced:${prompt.id}`];
        return Boolean(entry?.completedAt || entry?.dismissedAt);
      };
      return {
        rolePriority: tool.rolePriority === true,
        used: prompts.filter(resolved).length,
        pending: prompts.filter((prompt) => !resolved(prompt)),
        resolved: prompts.filter(resolved),
      };
    })
    .sort(
      (left, right) =>
        Number(right.rolePriority) - Number(left.rolePriority) ||
        left.used - right.used,
    );
  // Round-robin gives breadth within each window. A newly connected or unused
  // tool gets its first turn before another tool gets its second.
  const prompts: AdvancedOnboardingPrompt[] = [];
  for (
    let index = 0;
    groups.some((group) => index < group.pending.length);
    index += 1
  ) {
    for (const group of groups) {
      const prompt = group.pending[index];
      if (prompt) prompts.push(prompt);
    }
  }
  return [...prompts, ...groups.flatMap((group) => group.resolved)];
}

type PersistedEntries = HomeOnboardingSuggestionsPreferences['entries'];

export function strictlyNontechnical(
  selectedRoles: readonly ProfileRoleId[] | null,
): boolean {
  return (
    selectedRoles !== null &&
    selectedRoles.length > 0 &&
    selectedRoles.every((role) => NONTECHNICAL_PROFILE_ROLES.has(role))
  );
}

/** The opt-in joins the queue only once the cloud answer has settled. */
function dailyCreditDripAnswerable(
  live: OnboardingSuggestionLiveInputs,
): boolean {
  const { state } = live.dailyCreditDrip;
  return state === 'undecided' || state === 'decided';
}

function curatedStepFor(
  entryId: (typeof HOME_ONBOARDING_SUGGESTION_ENTRY_IDS)[number],
  live: OnboardingSuggestionLiveInputs,
): OnboardingSuggestionStep {
  switch (entryId) {
    case 'daily-credits':
      return {
        kind: 'enable-daily-credits',
        capCredits:
          live.dailyCreditDrip.capCredits ?? DEFAULT_DAILY_DRIP_CAP_CREDITS,
      };
    case 'import-projects':
      return { kind: 'import-projects-cta' };
    case 'import-editor-setup':
      return { kind: 'import-editor-setup-cta' };
    case 'mobile-app':
      return { kind: 'get-mobile-app' };
    case 'focus-shortcut':
      // On but unregistered means another app holds the chord: the only fix
      // is a different chord, so the step points at the Settings recorder.
      return live.focusShortcut.enabled && !live.focusShortcut.registered
        ? {
            kind: 'focus-shortcut-blocked',
            shortcut: live.focusShortcut.shortcut,
          }
        : {
            kind: 'enable-focus-shortcut',
            shortcut: live.focusShortcut.shortcut,
          };
    case 'launch-at-login':
      // Registered but not yet allowed: only System Settings can finish it.
      return live.launchAtLogin?.pendingApproval === true
        ? { kind: 'launch-at-login-needs-approval' }
        : { kind: 'enable-launch-at-login' };
    case 'add-repo':
      return live.hasCodeWorkspace
        ? { kind: 'prompt', promptText: addRepoTryPrompt(live.latestRepoName) }
        : { kind: 'add-repo-cta' };
    case 'github':
      // GitHub is offered when a push or pull request first needs it; its
      // examples stay with the other connected tools.
      return {
        kind: 'connect-tools',
        tools: checklistConnectionTiles(toolRecommendations(live)),
      };
    case 'plugin-examples-preview':
      return {
        kind: 'plugin-examples-preview',
        tools: previewToolRecommendations(live),
      };
    case 'agent-connections':
      // Keep provider setup as its own explicit lesson. Connected providers
      // render as connected in the UI, but no longer erase the lesson.
      return { kind: 'connect-agents' };
    case 'plan-mode':
      return strictlyNontechnical(live.selectedRoles)
        ? {
            kind: 'prompt',
            label: 'Outline my next steps',
            promptText: NONTECHNICAL_FIRST_PROMPT,
          }
        : { kind: 'create-plan' };
    case 'linear':
      return live.linear === 'connected'
        ? { kind: 'linear-try-prompt', promptText: LINEAR_TRY_PROMPT }
        : { kind: 'connect-linear' };
  }
}

function toolRecommendations(
  live: OnboardingSuggestionLiveInputs,
): OnboardingToolRecommendation[] {
  const nontechnical = strictlyNontechnical(live.selectedRoles);
  const tools: OnboardingToolRecommendation[] = [];
  if (!nontechnical) {
    tools.push(
      {
        key: 'github',
        kind: 'github',
        pluginName: 'github',
        displayName: 'GitHub',
        connected: live.github === 'connected',
        promptTexts: [
          addRepoTryPrompt(live.latestRepoName),
          'Summarize GitHub pull requests waiting on my review',
          'Draft release notes from GitHub changes since the last release',
          'Review recent GitHub changes and propose regression tests for the riskiest areas',
          'Find an undocumented area in my GitHub repo and draft a guide with examples',
        ],
      },
      {
        key: 'linear',
        kind: 'linear',
        pluginName: 'linear',
        displayName: 'Linear',
        connected: live.linear === 'connected',
        promptTexts: [
          LINEAR_TRY_PROMPT,
          'Summarize what my team shipped this cycle in Linear',
          'Turn my notes into a Linear issue',
          'Break a complex Linear issue into milestones, dependencies, and acceptance criteria',
        ],
      },
    );
  }
  // A plugin the active project template already asks for (CAN-3032) is
  // not offered a second time in the general tools step.
  const templatePlugins = new Set(
    (live.blueprint?.plugins ?? []).map((plugin) => plugin.name.toLowerCase()),
  );
  for (const plugin of live.pluginSuggestions) {
    const name = plugin.name.toLowerCase();
    if (templatePlugins.has(name)) continue;
    if (nontechnical && TECHNICAL_ONLY_PLUGIN_NAMES.has(name)) continue;
    tools.push({
      key: `plugin:${plugin.key}`,
      kind: 'plugin',
      pluginName: plugin.name,
      displayName: plugin.displayName,
      connected: plugin.enabled,
      promptTexts: plugin.promptTexts,
      enableKeys: plugin.enableKeys,
      searchQuery: plugin.searchQuery,
      rolePriority: plugin.recommendationTier === 'role',
    });
  }
  return tools;
}

/** Up to three connected tools, with the user's role-specific picks first. */
function previewToolRecommendations(
  live: OnboardingSuggestionLiveInputs,
): OnboardingToolRecommendation[] {
  return toolRecommendations(live)
    .filter((tool) => tool.connected)
    .sort(
      (left, right) =>
        Number(right.rolePriority === true) -
        Number(left.rolePriority === true),
    )
    .slice(0, 3);
}

/** Step kinds that operate on a repository and defer without one. */
export function isRepoDependentStep(step: OnboardingSuggestionStep): boolean {
  return step.kind === 'create-plan' || step.kind === 'linear-try-prompt';
}

function withEntryPatch(
  state: HomeOnboardingSuggestionsPreferences,
  entryId: string,
  patch: NonNullable<PersistedEntries[string]>,
): HomeOnboardingSuggestionsPreferences {
  return {
    ...state,
    entries: {
      ...state.entries,
      [entryId]: { ...state.entries[entryId], ...patch },
    },
  };
}

export function withEntryDismissed(
  state: HomeOnboardingSuggestionsPreferences,
  entryId: string,
  at: string,
): HomeOnboardingSuggestionsPreferences {
  return withEntryPatch(state, entryId, { dismissedAt: at });
}

/**
 * Drops every entry's dismissal so the rows come back, and the legacy
 * whole-module `retiredAt` with it; completions and latched steps stay.
 * Settings' "Show setup checklist" applies this.
 */
export function withDismissalsCleared(
  state: HomeOnboardingSuggestionsPreferences,
): HomeOnboardingSuggestionsPreferences {
  const entries: HomeOnboardingSuggestionsPreferences['entries'] = {};
  for (const [entryId, entry] of Object.entries(state.entries)) {
    const next = { ...entry };
    delete next.dismissedAt;
    entries[entryId] = next;
  }
  // Spread rather than rebuild so any future top-level field survives a
  // restore; only the legacy retirement is dropped on purpose.
  const next = { ...state, entries };
  delete next.retiredAt;
  return next;
}

export function withEntryCompleted(
  state: HomeOnboardingSuggestionsPreferences,
  entryId: string,
  at: string,
): HomeOnboardingSuggestionsPreferences {
  return withEntryPatch(state, entryId, { completedAt: at });
}
