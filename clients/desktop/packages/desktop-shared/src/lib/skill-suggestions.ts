import type { IPCResult } from '../types/pipeline';

/**
 * Repeat-task skill suggestions (CAN-385). Main detects requests a user keeps
 * making across chats, confirms them in an idle scan, and offers to turn them
 * into a custom skill. These are the portable shapes shared by main, preload
 * and renderer; they never carry host paths or raw private-workspace text.
 */
export type SkillSuggestionKind = 'prompt' | 'chain';

/** Open states are listed and matched; the rest are terminal. */
export type SkillSuggestionState =
  | 'confirmed'
  | 'shown'
  | 'accepted'
  | 'dismissed'
  | 'expired';
export type OpenSkillSuggestionState = Extract<
  SkillSuggestionState,
  'confirmed' | 'shown'
>;

export type SkillSuggestionResolution = 'shown' | 'dismissed' | 'accepted';

export interface SkillSuggestionOrigin {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

/** The owner whose work produced the suggestion, never mixed across owners. */
export type SkillSuggestionOwner =
  | { kind: 'personal' }
  | { kind: 'organization'; organizationId: string };

export interface SkillSuggestion {
  id: string;
  kind: SkillSuggestionKind;
  title: string;
  /** Cluster members plus every distinct later match. */
  occurrenceCount: number;
  summary: string;
  proposedSkillName: string;
  proposedDescription: string;
  parameters: string[];
  /** Skill names in invocation order; empty for prompt suggestions. */
  chainSkills: string[];
  /** Up to three redacted example requests; always empty for private work. */
  examples: string[];
  owner: SkillSuggestionOwner;
  /** Display label for the owner: Personal, an organization, or a workspace. */
  ownerLabel: string;
  /** Built from a private workspace: no examples, summary-only drafting. */
  isPrivate: boolean;
  lastSeenAt: number;
  state: OpenSkillSuggestionState;
}

export interface PendingSkillSuggestion {
  /** Identifies this chat's pending entry; a banner resolution echoes it. */
  id: string;
  suggestion: SkillSuggestion;
  state: 'pending' | 'shown';
}

export const SKILL_SUGGESTION_MODAL_SOURCE = 'suggestions_modal';

export type ResolveSkillSuggestionRequest =
  | (SkillSuggestionOrigin & {
      source: 'banner';
      pendingId: string;
      suggestionId: string;
      resolution: SkillSuggestionResolution;
    })
  | {
      source: typeof SKILL_SUGGESTION_MODAL_SOURCE;
      suggestionId: string;
      resolution: Exclude<SkillSuggestionResolution, 'shown'>;
    };

/**
 * Scan confirmations and modal resolutions carry no origin; the renderer
 * refetches `list` on every event and `getPending` on ones for its chat.
 */
export interface SkillSuggestionChangedEvent {
  origin?: SkillSuggestionOrigin;
}

export const SKILL_SUGGESTION_CHANNELS = {
  getPending: 'skill-suggestion:get-pending',
  list: 'skill-suggestion:list',
  resolve: 'skill-suggestion:resolve',
  changed: 'skill-suggestion:changed',
} as const;

export interface SkillSuggestionsAPI {
  getPending(
    origin: SkillSuggestionOrigin,
  ): Promise<IPCResult<PendingSkillSuggestion | null>>;
  list(): Promise<IPCResult<SkillSuggestion[]>>;
  resolve(request: ResolveSkillSuggestionRequest): Promise<IPCResult<boolean>>;
  onChanged(callback: (event: SkillSuggestionChangedEvent) => void): () => void;
}

/** Field limits the scan validator enforces on model output. */
export const SKILL_SUGGESTION_LIMITS = {
  titleMax: 60,
  summaryMax: 240,
  descriptionMax: 240,
  parametersMax: 5,
  parameterMax: 40,
  examplesMax: 3,
} as const;

export const SKILL_SUGGESTION_SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,48}$/;

/** First line of the drafting prompt for a prompt suggestion. */
export const SKILL_SUGGESTION_DRAFT_PROMPT_LEAD =
  'I keep asking for the same kind of task. Help me turn it into a custom skill.';

const CHAIN_DRAFT_LEAD_PREFIX = 'I keep running these skills in this order: ';
const CHAIN_DRAFT_LEAD_SUFFIX = ' Help me combine them into one custom skill.';

/** First line of the drafting prompt for a chain suggestion. */
export function skillSuggestionChainDraftLead(
  skills: readonly string[],
): string {
  return `${CHAIN_DRAFT_LEAD_PREFIX}${skills.join(' → ')}.${CHAIN_DRAFT_LEAD_SUFFIX}`;
}

/**
 * Whether a prompt is a sent drafting prompt. Every draft shares a long fixed
 * template, so recording them would make drafts cluster into a suggestion of
 * their own.
 */
export function isSkillSuggestionDraftPrompt(text: string): boolean {
  const lead = (text.trimStart().split('\n', 1)[0] ?? '').trim();
  return (
    lead === SKILL_SUGGESTION_DRAFT_PROMPT_LEAD ||
    (lead.startsWith(CHAIN_DRAFT_LEAD_PREFIX) &&
      lead.endsWith(CHAIN_DRAFT_LEAD_SUFFIX))
  );
}

export function isSkillSuggestionResolution(
  value: unknown,
): value is SkillSuggestionResolution {
  return value === 'shown' || value === 'dismissed' || value === 'accepted';
}

function boundedId(value: unknown): value is string {
  return (
    typeof value === 'string' && value.trim().length > 0 && value.length <= 4096
  );
}

export function isSkillSuggestionOrigin(
  value: unknown,
): value is SkillSuggestionOrigin {
  return (
    !!value &&
    typeof value === 'object' &&
    'projectId' in value &&
    'worktreeId' in value &&
    'chatId' in value &&
    boundedId(value.projectId) &&
    boundedId(value.worktreeId) &&
    boundedId(value.chatId)
  );
}

export function isSkillSuggestionResolveRequest(
  value: unknown,
): value is ResolveSkillSuggestionRequest {
  if (!value || typeof value !== 'object') return false;
  if (!('source' in value && 'suggestionId' in value && 'resolution' in value))
    return false;
  if (!boundedId(value.suggestionId)) return false;
  if (value.source === SKILL_SUGGESTION_MODAL_SOURCE) {
    return value.resolution === 'dismissed' || value.resolution === 'accepted';
  }
  return (
    value.source === 'banner' &&
    'pendingId' in value &&
    boundedId(value.pendingId) &&
    isSkillSuggestionResolution(value.resolution) &&
    isSkillSuggestionOrigin(value)
  );
}
