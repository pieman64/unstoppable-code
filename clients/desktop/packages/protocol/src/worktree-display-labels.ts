// Generated worktree display labels, shared by the desktop app and the cloud
// server. Pure: a model proposes a label with how clear the task is, and these
// helpers decide whether it is specific enough, and supported enough by the
// conversation, to name the worktree in the sidebar. Display labels are never
// Git branch names.

import {
  DEFAULT_WORKTREE_DISPLAY_NAME,
  NEW_WORKTREE_DISPLAY_NAME,
} from './worktree-branch-names';

/**
 * How clearly the conversation shows what the worktree is for. `provisional`
 * names a likely subject that later turns may change; `unclear` proposes none.
 */
export type GeneratedWorktreeLabelClarity = 'clear' | 'provisional' | 'unclear';

export interface GeneratedWorktreeLabelCandidate {
  label: string;
  clarity: GeneratedWorktreeLabelClarity;
}

export type GeneratedWorktreeLabelVerdict =
  | { kind: 'accepted'; label: string; provisional: boolean }
  | {
      kind: 'rejected';
      reason: 'unclear' | 'malformed' | 'generic' | 'unsupported';
    };

/** The label fields of a worktree row that automatic naming reads. */
export interface WorktreeLabelProvenance {
  label?: string;
  labelSource?: 'generated' | 'manual';
  labelProvisional?: true;
}

const GENERATED_WORKTREE_LABEL_MAX_LENGTH = 48;
const GENERATED_WORKTREE_LABEL_MIN_WORDS = 2;
const GENERATED_WORKTREE_LABEL_MAX_WORDS = 6;
const EVIDENCE_STEM_LENGTH = 5;

/** Instructions for the model that proposes a display label. */
export const GENERATED_WORKTREE_LABEL_INSTRUCTIONS = [
  'Also return `displayLabel`, the name shown for this work in the sidebar, and `displayLabelClarity`.',
  'The display label is 2-6 words in sentence case with no trailing punctuation. Name the concrete subject and the purpose of the work, for example "Cloud worktree setup failure", "Cloud memory and project sync" or "Test triage coordinator".',
  'Base it on what the user is actually working on across the conversation, the changes, and any linked ticket or pull request. Ignore greetings and vague opening messages when later turns say what the work is.',
  'Never return a generic name such as "Multiple worktrees", "Fix issues", "General discussion", "Code changes" or "New task", and never invent a subject the evidence does not mention.',
  'Set `displayLabelClarity` to "clear" when the purpose is evident, "provisional" when a subject is likely but not settled, and "unclear" when there is not enough context to name it. With "unclear", return an empty displayLabel.',
].join('\n');

const STOP_WORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'by',
  'for',
  'from',
  'in',
  'into',
  'of',
  'on',
  'or',
  'the',
  'to',
  'up',
  'via',
  'vs',
  'with',
]);

// Words that say there is work without saying what it is about. A label made
// only of these (and stop words) names nothing.
const GENERIC_WORDS: ReadonlySet<string> = new Set([
  'app',
  'branch',
  'branche',
  'bug',
  'change',
  'chat',
  'cleanup',
  'code',
  'conversation',
  'discussion',
  'feature',
  'fix',
  'fixe',
  'fixing',
  'follow',
  'followup',
  'general',
  'greeting',
  'hello',
  'help',
  'hey',
  'hi',
  'implementation',
  'implement',
  'improvement',
  'initial',
  'investigation',
  'investigate',
  'issue',
  'misc',
  'miscellaneous',
  'minor',
  'multiple',
  'new',
  'pr',
  'problem',
  'project',
  'question',
  'quick',
  'refactor',
  'repo',
  'repository',
  'request',
  'review',
  'session',
  'setup',
  'several',
  'small',
  'some',
  'start',
  'stuff',
  'support',
  'task',
  'test',
  'testing',
  'thing',
  'todo',
  'untitled',
  'update',
  'various',
  'work',
  'working',
  'worktree',
]);

