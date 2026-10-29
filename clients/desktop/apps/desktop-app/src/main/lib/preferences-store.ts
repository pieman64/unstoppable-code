import { DATA_SHARING_OPT_IN_FEATURES } from '@canopy/protocol/canopy-server';
import {
  excludeDisabledInstalledItems,
  normalizeDisabledInstalledItems,
  parseInstalledItemKey,
  InstalledItemRefSchema,
  InstalledItemUninstallTargetSchema,
} from '@canopy/protocol/installed-items';
import { z } from 'zod';
import {
  compareReleaseVersions,
  parseReleaseVersion,
} from '@canopy/protocol/release-notes';
import {
  DEFAULT_CLAUDE_MAX_TURNS,
  normalizeClaudeMaxTurns,
} from '@canopy/desktop-shared/constants/preferences';
import {
  normalizeManagedDelegationMode,
  normalizeManagedDelegationMaxConcurrent,
  normalizeManagedDelegationMaxDepth,
} from '@canopy/protocol/delegation/discovery';
import { normalizeCodexMaxConcurrentSubagents } from '@canopy/desktop-shared/lib/codex-multi-agent';
import { normalizeAppAdvisorProjectAgentAccess } from '@canopy/desktop-shared/lib/app-advisor-project-agent-access';
import { isSyntacticallyValidModelId } from '@canopy/desktop-shared/lib/model-id';
import { renameWithRetry } from './atomic-file';
import { resolveAvailableModel } from './model-availability';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { mcpHttpAuthTargetKey } from '@canopy/desktop-shared/lib/mcp-http-auth';
import { isTerminalPresetImageDataUrl } from '@canopy/desktop-shared/lib/terminal-preset-images';
import { isGatewayRoutableModel } from '@canopy/desktop-shared/lib/gateway-model-availability';
import {
  isAccountProxyRoutingStrategy,
  normalizeAccountProxyUrl,
} from '@canopy/desktop-shared/lib/account-proxy';
import type {
  AccountProxyConnection,
  AccountProxyConnectionKind,
} from '@canopy/desktop-shared/types/account-proxy';
import {
  isBillingLane,
  type BillingLane,
} from '@canopy/desktop-shared/lib/default-model-lane';
import { normalizePlanDetectionRule } from '@canopy/desktop-shared/plan-detection';
import {
  DEFAULT_MERGE_QUEUE_AGENT_HANDLING,
  isMergeQueueAgentHandling,
} from '@canopy/desktop-shared/types/github';
import {
  createDefaultSidebarNavLayout,
  reconcileSidebarNavLayout,
} from '@canopy/desktop-shared/lib/sidebar-nav-layout';
import { TELEMETRY_SHARE_SCOPES } from '@canopy/protocol/telemetry';
import { expandLegacyProfileRoles } from '@canopy/protocol/plugin-catalog';
import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  DEFAULT_BRANCH_NAMING_MODEL,
  DEFAULT_COMMIT_GENERATION_MODEL,
  DEFAULT_PR_GENERATION_MODEL,
  DEFAULT_SUMMARY_MODEL,
  DEFAULT_HANDOFF_SUMMARY_MODEL,
  DEFAULT_LOCAL_MEMORY_MODEL,
  defaultLocalMemoryModel,
  defaultSummaryModel,
  DEFAULT_APP_ADVISOR_MODEL,
  DEFAULT_CRON_GENERATION_MODEL,
  DEFAULT_IF_COMMAND_GENERATION_MODEL,
  DEFAULT_PIPELINE_ADVISOR_MODEL,
  DEFAULT_MCP_HTTP_AUTH_HANDLER,
  DEFAULT_MCP_PROXY_PORT,
  DEFAULT_OLLAMA_SERVER_PORT,
  DEFAULT_HIDE_ANTHROPIC_NAV,
  DEFAULT_CODEX_APP_SERVER_IDLE_TIMEOUT_MINUTES,
  DEFAULT_TERMINAL_DRAWER_ACTIVE_TAB_ID,
  DEFAULT_TERMINAL_DRAWER_COLLAPSED,
  DEFAULT_TERMINAL_DRAWER_HEIGHT,
  MAX_TERMINAL_DRAWER_HEIGHT,
  MIN_TERMINAL_DRAWER_HEIGHT,
  THEME_NAMES,
  COLOR_MODES,
  SIDEBAR_APPEARANCES,
  WORKTREE_DIFF_STATS_STYLES,
  SCROLLBAR_BEHAVIORS,
  CHAT_ENRICHMENT_MODES,
  ATTRIBUTION_SOURCES,
  PROFILE_ROLES,
  AI_CREDITS_ROUTING_MODES,
  CHAT_BILLING_FRAMEWORKS,
  IN_APP_NOTIFICATION_PLACEMENTS,
  OS_NOTIFICATION_CATEGORY_SOUNDS,
  OS_NOTIFICATION_TOP_LEVEL_SOUNDS,
  createEmptyGlobalInstructionsConfig,
  getExecutionHarnessForModel,
  getModelSource,
  HOME_ONBOARDING_PLUGIN_SUGGESTION_PREFIX,
  HOME_ONBOARDING_ADVANCED_SUGGESTION_PREFIX,
  HOME_ONBOARDING_BLUEPRINT_SUGGESTION_PREFIX,
  HOME_ONBOARDING_SUGGESTION_ENTRY_IDS,
  RETIRED_HOME_ONBOARDING_SUGGESTION_ENTRY_IDS,
  isNavigationMode,
  isWorkspaceLayoutMode,
  normalizeAgentModelConfig,
  normalizePersistedThinkingLevel,
  clampThinkingLevelForModel,
  resolveKnownModel,
  resolveModelAlias,
  type AgentModelConfig,
  type AgentProviderType,
  type ApprovalDefaults,
  type BranchDisplayMapping,
  type BranchNamePrefixMode,
  type BrowserDrawerTabId,
  type ChatInterfaceMode,
  type ChatTabPluginSelections,
  type ChatModel,
  type CodeGraphPreferences,
  type FileLabelBucket,
  type FileLabelMatcher,
  type PlanDetectionPreferences,
  type PlanDetectionRule,
  type InAppNotificationPlacement,
  type InAppNotificationPreferences,
  type LastActiveContext,
  type McpHttpAuthHandler,
  type McpHttpAuthPreference,
  type AiCreditsRoutingMode,
  type ChatBillingFramework,
  type McpHttpAuthTarget,
  type ModelDefaultsByProvider,
  type NotificationCategoryMap,
  type OsNotificationCategorySound,
  type OsNotificationPreferences,
  type OsNotificationTopLevelSound,
  type HomeOnboardingSuggestionEntryPreferences,
  type HomeOnboardingSuggestionsPreferences,
  type NativeProviderAccountRecord,
  type PreferencesData,
  type PreferencesFile,
  type PreferencesLoadErrorDetails,
  type PreferencesLoadErrorReason,
  type PreferencesLoadResult,
  type PreferencesProjectionOptions,
  type PrInstructionMode,
  type ProviderModelSelection,
  type TelemetrySharingPreferences,
  type TelemetrySharingVisibility,
  type ThinkingLevel,
  type TerminalPreset,
  type TerminalPresetIcon,
  type TerminalShellProfileId,
  type WindowBounds,
} from '@canopy/desktop-shared/types';
import {
  DEFAULT_BYPASS_CODEX_APP_SERVER_IDLE_TIMEOUT_UNDER_CRITICAL_PRESSURE,
  DEFAULT_MEMORY_DIAGNOSTICS_ENABLED,
  DEFAULT_MEMORY_PRESSURE_CRITICAL_THRESHOLD_BYTES,
  DEFAULT_MEMORY_PRESSURE_GUARD_ENABLED,
  DEFAULT_MEMORY_PRESSURE_WARNING_THRESHOLD_BYTES,
  DEFAULT_MAX_ACTIVE_CHAT_TURNS,
  DEFAULT_MAX_ACTIVE_PIPELINE_EXECUTIONS,
  DEFAULT_SIDEBAR_WIDTH,
  DEFAULT_GITHUB_CHAT_ENRICHMENT_MODE,
  DEFAULT_LINEAR_CHAT_ENRICHMENT_MODE,
  DEFAULT_VOICE_DICTATION_ENABLED,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from '@canopy/desktop-shared/constants/preferences';
import {
  isApprovalMode,
  normalizeApprovalRules,
} from '@canopy/desktop-shared/lib/approval-engine';
import {
  APPROVAL_DEFAULT_SURFACES,
  FAIL_CLOSED_APPROVAL_MODE,
  createDefaultApprovalDefaults,
  createFailClosedApprovalDefaults,
  type ApprovalMode,
} from '@canopy/desktop-shared/types';
import { createDefaultFileIndexingPreferences } from '@canopy/protocol/file-indexing';
import { normalizeFileIndexingPreferences } from '@canopy/core-runtime/node';
import { BUILTIN_PLAN_DETECTION_RULE_IDS } from '@canopy/desktop-shared/plan-detection';
import { normalizeGlobalInstructionsConfig } from '@canopy/desktop-shared/lib/global-instructions';
import { getPreferencesFilePath } from '../lib/paths';
import { getResolvedCanopyDataDir } from '@canopy/desktop-shared/canopy-paths';
import { normalizeStringArray } from './string-utils';

const VALID_PREFIX_MODES = new Set<string>(['github', 'custom', 'none']);

const VALID_PR_INSTRUCTION_MODES = new Set<string>(['replace', 'append']);

const VALID_THEMES = new Set<string>(THEME_NAMES);
const VALID_COLOR_MODES = new Set<string>(COLOR_MODES);
const VALID_SIDEBAR_APPEARANCES = new Set<string>(SIDEBAR_APPEARANCES);
const VALID_WORKTREE_DIFF_STATS_STYLES = new Set<string>(
  WORKTREE_DIFF_STATS_STYLES,
);
const VALID_SCROLLBAR_BEHAVIORS = new Set<string>(SCROLLBAR_BEHAVIORS);
const VALID_CHAT_ENRICHMENT_MODES = new Set<string>(CHAT_ENRICHMENT_MODES);
const VALID_ATTRIBUTION_SOURCES = new Set<string>(ATTRIBUTION_SOURCES);
const VALID_PROFILE_ROLES = new Set<string>(PROFILE_ROLES);

const ONBOARDING_PROFILE_DETAIL_MAX_LENGTH = 256;
const ONBOARDING_PROFILE_INTENT_MAX_LENGTH = 2000;
const VALID_AI_CREDITS_ROUTING_MODES = new Set<string>(
  AI_CREDITS_ROUTING_MODES,
);
const VALID_CHAT_BILLING_FRAMEWORKS = new Set<string>(CHAT_BILLING_FRAMEWORKS);
// Derive from the canonical protocol scope vocabulary plus the Canopy-local
// `off` sentinel so a new scope added to `TELEMETRY_SHARE_SCOPES` is accepted
// automatically rather than being silently coerced to `off`.
const VALID_TELEMETRY_SHARING_VISIBILITIES = new Set<string>([
  'off',
  ...TELEMETRY_SHARE_SCOPES,
]);

/**
 * Coerces a persisted `lastActiveContext` value to a valid `LastActiveContext`
 * or `null`. Malformed shapes (wrong/missing `kind`, missing or non-string
 * ids) normalize to `null` rather than throwing or partially trusting the
 * input.
 */
function normalizeLastActiveContext(value: unknown): LastActiveContext | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    value.kind === 'worktree' &&
    typeof value.workspaceId === 'string' &&
    typeof value.worktreeId === 'string'
  ) {
    return {
      kind: 'worktree',
      workspaceId: value.workspaceId,
      worktreeId: value.worktreeId,
    };
  }
  if (value.kind === 'cowork' && typeof value.workspaceId === 'string') {
    return {
      kind: 'cowork',
      workspaceId: value.workspaceId,
      // Optional Work Entry id (cowork entries occupy the worktreeId slot).
      // Round-trip it when present; older contexts simply omit it.
      ...(typeof value.workEntryId === 'string'
        ? { workEntryId: value.workEntryId }
        : {}),
    };
  }
  return null;
}

function isBrowserDrawerTabId(value: unknown): value is BrowserDrawerTabId {
  return value === DEFAULT_TERMINAL_DRAWER_ACTIVE_TAB_ID || value === 'browser';
}

function isBranchNamePrefixMode(value: unknown): value is BranchNamePrefixMode {
  return typeof value === 'string' && VALID_PREFIX_MODES.has(value);
}

function isPrInstructionMode(value: unknown): value is PrInstructionMode {
  return typeof value === 'string' && VALID_PR_INSTRUCTION_MODES.has(value);
}

function isThemeName(value: unknown): value is PreferencesData['theme'] {
  return typeof value === 'string' && VALID_THEMES.has(value);
}

function isColorMode(value: unknown): value is PreferencesData['colorMode'] {
  return typeof value === 'string' && VALID_COLOR_MODES.has(value);
}

function isSidebarAppearance(
  value: unknown,
): value is NonNullable<PreferencesData['sidebarAppearance']> {
  return typeof value === 'string' && VALID_SIDEBAR_APPEARANCES.has(value);
}

function isWorktreeDiffStatsStyle(
  value: unknown,
): value is NonNullable<PreferencesData['worktreeDiffStatsStyle']> {
  return (
    typeof value === 'string' && VALID_WORKTREE_DIFF_STATS_STYLES.has(value)
  );
}

function isScrollbarBehavior(
  value: unknown,
): value is NonNullable<PreferencesData['scrollbarBehavior']> {
  return typeof value === 'string' && VALID_SCROLLBAR_BEHAVIORS.has(value);
}

function isChatEnrichmentMode(
  value: unknown,
): value is NonNullable<PreferencesData['linearChatEnrichmentMode']> {
  return typeof value === 'string' && VALID_CHAT_ENRICHMENT_MODES.has(value);
}

function isAttributionSourceId(
  value: unknown,
): value is NonNullable<PreferencesData['attributionSource']> {
  return typeof value === 'string' && VALID_ATTRIBUTION_SOURCES.has(value);
}

function isProfileRoleId(
  value: unknown,
): value is NonNullable<PreferencesData['profileRole']> {
  return typeof value === 'string' && VALID_PROFILE_ROLES.has(value);
}

function normalizeOptionalFreeText(
  value: unknown,
  maxLength: number,
): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed.slice(0, maxLength);
}

/**
 * Onboarding profile answers (CAN-1009). All five fields are intentionally
 * absent until the user answers — skipping a step must stay distinguishable
 * from any concrete answer, so none of them get defaults.
 */
function buildOnboardingProfileFields(
  data: Partial<PreferencesData> | undefined,
): Partial<PreferencesData> {
  const attributionSourceDetail = normalizeOptionalFreeText(
    data?.attributionSourceDetail,
    ONBOARDING_PROFILE_DETAIL_MAX_LENGTH,
  );
  const profileRoleDetail = normalizeOptionalFreeText(
    data?.profileRoleDetail,
    ONBOARDING_PROFILE_DETAIL_MAX_LENGTH,
  );
  const profileIntent = normalizeOptionalFreeText(
    data?.profileIntent,
    ONBOARDING_PROFILE_INTENT_MAX_LENGTH,
  );
  const hasExplicitRoleList = Array.isArray(data?.profileRoles);
  const rawRoles = hasExplicitRoleList
    ? data.profileRoles?.filter(isProfileRoleId)
    : isProfileRoleId(data?.profileRole)
      ? [data.profileRole]
      : [];
  const profileRoles = expandLegacyProfileRoles(rawRoles ?? []);
  // An explicit empty list means the user cleared their answer. It must stay
  // authoritative over a stale legacy primary role across reloads.
  const rolesWereCleared =
    hasExplicitRoleList && data.profileRoles?.length === 0;
  const requestedPrimary = isProfileRoleId(data?.profileRole)
    ? expandLegacyProfileRoles([data.profileRole])[0]
    : undefined;
  const profileRole = rolesWereCleared
    ? undefined
    : requestedPrimary !== undefined && profileRoles.includes(requestedPrimary)
      ? requestedPrimary
      : profileRoles[0];
  return {
    ...(isAttributionSourceId(data?.attributionSource)
      ? { attributionSource: data.attributionSource }
      : {}),
    ...(data?.attributionSource === 'other' &&
    attributionSourceDetail !== undefined
      ? { attributionSourceDetail }
      : {}),
    ...(profileRole !== undefined ? { profileRole } : {}),
    ...(rolesWereCleared
      ? { profileRoles: [] }
      : profileRoles.length > 0
        ? { profileRoles }
        : {}),
    ...(profileRole !== undefined && profileRoleDetail !== undefined
      ? { profileRoleDetail }
      : {}),
    ...(profileIntent !== undefined ? { profileIntent } : {}),
  };
}

function isAiCreditsRoutingMode(value: unknown): value is AiCreditsRoutingMode {
  return typeof value === 'string' && VALID_AI_CREDITS_ROUTING_MODES.has(value);
}

function isChatBillingFramework(value: unknown): value is ChatBillingFramework {
  return typeof value === 'string' && VALID_CHAT_BILLING_FRAMEWORKS.has(value);
}

function isTelemetrySharingVisibility(
  value: unknown,
): value is TelemetrySharingVisibility {
  return (
    typeof value === 'string' && VALID_TELEMETRY_SHARING_VISIBILITIES.has(value)
  );
}

function normalizeTelemetrySharingVisibility(
  value: unknown,
): TelemetrySharingVisibility {
  return isTelemetrySharingVisibility(value) ? value : 'off';
}

function normalizeTelemetrySharing(
  value: unknown,
): TelemetrySharingPreferences {
  if (!isRecord(value)) {
    return {
      transcripts: 'off',
      plans: 'off',
      metadata: 'off',
      summaries: 'off',
    };
  }
  const metadata = normalizeTelemetrySharingVisibility(value.metadata);
  return {
    transcripts: normalizeTelemetrySharingVisibility(value.transcripts),
    plans: normalizeTelemetrySharingVisibility(value.plans),
    metadata,
    // MIGRATION (summaries split): AI-generated worktree summaries used to ride
    // on `metadata`, so a preferences file written before the split has no
    // `summaries` key at all. Reading that absence back as `'off'` would
    // silently stop summaries for every existing user, so an ABSENT key
    // inherits the stored `metadata` value. A key that is present but
    // unrecognized still coerces to `'off'` like every other visibility.
    summaries:
      value.summaries === undefined
        ? metadata
        : normalizeTelemetrySharingVisibility(value.summaries),
  };
}

function normalizeString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function isChatInterfaceMode(value: unknown): value is ChatInterfaceMode {
  return value === 'canopy' || value === 'claude-code' || value === 'auto';
}

function isBackgroundProcessMode(
  value: unknown,
): value is PreferencesData['canopyBackgroundProcessesMode'] {
  return value === 'canopy' || value === 'terminal';
}

function createDefaultModelDefaultsByProvider(): ModelDefaultsByProvider {
  return {
    claude: { model: DEFAULT_CLAUDE_MODEL, thinkingLevel: 'high' },
    codex: { model: DEFAULT_CODEX_MODEL, thinkingLevel: 'high' },
    ollama: null,
    aiCredits: null,
  };
}

function createEmptyPluginSelections(): ChatTabPluginSelections {
  return {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [],
    mcpServerRefs: [],
  };
}