const PLACEHOLDER_LABELS: ReadonlySet<string> = new Set(
  [DEFAULT_WORKTREE_DISPLAY_NAME, NEW_WORKTREE_DISPLAY_NAME].map((name) =>
    name.toLowerCase(),
  ),
);

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** A crude singular, so "issues" and "issue" compare equal. */
function singular(word: string): string {
  return word.length > 3 && word.endsWith('s') && !word.endsWith('ss')
    ? word.slice(0, -1)
    : word;
}

function contentWords(label: string): string[] {
  return words(label)
    .filter((word) => !STOP_WORDS.has(word))
    .map(singular);
}

function stem(word: string): string {
  return singular(word).slice(0, EVIDENCE_STEM_LENGTH);
}

/**
 * Collapses whitespace, strips wrapping quotes and trailing punctuation, and
 * capitalizes the first letter. Null when the result is outside 2-6 words or
 * longer than `GENERATED_WORKTREE_LABEL_MAX_LENGTH`.
 */
export function normalizeGeneratedWorktreeLabel(raw: string): string | null {
  const collapsed = raw
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'`‘“]+|["'`’”]+$/g, '')
    .replace(/[\s.,;:!?…-]+$/u, '')
    .trim();
  const wordCount = collapsed.split(' ').filter(Boolean).length;
  if (
    collapsed.length === 0 ||
    collapsed.length > GENERATED_WORKTREE_LABEL_MAX_LENGTH ||
    wordCount < GENERATED_WORKTREE_LABEL_MIN_WORDS ||
    wordCount > GENERATED_WORKTREE_LABEL_MAX_WORDS
  ) {
    return null;
  }
  return `${collapsed.charAt(0).toUpperCase()}${collapsed.slice(1)}`;
}

/** True when a label says there is work but not what it is about. */
function isGenericWorktreeLabel(label: string): boolean {
  if (PLACEHOLDER_LABELS.has(label.trim().toLowerCase())) return true;
  return contentWords(label).every((word) => GENERIC_WORDS.has(word));
}

/**
 * True when at least half of the label's specific words (and at least one)
 * appear in the evidence, compared by a short stem so "syncing" supports
 * "sync" and "memories" supports "memory".
 */
function isWorktreeLabelSupportedByEvidence(
  label: string,
  evidence: string,
): boolean {
  const specific = contentWords(label).filter(
    (word) => !GENERIC_WORDS.has(word),
  );
  if (specific.length === 0) return false;
  const evidenceStems = new Set(words(evidence).map(stem));
  const supported = specific.filter((word) =>
    evidenceStems.has(stem(word)),
  ).length;
  return supported >= Math.ceil(specific.length / 2);
}

/** Validates a proposed label against the conversation it should describe. */
export function evaluateGeneratedWorktreeLabel(
  candidate: GeneratedWorktreeLabelCandidate,
  evidence: string,
): GeneratedWorktreeLabelVerdict {
  if (candidate.clarity === 'unclear') {
    return { kind: 'rejected', reason: 'unclear' };
  }
  const label = normalizeGeneratedWorktreeLabel(candidate.label);
  if (label === null) return { kind: 'rejected', reason: 'malformed' };
  if (isGenericWorktreeLabel(label)) {
    return { kind: 'rejected', reason: 'generic' };
  }
  if (!isWorktreeLabelSupportedByEvidence(label, evidence)) {
    return { kind: 'rejected', reason: 'unsupported' };
  }
  return {
    kind: 'accepted',
    label,
    provisional: candidate.clarity === 'provisional',
  };
}

/**
 * Whether automatic naming may set this row's label: it has none, or it has a
 * provisional generated one. A manual label, a label with no source (saved
 * before provenance existed) and a settled generated label are kept.
 */
export function canGenerateWorktreeLabel(
  row: WorktreeLabelProvenance,
): boolean {
  if (row.labelSource === 'manual') return false;
  if (row.labelSource === 'generated') return row.labelProvisional === true;
  return (row.label?.trim() ?? '') === '';
}