function normalizeFileLabelMatcher(value: unknown): FileLabelMatcher | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  const pattern = typeof value.pattern === 'string' ? value.pattern.trim() : '';
  if (!id || !pattern) {
    return null;
  }
  return {
    id,
    pattern,
    enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
    stopMatching:
      typeof value.stopMatching === 'boolean' ? value.stopMatching : false,
    builtin: typeof value.builtin === 'boolean' ? value.builtin : false,
  };
}

/**
 * Shape validation only. The renderer merges the persisted array with the
 * seeded built-in buckets (`mergeFileLabelsWithBuiltins`) on read, so this
 * pass just drops malformed entries and dedupes ids; an empty array means
 * "seeded defaults, untouched".
 */
function normalizeFileLabels(value: unknown): FileLabelBucket[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seenIds = new Set<string>();
  const buckets: FileLabelBucket[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (!id || !name || seenIds.has(id)) continue;
    seenIds.add(id);
    const rawMatchers = Array.isArray(entry.matchers) ? entry.matchers : [];
    const seenMatcherIds = new Set<string>();
    const matchers: FileLabelMatcher[] = [];
    for (const rawMatcher of rawMatchers) {
      const matcher = normalizeFileLabelMatcher(rawMatcher);
      if (matcher && !seenMatcherIds.has(matcher.id)) {
        seenMatcherIds.add(matcher.id);
        matchers.push(matcher);
      }
    }
    buckets.push({
      id,
      name,
      enabled: typeof entry.enabled === 'boolean' ? entry.enabled : true,
      stopFurtherLabels:
        typeof entry.stopFurtherLabels === 'boolean'
          ? entry.stopFurtherLabels
          : false,
      builtin: typeof entry.builtin === 'boolean' ? entry.builtin : false,
      matchers,
    });
  }
  return buckets;
}

function normalizePlanDetectionPreferences(
  value: unknown,
): PlanDetectionPreferences {
  if (!isRecord(value)) {
    return { disabledBuiltinRuleIds: [], customRules: [] };
  }
  const rawDisabled = Array.isArray(value.disabledBuiltinRuleIds)
    ? value.disabledBuiltinRuleIds
    : [];
  const seenDisabled = new Set<string>();
  const disabledBuiltinRuleIds: string[] = [];
  for (const entry of rawDisabled) {
    if (
      typeof entry === 'string' &&
      BUILTIN_PLAN_DETECTION_RULE_IDS.has(entry) &&
      !seenDisabled.has(entry)
    ) {
      seenDisabled.add(entry);
      disabledBuiltinRuleIds.push(entry);
    }
  }
  const rawCustom = Array.isArray(value.customRules) ? value.customRules : [];
  const seenIds = new Set<string>();
  const customRules: PlanDetectionRule[] = [];
  for (const entry of rawCustom) {
    const normalized = normalizePlanDetectionRule(entry);
    if (normalized && !seenIds.has(normalized.id)) {
      seenIds.add(normalized.id);
      customRules.push(normalized);
    }
  }
  return { disabledBuiltinRuleIds, customRules };
}

/**
 * Windows close-to-tray defaults ON, matching Slack/Discord/Teams. Defaulting
 * it off would leave Windows with a settings toggle nobody discovers and no
 * background presence at all — the same failure mode as OS notifications
 * being off by default. The one-time tray disclosure plus the Settings toggle
 * keep it discoverable and reversible.
 */
import { DEFAULT_ACTIVATION_QUIET_HOURS } from '../notifications/campaigns/quiet-hours';
import {
  DEFAULT_PROMOTIONAL_NOTIFICATIONS,
  normalizePromotionalNotifications,
} from '@canopy/desktop-shared/lib/promotional-notifications';
import type { ActivationQuietHours } from '@canopy/desktop-shared/types';
import { DEFAULT_GLOBAL_FOCUS_SHORTCUT_ENABLED } from '@canopy/desktop-shared/constants/preferences';
import {
  GLOBAL_FOCUS_SHORTCUT_DEFAULT_ACCELERATOR,
  toShortcutPlatform,
  validateGlobalShortcut,
} from '@canopy/desktop-shared/lib/global-shortcut-accelerator';
import {
  clampUiScale,
  UI_SCALE_DEFAULT,
} from '@canopy/desktop-shared/lib/ui-scale';

const DEFAULT_CLOSE_TO_TRAY = true;

/**
 * A saved OS focus shortcut (CAN-1963) is only kept when it would pass the
 * same validation the Settings recorder applies. Electron silently registers
 * unknown tokens as bare keys, so a corrupt value must never reach it as a
 * typing-stealing global hotkey; the default chord is the safe fallback.
 */
function normalizeGlobalFocusShortcut(value: unknown): string {
  if (typeof value !== 'string') {
    return GLOBAL_FOCUS_SHORTCUT_DEFAULT_ACCELERATOR;
  }
  const validation = validateGlobalShortcut(
    value,
    toShortcutPlatform(process.platform),
  );
  return validation.ok
    ? validation.accelerator
    : GLOBAL_FOCUS_SHORTCUT_DEFAULT_ACCELERATOR;
}

function normalizeHour(value: unknown, fallback: number): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 23
    ? value
    : fallback;
}

function normalizeActivationQuietHours(value: unknown): ActivationQuietHours {
  const fallback = DEFAULT_ACTIVATION_QUIET_HOURS;
  if (typeof value !== 'object' || value === null) return { ...fallback };
  const raw: Record<string, unknown> = { ...value };
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : fallback.enabled,
    startHour: normalizeHour(raw.startHour, fallback.startHour),
    endHour: normalizeHour(raw.endHour, fallback.endHour),
  };
}

export const DEFAULT_PREFERENCES: PreferencesData = {
  orgProjectDefaultDestinationRoot: undefined,
  orgProjectCloneProtocol: 'https',
  workspaceDefaultLayoutMode: 'advanced',
  navigationMode: 'code',
  worktreePanelPercent: 32,
  activityPanelExpanded: false,
  activityPanelWidthPercent: 25,
  kanbanWorktreePanelPercent: 32,
  kanbanActivityPanelExpanded: false,
  kanbanActivityPanelWidthPercent: 25,
  kanbanChatPanelVisible: false,
  pipelineChatPanelVisible: true,
  pipelineChatPanelWidthPercent: 30,
  sidebarCollapsed: false,
  sidebarProjectSortMode: 'manual',
  sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
  sidebarCodeSectionCollapsed: false,
  sidebarCoworkSectionCollapsed: false,
  sidebarNavLayout: createDefaultSidebarNavLayout(),
  branchNamePrefixMode: 'github',
  branchNameCustomPrefix: '',
  deleteBranchOnArchive: true,
  archiveOnMerge: true,
  groupChildBranchesWithBase: true,
  defaultChatProvider: 'claude',
  defaultChatModelByProvider: createDefaultModelDefaultsByProvider(),
  defaultWorktreeProvider: 'claude',
  defaultWorktreeModelByProvider: createDefaultModelDefaultsByProvider(),
  approvalDefaults: createDefaultApprovalDefaults(),
  globalApprovalRules: [],
  // Full Access is the product default, so a fresh profile is exactly the
  // population that has never been told agents act without asking. Default the
  // notice to NOT dismissed so a new install sees the one-time explainer once
  // and can opt down from it; dismissing persists `true`. The approval-defaults
  // migration separately re-arms it for an upgrading profile whose persisted
  // posture it overwrites (CAN-3055).
  approvalsUpgradeNoticeDismissed: false,
  summaryModel: DEFAULT_SUMMARY_MODEL,
  summaryModelSetByUser: false,
  summaryThinkingLevel: 'off' as ThinkingLevel,
  handoffSummaryModel: DEFAULT_HANDOFF_SUMMARY_MODEL,
  handoffSummaryThinkingLevel: 'off',
  worktreeSummaryEnabled: true,
  worktreeSummaryModel: 'haiku',
  worktreeSummaryThinkingLevel: 'off' as ThinkingLevel,
  planDiagramModel: 'haiku',
  planDiagramThinkingLevel: 'off' as ThinkingLevel,
  codeReviewModel: 'haiku',
  codeReviewThinkingLevel: 'off' as ThinkingLevel,
  prGenerationModel: DEFAULT_PR_GENERATION_MODEL,
  prGenerationThinkingLevel: 'high' as ThinkingLevel,
  prInstructions: '',
  prInstructionMode: 'append',
  commitGenerationModel: DEFAULT_COMMIT_GENERATION_MODEL,
  commitGenerationThinkingLevel: 'high' as ThinkingLevel,
  commitInstructions: '',
  commitInstructionMode: 'append' as PrInstructionMode,
  branchNamingModel: DEFAULT_BRANCH_NAMING_MODEL,
  branchNamingThinkingLevel: 'off' as ThinkingLevel,
  branchNamingInstructions: '',
  globalInstructions: createEmptyGlobalInstructionsConfig(),
  pipelineAdvisorEnabled: true,
  orgMemoryInjectionEnabled: true,
  // Local memory is enabled by default (CAN-2657); an explicit opt-out is
  // persisted normally and keeps provider-native memory on harness defaults.
  localMemoryEnabled: true,
  localMemoryEnabledSetByUser: false,
  localMemoryModel: DEFAULT_LOCAL_MEMORY_MODEL,
  localMemoryModelSetByUser: false,
  localMemoryThinkingLevel: 'high',
  pipelineAdvisorModel: DEFAULT_PIPELINE_ADVISOR_MODEL,
  pipelineAdvisorThinkingLevel: 'high' as ThinkingLevel,
  disabledPipelineIds: [],
  appAdvisorModel: DEFAULT_APP_ADVISOR_MODEL,
  appAdvisorThinkingLevel: 'high' as ThinkingLevel,
  cronGenerationModel: DEFAULT_CRON_GENERATION_MODEL,
  cronGenerationThinkingLevel: 'medium' as ThinkingLevel,
  ifCommandGenerationModel: DEFAULT_IF_COMMAND_GENERATION_MODEL,
  ifCommandGenerationThinkingLevel: 'medium' as ThinkingLevel,
  splitPrThresholdLines: 500,
  splitPrEnabled: true,
  splitPrPlannerModel: DEFAULT_CODEX_MODEL,
  splitPrPlannerThinkingLevel: 'high' as ThinkingLevel,
  disabledInstalledItems: [],
  parkedCodexPlugins: [],
  pendingInstalledItemUninstalls: [],
  globalPluginSelections: createEmptyPluginSelections(),
  initializedCuratedPluginDefaults: [],
  appAdvisorPluginSelections: createEmptyPluginSelections(),
  pipelineEditorPluginSelections: createEmptyPluginSelections(),
  appAdvisorDialogBounds: null,
  codexMultiAgentAppAdvisorEnabled: true,
  providerModelConfigDefaults: {
    codex: { fastMode: false },
  },
  codexFastModeDefaultEnabled: false,
  branchNamingPluginSelections: createEmptyPluginSelections(),
  commitGenerationPluginSelections: createEmptyPluginSelections(),
  prGenerationPluginSelections: createEmptyPluginSelections(),
  worktreeSummaryPluginSelections: createEmptyPluginSelections(),
  codexCompatDisabledPlugins: [],
  branchDisplayMappings: [],
  reviewCommitMessage: false,
  agentRebaseResolutionEnabled: false,
  agentRebaseResolutionModel: null,
  agentRebaseResolutionThinkingLevel: null,
  mergeQueueAgentHandling: DEFAULT_MERGE_QUEUE_AGENT_HANDLING,
  rtkEnabled: true,
  autoRetryTransientErrorsChats: true,
  autoRetryTransientErrorsPipelines: true,
  scriptTimeoutMinutes: 5,
  codexAppServerIdleTimeoutMinutes:
    DEFAULT_CODEX_APP_SERVER_IDLE_TIMEOUT_MINUTES,
  defaultChatInterfaceMode: 'canopy',
  defaultStandaloneChatInterfaceMode: 'canopy',
  defaultAppAdvisorInterfaceMode: 'canopy',
  preventClaudeNativeCaffeinate: true,
  claudeMaxTurns: DEFAULT_CLAUDE_MAX_TURNS,
  maxActiveChatTurns: DEFAULT_MAX_ACTIVE_CHAT_TURNS,
  maxActivePipelineExecutions: DEFAULT_MAX_ACTIVE_PIPELINE_EXECUTIONS,
  canopyBackgroundProcessesMode: 'canopy',
  pipelinesMode: 'canopy',
  workerConcurrencyLimit: 5,
  memoryPressureGuardEnabled: DEFAULT_MEMORY_PRESSURE_GUARD_ENABLED,
  bypassCodexAppServerIdleTimeoutUnderCriticalPressure:
    DEFAULT_BYPASS_CODEX_APP_SERVER_IDLE_TIMEOUT_UNDER_CRITICAL_PRESSURE,
  memoryPressureWarningThresholdBytes:
    DEFAULT_MEMORY_PRESSURE_WARNING_THRESHOLD_BYTES,
  memoryPressureCriticalThresholdBytes:
    DEFAULT_MEMORY_PRESSURE_CRITICAL_THRESHOLD_BYTES,
  memoryDiagnosticsEnabled: DEFAULT_MEMORY_DIAGNOSTICS_ENABLED,
  keepSystemAwakeWhileAgentsActive: true,
  managedDelegationMaxConcurrent: 5,
  managedDelegationMaxDepth: 1,
  codexMultiAgentWorktreeChatsEnabled: false,
  codexMultiAgentStandaloneChatsEnabled: false,
  codexMaxConcurrentSubagents: null,
  codexMultiAgentPipelinesEnabled: false,
  deferredToolsWorktreeChatsEnabled: true,
  deferredToolsStandaloneChatsEnabled: true,
  deferredToolsAppAdvisorEnabled: true,
  deferredToolsPipelineAssistantEnabled: true,
  lastOpenApp: '',
  disabledOpenApps: [],
  lastSelectedWorktreeProjectId: '',
  lastSelectedWorktreeId: '',
  lastActiveContext: null,
  executionDetailViewMode: 'list',
  worktreeViewMode: 'list',
  worktreeFilterHiddenWorkspaceIds: [],
  auditRetentionDays: 7,
  automationRunRetentionDays: 90,
  aiCreditsRoutingMode: 'off',
  theme: 'default',
  colorMode: 'system',
  sidebarAppearance: 'translucent',
  worktreeDiffStatsStyle: 'short',
  scrollbarBehavior: 'system',
  linearChatEnrichmentMode: DEFAULT_LINEAR_CHAT_ENRICHMENT_MODE,
  githubChatEnrichmentMode: DEFAULT_GITHUB_CHAT_ENRICHMENT_MODE,
  uiScale: UI_SCALE_DEFAULT,
  // "Agents add to the Feed" (LD09) is on by default.
  ledgerAgentRecordingEnabled: true,
  // "Suggest automations for repeated tasks" (CAN-4009) is on by default.
  repeatTaskAutomationSuggestionsEnabled: true,
  // "Suggest skills for repeated requests" (CAN-385) is on by default.
  skillSuggestionsEnabled: true,
  rendererCodeCacheSchemeEnabled: false,
  chatLiveStepWindowEnabled: false,
  chatGroupToolCallsEnabled: false,
  remoteControlEnabled: true,
  windowBounds: null,
  windowMaximized: false,
  windowFullScreen: false,
  ollamaServerPort: DEFAULT_OLLAMA_SERVER_PORT,
  // Transport contract: the shared `PreferencesData.ollamaConnectionMode` /
  // `ollamaExecutablePath` fields default to `managed` / '' (not yet resolved).
  // Final default placement and the load-time normalization/migration remain
  // owned by the backend plan.
  ollamaConnectionMode: 'managed',
  ollamaExecutablePath: '',
  mcpProxyPort: DEFAULT_MCP_PROXY_PORT,
  hideAnthropicNav: DEFAULT_HIDE_ANTHROPIC_NAV,
  fileAutoSave: false,
  inAppBrowserLocalServersOnly: false,
  openAppLinksInBuiltInBrowser: true,
  useAsSystemDefaultBrowser: false,
  inAppNotifications: {
    enabled: true,
    categories: {
      chat: true,
      script: true,
      hook: true,
      gitCommit: true,
      gitPush: true,
      prCreate: true,
      pipeline: true,
      terminal: true,
      runComment: true,
      activation: true,
    },
  },
  terminalDrawerCollapsed: DEFAULT_TERMINAL_DRAWER_COLLAPSED,
  terminalDrawerHeight: DEFAULT_TERMINAL_DRAWER_HEIGHT,
  terminalDrawerActiveTabId: DEFAULT_TERMINAL_DRAWER_ACTIVE_TAB_ID,
  disabledTerminalShellProfileIds: [],
  terminalPresets: [],
  osNotifications: {
    enabled: false,
    skipWhenFocused: true,
    defaultSound: 'System',
    categories: {
      chat: true,
      script: true,
      hook: true,
      gitCommit: true,
      gitPush: true,
      prCreate: true,
      pipeline: true,
      terminal: true,
      runComment: true,
      activation: true,
    },
    categorySounds: {
      chat: 'Default',
      script: 'Default',
      hook: 'Default',
      gitCommit: 'Default',
      gitPush: 'Default',
      prCreate: 'Default',
      pipeline: 'Default',
      terminal: 'Default',
      runComment: 'Default',
      activation: 'Default',
    },
  },
  voiceDictationEnabled: DEFAULT_VOICE_DICTATION_ENABLED,
  closeToTray: DEFAULT_CLOSE_TO_TRAY,
  globalFocusShortcutEnabled: DEFAULT_GLOBAL_FOCUS_SHORTCUT_ENABLED,
  globalFocusShortcut: GLOBAL_FOCUS_SHORTCUT_DEFAULT_ACCELERATOR,
  activationQuietHours: DEFAULT_ACTIVATION_QUIET_HOURS,
  promotionalNotifications: DEFAULT_PROMOTIONAL_NOTIFICATIONS,
  mcpHttpAuthDefaultHandler: DEFAULT_MCP_HTTP_AUTH_HANDLER,
  fileIndexing: createDefaultFileIndexingPreferences(),
  planDetection: { disabledBuiltinRuleIds: [], customRules: [] },
  fileLabels: [],
  changedFilesHiddenLabelIds: [],
  autoDownloadUpdates: true,
  showDiagnosticsPill: true,
  onboardingCompleted: [],
  releaseHighlightsLastSeenVersion: null,
  guestSessionCount: 0,
  guestUpgradeNudgeLastShownSessionCount: 0,
  telemetrySharing: {
    transcripts: 'off',
    plans: 'off',
    metadata: 'off',
    summaries: 'off',
  },
  personalWorkspaceCatalogSync: 'off',
  personalCatalogOfferSeen: false,
  personalCatalogNotice: null,
  telemetrySharingPromptSeen: false,
  // Transport contract: the shared `PreferencesData.gitExecutablePath` field
  // defaults to '' (not yet resolved). Final default placement and the
  // load-time normalization remain owned by the backend plan.
  gitExecutablePath: '',
  appAdvisorProjectAgentAccess:
    normalizeAppAdvisorProjectAgentAccess(undefined),
  codeGraph: {
    mode: 'enabled',
    selectedWorkspaceIds: [],
    generationTimeoutMinutes: 30,
  },
};

const EMPTY_PREFERENCES_FILE: PreferencesFile = {
  version: 1,
  preferences: DEFAULT_PREFERENCES,
};

interface LastGoodPreferences {
  path: string;
  preferences: PreferencesData;
}

type PreferencesUpdater = (
  latest: PreferencesData,
) => Partial<PreferencesData> | null | Promise<Partial<PreferencesData> | null>;
type PreferencesCommitObserver = (committed: PreferencesData) => void;

let writePreferencesQueue: Promise<void> = Promise.resolve();
// Setup rollback owns a committed enablement value, not a runtime generation.
// Track only durable changes to this field so unrelated preference saves do
// not prevent rollback and a newer disable/re-enable cannot be overwritten.
let openCodeEnabledRevision = 0;
export function getOpenCodeEnabledRevision(): number {
  return openCodeEnabledRevision;
}

let lastPreferencesLoadError: PreferencesLoadErrorDetails | null = null;
let preferencesRecoveryOperation: Promise<PreferencesData> | null = null;
let preferencesRendererLoadOperation: Promise<PreferencesLoadResult> | null =
  null;
let rendererPreferencesCache: PreferencesData | null = null;
// A failed enabled-profile migration must retry the same candidate rather
// than choosing a fresh answer date on each renderer load or ordinary save.
const osNotificationOfferMigrationTimestamps = new Map<string, string>();
let rendererRuntimeProjection: {
  source: PreferencesData;
  result: PreferencesData;
} | null = null;
let atomicWriteCounter = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const TERMINAL_SHELL_PROFILE_IDS = new Set<string>([
  'default',
  'zsh',
  'bash',
  'cmd',
  'powershell',
  'git-bash',
]);

function isTerminalShellProfileId(
  value: unknown,
): value is TerminalShellProfileId {
  return typeof value === 'string' && TERMINAL_SHELL_PROFILE_IDS.has(value);
}

function normalizeTerminalPresetImageDataUrl(
  value: unknown,
): string | undefined {
  return isTerminalPresetImageDataUrl(value) ? value : undefined;
}

function normalizeTerminalPresetIcon(
  value: unknown,
): TerminalPresetIcon | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.kind === 'character' &&
    typeof value.value === 'string' &&
    value.value.length > 0
  ) {
    return { kind: 'character', value: value.value.slice(0, 16) };
  }
  if (value.kind !== 'image') return undefined;

  // `dataUrl` is the pre-themed persisted shape. Treat it as the light asset;
  // the renderer's fallback rule still uses it in dark mode until the user
  // optionally configures a dedicated dark image.
  const lightDataUrl =
    normalizeTerminalPresetImageDataUrl(value.lightDataUrl) ??
    normalizeTerminalPresetImageDataUrl(value.dataUrl);
  const darkDataUrl = normalizeTerminalPresetImageDataUrl(value.darkDataUrl);
  if (!lightDataUrl && !darkDataUrl) return undefined;
  return {
    kind: 'image',
    ...(lightDataUrl ? { lightDataUrl } : {}),
    ...(darkDataUrl ? { darkDataUrl } : {}),
  };
}

function normalizeTerminalPresets(value: unknown): TerminalPreset[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const presets: TerminalPreset[] = [];
  for (const candidate of value.slice(0, 50)) {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== 'string' ||
      candidate.id.length < 1 ||
      candidate.id.length > 128 ||
      seen.has(candidate.id) ||
      typeof candidate.name !== 'string' ||
      candidate.name.trim().length < 1 ||
      typeof candidate.command !== 'string' ||
      candidate.command.trim().length < 1 ||
      !isTerminalShellProfileId(candidate.terminalProfileId)
    ) {
      continue;
    }
    const icon = normalizeTerminalPresetIcon(candidate.icon);
    seen.add(candidate.id);
    presets.push({
      id: candidate.id,
      name: candidate.name.trim().slice(0, 64),
      terminalProfileId: candidate.terminalProfileId,
      command: candidate.command.trim().slice(0, 4_000),
      enabled: candidate.enabled !== false,
      ...(icon ? { icon } : {}),
    });
  }
  return presets;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getErrorCode(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === 'string' ? code : undefined;
}

function isMissingFileError(error: unknown): boolean {
  return (
    getErrorCode(error) === 'ENOENT' || getErrorMessage(error) === 'ENOENT'
  );
}

function normalizeCodexCompatDisabledPlugins(value: unknown): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of normalizeStringArray(value)) {
    const separatorIndex = entry.indexOf('/');
    const normalized =
      separatorIndex === -1
        ? entry
        : `${entry.slice(0, separatorIndex)}/${entry
            .slice(separatorIndex + 1)
            .toLowerCase()}`;
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function createPreferencesBackupPath(
  filePath: string,
  timestamp: string,
): string {
  const safeTimestamp = timestamp.replace(/[:.]/g, '-');
  return join(dirname(filePath), `preferences.backup-${safeTimestamp}.json`);
}

function createPreferencesLastGoodPath(filePath: string): string {
  return join(dirname(filePath), 'preferences.last-good.json');
}

function createPreferencesRecoveryError(
  filePath: string,
  reason: PreferencesLoadErrorReason,
  message: string,
  actualVersion?: unknown,
  code?: string,
): PreferencesLoadErrorDetails {
  const timestamp = new Date().toISOString();
  const backupPath = createPreferencesBackupPath(filePath, timestamp);
  return {
    timestamp,
    reason,
    message,
    filePath,
    backupPath,
    code,
    expectedVersion: 1,
    actualVersion,
  };
}

function createPreferencesBackupPayload(
  error: PreferencesLoadErrorDetails,
  rawContent: string | null,
  parsedContent: unknown,
): Record<string, unknown> {
  if (isRecord(parsedContent)) {
    const payload: Record<string, unknown> = {
      ...parsedContent,
      __error: error,
    };

    if (rawContent !== null) {
      payload.rawContent = rawContent;
    }

    return payload;
  }

  if (rawContent !== null) {
    return {
      __error: error,
      rawContent,
    };
  }

  return {
    __error: error,
    originalContentUnavailable: true,
  };
}

function createAtomicWriteTempPath(filePath: string): string {
  atomicWriteCounter =
    atomicWriteCounter >= Number.MAX_SAFE_INTEGER ? 1 : atomicWriteCounter + 1;
  return join(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${Date.now()}-${atomicWriteCounter}.tmp`,
  );
}

async function writeTextFileAtomically(
  filePath: string,
  content: string,
): Promise<void> {
  const tempPath = createAtomicWriteTempPath(filePath);
  const existingMode = await stat(filePath)
    .then((stats) => stats.mode)
    .catch((error: unknown) => {
      if (isMissingFileError(error)) {
        return undefined;
      }
      throw error;
    });
  let shouldCleanupTemp = true;

  try {
    await writeFile(tempPath, content, {
      encoding: 'utf8',
      mode: existingMode,
    });
    await renameWithRetry(tempPath, filePath);
    shouldCleanupTemp = false;
  } finally {
    if (shouldCleanupTemp) {
      await unlink(tempPath).catch(() => undefined);
    }
  }
}

async function writePreferencesDataFile(
  filePath: string,
  preferences: PreferencesData,
): Promise<void> {
  const payload: PreferencesFile = {
    ...EMPTY_PREFERENCES_FILE,
    preferences,
  };
  await writeTextFileAtomically(filePath, JSON.stringify(payload, null, 2));
}

async function writeLastGoodPreferencesFile(
  filePath: string,
  preferences: PreferencesData,
): Promise<void> {
  await writePreferencesDataFile(
    createPreferencesLastGoodPath(filePath),
    preferences,
  );
}

function normalizeParsedPreferencesFile(
  parsed: unknown,
): PreferencesData | null {
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    !isRecord(parsed.preferences)
  ) {
    return null;
  }

  return normalizePreferences(parsed.preferences, 'persisted');
}

async function readLastGoodPreferencesFile(
  filePath: string,
): Promise<LastGoodPreferences | null> {
  const lastGoodPath = createPreferencesLastGoodPath(filePath);

  try {
    const raw = await readFile(lastGoodPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const preferences = normalizeParsedPreferencesFile(parsed);
    if (!preferences) {
      return null;
    }

    return {
      path: lastGoodPath,
      preferences,
    };
  } catch {
    return null;
  }
}

async function recoverPreferencesFile(
  filePath: string,
  error: PreferencesLoadErrorDetails,
  rawContent: string | null,
  parsedContent: unknown,
  knownLastGood?: LastGoodPreferences | null,
): Promise<PreferencesData> {
  if (preferencesRecoveryOperation) {
    return preferencesRecoveryOperation;
  }

  const recoveryOperation = (async (): Promise<PreferencesData> => {
    await mkdir(dirname(filePath), { recursive: true });
    const lastGood =
      knownLastGood === undefined
        ? await readLastGoodPreferencesFile(filePath)
        : knownLastGood;
    const restoredPreferences = lastGood?.preferences ?? DEFAULT_PREFERENCES;
    const recoveryError = lastGood
      ? { ...error, restoredFromPath: lastGood.path }
      : error;
    const backupPayload = createPreferencesBackupPayload(
      recoveryError,
      rawContent,
      parsedContent,
    );
    const backupPath = recoveryError.backupPath;
    if (!backupPath) {
      throw new Error('Preferences recovery backup path is missing.');
    }
    await writeTextFileAtomically(
      backupPath,
      JSON.stringify(backupPayload, null, 2),
    );
    await writePreferencesDataFile(filePath, restoredPreferences);
    await writeLastGoodPreferencesFile(filePath, restoredPreferences);
    lastPreferencesLoadError = recoveryError;
    return restoredPreferences;
  })();

  preferencesRecoveryOperation = recoveryOperation;
  try {
    return await recoveryOperation;
  } finally {
    preferencesRecoveryOperation = null;
  }
}

function normalizeThinkingLevel(
  value: unknown,
  fallback: ThinkingLevel = 'high',
): ThinkingLevel {
  return normalizePersistedThinkingLevel(value, fallback);
}

function normalizeOptionalThinkingLevel(value: unknown): ThinkingLevel | null {
  if (typeof value !== 'string') return null;
  const fallback: ThinkingLevel = 'off';
  const normalized = normalizeThinkingLevel(value, fallback);
  return normalized === fallback && value !== fallback ? null : normalized;
}

type ModelSelectionValidation = 'runtime' | 'persisted';

function normalizeProviderModel(
  value: unknown,
  provider: AgentProviderType,
  validation: ModelSelectionValidation,
): ChatModel | null {
  if (validation === 'persisted') {
    return normalizePersistableModelSelection(value);
  }
  if (typeof value !== 'string') return null;
  const model = resolveKnownModel(value);
  if (!model) return null;
  if (provider === 'ollama') {
    return getModelSource(model) === 'ollama' && __CANOPY_OLLAMA_ENABLED__
      ? model
      : null;
  }
  if (getModelSource(model) === 'ai-gateway') return null;
  return getExecutionHarnessForModel(model) === provider ? model : null;
}

function normalizeAiCreditsModel(
  value: unknown,
  validation: ModelSelectionValidation,
): ChatModel | null {
  if (validation === 'persisted') {
    return normalizePersistableModelSelection(value);
  }
  if (typeof value !== 'string') return null;
  const model = resolveKnownModel(value);
  return model && isGatewayRoutableModel(model) ? model : null;
}

function normalizeProviderSelection(
  value: unknown,
  provider: AgentProviderType,
  fallback: ProviderModelSelection,
  validation: ModelSelectionValidation,
): ProviderModelSelection {
  if (!isRecord(value)) return fallback;
  const model =
    normalizeProviderModel(value.model, provider, validation) ?? fallback.model;
  const thinkingLevel = normalizeThinkingLevel(
    value.thinkingLevel,
    fallback.thinkingLevel,
  );
  return { model, thinkingLevel };
}

function normalizeNullableOllamaSelection(
  value: unknown,
  validation: ModelSelectionValidation,
): ProviderModelSelection | null {
  if (!isRecord(value)) return null;
  const model = normalizeProviderModel(value.model, 'ollama', validation);
  if (!model) return null;
  const thinkingLevel = normalizeThinkingLevel(value.thinkingLevel, 'high');
  return { model, thinkingLevel };
}

function normalizeNullableAiCreditsSelection(
  value: unknown,
  validation: ModelSelectionValidation,
): ProviderModelSelection | null {
  if (!isRecord(value)) return null;
  const model = normalizeAiCreditsModel(value.model, validation);
  if (!model) return null;
  return {
    model,
    thinkingLevel: normalizeThinkingLevel(value.thinkingLevel, 'high'),
  };
}

function normalizeModelDefaultsByProvider(
  value: unknown,
  fallback: ModelDefaultsByProvider,
  validation: ModelSelectionValidation,
): ModelDefaultsByProvider {
  if (!isRecord(value)) {
    return {
      claude: { ...fallback.claude },
      codex: { ...fallback.codex },
      ollama: fallback.ollama ? { ...fallback.ollama } : null,
      aiCredits: fallback.aiCredits ? { ...fallback.aiCredits } : null,
    };
  }
  return {
    claude: normalizeProviderSelection(
      value.claude,
      'claude',
      fallback.claude,
      validation,
    ),
    codex: normalizeProviderSelection(
      value.codex,
      'codex',
      fallback.codex,
      validation,
    ),
    ollama: normalizeNullableOllamaSelection(value.ollama, validation),
    aiCredits: normalizeNullableAiCreditsSelection(value.aiCredits, validation),
  };
}

/**
 * Normalizes one persisted surface key.
 *
 * A key that is simply ABSENT never had a user choice, so it takes the product
 * default. A key that is PRESENT but malformed is corrupt persisted state, and
 * resolving corruption *upward* to Full Access would silently escalate a user
 * who had chosen Ask — so it fails closed instead (CAN-3055). Keeping these two
 * cases distinct is the whole point; do not collapse them back onto `fallback`.
 */
function normalizeApprovalDefaultKey(
  value: Record<string, unknown>,
  key: keyof ApprovalDefaults,
  fallback: ApprovalDefaults,
): ApprovalMode {
  const persisted = value[key];
  if (isApprovalMode(persisted)) {
    return persisted;
  }
  return persisted === undefined ? fallback[key] : FAIL_CLOSED_APPROVAL_MODE;
}

function normalizeApprovalDefaults(
  value: unknown,
  fallback: ApprovalDefaults,
): ApprovalDefaults {
  if (value === undefined) {
    // Never persisted: no user choice was ever made, so take the product
    // default. This is the fresh-install path.
    return { ...fallback };
  }
  if (!isRecord(value)) {
    // Present but not even an object (`null`, a string, an array, a number):
    // corrupt persisted state, exactly like a malformed per-key value. Falling
    // back to the product default here would resolve corruption UPWARD to Full
    // Access and silently escalate a user who had chosen Ask (CAN-3055).
    return createFailClosedApprovalDefaults();
  }
  const normalized = { ...fallback };
  for (const surface of APPROVAL_DEFAULT_SURFACES) {
    normalized[surface] = normalizeApprovalDefaultKey(value, surface, fallback);
  }
  return normalized;
}

function normalizeProviderModelConfigDefaults(
  value: unknown,
  legacyCodexFastModeDefaultEnabled: unknown,
): Partial<Record<AgentProviderType, AgentModelConfig>> {
  const result: Partial<Record<AgentProviderType, AgentModelConfig>> = {};
  const source = isRecord(value) ? value : {};
  const providers: AgentProviderType[] = ['claude', 'codex', 'ollama'];

  for (const provider of providers) {
    const normalized = normalizeAgentModelConfig(source[provider]);
    if (normalized) {
      result[provider] = normalized;
    }
  }

  const codexHasExplicitFastMode = typeof result.codex?.fastMode === 'boolean';
  if (
    !codexHasExplicitFastMode &&
    typeof legacyCodexFastModeDefaultEnabled === 'boolean'
  ) {
    result.codex = {
      ...(result.codex ?? {}),
      fastMode: legacyCodexFastModeDefaultEnabled,
    };
  } else if (!codexHasExplicitFastMode) {
    result.codex = {
      ...(result.codex ?? {}),
      fastMode:
        DEFAULT_PREFERENCES.providerModelConfigDefaults.codex?.fastMode ??
        false,
    };
  }

  return result;
}

function normalizeDefaultProvider(
  value: unknown,
  byProvider: ModelDefaultsByProvider,
  fallback: AgentProviderType,
): AgentProviderType {
  const candidate =
    value === 'claude' || value === 'codex' || value === 'ollama'
      ? value
      : fallback;
  if (candidate === 'ollama' && byProvider.ollama === null) {
    return 'claude';
  }
  return candidate;
}

function isLaneScopeRecord(
  value: unknown,
): value is { chat?: unknown; worktree?: unknown } {
  // Arrays must NOT qualify. `typeof [] === 'object'`, so a corrupt
  // `lastResolvedDefaultLaneByScope: []` used to pass here and — now that an
  // empty-but-present map means "deliberate full erasure" — would be persisted
  // as one instead of falling through to the legacy-scalar migration, silently
  // discarding lane stickiness the file still carried.
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Normalize the per-scope resolved-lane map, seeding each scope from the legacy
 * scope-agnostic `lastResolvedDefaultLane` so an existing preferences file
 * keeps its lane stickiness across the upgrade.
 *
 * The seed is a MIGRATION, so it only applies when the per-scope map is absent
 * (or unusable) entirely. Once the map exists, an absent slot is a deliberate
 * erasure — `default-model-lane-resolver.ts` drops a scope whose lane it
 * CONFIRMED unavailable, from every scope at once, while the scalar can survive
 * holding a different lane. Re-seeding from that scalar silently undid half the
 * erase on the very next normalize, resurrecting a lane the user no longer has.
 */
function normalizeLastResolvedLaneByScope(
  raw: unknown,
  legacy: unknown,
): Pick<PreferencesData, 'lastResolvedDefaultLaneByScope'> {
  const hasScopeRecord = isLaneScopeRecord(raw);
  const scopes: { chat?: unknown; worktree?: unknown } = hasScopeRecord
    ? raw
    : {};
  const readScope = (key: 'chat' | 'worktree'): BillingLane | undefined => {
    const value = scopes[key];
    if (isBillingLane(value)) return value;
    // An ABSENT slot in a map that EXISTS is a deliberate erasure, not a gap to
    // migrate. A CORRUPT slot still falls through to the legacy seed below —
    // the resolver never writes one, so that can only come from a damaged file.
    if (hasScopeRecord && value === undefined) return undefined;
    return isBillingLane(legacy) ? legacy : undefined;
  };
  const chat = readScope('chat');
  const worktree = readScope('worktree');
  if (!chat && !worktree) {
    // A FULLY erased map must survive as an empty-but-present marker.
    // Normalization runs on the WRITE path too, so returning `{}` here dropped
    // the key before it ever reached disk — making a deliberate erasure
    // indistinguishable from "this file predates the map". The next read then
    // took the migration branch above and re-seeded BOTH scopes from the
    // surviving scalar, resurrecting the lane that was just erased.
    //
    // The scalar is usually cleared in the same atomic write
    // (`flushResolvedLanePersistence`), which hid this for the common case —
    // but not when the scalar holds a DIFFERENT lane than the one erased.
    return hasScopeRecord ? { lastResolvedDefaultLaneByScope: {} } : {};
  }
  return {
    lastResolvedDefaultLaneByScope: {
      ...(chat ? { chat } : {}),
      ...(worktree ? { worktree } : {}),
    },
  };
}

function normalizeWindowBounds(value: unknown): WindowBounds | null {
  if (value === null || value === undefined || typeof value !== 'object') {
    return null;
  }
  const obj = value as Record<string, unknown>;
  const x = obj.x;
  const y = obj.y;
  const width = obj.width;
  const height = obj.height;
  if (
    typeof x !== 'number' ||
    !Number.isFinite(x) ||
    typeof y !== 'number' ||
    !Number.isFinite(y) ||
    typeof width !== 'number' ||
    !Number.isFinite(width) ||
    typeof height !== 'number' ||
    !Number.isFinite(height)
  ) {
    return null;
  }
  if (width < 800 || height < 500) {
    return null;
  }
  return { x, y, width, height };
}

/**
 * Validate the persisted App Advisor window bounds. The preference key
 * `appAdvisorDialogBounds` is legacy-named — it was retained from the
 * earlier floating-dialog implementation to avoid a preference migration —
 * but the persisted value is now the standalone App Advisor
 * `BrowserWindow` bounds. The size floor matches the App Advisor
 * window's minimum usable dimensions; invalid values return `null` so
 * the window can fall back to its built-in default size.
 */
function normalizeAppAdvisorDialogBounds(
  value: unknown,
): PreferencesData['appAdvisorDialogBounds'] {
  if (value === null || value === undefined || typeof value !== 'object') {
    return null;
  }
  const obj = value as Record<string, unknown>;
  const { x, y, width, height } = obj;
  if (
    typeof x !== 'number' ||
    !Number.isFinite(x) ||
    typeof y !== 'number' ||
    !Number.isFinite(y) ||
    typeof width !== 'number' ||
    !Number.isFinite(width) ||
    width < 360 ||
    typeof height !== 'number' ||
    !Number.isFinite(height) ||
    height < 360
  ) {
    return null;
  }
  return { x, y, width, height };
}

function isValidMappingItem(item: unknown): item is BranchDisplayMapping {
  if (typeof item !== 'object' || item === null) return false;
  if (
    !('id' in item) ||
    !('label' in item) ||
    !('matcher' in item) ||
    !('result' in item) ||
    !('enabled' in item) ||
    !('builtin' in item) ||
    !('settings' in item)
  )
    return false;
  if (
    typeof item.id !== 'string' ||
    typeof item.label !== 'string' ||
    typeof item.matcher !== 'string' ||
    typeof item.result !== 'string' ||
    typeof item.enabled !== 'boolean' ||
    typeof item.builtin !== 'boolean' ||
    typeof item.settings !== 'object' ||
    item.settings === null
  )
    return false;
  // Validate examples/readonlyExampleCount if present; normalization backfills defaults
  if ('examples' in item && !Array.isArray(item.examples)) return false;
  if (
    'readonlyExampleCount' in item &&
    typeof item.readonlyExampleCount !== 'number'
  )
    return false;
  if (!('replaceHyphens' in item.settings) || !('capitalize' in item.settings))
    return false;
  return (
    typeof item.settings.replaceHyphens === 'boolean' &&
    typeof item.settings.capitalize === 'boolean'
  );
}

function normalizeBranchDisplayMappings(
  value: unknown,
): BranchDisplayMapping[] {
  if (!Array.isArray(value)) return DEFAULT_PREFERENCES.branchDisplayMappings;
  return value.filter(isValidMappingItem).map((item: BranchDisplayMapping) => ({
    ...item,
    examples: Array.isArray(item.examples)
      ? item.examples.filter((v: unknown): v is string => typeof v === 'string')
      : [],
    readonlyExampleCount:
      typeof item.readonlyExampleCount === 'number' &&
      Number.isFinite(item.readonlyExampleCount)
        ? Math.max(0, Math.round(item.readonlyExampleCount))
        : 0,
  }));
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeTwoPartRefs<T>(
  value: unknown,
  firstKey: string,
  secondKey: string,
  createRef: (first: string, second: string) => T,
): T[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const result: T[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }

    const first = entry[firstKey];
    const second = entry[secondKey];
    if (typeof first !== 'string' || typeof second !== 'string') {
      continue;
    }

    const normalizedFirst = first.trim();
    const normalizedSecond = second.trim();
    if (normalizedFirst.length === 0 || normalizedSecond.length === 0) {
      continue;
    }

    const stableKey = `${normalizedFirst}/${normalizedSecond}`;
    if (seen.has(stableKey)) {
      continue;
    }

    seen.add(stableKey);
    result.push(createRef(normalizedFirst, normalizedSecond));
  }

  return result;
}

function isMcpHttpAuthHandler(value: unknown): value is McpHttpAuthHandler {
  return value === 'canopy' || value === 'provider' || value === 'account';
}

function normalizeMcpHttpAuthTarget(value: unknown): McpHttpAuthTarget | null {
  if (!isRecord(value)) {
    return null;
  }

  if (value.kind === 'standalone') {
    return typeof value.serverId === 'string' &&
      value.serverId.trim().length > 0 &&
      typeof value.configId === 'string' &&
      value.configId.trim().length > 0
      ? {
          kind: 'standalone',
          serverId: value.serverId.trim(),
          configId: value.configId.trim(),
        }
      : null;
  }

  if (value.kind === 'plugin') {
    return typeof value.marketplaceId === 'string' &&
      value.marketplaceId.trim().length > 0 &&
      typeof value.pluginName === 'string' &&
      value.pluginName.trim().length > 0 &&
      typeof value.serverName === 'string' &&
      value.serverName.trim().length > 0
      ? {
          kind: 'plugin',
          marketplaceId: value.marketplaceId.trim(),
          pluginName: value.pluginName.trim(),
          serverName: value.serverName.trim(),
        }
      : null;
  }

  return null;
}

function normalizeMcpHttpAuthPreferences(
  value: unknown,
): McpHttpAuthPreference[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const byKey = new Map<string, McpHttpAuthPreference>();
  for (const entry of value) {
    if (!isRecord(entry) || !isMcpHttpAuthHandler(entry.handler)) {
      continue;
    }

    const target = normalizeMcpHttpAuthTarget(entry.target);
    if (!target) {
      continue;
    }

    byKey.set(mcpHttpAuthTargetKey(target), {
      target,
      handler: entry.handler,
    });
  }

  return Array.from(byKey.values());
}

export function normalizeChatTabPluginSelections(
  value: unknown,
): ChatTabPluginSelections {
  if (!isRecord(value)) {
    return createEmptyPluginSelections();
  }

  const skillRefs = normalizeTwoPartRefs(
    value.skillRefs,
    'sourceId',
    'skillName',
    (sourceId, skillName) => ({ sourceId, skillName }),
  );
  const pluginRefs = normalizeTwoPartRefs(
    value.pluginRefs,
    'marketplaceId',
    'pluginName',
    (marketplaceId, pluginName) => ({ marketplaceId, pluginName }),
  );
  const mcpServerRefs = normalizeTwoPartRefs(
    value.mcpServerRefs,
    'serverId',
    'configId',
    (serverId, configId) => ({ serverId, configId }),
  );

  const mcpHttpAuthPreferences = normalizeMcpHttpAuthPreferences(
    value.mcpHttpAuthPreferences,
  );
  // Accept either `collectionIds` (canonical) or the deprecated `bundleIds`
  // alias on input, merge + de-duplicate them, and persist only
  // `collectionIds` on output.
  const collectionIdsInput = normalizeStringArray(value.collectionIds);
  const legacyBundleIds = normalizeStringArray(value.bundleIds);
  const seen = new Set<string>();
  const collectionIds: string[] = [];
  for (const id of [...collectionIdsInput, ...legacyBundleIds]) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    collectionIds.push(id);
  }
  return {
    collectionIds,
    skillRefs,
    pluginRefs,
    mcpServerRefs,
    ...(mcpHttpAuthPreferences.length > 0 ? { mcpHttpAuthPreferences } : {}),
  };
}

const VALID_TOP_LEVEL_SOUNDS = new Set<string>(
  OS_NOTIFICATION_TOP_LEVEL_SOUNDS,
);
const VALID_CATEGORY_SOUNDS = new Set<string>(OS_NOTIFICATION_CATEGORY_SOUNDS);
const VALID_IN_APP_NOTIFICATION_PLACEMENTS = new Set<string>(
  IN_APP_NOTIFICATION_PLACEMENTS,
);

function isTopLevelSound(value: unknown): value is OsNotificationTopLevelSound {
  return typeof value === 'string' && VALID_TOP_LEVEL_SOUNDS.has(value);
}

function isCategorySound(value: unknown): value is OsNotificationCategorySound {
  return typeof value === 'string' && VALID_CATEGORY_SOUNDS.has(value);
}

function isInAppNotificationPlacement(
  value: unknown,
): value is InAppNotificationPlacement {
  return (
    typeof value === 'string' && VALID_IN_APP_NOTIFICATION_PLACEMENTS.has(value)
  );
}

function normalizeTopLevelSound(
  value: unknown,
  fallback: OsNotificationTopLevelSound,
): OsNotificationTopLevelSound {
  return isTopLevelSound(value) ? value : fallback;
}

function normalizeCategorySound(
  value: unknown,
  fallback: OsNotificationCategorySound,
): OsNotificationCategorySound {
  return isCategorySound(value) ? value : fallback;
}

function normalizeInAppNotificationPlacement(
  value: unknown,
): InAppNotificationPlacement | undefined {
  return isInAppNotificationPlacement(value) ? value : undefined;
}

function normalizeLegacyInAppChatActivityToasts(
  value: unknown,
  fallback: boolean,
): boolean {
  if (!isRecord(value)) {
    return fallback;
  }

  return normalizeBoolean(value.showInAppChatActivityToasts, fallback);
}

function normalizeNotificationCategories(
  value: unknown,
  fallback: NotificationCategoryMap,
): NotificationCategoryMap {
  if (!isRecord(value)) {
    return { ...fallback };
  }
  return {
    chat: normalizeBoolean(value.chat, fallback.chat),
    script: normalizeBoolean(value.script, fallback.script),
    hook: normalizeBoolean(value.hook, fallback.hook),
    gitCommit: normalizeBoolean(value.gitCommit, fallback.gitCommit),
    gitPush: normalizeBoolean(value.gitPush, fallback.gitPush),
    prCreate: normalizeBoolean(value.prCreate, fallback.prCreate),
    pipeline: normalizeBoolean(value.pipeline, fallback.pipeline),
    terminal: normalizeBoolean(value.terminal, fallback.terminal),
    runComment: normalizeBoolean(value.runComment, fallback.runComment),
    activation: normalizeBoolean(value.activation, fallback.activation),
  };
}

function normalizeInAppNotifications(
  value: unknown,
  legacyOsNotificationsValue: unknown,
): InAppNotificationPreferences {
  const fallback = DEFAULT_PREFERENCES.inAppNotifications;
  const legacyEnabled = normalizeLegacyInAppChatActivityToasts(
    legacyOsNotificationsValue,
    fallback.enabled,
  );

  if (!isRecord(value)) {
    return {
      enabled: legacyEnabled,
      categories: { ...fallback.categories },
    };
  }

  const legacyShowChatActivityToasts = normalizeBoolean(
    value.showChatActivityToasts,
    legacyEnabled,
  );

  const placementChosen = value.placementChosen === true;
  const storedPlacement = normalizeInAppNotificationPlacement(value.placement);
  // Older builds wrote `bottom-right` as the default on every save. Only a
  // corner the user picked is kept, so the default can change.
  const placement =
    storedPlacement === 'bottom-right' && !placementChosen
      ? undefined
      : storedPlacement;
  return {
    enabled: normalizeBoolean(value.enabled, legacyShowChatActivityToasts),
    ...(placement === undefined
      ? {}
      : { placement, ...(placementChosen ? { placementChosen: true } : {}) }),
    categories: normalizeNotificationCategories(
      value.categories,
      fallback.categories,
    ),
  };
}

function normalizeOsNotifications(value: unknown): OsNotificationPreferences {
  const fallback = DEFAULT_PREFERENCES.osNotifications;

  if (!isRecord(value)) {
    return fallback;
  }

  const categories = normalizeNotificationCategories(
    value.categories,
    fallback.categories,
  );

  const rawCategorySounds = value.categorySounds;
  const categorySounds = isRecord(rawCategorySounds)
    ? {
        chat: normalizeCategorySound(
          rawCategorySounds.chat,
          fallback.categorySounds.chat,
        ),
        script: normalizeCategorySound(
          rawCategorySounds.script,
          fallback.categorySounds.script,
        ),
        hook: normalizeCategorySound(
          rawCategorySounds.hook,
          fallback.categorySounds.hook,
        ),
        gitCommit: normalizeCategorySound(
          rawCategorySounds.gitCommit,
          fallback.categorySounds.gitCommit,
        ),
        gitPush: normalizeCategorySound(
          rawCategorySounds.gitPush,
          fallback.categorySounds.gitPush,
        ),
        prCreate: normalizeCategorySound(
          rawCategorySounds.prCreate,
          fallback.categorySounds.prCreate,
        ),
        pipeline: normalizeCategorySound(
          rawCategorySounds.pipeline,
          fallback.categorySounds.pipeline,
        ),
        terminal: normalizeCategorySound(
          rawCategorySounds.terminal,
          fallback.categorySounds.terminal,
        ),
        runComment: normalizeCategorySound(
          rawCategorySounds.runComment,
          fallback.categorySounds.runComment,
        ),
        activation: normalizeCategorySound(
          rawCategorySounds.activation,
          fallback.categorySounds.activation,
        ),
      }
    : fallback.categorySounds;

  return {
    enabled: normalizeBoolean(value.enabled, fallback.enabled),
    skipWhenFocused: normalizeBoolean(
      value.skipWhenFocused,
      fallback.skipWhenFocused,
    ),
    defaultSound: normalizeTopLevelSound(
      value.defaultSound,
      fallback.defaultSound,
    ),
    categories,
    categorySounds,
  };
}

type PreferencesInput =
  | Partial<PreferencesData>
  | Record<string, unknown>
  | undefined;

interface NormalizedLayoutPreferences {
  worktreePanelPercent: number;
  activityPanelWidthPercent: number;
  kanbanWorktreePanelPercent: number;
  kanbanActivityPanelWidthPercent: number;
}

interface NormalizedProviderDefaults {
  defaultChatProvider: AgentProviderType;
  defaultChatModelByProvider: ModelDefaultsByProvider;
  defaultWorktreeProvider: AgentProviderType;
  defaultWorktreeModelByProvider: ModelDefaultsByProvider;
}

interface NormalizedRuntimeLimits {
  scriptTimeoutMinutes: number;
  auditRetentionDays: number;
  automationRunRetentionDays: number;
  codexAppServerIdleTimeoutMinutes: number;
  maxActiveChatTurns: number | null;
  maxActivePipelineExecutions: number | null;
  memoryPressureGuardEnabled: boolean;
  bypassCodexAppServerIdleTimeoutUnderCriticalPressure: boolean;
  memoryPressureWarningThresholdBytes: number;
  memoryPressureCriticalThresholdBytes: number;
}

export function normalizePersistableModelSelection(
  model: unknown,
): string | null {
  return isSyntacticallyValidModelId(model) ? resolveModelAlias(model) : null;
}

function normalizePersistableModelSelectionOrDefault(
  model: unknown,
  fallback: string,
  validation: ModelSelectionValidation,
): string;
function normalizePersistableModelSelectionOrDefault(
  model: unknown,
  fallback: null,
  validation: ModelSelectionValidation,
): string | null;
function normalizePersistableModelSelectionOrDefault(
  model: unknown,
  fallback: string | null,
  validation: ModelSelectionValidation,
): string | null;
function normalizePersistableModelSelectionOrDefault(
  model: unknown,
  fallback: string | null,
  validation: ModelSelectionValidation,
): string | null {
  return (
    (validation === 'persisted'
      ? normalizePersistableModelSelection(model)
      : resolveAvailableModel(model)) ?? fallback
  );
}

interface UserSelectedModelOptions {
  /**
   * Keep a chosen model that is not available right now instead of swapping
   * in the default. For features whose model choice is a data boundary (local
   * memory may be kept on a local model on purpose): their runs refuse an
   * unavailable model rather than send data to another provider.
   */
  keepUnavailableChoice?: boolean;
}

/**
 * A model preference the user may leave on its default. Persisted data keeps
 * the stored value as written. At runtime the model follows the
 * provider-aware default until the user picks one, so a default never names a
 * provider this install cannot run and later default changes reach it; a
 * chosen model that is no longer available falls back to the default too,
 * unless `keepUnavailableChoice` keeps it.
 */
function normalizeUserSelectedModel(
  model: unknown,
  setByUser: unknown,
  defaults: { stored: string; providerAware: () => string },
  validation: ModelSelectionValidation,
  options: UserSelectedModelOptions = {},
): { model: string; setByUser: boolean } {
  if (validation === 'persisted') {
    const stored = normalizePersistableModelSelection(model);
    return stored === null
      ? { model: defaults.stored, setByUser: false }
      : { model: stored, setByUser: setByUser === true };
  }
  const selected =
    setByUser === true
      ? (resolveAvailableModel(model) ??
        (options.keepUnavailableChoice
          ? normalizePersistableModelSelection(model)
          : null))
      : null;
  return selected === null
    ? { model: defaults.providerAware(), setByUser: false }
    : { model: selected, setByUser: true };
}

/** Pipeline Advisor accepts every currently executable model. */
function normalizePersistablePipelineAdvisorModel(
  model: unknown,
  validation: ModelSelectionValidation,
): string | null {
  if (validation === 'persisted') {
    return normalizePersistableModelSelection(model);
  }
  if (typeof model !== 'string') return null;
  const resolved = resolveKnownModel(model);
  return resolved &&
    getExecutionHarnessForModel(resolved) &&
    getExecutionHarnessForModel(resolved) !== 'cursor'
    ? resolved
    : null;
}

function normalizePersistablePipelineAdvisorModelOrDefault(
  model: unknown,
  fallback: string,
  validation: ModelSelectionValidation,
): string {
  return (
    normalizePersistablePipelineAdvisorModel(model, validation) ?? fallback
  );
}

function normalizeFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeNullablePositiveInteger(
  value: unknown,
  fallback: number | null,
  max: number,
): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return clampNumber(Math.round(value), 1, max);
  }
  return fallback;
}

function normalizePositiveInteger(
  value: unknown,
  fallback: number,
  max: number,
): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return clampNumber(Math.round(value), 1, max);
  }
  return fallback;
}

export function normalizeCodeGraphPreferences(
  value: unknown,
): CodeGraphPreferences {
  const record = isRecord(value) ? value : undefined;
  const mode =
    record?.mode === 'disabled' || record?.mode === 'selected-workspaces'
      ? record.mode
      : 'enabled';
  const timeout = record?.generationTimeoutMinutes;
  return {
    mode,
    selectedWorkspaceIds: normalizeStringArray(record?.selectedWorkspaceIds),
    generationTimeoutMinutes:
      typeof timeout === 'number' &&
      Number.isFinite(timeout) &&
      Number.isInteger(timeout) &&
      timeout >= 1 &&
      timeout <= 1_440
        ? timeout
        : 30,
  };
}

function normalizeLayoutPreferences(
  data: PreferencesInput,
): NormalizedLayoutPreferences {
  return {
    worktreePanelPercent: clampNumber(
      normalizeFiniteNumber(
        data?.worktreePanelPercent,
        DEFAULT_PREFERENCES.worktreePanelPercent,
      ),
      20,
      65,
    ),
    activityPanelWidthPercent: clampNumber(
      normalizeFiniteNumber(
        data?.activityPanelWidthPercent,
        DEFAULT_PREFERENCES.activityPanelWidthPercent,
      ),
      15,
      40,
    ),
    kanbanWorktreePanelPercent: clampNumber(
      normalizeFiniteNumber(
        data?.kanbanWorktreePanelPercent,
        DEFAULT_PREFERENCES.kanbanWorktreePanelPercent,
      ),
      20,
      65,
    ),
    kanbanActivityPanelWidthPercent: clampNumber(
      normalizeFiniteNumber(
        data?.kanbanActivityPanelWidthPercent,
        DEFAULT_PREFERENCES.kanbanActivityPanelWidthPercent,
      ),
      15,
      40,
    ),
  };
}

function normalizeProviderDefaults(
  data: PreferencesInput,
  validation: ModelSelectionValidation,
): NormalizedProviderDefaults {
  const defaultChatModelByProvider = normalizeModelDefaultsByProvider(
    data?.defaultChatModelByProvider,
    DEFAULT_PREFERENCES.defaultChatModelByProvider,
    validation,
  );
  const defaultWorktreeModelByProvider = normalizeModelDefaultsByProvider(
    data?.defaultWorktreeModelByProvider,
    DEFAULT_PREFERENCES.defaultWorktreeModelByProvider,
    validation,
  );

  return {
    defaultChatProvider: normalizeDefaultProvider(
      data?.defaultChatProvider,
      defaultChatModelByProvider,
      DEFAULT_PREFERENCES.defaultChatProvider,
    ),
    defaultChatModelByProvider,
    defaultWorktreeProvider: normalizeDefaultProvider(
      data?.defaultWorktreeProvider,
      defaultWorktreeModelByProvider,
      DEFAULT_PREFERENCES.defaultWorktreeProvider,
    ),
    defaultWorktreeModelByProvider,
  };
}

function normalizeRuntimeLimits(
  data: PreferencesInput,
): NormalizedRuntimeLimits {
  const scriptTimeoutRaw = data?.scriptTimeoutMinutes;
  const auditRetentionRaw = data?.auditRetentionDays;
  const automationRunRetentionRaw = data?.automationRunRetentionDays;
  const codexIdleTimeoutRaw = data?.codexAppServerIdleTimeoutMinutes;
  const maxMemoryThresholdBytes = 1024 * 1024 * 1024 * 1024;
  let memoryPressureWarningThresholdBytes = normalizePositiveInteger(
    data?.memoryPressureWarningThresholdBytes,
    DEFAULT_PREFERENCES.memoryPressureWarningThresholdBytes,
    maxMemoryThresholdBytes,
  );
  let memoryPressureCriticalThresholdBytes = normalizePositiveInteger(
    data?.memoryPressureCriticalThresholdBytes,
    DEFAULT_PREFERENCES.memoryPressureCriticalThresholdBytes,
    maxMemoryThresholdBytes,
  );
  if (
    memoryPressureCriticalThresholdBytes <= memoryPressureWarningThresholdBytes
  ) {
    memoryPressureWarningThresholdBytes =
      DEFAULT_PREFERENCES.memoryPressureWarningThresholdBytes;
    memoryPressureCriticalThresholdBytes =
      DEFAULT_PREFERENCES.memoryPressureCriticalThresholdBytes;
  }

  return {
    scriptTimeoutMinutes:
      typeof scriptTimeoutRaw === 'number' && Number.isFinite(scriptTimeoutRaw)
        ? clampNumber(Math.round(scriptTimeoutRaw), 1, 30)
        : DEFAULT_PREFERENCES.scriptTimeoutMinutes,
    auditRetentionDays:
      typeof auditRetentionRaw === 'number' &&
      Number.isFinite(auditRetentionRaw)
        ? clampNumber(Math.round(auditRetentionRaw), 1, 90)
        : DEFAULT_PREFERENCES.auditRetentionDays,
    automationRunRetentionDays:
      typeof automationRunRetentionRaw === 'number' &&
      Number.isFinite(automationRunRetentionRaw)
        ? clampNumber(Math.round(automationRunRetentionRaw), 1, 365)
        : (DEFAULT_PREFERENCES.automationRunRetentionDays ?? 90),
    codexAppServerIdleTimeoutMinutes:
      typeof codexIdleTimeoutRaw === 'number' &&
      Number.isFinite(codexIdleTimeoutRaw)
        ? clampNumber(Math.round(codexIdleTimeoutRaw), 1, 120)
        : DEFAULT_PREFERENCES.codexAppServerIdleTimeoutMinutes,
    maxActiveChatTurns: normalizeNullablePositiveInteger(
      data?.maxActiveChatTurns,
      DEFAULT_PREFERENCES.maxActiveChatTurns,
      100,
    ),
    maxActivePipelineExecutions: normalizeNullablePositiveInteger(
      data?.maxActivePipelineExecutions,
      DEFAULT_PREFERENCES.maxActivePipelineExecutions,
      100,
    ),
    memoryPressureGuardEnabled: normalizeBoolean(
      data?.memoryPressureGuardEnabled,
      DEFAULT_PREFERENCES.memoryPressureGuardEnabled,
    ),
    bypassCodexAppServerIdleTimeoutUnderCriticalPressure: normalizeBoolean(
      data?.bypassCodexAppServerIdleTimeoutUnderCriticalPressure,
      DEFAULT_PREFERENCES.bypassCodexAppServerIdleTimeoutUnderCriticalPressure,
    ),
    memoryPressureWarningThresholdBytes,
    memoryPressureCriticalThresholdBytes,
  };
}

function normalizeIsoTimestamp(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value
    : undefined;
}

/** Narrows persisted unknowns to plain objects without a type assertion. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Corruption guard with room for years of completed/dismissed suggestions. */
const MAX_HOME_ONBOARDING_SUGGESTION_ENTRIES = 10_000;
/** Per-entry latched-step bound; the state machine defines only one today. */
const MAX_HOME_ONBOARDING_LATCHED_STEPS = 10;

function normalizeNativeProviderAccountRecord(
  value: unknown,
): NativeProviderAccountRecord | undefined {
  if (!isPlainRecord(value)) return undefined;
  const accountKey =
    typeof value.accountKey === 'string' ? value.accountKey.trim() : '';
  if (!accountKey) return undefined;
  const changedAt = value.changedAt;
  return typeof changedAt === 'number' &&
    Number.isFinite(changedAt) &&
    changedAt > 0
    ? { accountKey, changedAt }
    : { accountKey };
}

function normalizeNativeProviderAccounts(
  value: unknown,
): PreferencesData['nativeProviderAccounts'] {
  if (!isPlainRecord(value)) return undefined;
  const accounts: NonNullable<PreferencesData['nativeProviderAccounts']> = {};
  for (const provider of ['claude', 'codex'] as const) {
    const record = normalizeNativeProviderAccountRecord(value[provider]);
    if (record) accounts[provider] = record;
  }
  return Object.keys(accounts).length ? accounts : undefined;
}

function normalizeOptInTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? new Date(instant).toISOString() : undefined;
}
function normalizeDataSharingOptInHints(
  value: unknown,
): PreferencesData['dataSharingOptInHints'] {
  if (!isPlainRecord(value)) return undefined;
  const hints: NonNullable<PreferencesData['dataSharingOptInHints']> = {};
  for (const feature of DATA_SHARING_OPT_IN_FEATURES) {
    const entry = value[feature];
    if (!isPlainRecord(entry)) continue;
    const dismissedAt = normalizeOptInTimestamp(entry.dismissedAt);
    if (dismissedAt !== undefined) hints[feature] = { dismissedAt };
  }
  return Object.keys(hints).length ? hints : undefined;
}
function normalizeDataSharingOptInHistory(
  value: unknown,
): PreferencesData['dataSharingOptInHistory'] {
  if (!Array.isArray(value)) return undefined;
  const history: NonNullable<PreferencesData['dataSharingOptInHistory']> = [];
  for (const entry of value) {
    if (!isPlainRecord(entry)) continue;
    const enabledAt = normalizeOptInTimestamp(entry.enabledAt);
    if (enabledAt !== undefined && isPlainRecord(entry.sharing)) {
      history.push({
        enabledAt,
        sharing: normalizeTelemetrySharing(entry.sharing),
      });
    }
  }
  return history.length
    ? history.sort((a, b) => a.enabledAt.localeCompare(b.enabledAt))
    : undefined;
}

/**
 * Normalizes the persisted Home onboarding suggestions module state. A state
 * without a `startedAt` cohort latch is meaningless and discarded; unknown
 * entry ids and malformed fields are filtered so renderer derivation only
 * ever sees the shapes it understands.
 */
function normalizeHomeOnboardingSuggestions(
  value: unknown,
): HomeOnboardingSuggestionsPreferences | undefined {
  if (!isPlainRecord(value)) {
    return undefined;
  }
  const startedAt = normalizeIsoTimestamp(value.startedAt);
  if (startedAt === undefined) {
    return undefined;
  }
  const retiredAt = normalizeIsoTimestamp(value.retiredAt);
  const entries: HomeOnboardingSuggestionsPreferences['entries'] = {};
  const rawEntries: Record<string, unknown> = isPlainRecord(value.entries)
    ? value.entries
    : {};
  const curatedIds: readonly string[] = HOME_ONBOARDING_SUGGESTION_ENTRY_IDS;
  const retiredIds: readonly string[] =
    RETIRED_HOME_ONBOARDING_SUGGESTION_ENTRY_IDS;
  const knownEntryIds = Object.keys(rawEntries)
    .filter(
      (entryId) =>
        curatedIds.includes(entryId) ||
        retiredIds.includes(entryId) ||
        entryId.startsWith(HOME_ONBOARDING_PLUGIN_SUGGESTION_PREFIX) ||
        entryId.startsWith(HOME_ONBOARDING_ADVANCED_SUGGESTION_PREFIX) ||
        entryId.startsWith(HOME_ONBOARDING_BLUEPRINT_SUGGESTION_PREFIX),
    )
    // Keep long-lived history while bounding malformed preference files.
    .slice(0, MAX_HOME_ONBOARDING_SUGGESTION_ENTRIES);
  for (const entryId of knownEntryIds) {
    const entryRecord = rawEntries[entryId];
    if (!isPlainRecord(entryRecord)) {
      continue;
    }
    const entry: HomeOnboardingSuggestionEntryPreferences = {};
    const dismissedAt = normalizeIsoTimestamp(entryRecord.dismissedAt);
    if (dismissedAt !== undefined) entry.dismissedAt = dismissedAt;
    const completedAt = normalizeIsoTimestamp(entryRecord.completedAt);
    if (completedAt !== undefined) entry.completedAt = completedAt;
    if (Array.isArray(entryRecord.latchedSteps)) {
      const latchedSteps = Array.from(
        new Set(
          entryRecord.latchedSteps.filter(
            (step: unknown): step is string => typeof step === 'string',
          ),
        ),
      ).slice(0, MAX_HOME_ONBOARDING_LATCHED_STEPS);
      if (latchedSteps.length > 0) entry.latchedSteps = latchedSteps;
    }
    if (Object.keys(entry).length > 0) {
      entries[entryId] = entry;
    }
  }
  return {
    startedAt,
    ...(retiredAt !== undefined ? { retiredAt } : {}),
    entries,
  };
}

const ACCOUNT_PROXY_CONNECTION_KINDS: ReadonlySet<string> = new Set([
  'server',
  'local',
  'device',
]);

/** A stored proxy connection, or null when it is missing or malformed. */
function normalizeAccountProxyConnection(
  value: unknown,
): AccountProxyConnection | null {
  if (!isRecord(value)) return null;
  const { id, kind, url } = value;
  if (
    typeof id !== 'string' ||
    !/^[a-zA-Z0-9-]{8,64}$/.test(id) ||
    typeof kind !== 'string' ||
    !ACCOUNT_PROXY_CONNECTION_KINDS.has(kind) ||
    typeof url !== 'string'
  ) {
    return null;
  }
  const normalizedUrl = normalizeAccountProxyUrl(url);
  if (!normalizedUrl.ok) return null;
  const connectionKind: AccountProxyConnectionKind =
    kind === 'local' ? 'local' : kind === 'device' ? 'device' : 'server';
  return { id, kind: connectionKind, url: normalizedUrl.url };
}

function normalizePendingInstalledItemUninstalls(
  value: unknown,
): NonNullable<PreferencesData['pendingInstalledItemUninstalls']> {
  if (!Array.isArray(value)) return [];
  const schema = z
    .object({
      target: InstalledItemUninstallTargetSchema,
      refs: z.array(InstalledItemRefSchema),
    })
    .strict();
  return value.flatMap((entry: unknown) => {
    const result = schema.safeParse(entry);
    return result.success ? [result.data] : [];
  });
}

function normalizeParkedCodexPlugins(
  value: unknown,
): NonNullable<PreferencesData['parkedCodexPlugins']> {
  if (!Array.isArray(value)) return [];
  const records: NonNullable<PreferencesData['parkedCodexPlugins']> = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.key !== 'string' ||
      seen.has(entry.key) ||
      parseInstalledItemKey(entry.key)?.kind !== 'plugin' ||
      typeof entry.pluginId !== 'string' ||
      !entry.pluginId ||
      typeof entry.pluginName !== 'string' ||
      !entry.pluginName ||
      !(
        entry.marketplacePath === null ||
        typeof entry.marketplacePath === 'string'
      ) ||
      !(
        entry.remoteMarketplaceName === null ||
        typeof entry.remoteMarketplaceName === 'string'
      ) ||
      (!entry.marketplacePath && !entry.remoteMarketplaceName) ||
      (entry.state !== 'parking' &&
        entry.state !== 'parked' &&
        entry.state !== 'restoring')
    )
      continue;
    records.push({
      key: entry.key,
      pluginId: entry.pluginId,
      pluginName: entry.pluginName,
      marketplacePath: entry.marketplacePath,
      remoteMarketplaceName: entry.remoteMarketplaceName,
      ...(typeof entry.version === 'string' ? { version: entry.version } : {}),
      ...(typeof entry.sourceDigest === 'string' &&
      /^[a-f0-9]{64}$/.test(entry.sourceDigest)
        ? { sourceDigest: entry.sourceDigest }
        : {}),
      ...(typeof entry.marketplaceSourceDigest === 'string' &&
      /^[a-f0-9]{64}$/.test(entry.marketplaceSourceDigest)
        ? { marketplaceSourceDigest: entry.marketplaceSourceDigest }
        : {}),
      state: entry.state,
    });
    seen.add(entry.key);
  }
  return records;
}

export function normalizePreferences(
  data: Partial<PreferencesData> | Record<string, unknown> | undefined,
  modelSelectionValidation: ModelSelectionValidation = 'runtime',
): PreferencesData {
  const layout = normalizeLayoutPreferences(data);
  const providerDefaults = normalizeProviderDefaults(
    data,
    modelSelectionValidation,
  );
  const providerModelConfigDefaults = normalizeProviderModelConfigDefaults(
    data?.providerModelConfigDefaults,
    data?.codexFastModeDefaultEnabled,
  );
  const runtimeLimits = normalizeRuntimeLimits(data);
  const onboardingCompleted = normalizeStringArray(data?.onboardingCompleted);
  const homeOnboardingSuggestions = normalizeHomeOnboardingSuggestions(
    data?.homeOnboardingSuggestions,
  );
  const nativeProviderAccounts = normalizeNativeProviderAccounts(
    data?.nativeProviderAccounts,
  );
  const legacyNotificationAnswer =
    homeOnboardingSuggestions?.entries.notifications;
  const legacyNotificationAnswerTimestamps = [
    normalizeOptInTimestamp(legacyNotificationAnswer?.completedAt),
    normalizeOptInTimestamp(legacyNotificationAnswer?.dismissedAt),
  ].filter((value): value is string => value !== undefined);
  legacyNotificationAnswerTimestamps.sort(
    (a, b) => Date.parse(a) - Date.parse(b),
  );
  const osNotificationOfferAnsweredAt =
    normalizeOptInTimestamp(data?.osNotificationOfferAnsweredAt) ??
    legacyNotificationAnswerTimestamps[0];
  const dataSharingOptInHints = normalizeDataSharingOptInHints(
    data?.dataSharingOptInHints,
  );
  const dataSharingOptInHistory = normalizeDataSharingOptInHistory(
    data?.dataSharingOptInHistory,
  );
  const prefixMode = isBranchNamePrefixMode(data?.branchNamePrefixMode)
    ? data.branchNamePrefixMode
    : DEFAULT_PREFERENCES.branchNamePrefixMode;
  const summaryModel = normalizeUserSelectedModel(
    data?.summaryModel,
    data?.summaryModelSetByUser,
    { stored: DEFAULT_SUMMARY_MODEL, providerAware: defaultSummaryModel },
    modelSelectionValidation,
  );
  const localMemoryModel = normalizeUserSelectedModel(
    data?.localMemoryModel,
    data?.localMemoryModelSetByUser,
    {
      stored: DEFAULT_LOCAL_MEMORY_MODEL,
      providerAware: defaultLocalMemoryModel,
    },
    modelSelectionValidation,
    // Memory runs refuse an unavailable chosen model (see
    // resolveLocalMemoryHelperModel) instead of sending saved memory to the
    // default's provider.
    { keepUnavailableChoice: true },
  );
  const handoffSummaryModel = normalizePersistableModelSelectionOrDefault(
    data?.handoffSummaryModel,
    DEFAULT_HANDOFF_SUMMARY_MODEL,
    // Keep an unavailable saved local choice. Changed runtime writes are
    // rejected below instead of substituting a cloud default.
    'persisted',
  );
  const handoffThinking = normalizeThinkingLevel(
    data?.handoffSummaryThinkingLevel,
    'off',
  );

  return {
    cursorEnabled: data?.cursorEnabled === true,
    copilotEnabled: data?.copilotEnabled === true,
    opencodeEnabled: data?.opencodeEnabled === true,
    accountProxyEnabled: data?.accountProxyEnabled === true,
    accountProxyConnection: normalizeAccountProxyConnection(
      data?.accountProxyConnection,
    ),
    accountProxyKeepChatOnOneAccount:
      data?.accountProxyKeepChatOnOneAccount !== false,
    accountProxyRouteClaude: data?.accountProxyRouteClaude !== false,
    accountProxyRouteCodex: data?.accountProxyRouteCodex !== false,
    accountProxyLocalStartWithApp:
      data?.accountProxyLocalStartWithApp !== false,
    ...(isAccountProxyRoutingStrategy(data?.accountProxyLocalRoutingStrategy)
      ? {
          accountProxyLocalRoutingStrategy:
            data.accountProxyLocalRoutingStrategy,
        }
      : {}),
    copilotAccount:
      isRecord(data?.copilotAccount) &&
      typeof data.copilotAccount.login === 'string' &&
      /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(data.copilotAccount.login) &&
      typeof data.copilotAccount.host === 'string' &&
      /^https:\/\/(github\.com|[a-z0-9-]+\.ghe\.com)$/.test(
        data.copilotAccount.host,
      )
        ? { login: data.copilotAccount.login, host: data.copilotAccount.host }
        : undefined,
    orgProjectDefaultDestinationRoot:
      typeof data?.orgProjectDefaultDestinationRoot === 'string'
        ? data.orgProjectDefaultDestinationRoot.trim()
        : undefined,
    orgProjectCloneProtocol:
      data?.orgProjectCloneProtocol === 'ssh' ? 'ssh' : 'https',
    cursorAgentPath:
      typeof data?.cursorAgentPath === 'string'
        ? data.cursorAgentPath.trim()
        : '',
    ...(data?.chatWidth === 'full' ? { chatWidth: 'full' as const } : {}),
    workspaceDefaultLayoutMode: isWorkspaceLayoutMode(
      data?.workspaceDefaultLayoutMode,
    )
      ? data.workspaceDefaultLayoutMode
      : DEFAULT_PREFERENCES.workspaceDefaultLayoutMode,
    navigationMode: isNavigationMode(data?.navigationMode)
      ? data.navigationMode
      : DEFAULT_PREFERENCES.navigationMode,
    worktreePanelPercent: layout.worktreePanelPercent,
    activityPanelExpanded:
      typeof data?.activityPanelExpanded === 'boolean'
        ? data.activityPanelExpanded
        : DEFAULT_PREFERENCES.activityPanelExpanded,
    activityPanelWidthPercent: layout.activityPanelWidthPercent,
    kanbanWorktreePanelPercent: layout.kanbanWorktreePanelPercent,
    kanbanActivityPanelExpanded:
      typeof data?.kanbanActivityPanelExpanded === 'boolean'
        ? data.kanbanActivityPanelExpanded
        : DEFAULT_PREFERENCES.kanbanActivityPanelExpanded,
    kanbanActivityPanelWidthPercent: layout.kanbanActivityPanelWidthPercent,
    kanbanChatPanelVisible:
      typeof data?.kanbanChatPanelVisible === 'boolean'
        ? data.kanbanChatPanelVisible
        : DEFAULT_PREFERENCES.kanbanChatPanelVisible,
    pipelineChatPanelVisible:
      typeof data?.pipelineChatPanelVisible === 'boolean'
        ? data.pipelineChatPanelVisible
        : DEFAULT_PREFERENCES.pipelineChatPanelVisible,
    pipelineChatPanelWidthPercent: clampNumber(
      normalizeFiniteNumber(
        data?.pipelineChatPanelWidthPercent,
        DEFAULT_PREFERENCES.pipelineChatPanelWidthPercent ?? 30,
      ),
      20,
      65,
    ),
    sidebarCollapsed:
      typeof data?.sidebarCollapsed === 'boolean'
        ? data.sidebarCollapsed
        : DEFAULT_PREFERENCES.sidebarCollapsed,
    sidebarProjectSortMode:
      data?.sidebarProjectSortMode === 'last-updated'
        ? 'last-updated'
        : 'manual',
    sidebarWidth: clampNumber(
      normalizeFiniteNumber(
        data?.sidebarWidth,
        DEFAULT_PREFERENCES.sidebarWidth,
      ),
      SIDEBAR_MIN_WIDTH,
      SIDEBAR_MAX_WIDTH,
    ),
    sidebarCodeSectionCollapsed:
      typeof data?.sidebarCodeSectionCollapsed === 'boolean'
        ? data.sidebarCodeSectionCollapsed
        : DEFAULT_PREFERENCES.sidebarCodeSectionCollapsed,
    sidebarCoworkSectionCollapsed:
      typeof data?.sidebarCoworkSectionCollapsed === 'boolean'
        ? data.sidebarCoworkSectionCollapsed
        : DEFAULT_PREFERENCES.sidebarCoworkSectionCollapsed,
    sidebarNavLayout:
      typeof data?.sidebarNavLayout === 'object' &&
      data?.sidebarNavLayout !== null
        ? reconcileSidebarNavLayout(data.sidebarNavLayout)
        : reconcileSidebarNavLayout(undefined),
    branchNamePrefixMode: prefixMode,
    branchNameCustomPrefix:
      typeof data?.branchNameCustomPrefix === 'string'
        ? data.branchNameCustomPrefix
        : DEFAULT_PREFERENCES.branchNameCustomPrefix,
    deleteBranchOnArchive:
      typeof data?.deleteBranchOnArchive === 'boolean'
        ? data.deleteBranchOnArchive
        : DEFAULT_PREFERENCES.deleteBranchOnArchive,
    archiveOnMerge:
      typeof data?.archiveOnMerge === 'boolean'
        ? data.archiveOnMerge
        : DEFAULT_PREFERENCES.archiveOnMerge,
    groupChildBranchesWithBase:
      typeof data?.groupChildBranchesWithBase === 'boolean'
        ? data.groupChildBranchesWithBase
        : DEFAULT_PREFERENCES.groupChildBranchesWithBase,
    defaultChatProvider: providerDefaults.defaultChatProvider,
    defaultChatModelByProvider: providerDefaults.defaultChatModelByProvider,
    defaultWorktreeProvider: providerDefaults.defaultWorktreeProvider,
    defaultWorktreeModelByProvider:
      providerDefaults.defaultWorktreeModelByProvider,
    approvalDefaults: normalizeApprovalDefaults(
      data?.approvalDefaults,
      DEFAULT_PREFERENCES.approvalDefaults,
    ),
    globalApprovalRules: normalizeApprovalRules(data?.globalApprovalRules),
    approvalsUpgradeNoticeDismissed:
      typeof data?.approvalsUpgradeNoticeDismissed === 'boolean'
        ? data.approvalsUpgradeNoticeDismissed
        : DEFAULT_PREFERENCES.approvalsUpgradeNoticeDismissed,
    ...(isBillingLane(data?.lastResolvedDefaultLane)
      ? { lastResolvedDefaultLane: data.lastResolvedDefaultLane }
      : {}),
    ...normalizeLastResolvedLaneByScope(
      data?.lastResolvedDefaultLaneByScope,
      data?.lastResolvedDefaultLane,
    ),
    summaryModel: summaryModel.model,
    summaryModelSetByUser: summaryModel.setByUser,
    summaryThinkingLevel: normalizeThinkingLevel(
      data?.summaryThinkingLevel,
      DEFAULT_PREFERENCES.summaryThinkingLevel,
    ),
    handoffSummaryModel,
    handoffSummaryThinkingLevel: resolveKnownModel(handoffSummaryModel)
      ? clampThinkingLevelForModel(handoffThinking, handoffSummaryModel)
      : handoffThinking,
    worktreeSummaryEnabled:
      typeof data?.worktreeSummaryEnabled === 'boolean'
        ? data.worktreeSummaryEnabled
        : DEFAULT_PREFERENCES.worktreeSummaryEnabled,
    worktreeSummaryModel: normalizePersistableModelSelectionOrDefault(
      data?.worktreeSummaryModel,
      DEFAULT_PREFERENCES.worktreeSummaryModel,
      modelSelectionValidation,
    ),
    worktreeSummaryThinkingLevel: normalizeThinkingLevel(
      data?.worktreeSummaryThinkingLevel,
      DEFAULT_PREFERENCES.worktreeSummaryThinkingLevel,
    ),
    planDiagramModel: normalizePersistableModelSelectionOrDefault(
      data?.planDiagramModel,
      DEFAULT_PREFERENCES.planDiagramModel,
      modelSelectionValidation,
    ),
    planDiagramThinkingLevel: normalizeThinkingLevel(
      data?.planDiagramThinkingLevel,
      DEFAULT_PREFERENCES.planDiagramThinkingLevel,
    ),
    codeReviewModel: normalizePersistableModelSelectionOrDefault(
      data?.codeReviewModel,
      DEFAULT_PREFERENCES.codeReviewModel,
      modelSelectionValidation,
    ),
    codeReviewThinkingLevel: normalizeThinkingLevel(
      data?.codeReviewThinkingLevel,
      DEFAULT_PREFERENCES.codeReviewThinkingLevel,
    ),
    prGenerationModel: normalizePersistableModelSelectionOrDefault(
      data?.prGenerationModel,
      DEFAULT_PREFERENCES.prGenerationModel,
      modelSelectionValidation,
    ),
    prGenerationThinkingLevel: normalizeThinkingLevel(
      data?.prGenerationThinkingLevel,
    ),
    prInstructions:
      typeof data?.prInstructions === 'string'
        ? data.prInstructions
        : DEFAULT_PREFERENCES.prInstructions,
    prInstructionMode: isPrInstructionMode(data?.prInstructionMode)
      ? data.prInstructionMode
      : DEFAULT_PREFERENCES.prInstructionMode,
    commitGenerationModel: normalizePersistableModelSelectionOrDefault(
      data?.commitGenerationModel,
      DEFAULT_PREFERENCES.commitGenerationModel,
      modelSelectionValidation,
    ),
    commitGenerationThinkingLevel: normalizeThinkingLevel(
      data?.commitGenerationThinkingLevel,
      DEFAULT_PREFERENCES.commitGenerationThinkingLevel,
    ),
    commitInstructions:
      typeof data?.commitInstructions === 'string'
        ? data.commitInstructions
        : DEFAULT_PREFERENCES.commitInstructions,
    commitInstructionMode: isPrInstructionMode(data?.commitInstructionMode)
      ? data.commitInstructionMode
      : DEFAULT_PREFERENCES.commitInstructionMode,
    branchNamingModel: normalizePersistableModelSelectionOrDefault(
      data?.branchNamingModel,
      DEFAULT_PREFERENCES.branchNamingModel,
      modelSelectionValidation,
    ),
    branchNamingThinkingLevel: normalizeThinkingLevel(
      data?.branchNamingThinkingLevel,
      DEFAULT_PREFERENCES.branchNamingThinkingLevel,
    ),
    branchNamingInstructions:
      typeof data?.branchNamingInstructions === 'string'
        ? data.branchNamingInstructions
        : DEFAULT_PREFERENCES.branchNamingInstructions,
    globalInstructions: normalizeGlobalInstructionsConfig(
      data?.globalInstructions,
    ),
    pipelineAdvisorEnabled:
      typeof data?.pipelineAdvisorEnabled === 'boolean'
        ? data.pipelineAdvisorEnabled
        : DEFAULT_PREFERENCES.pipelineAdvisorEnabled,
    // This intentionally uses a new key instead of reinterpreting the legacy
    // opt-in `orgMemoryEnabled` preference. Existing installs therefore adopt
    // the new enabled-by-default behavior once, while a subsequent opt-out is
    // persisted normally under the new key.
    orgMemoryInjectionEnabled:
      typeof data?.orgMemoryInjectionEnabled === 'boolean'
        ? data.orgMemoryInjectionEnabled
        : DEFAULT_PREFERENCES.orgMemoryInjectionEnabled,
    localMemoryEnabled:
      typeof data?.localMemoryEnabled === 'boolean'
        ? data.localMemoryEnabled
        : DEFAULT_PREFERENCES.localMemoryEnabled,
    localMemoryEnabledSetByUser:
      typeof data?.localMemoryEnabledSetByUser === 'boolean'
        ? data.localMemoryEnabledSetByUser
        : DEFAULT_PREFERENCES.localMemoryEnabledSetByUser,
    localMemoryModel: localMemoryModel.model,
    localMemoryModelSetByUser: localMemoryModel.setByUser,
    localMemoryThinkingLevel: normalizeThinkingLevel(
      data?.localMemoryThinkingLevel,
      DEFAULT_PREFERENCES.localMemoryThinkingLevel,
    ),
    pipelineAdvisorModel: normalizePersistablePipelineAdvisorModelOrDefault(
      data?.pipelineAdvisorModel,
      DEFAULT_PREFERENCES.pipelineAdvisorModel,
      modelSelectionValidation,
    ),
    pipelineAdvisorThinkingLevel: normalizeThinkingLevel(
      data?.pipelineAdvisorThinkingLevel,
      DEFAULT_PREFERENCES.pipelineAdvisorThinkingLevel,
    ),
    disabledPipelineIds: normalizeStringArray(data?.disabledPipelineIds),
    appAdvisorModel: normalizePersistableModelSelectionOrDefault(
      data?.appAdvisorModel,
      DEFAULT_PREFERENCES.appAdvisorModel,
      modelSelectionValidation,
    ),
    appAdvisorThinkingLevel: normalizeThinkingLevel(
      data?.appAdvisorThinkingLevel,
      DEFAULT_PREFERENCES.appAdvisorThinkingLevel,
    ),
    cronGenerationModel: normalizePersistablePipelineAdvisorModelOrDefault(
      data?.cronGenerationModel,
      DEFAULT_PREFERENCES.cronGenerationModel,
      modelSelectionValidation,
    ),
    cronGenerationThinkingLevel: normalizeThinkingLevel(
      data?.cronGenerationThinkingLevel,
      DEFAULT_PREFERENCES.cronGenerationThinkingLevel,
    ),
    ifCommandGenerationModel: normalizePersistablePipelineAdvisorModelOrDefault(
      data?.ifCommandGenerationModel,
      DEFAULT_PREFERENCES.ifCommandGenerationModel,
      modelSelectionValidation,
    ),
    ifCommandGenerationThinkingLevel: normalizeThinkingLevel(
      data?.ifCommandGenerationThinkingLevel,
      DEFAULT_PREFERENCES.ifCommandGenerationThinkingLevel,
    ),
    splitPrThresholdLines: clampNumber(
      normalizeFiniteNumber(
        data?.splitPrThresholdLines,
        DEFAULT_PREFERENCES.splitPrThresholdLines,
      ),
      50,
      100_000,
    ),
    splitPrEnabled: normalizeBoolean(
      data?.splitPrEnabled,
      DEFAULT_PREFERENCES.splitPrEnabled,
    ),
    splitPrPlannerModel: normalizePersistableModelSelectionOrDefault(
      data?.splitPrPlannerModel,
      DEFAULT_PREFERENCES.splitPrPlannerModel,
      modelSelectionValidation,
    ),
    splitPrPlannerThinkingLevel: normalizeThinkingLevel(
      data?.splitPrPlannerThinkingLevel,
      DEFAULT_PREFERENCES.splitPrPlannerThinkingLevel,
    ),
    disabledInstalledItems: normalizeDisabledInstalledItems(
      data?.disabledInstalledItems,
    ),
    parkedCodexPlugins: normalizeParkedCodexPlugins(data?.parkedCodexPlugins),
    pendingInstalledItemUninstalls: normalizePendingInstalledItemUninstalls(
      data?.pendingInstalledItemUninstalls,
    ),
    globalPluginSelections: excludeDisabledInstalledItems(
      normalizeChatTabPluginSelections(data?.globalPluginSelections),
      normalizeDisabledInstalledItems(data?.disabledInstalledItems),
    ),
    ...(Array.isArray(data?.initializedCuratedPluginDefaults)
      ? {
          initializedCuratedPluginDefaults: normalizeStringArray(
            data.initializedCuratedPluginDefaults,
          ),
        }
      : {}),
    appAdvisorPluginSelections: normalizeChatTabPluginSelections(
      data?.appAdvisorPluginSelections,
    ),
    pipelineEditorPluginSelections: normalizeChatTabPluginSelections(
      data?.pipelineEditorPluginSelections,
    ),
    appAdvisorDialogBounds: normalizeAppAdvisorDialogBounds(
      data?.appAdvisorDialogBounds,
    ),
    // Optional: only persisted once the user has toggled the App Advisor
    // popout nav (absent = expanded default).
    ...(typeof data?.appAdvisorNavCollapsed === 'boolean'
      ? { appAdvisorNavCollapsed: data.appAdvisorNavCollapsed }
      : {}),
    codexMultiAgentAppAdvisorEnabled: normalizeBoolean(
      data?.codexMultiAgentAppAdvisorEnabled,
      DEFAULT_PREFERENCES.codexMultiAgentAppAdvisorEnabled,
    ),
    providerModelConfigDefaults,
    codexFastModeDefaultEnabled:
      providerModelConfigDefaults.codex?.fastMode ?? false,
    branchNamingPluginSelections: normalizeChatTabPluginSelections(
      data?.branchNamingPluginSelections,
    ),
    commitGenerationPluginSelections: normalizeChatTabPluginSelections(
      data?.commitGenerationPluginSelections,
    ),
    prGenerationPluginSelections: normalizeChatTabPluginSelections(
      data?.prGenerationPluginSelections,
    ),
    worktreeSummaryPluginSelections: normalizeChatTabPluginSelections(
      data?.worktreeSummaryPluginSelections,
    ),
    codexCompatDisabledPlugins: normalizeCodexCompatDisabledPlugins(
      data?.codexCompatDisabledPlugins,
    ),
    branchDisplayMappings: normalizeBranchDisplayMappings(
      data?.branchDisplayMappings,
    ),
    reviewCommitMessage:
      typeof data?.reviewCommitMessage === 'boolean'
        ? data.reviewCommitMessage
        : DEFAULT_PREFERENCES.reviewCommitMessage,
    agentRebaseResolutionEnabled:
      typeof data?.agentRebaseResolutionEnabled === 'boolean'
        ? data.agentRebaseResolutionEnabled
        : DEFAULT_PREFERENCES.agentRebaseResolutionEnabled,
    agentRebaseResolutionModel: normalizePersistableModelSelectionOrDefault(
      data?.agentRebaseResolutionModel,
      DEFAULT_PREFERENCES.agentRebaseResolutionModel,
      modelSelectionValidation,
    ),
    agentRebaseResolutionThinkingLevel: normalizeOptionalThinkingLevel(
      data?.agentRebaseResolutionThinkingLevel,
    ),
    mergeQueueAgentHandling: isMergeQueueAgentHandling(
      data?.mergeQueueAgentHandling,
    )
      ? data.mergeQueueAgentHandling
      : DEFAULT_PREFERENCES.mergeQueueAgentHandling,
    rtkEnabled:
      typeof data?.rtkEnabled === 'boolean'
        ? data.rtkEnabled
        : DEFAULT_PREFERENCES.rtkEnabled,
    autoRetryTransientErrorsChats:
      typeof data?.autoRetryTransientErrorsChats === 'boolean'
        ? data.autoRetryTransientErrorsChats
        : DEFAULT_PREFERENCES.autoRetryTransientErrorsChats,
    autoRetryTransientErrorsPipelines:
      typeof data?.autoRetryTransientErrorsPipelines === 'boolean'
        ? data.autoRetryTransientErrorsPipelines
        : DEFAULT_PREFERENCES.autoRetryTransientErrorsPipelines,
    scriptTimeoutMinutes: runtimeLimits.scriptTimeoutMinutes,
    codexAppServerIdleTimeoutMinutes:
      runtimeLimits.codexAppServerIdleTimeoutMinutes,
    defaultChatInterfaceMode: isChatInterfaceMode(
      data?.defaultChatInterfaceMode,
    )
      ? data.defaultChatInterfaceMode
      : DEFAULT_PREFERENCES.defaultChatInterfaceMode,
    defaultStandaloneChatInterfaceMode: isChatInterfaceMode(
      data?.defaultStandaloneChatInterfaceMode,
    )
      ? data.defaultStandaloneChatInterfaceMode
      : DEFAULT_PREFERENCES.defaultStandaloneChatInterfaceMode,
    defaultAppAdvisorInterfaceMode: isChatInterfaceMode(
      data?.defaultAppAdvisorInterfaceMode,
    )
      ? data.defaultAppAdvisorInterfaceMode
      : DEFAULT_PREFERENCES.defaultAppAdvisorInterfaceMode,
    preventClaudeNativeCaffeinate: normalizeBoolean(
      data?.preventClaudeNativeCaffeinate,
      DEFAULT_PREFERENCES.preventClaudeNativeCaffeinate,
    ),
    claudeMaxTurns: normalizeClaudeMaxTurns(data?.claudeMaxTurns),
    maxActiveChatTurns: runtimeLimits.maxActiveChatTurns,
    maxActivePipelineExecutions: runtimeLimits.maxActivePipelineExecutions,
    canopyBackgroundProcessesMode: isBackgroundProcessMode(
      data?.canopyBackgroundProcessesMode,
    )
      ? data.canopyBackgroundProcessesMode
      : DEFAULT_PREFERENCES.canopyBackgroundProcessesMode,
    pipelinesMode: isBackgroundProcessMode(data?.pipelinesMode)
      ? data.pipelinesMode
      : DEFAULT_PREFERENCES.pipelinesMode,
    workerConcurrencyLimit:
      typeof data?.workerConcurrencyLimit === 'number' &&
      Number.isFinite(data.workerConcurrencyLimit)
        ? clampNumber(Math.round(data.workerConcurrencyLimit), 1, 16)
        : DEFAULT_PREFERENCES.workerConcurrencyLimit,
    memoryPressureGuardEnabled: runtimeLimits.memoryPressureGuardEnabled,
    bypassCodexAppServerIdleTimeoutUnderCriticalPressure:
      runtimeLimits.bypassCodexAppServerIdleTimeoutUnderCriticalPressure,
    memoryPressureWarningThresholdBytes:
      runtimeLimits.memoryPressureWarningThresholdBytes,
    memoryPressureCriticalThresholdBytes:
      runtimeLimits.memoryPressureCriticalThresholdBytes,
    memoryDiagnosticsEnabled:
      typeof data?.memoryDiagnosticsEnabled === 'boolean'
        ? data.memoryDiagnosticsEnabled
        : DEFAULT_PREFERENCES.memoryDiagnosticsEnabled,
    keepSystemAwakeWhileAgentsActive:
      typeof data?.keepSystemAwakeWhileAgentsActive === 'boolean'
        ? data.keepSystemAwakeWhileAgentsActive
        : DEFAULT_PREFERENCES.keepSystemAwakeWhileAgentsActive,
    managedDelegationMaxDepth: normalizeManagedDelegationMaxDepth(
      data?.managedDelegationMaxDepth,
    ),
    managedDelegationMaxConcurrent: normalizeManagedDelegationMaxConcurrent(
      data?.managedDelegationMaxConcurrent,
    ),
    ...(data?.managedDelegationMode === undefined
      ? {}
      : {
          managedDelegationMode: normalizeManagedDelegationMode(
            data.managedDelegationMode,
          ),
        }),
    codexMultiAgentWorktreeChatsEnabled: normalizeBoolean(
      data?.codexMultiAgentWorktreeChatsEnabled,
      DEFAULT_PREFERENCES.codexMultiAgentWorktreeChatsEnabled,
    ),
    codexMultiAgentStandaloneChatsEnabled: normalizeBoolean(
      data?.codexMultiAgentStandaloneChatsEnabled,
      DEFAULT_PREFERENCES.codexMultiAgentStandaloneChatsEnabled,
    ),
    codexMaxConcurrentSubagents: normalizeCodexMaxConcurrentSubagents(
      data?.codexMaxConcurrentSubagents,
    ),
    codexMultiAgentPipelinesEnabled: normalizeBoolean(
      data?.codexMultiAgentPipelinesEnabled,
      DEFAULT_PREFERENCES.codexMultiAgentPipelinesEnabled,
    ),
    deferredToolsWorktreeChatsEnabled: normalizeBoolean(
      data?.deferredToolsWorktreeChatsEnabled,
      DEFAULT_PREFERENCES.deferredToolsWorktreeChatsEnabled ?? true,
    ),
    deferredToolsStandaloneChatsEnabled: normalizeBoolean(
      data?.deferredToolsStandaloneChatsEnabled,
      DEFAULT_PREFERENCES.deferredToolsStandaloneChatsEnabled ?? true,
    ),
    deferredToolsAppAdvisorEnabled: normalizeBoolean(
      data?.deferredToolsAppAdvisorEnabled,
      DEFAULT_PREFERENCES.deferredToolsAppAdvisorEnabled ?? true,
    ),
    deferredToolsPipelineAssistantEnabled: normalizeBoolean(
      data?.deferredToolsPipelineAssistantEnabled,
      DEFAULT_PREFERENCES.deferredToolsPipelineAssistantEnabled ?? true,
    ),
    lastOpenApp:
      typeof data?.lastOpenApp === 'string'
        ? data.lastOpenApp
        : DEFAULT_PREFERENCES.lastOpenApp,
    disabledOpenApps: Array.isArray(data?.disabledOpenApps)
      ? data.disabledOpenApps.filter(
          (v: unknown): v is string => typeof v === 'string',
        )
      : DEFAULT_PREFERENCES.disabledOpenApps,
    lastSelectedWorktreeProjectId:
      typeof data?.lastSelectedWorktreeProjectId === 'string'
        ? data.lastSelectedWorktreeProjectId
        : DEFAULT_PREFERENCES.lastSelectedWorktreeProjectId,
    lastSelectedWorktreeId:
      typeof data?.lastSelectedWorktreeId === 'string'
        ? data.lastSelectedWorktreeId
        : DEFAULT_PREFERENCES.lastSelectedWorktreeId,
    lastActiveContext: normalizeLastActiveContext(data?.lastActiveContext),
    executionDetailViewMode:
      data?.executionDetailViewMode === 'list' ||
      data?.executionDetailViewMode === 'flow'
        ? data.executionDetailViewMode
        : DEFAULT_PREFERENCES.executionDetailViewMode,
    worktreeViewMode:
      data?.worktreeViewMode === 'list' || data?.worktreeViewMode === 'kanban'
        ? data.worktreeViewMode
        : DEFAULT_PREFERENCES.worktreeViewMode,
    worktreeFilterHiddenWorkspaceIds: Array.isArray(
      data?.worktreeFilterHiddenWorkspaceIds,
    )
      ? data.worktreeFilterHiddenWorkspaceIds.filter(
          (v: unknown): v is string => typeof v === 'string',
        )
      : DEFAULT_PREFERENCES.worktreeFilterHiddenWorkspaceIds,
    auditRetentionDays: runtimeLimits.auditRetentionDays,
    automationRunRetentionDays: runtimeLimits.automationRunRetentionDays,
    theme: isThemeName(data?.theme) ? data.theme : DEFAULT_PREFERENCES.theme,
    colorMode: isColorMode(data?.colorMode)
      ? data.colorMode
      : DEFAULT_PREFERENCES.colorMode,
    sidebarAppearance: isSidebarAppearance(data?.sidebarAppearance)
      ? data.sidebarAppearance
      : DEFAULT_PREFERENCES.sidebarAppearance,
    worktreeDiffStatsStyle: isWorktreeDiffStatsStyle(
      data?.worktreeDiffStatsStyle,
    )
      ? data.worktreeDiffStatsStyle
      : DEFAULT_PREFERENCES.worktreeDiffStatsStyle,
    scrollbarBehavior: isScrollbarBehavior(data?.scrollbarBehavior)
      ? data.scrollbarBehavior
      : DEFAULT_PREFERENCES.scrollbarBehavior,
    linearChatEnrichmentMode: isChatEnrichmentMode(
      data?.linearChatEnrichmentMode,
    )
      ? data.linearChatEnrichmentMode
      : DEFAULT_LINEAR_CHAT_ENRICHMENT_MODE,
    githubChatEnrichmentMode: isChatEnrichmentMode(
      data?.githubChatEnrichmentMode,
    )
      ? data.githubChatEnrichmentMode
      : DEFAULT_GITHUB_CHAT_ENRICHMENT_MODE,
    // Clamped and snapped through the shared helper the Display slider and
    // the View-menu zoom items also use, so no surface can offer a scale the
    // store would rewrite behind it.
    uiScale: clampUiScale(
      typeof data?.uiScale === 'number' ? data.uiScale : undefined,
    ),
    // Always a boolean, on unless the user turned it off: preferences written
    // before the setting existed keep agents recording in the Ledger.
    ledgerAgentRecordingEnabled:
      typeof data?.ledgerAgentRecordingEnabled === 'boolean'
        ? data.ledgerAgentRecordingEnabled
        : DEFAULT_PREFERENCES.ledgerAgentRecordingEnabled,
    // On unless the user turned it off, as for preferences written before
    // the setting existed.
    repeatTaskAutomationSuggestionsEnabled:
      typeof data?.repeatTaskAutomationSuggestionsEnabled === 'boolean'
        ? data.repeatTaskAutomationSuggestionsEnabled
        : DEFAULT_PREFERENCES.repeatTaskAutomationSuggestionsEnabled,
    skillSuggestionsEnabled:
      typeof data?.skillSuggestionsEnabled === 'boolean'
        ? data.skillSuggestionsEnabled
        : DEFAULT_PREFERENCES.skillSuggestionsEnabled,
    // Off unless explicitly on; the next launch moves storage to match.
    rendererCodeCacheSchemeEnabled:
      data?.rendererCodeCacheSchemeEnabled === true,
    // Off unless explicitly on.
    chatLiveStepWindowEnabled: data?.chatLiveStepWindowEnabled === true,
    // Off unless explicitly on: every tool call shows as its own row.
    chatGroupToolCallsEnabled: data?.chatGroupToolCallsEnabled === true,
    // On unless the user turned it off.
    remoteControlEnabled: data?.remoteControlEnabled !== false,
    windowBounds: normalizeWindowBounds(data?.windowBounds),
    windowMaximized:
      typeof data?.windowMaximized === 'boolean'
        ? data.windowMaximized
        : DEFAULT_PREFERENCES.windowMaximized,
    windowFullScreen:
      typeof data?.windowFullScreen === 'boolean'
        ? data.windowFullScreen
        : DEFAULT_PREFERENCES.windowFullScreen,
    ollamaServerPort:
      typeof data?.ollamaServerPort === 'number' &&
      Number.isFinite(data.ollamaServerPort) &&
      data.ollamaServerPort > 0 &&
      data.ollamaServerPort <= 65535
        ? Math.round(data.ollamaServerPort)
        : DEFAULT_PREFERENCES.ollamaServerPort,
    // Transport contract: minimal shape normalization so the field is always
    // present. The full migration behavior (Windows/older-macOS compatibility,
    // legacy value mapping) is owned by the backend plan.
    ollamaConnectionMode:
      data?.ollamaConnectionMode === 'managed' ||
      data?.ollamaConnectionMode === 'manual'
        ? data.ollamaConnectionMode
        : DEFAULT_PREFERENCES.ollamaConnectionMode,
    ollamaExecutablePath: normalizeString(
      data?.ollamaExecutablePath,
      DEFAULT_PREFERENCES.ollamaExecutablePath,
    ),
    mcpProxyPort:
      typeof data?.mcpProxyPort === 'number' &&
      Number.isFinite(data.mcpProxyPort) &&
      data.mcpProxyPort > 0 &&
      data.mcpProxyPort <= 65535
        ? Math.round(data.mcpProxyPort)
        : DEFAULT_PREFERENCES.mcpProxyPort,
    hideAnthropicNav:
      typeof data?.hideAnthropicNav === 'boolean'
        ? data.hideAnthropicNav
        : DEFAULT_PREFERENCES.hideAnthropicNav,
    aiCreditsRoutingMode: isAiCreditsRoutingMode(data?.aiCreditsRoutingMode)
      ? data.aiCreditsRoutingMode
      : DEFAULT_PREFERENCES.aiCreditsRoutingMode,
    // Intentionally NOT defaulted: unset must stay unset so users who never
    // touch the "Use AI Credits" toggle preserve today's seeding behavior.
    lastChatBillingFramework: isChatBillingFramework(
      data?.lastChatBillingFramework,
    )
      ? data.lastChatBillingFramework
      : undefined,
    fileAutoSave:
      typeof data?.fileAutoSave === 'boolean'
        ? data.fileAutoSave
        : DEFAULT_PREFERENCES.fileAutoSave,
    inAppBrowserLocalServersOnly:
      typeof data?.inAppBrowserLocalServersOnly === 'boolean'
        ? data.inAppBrowserLocalServersOnly
        : DEFAULT_PREFERENCES.inAppBrowserLocalServersOnly,
    openAppLinksInBuiltInBrowser:
      typeof data?.openAppLinksInBuiltInBrowser === 'boolean'
        ? data.openAppLinksInBuiltInBrowser
        : DEFAULT_PREFERENCES.openAppLinksInBuiltInBrowser,
    useAsSystemDefaultBrowser:
      typeof data?.useAsSystemDefaultBrowser === 'boolean'
        ? data.useAsSystemDefaultBrowser
        : DEFAULT_PREFERENCES.useAsSystemDefaultBrowser,
    inAppNotifications: normalizeInAppNotifications(
      data?.inAppNotifications,
      data?.osNotifications,
    ),
    terminalDrawerCollapsed:
      typeof data?.terminalDrawerCollapsed === 'boolean'
        ? data.terminalDrawerCollapsed
        : DEFAULT_PREFERENCES.terminalDrawerCollapsed,
    terminalDrawerHeight:
      typeof data?.terminalDrawerHeight === 'number' &&
      Number.isFinite(data.terminalDrawerHeight)
        ? Math.min(
            MAX_TERMINAL_DRAWER_HEIGHT,
            Math.max(
              MIN_TERMINAL_DRAWER_HEIGHT,
              Math.round(data.terminalDrawerHeight),
            ),
          )
        : DEFAULT_PREFERENCES.terminalDrawerHeight,
    terminalDrawerActiveTabId: isBrowserDrawerTabId(
      data?.terminalDrawerActiveTabId,
    )
      ? data.terminalDrawerActiveTabId
      : DEFAULT_PREFERENCES.terminalDrawerActiveTabId,
    disabledTerminalShellProfileIds: Array.isArray(
      data?.disabledTerminalShellProfileIds,
    )
      ? Array.from(
          new Set(
            data.disabledTerminalShellProfileIds.filter(
              isTerminalShellProfileId,
            ),
          ),
        )
      : DEFAULT_PREFERENCES.disabledTerminalShellProfileIds,
    terminalPresets: normalizeTerminalPresets(data?.terminalPresets),
    osNotifications: normalizeOsNotifications(data?.osNotifications),
    voiceDictationEnabled:
      typeof data?.voiceDictationEnabled === 'boolean'
        ? data.voiceDictationEnabled
        : DEFAULT_PREFERENCES.voiceDictationEnabled,
    closeToTray:
      typeof data?.closeToTray === 'boolean'
        ? data.closeToTray
        : DEFAULT_PREFERENCES.closeToTray,
    globalFocusShortcutEnabled:
      typeof data?.globalFocusShortcutEnabled === 'boolean'
        ? data.globalFocusShortcutEnabled
        : DEFAULT_PREFERENCES.globalFocusShortcutEnabled,
    globalFocusShortcut: normalizeGlobalFocusShortcut(
      data?.globalFocusShortcut,
    ),
    activationQuietHours: normalizeActivationQuietHours(
      data?.activationQuietHours,
    ),
    promotionalNotifications: normalizePromotionalNotifications(
      data?.promotionalNotifications,
      normalizeOsNotifications(data?.osNotifications).categories.activation,
    ),
    ...(typeof data?.osNotificationsDeniedAt === 'string'
      ? { osNotificationsDeniedAt: data.osNotificationsDeniedAt }
      : {}),
    ...(osNotificationOfferAnsweredAt !== undefined
      ? { osNotificationOfferAnsweredAt }
      : {}),
    ...(typeof data?.closeToTrayDisclosedAt === 'string'
      ? { closeToTrayDisclosedAt: data.closeToTrayDisclosedAt }
      : {}),
    mcpHttpAuthDefaultHandler:
      data?.mcpHttpAuthDefaultHandler === 'canopy' ||
      data?.mcpHttpAuthDefaultHandler === 'provider' ||
      data?.mcpHttpAuthDefaultHandler === 'account'
        ? data.mcpHttpAuthDefaultHandler
        : DEFAULT_PREFERENCES.mcpHttpAuthDefaultHandler,
    fileIndexing: normalizeFileIndexingPreferences(data?.fileIndexing),
    planDetection: normalizePlanDetectionPreferences(data?.planDetection),
    fileLabels: normalizeFileLabels(data?.fileLabels),
    changedFilesHiddenLabelIds: Array.isArray(data?.changedFilesHiddenLabelIds)
      ? Array.from(
          new Set(
            data.changedFilesHiddenLabelIds.filter(
              (v: unknown): v is string => typeof v === 'string',
            ),
          ),
        )
      : DEFAULT_PREFERENCES.changedFilesHiddenLabelIds,
    autoDownloadUpdates:
      typeof data?.autoDownloadUpdates === 'boolean'
        ? data.autoDownloadUpdates
        : DEFAULT_PREFERENCES.autoDownloadUpdates,
    showDiagnosticsPill:
      typeof data?.showDiagnosticsPill === 'boolean'
        ? data.showDiagnosticsPill
        : DEFAULT_PREFERENCES.showDiagnosticsPill,
    onboardingCompleted,
    releaseHighlightsLastSeenVersion:
      typeof data?.releaseHighlightsLastSeenVersion === 'string'
        ? data.releaseHighlightsLastSeenVersion.trim() || null
        : null,
    guestSessionCount: Math.max(
      0,
      Math.floor(
        normalizeFiniteNumber(
          data?.guestSessionCount,
          DEFAULT_PREFERENCES.guestSessionCount ?? 0,
        ),
      ),
    ),
    guestUpgradeNudgeLastShownSessionCount: Math.max(
      0,
      Math.floor(
        normalizeFiniteNumber(
          data?.guestUpgradeNudgeLastShownSessionCount,
          DEFAULT_PREFERENCES.guestUpgradeNudgeLastShownSessionCount ?? 0,
        ),
      ),
    ),
    ...(typeof data?.mobileInstallCueSnoozedUntil === 'string' &&
    data.mobileInstallCueSnoozedUntil.trim().length > 0
      ? { mobileInstallCueSnoozedUntil: data.mobileInstallCueSnoozedUntil }
      : {}),
    ...(typeof data?.homeOnboardingDismissedAt === 'string' &&
    data.homeOnboardingDismissedAt.trim().length > 0
      ? { homeOnboardingDismissedAt: data.homeOnboardingDismissedAt }
      : {}),
    ...(homeOnboardingSuggestions !== undefined
      ? { homeOnboardingSuggestions }
      : {}),
    ...buildOnboardingProfileFields(data),
    ...(typeof data?.guestConsentAcceptedAt === 'string' &&
    data.guestConsentAcceptedAt.trim().length > 0
      ? { guestConsentAcceptedAt: data.guestConsentAcceptedAt }
      : {}),
    ...(typeof data?.guestConsentTosVersion === 'string' &&
    data.guestConsentTosVersion.trim().length > 0
      ? { guestConsentTosVersion: data.guestConsentTosVersion }
      : {}),
    ...(typeof data?.legalConsentAcceptedAt === 'string' &&
    data.legalConsentAcceptedAt.trim().length > 0
      ? { legalConsentAcceptedAt: data.legalConsentAcceptedAt }
      : {}),
    ...(typeof data?.legalConsentTosVersion === 'string' &&
    data.legalConsentTosVersion.trim().length > 0
      ? { legalConsentTosVersion: data.legalConsentTosVersion }
      : {}),
    personalWorkspaceCatalogSync:
      data?.personalWorkspaceCatalogSync === 'private' ? 'private' : 'off',
    personalCatalogOfferSeen: data?.personalCatalogOfferSeen === true,
    personalCatalogNotice:
      data?.personalCatalogNotice === 'collision' ||
      data?.personalCatalogNotice === 'removed' ||
      data?.personalCatalogNotice === 'full' ||
      data?.personalCatalogNotice === 'failed'
        ? data.personalCatalogNotice
        : null,
    ...(dataSharingOptInHints ? { dataSharingOptInHints } : {}),
    ...(dataSharingOptInHistory ? { dataSharingOptInHistory } : {}),
    ...(nativeProviderAccounts ? { nativeProviderAccounts } : {}),
    telemetrySharing: normalizeTelemetrySharing(data?.telemetrySharing),
    // Legacy tier marker: kept as read so older files round-trip; nothing
    // writes it, and plan changes never rewrite `telemetrySharing`.
    ...(data?.telemetrySharingTier === 'free' ||
    data?.telemetrySharingTier === 'paid'
      ? { telemetrySharingTier: data.telemetrySharingTier }
      : {}),
    telemetrySharingPromptSeen:
      typeof data?.telemetrySharingPromptSeen === 'boolean'
        ? data.telemetrySharingPromptSeen
        : DEFAULT_PREFERENCES.telemetrySharingPromptSeen,
    gitExecutablePath: normalizeString(
      data?.gitExecutablePath,
      DEFAULT_PREFERENCES.gitExecutablePath,
    ),
    appAdvisorProjectAgentAccess: normalizeAppAdvisorProjectAgentAccess(
      data?.appAdvisorProjectAgentAccess,
    ),
    codeGraph: normalizeCodeGraphPreferences(data?.codeGraph),
  };
}

/** Execution projection only. Mutations must use the stored view in updatePreferencesFile. */
export async function readPreferencesFile(): Promise<PreferencesData> {
  return readPreferencesData('runtime');
}

/** Read authority without recovery writes, for decisions that can delete persisted state. */
export async function readPreferencesFileDetailed(): Promise<{
  preferences: PreferencesData;
  authority: 'ok' | 'absent' | 'unreadable';
}> {
  let raw: string;
  try {
    raw = await readFile(getPreferencesFilePath(), 'utf8');
  } catch (error) {
    return {
      preferences: DEFAULT_PREFERENCES,
      authority: isMissingFileError(error) ? 'absent' : 'unreadable',
    };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      isRecord(parsed) &&
      parsed.version === 1 &&
      isRecord(parsed.preferences)
    ) {
      return {
        preferences: normalizePreferences(parsed.preferences),
        authority: 'ok',
      };
    }
  } catch {
    // Corrupt preferences cannot authorize destructive cleanup.
  }
  return { preferences: DEFAULT_PREFERENCES, authority: 'unreadable' };
}

async function readPersistedPreferencesFile(): Promise<PreferencesData> {
  return readPreferencesData('persisted');
}

async function readPreferencesData(
  validation: ModelSelectionValidation,
): Promise<PreferencesData> {
  const projectRecovery = (preferences: PreferencesData): PreferencesData =>
    validation === 'runtime' ? normalizePreferences(preferences) : preferences;
  const filePath = getPreferencesFilePath();
  let raw: string;

  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) {
      const lastGood = await readLastGoodPreferencesFile(filePath);
      if (lastGood) {
        const recoveryError = createPreferencesRecoveryError(
          filePath,
          'read',
          'Preferences file is missing.',
          undefined,
          'ENOENT',
        );
        try {
          return projectRecovery(
            await recoverPreferencesFile(
              filePath,
              recoveryError,
              null,
              undefined,
              lastGood,
            ),
          );
        } catch {
          lastPreferencesLoadError = {
            ...recoveryError,
            backupPath: undefined,
            restoredFromPath: lastGood.path,
            message:
              'Preferences file is missing and automatic recovery failed. Restored the last known good preferences without creating a recovered preferences file.',
          };
          return projectRecovery(lastGood.preferences);
        }
      }

      const lastGoodPath = createPreferencesLastGoodPath(filePath);
      try {
        await stat(lastGoodPath);
        lastPreferencesLoadError = {
          ...createPreferencesRecoveryError(
            filePath,
            'read',
            'Preferences file is missing and the last known good preferences could not be read.',
          ),
          backupPath: undefined,
          restoredFromPath: lastGoodPath,
        };
      } catch (lastGoodError) {
        if (!isMissingFileError(lastGoodError)) {
          lastPreferencesLoadError = {
            ...createPreferencesRecoveryError(
              filePath,
              'read',
              'Preferences file is missing and the last known good preferences could not be inspected.',
              undefined,
              getErrorCode(lastGoodError),
            ),
            backupPath: undefined,
            restoredFromPath: lastGoodPath,
          };
        }
      }
      return projectRecovery(DEFAULT_PREFERENCES);
    }

    const recoveryError = createPreferencesRecoveryError(
      filePath,
      'read',
      getErrorMessage(error),
      undefined,
      getErrorCode(error),
    );
    try {
      return projectRecovery(
        await recoverPreferencesFile(filePath, recoveryError, null, undefined),
      );
    } catch {
      lastPreferencesLoadError = recoveryError;
      return projectRecovery(DEFAULT_PREFERENCES);
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const recoveryError = createPreferencesRecoveryError(
      filePath,
      'parse',
      getErrorMessage(error),
    );
    try {
      return projectRecovery(
        await recoverPreferencesFile(filePath, recoveryError, raw, null),
      );
    } catch {
      lastPreferencesLoadError = recoveryError;
      return projectRecovery(DEFAULT_PREFERENCES);
    }
  }

  if (!isRecord(parsed) || parsed.version !== 1) {
    const actualVersion = isRecord(parsed) ? parsed.version : undefined;
    const recoveryError = createPreferencesRecoveryError(
      filePath,
      'version',
      'Unsupported preferences file version.',
      actualVersion,
    );
    try {
      return projectRecovery(
        await recoverPreferencesFile(filePath, recoveryError, raw, parsed),
      );
    } catch {
      lastPreferencesLoadError = recoveryError;
      return projectRecovery(DEFAULT_PREFERENCES);
    }
  }

  if (!isRecord(parsed.preferences)) {
    const recoveryError = createPreferencesRecoveryError(
      filePath,
      'parse',
      'Preferences payload does not contain a valid preferences object.',
    );
    try {
      return projectRecovery(
        await recoverPreferencesFile(filePath, recoveryError, raw, parsed),
      );
    } catch {
      lastPreferencesLoadError = recoveryError;
      return projectRecovery(DEFAULT_PREFERENCES);
    }
  }

  return normalizePreferences(parsed.preferences, validation);
}

/**
 * Whether this data directory already contains durable preferences state.
 *
 * Startup migrations use this before reading normalized defaults so a truly
 * new install (no primary or last-good file) stays distinguishable from an
 * existing user whose older file simply lacks a newly introduced field.
 */
export async function hasPersistedPreferencesFile(): Promise<boolean> {
  const filePath = getPreferencesFilePath();
  for (const candidate of [filePath, createPreferencesLastGoodPath(filePath)]) {
    const exists = await stat(candidate)
      .then(() => true)
      .catch((error: unknown) => {
        if (isMissingFileError(error)) {
          return false;
        }
        throw error;
      });
    if (exists) {
      return true;
    }
  }
  return false;
}

/**
 * Resolve `localMemoryEnabled` for launch paths that gate harness-native
 * memory suppression. Missing or unreadable preferences use the application
 * default; an explicitly persisted `false` remains an opt-out.
 */
export async function readLocalMemoryEnabledPreference(): Promise<boolean> {
  try {
    const preferences = await readPreferencesFile();
    return preferences.localMemoryEnabled === true;
  } catch {
    return DEFAULT_PREFERENCES.localMemoryEnabled;
  }
}

export function projectPreferencesForRuntime(
  preferences: PreferencesData,
): PreferencesData {
  if (rendererRuntimeProjection?.source === preferences) {
    return rendererRuntimeProjection.result;
  }
  const result = normalizePreferences(preferences);
  rendererRuntimeProjection = { source: preferences, result };
  return result;
}

export function invalidateRendererRuntimePreferencesCache(): void {
  rendererRuntimeProjection = null;
}

export async function readPreferencesFileForRenderer(
  options?: PreferencesProjectionOptions,
): Promise<PreferencesLoadResult> {
  const persisted = await readPersistedPreferencesForRenderer();
  if (options?.view === 'persisted') return persisted;
  return {
    ...projectPreferencesForRuntime(rendererPreferencesCache ?? persisted),
    ...(persisted.__dataDir ? { __dataDir: persisted.__dataDir } : {}),
    ...(persisted.__error ? { __error: persisted.__error } : {}),
  };
}

async function readPersistedPreferencesForRenderer(): Promise<PreferencesLoadResult> {
  if (rendererPreferencesCache) {
    return {
      ...rendererPreferencesCache,
      __dataDir: getResolvedCanopyDataDir(),
      ...(lastPreferencesLoadError
        ? { __error: lastPreferencesLoadError }
        : {}),
    };
  }
  if (preferencesRendererLoadOperation) {
    return preferencesRendererLoadOperation;
  }

  const loadOperation = (async (): Promise<PreferencesLoadResult> => {
    let preferences = await readPersistedPreferencesFile();
    if (
      lastPreferencesLoadError === null &&
      preferences.osNotifications.enabled &&
      preferences.osNotificationOfferAnsweredAt === undefined
    ) {
      // The renderer must receive durable suppression for enabled profiles.
      // Re-read inside the existing queue so a concurrent answer or Settings
      // change wins. The normalizer itself remains free of writes and clocks.
      preferences = await updatePreferencesFile((current) => {
        if (lastPreferencesLoadError !== null) {
          throw new Error(
            'Preferences could not be read for notification offer migration.',
          );
        }
        if (
          !current.osNotifications.enabled ||
          current.osNotificationOfferAnsweredAt !== undefined
        ) {
          return null;
        }
        return {
          osNotificationOfferAnsweredAt: notificationOfferMigrationTimestamp(),
        };
      });
    }
    rendererPreferencesCache = preferences;
    const dataDir = getResolvedCanopyDataDir();
    const loadError = lastPreferencesLoadError;
    if (loadError) {
      return {
        ...preferences,
        __dataDir: dataDir,
        __error: loadError,
      };
    }
    return {
      ...preferences,
      __dataDir: dataDir,
    };
  })();

  preferencesRendererLoadOperation = loadOperation;
  try {
    return await loadOperation;
  } finally {
    if (preferencesRendererLoadOperation === loadOperation) {
      preferencesRendererLoadOperation = null;
    }
  }
}

export async function writePreferencesFile(
  preferences: Partial<PreferencesData>,
): Promise<PreferencesData> {
  return updatePreferencesFile(() => preferences);
}

export async function updatePreferencesFile(
  updater: PreferencesUpdater,
  onCommitted?: PreferencesCommitObserver,
): Promise<PreferencesData> {
  const result = await updatePreferencesFileWithPrevious(updater, onCommitted);
  return result.next;
}

/** Model preferences whose default follows provider availability. */
const USER_SELECTED_MODEL_FLAGS = {
  summaryModel: 'summaryModelSetByUser',
  localMemoryModel: 'localMemoryModelSetByUser',
} as const satisfies Partial<
  Record<keyof PreferencesData, keyof PreferencesData>
>;

const MODEL_SELECTION_PREFERENCE_KEYS = [
  'summaryModel',
  'handoffSummaryModel',
  'worktreeSummaryModel',
  'planDiagramModel',
  'codeReviewModel',
  'prGenerationModel',
  'commitGenerationModel',
  'branchNamingModel',
  'pipelineAdvisorModel',
  'appAdvisorModel',
  'cronGenerationModel',
  'ifCommandGenerationModel',
  'splitPrPlannerModel',
  'agentRebaseResolutionModel',
  'localMemoryModel',
] as const satisfies readonly (keyof PreferencesData)[];

function normalizePreferenceUpdate(
  existing: PreferencesData,
  patch: Partial<PreferencesData>,
): PreferencesData {
  const merged = { ...existing, ...patch };
  // Preserve a read-derived legacy answer before a checklist reset can erase
  // its source, and the first durable answer when Settings and the offer race.
  const answer =
    existing.osNotificationOfferAnsweredAt ??
    normalizeOptInTimestamp(patch.osNotificationOfferAnsweredAt);
  if (answer !== undefined) {
    merged.osNotificationOfferAnsweredAt = answer;
  } else if (
    existing.osNotifications.enabled ||
    patch.osNotifications?.enabled === true
  ) {
    // Enabling notifications is an answer; disabling an already-enabled
    // profile must also retain its permanent suppression, even before loading
    // the renderer has triggered a separate migration write.
    merged.osNotificationOfferAnsweredAt =
      notificationOfferMigrationTimestamp();
  }
  for (const modelKey of ['summaryModel', 'localMemoryModel'] as const) {
    const flagKey = USER_SELECTED_MODEL_FLAGS[modelKey];
    // Writing a model is choosing it, unless the writer states otherwise
    // (the legacy summary-model migration records an inferred flag).
    if (modelKey in patch && !(flagKey in patch)) merged[flagKey] = true;
  }
  const normalized = normalizePreferences(merged, 'persisted');
  // Check the current disk value inside the main-owned write queue. A stale
  // renderer/remount must never roll back an already recorded release.
  if ('releaseHighlightsLastSeenVersion' in patch) {
    const previous = existing.releaseHighlightsLastSeenVersion;
    const recorded = previous === null ? null : parseReleaseVersion(previous);
    const next = normalized.releaseHighlightsLastSeenVersion;
    const requested = next === null ? null : parseReleaseVersion(next);
    if (
      recorded &&
      (!requested || compareReleaseVersions(requested, recorded) <= 0)
    ) {
      normalized.releaseHighlightsLastSeenVersion = previous;
    }
  }
  let available: PreferencesData | undefined;
  const validateChanges = (): PreferencesData =>
    (available ??= normalizePreferences(merged));

  for (const key of MODEL_SELECTION_PREFERENCE_KEYS) {
    if (
      key in patch &&
      normalizePersistableModelSelection(patch[key]) !== existing[key]
    ) {
      if (key === 'handoffSummaryModel' && !resolveAvailableModel(patch[key])) {
        throw new Error(
          'Choose an available conversation handoff model in Settings.',
        );
      }
      Object.assign(normalized, { [key]: validateChanges()[key] });
      if (key === 'summaryModel' || key === 'localMemoryModel') {
        const flagKey = USER_SELECTED_MODEL_FLAGS[key];
        Object.assign(normalized, { [flagKey]: validateChanges()[flagKey] });
      }
    }
  }

  for (const key of [
    'defaultChatModelByProvider',
    'defaultWorktreeModelByProvider',
  ] as const) {
    if (!(key in patch)) continue;
    for (const provider of [
      'claude',
      'codex',
      'ollama',
      'aiCredits',
    ] as const) {
      const selection = patch[key]?.[provider];
      if (
        normalizePersistableModelSelection(selection?.model) !==
        (existing[key][provider]?.model ?? null)
      ) {
        Object.assign(normalized[key], {
          [provider]: validateChanges()[key][provider],
        });
      }
    }
  }
  normalized.defaultChatProvider = normalizeDefaultProvider(
    merged.defaultChatProvider,
    normalized.defaultChatModelByProvider,
    DEFAULT_PREFERENCES.defaultChatProvider,
  );
  normalized.defaultWorktreeProvider = normalizeDefaultProvider(
    merged.defaultWorktreeProvider,
    normalized.defaultWorktreeModelByProvider,
    DEFAULT_PREFERENCES.defaultWorktreeProvider,
  );
  return normalized;
}

function notificationOfferMigrationTimestamp(): string {
  const filePath = getPreferencesFilePath();
  const existing = osNotificationOfferMigrationTimestamps.get(filePath);
  if (existing !== undefined) return existing;
  const timestamp = new Date().toISOString();
  osNotificationOfferMigrationTimestamps.set(filePath, timestamp);
  return timestamp;
}

export async function updatePreferencesFileWithPrevious(
  updater: PreferencesUpdater,
  onCommitted?: PreferencesCommitObserver,
): Promise<{ previous: PreferencesData; next: PreferencesData }> {
  const writeOperation = writePreferencesQueue.then(async () => {
    const filePath = getPreferencesFilePath();
    await mkdir(dirname(filePath), { recursive: true });

    const existing = await readPersistedPreferencesFile();
    const preferences = await updater(existing);
    if (preferences === null) {
      return { previous: existing, next: existing };
    }
    const normalized = normalizePreferenceUpdate(existing, preferences);

    await writePreferencesDataFile(filePath, normalized);
    if (existing.opencodeEnabled !== normalized.opencodeEnabled) {
      openCodeEnabledRevision++;
    }
    rendererPreferencesCache = normalized;
    if (
      JSON.stringify(existing.disabledInstalledItems ?? []) !==
        JSON.stringify(normalized.disabledInstalledItems ?? []) ||
      JSON.stringify(existing.parkedCodexPlugins ?? []) !==
        JSON.stringify(normalized.parkedCodexPlugins ?? [])
    ) {
      const { notifyInstalledItemsChanged } =
        await import('../installed-items/installed-item-events');
      notifyInstalledItemsChanged();
    }
    try {
      await writeLastGoodPreferencesFile(filePath, normalized);
    } catch (error) {
      // The authoritative file is already atomically committed. Treat the
      // recovery copy as best-effort so callers still publish the committed
      // state instead of leaving renderer caches stale.
      // eslint-disable-next-line no-console
      console.error(
        'Failed to refresh the last-good preferences backup:',
        error,
      );
    }
    // Run commit observers before releasing the serialized write queue. This
    // lets ordering metadata become visible atomically with the durable value,
    // so the next queued updater cannot mistake a committed write for a still
    // pending one.
    onCommitted?.(normalized);
    return { previous: existing, next: normalized };
  });

  writePreferencesQueue = writeOperation.then(
    () => undefined,
    () => undefined,
  );

  return writeOperation;
}

export async function flushPreferencesWrites(): Promise<void> {
  await writePreferencesQueue;
}

export async function readLatestPreferencesFile(): Promise<PreferencesData> {
  await writePreferencesQueue;
  return rendererPreferencesCache ?? readPreferencesFile();
}

export function invalidateRendererPreferencesCache(): void {
  rendererPreferencesCache = null;
  invalidateRendererRuntimePreferencesCache();
}

/**
 * Read the pending preferences load/recovery error WITHOUT consuming it.
 *
 * `readPreferencesFile()` silently falls back to defaults (or to a recovered
 * last-known-good file) when the real preferences file is unreadable, corrupt,
 * or on an unsupported version — callers cannot otherwise tell a genuine
 * "user has no such preference" from "we never managed to read their file".
 * Startup migrations use this to avoid acting on, and permanently marking
 * themselves against, preferences that were never actually observed.
 *
 * Non-clearing on purpose: the app shell acknowledges the error only after it
 * has surfaced the recovery notification to the user.
 */
export function peekPreferencesLoadError(): PreferencesLoadErrorDetails | null {
  return lastPreferencesLoadError;
}

/** Clear a recovery error after the app shell has surfaced it to the user. */
export function acknowledgePreferencesLoadError(): void {
  lastPreferencesLoadError = null;
}

export function resetPreferencesLoadErrorForTests(): void {
  lastPreferencesLoadError = null;
  preferencesRecoveryOperation = null;
  preferencesRendererLoadOperation = null;
  osNotificationOfferMigrationTimestamps.clear();
  invalidateRendererPreferencesCache();
  atomicWriteCounter = 0;
}
