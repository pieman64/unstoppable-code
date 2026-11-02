/**
 * The composer's plan-mode suggestion heuristic (CAN-4008): does a draft read
 * like a long, multi-step task? Intentionally simple and English-oriented.
 * Long ordinary prose alone does not qualify; pasted unfenced logs and
 * punctuation can still produce false positives. Matching is linear in the
 * input length.
 */

/** A long prompt qualifies with at least this many sequencing signals. */
export const PLAN_MODE_SUGGESTION_LONG_WORDS = 80;
export const PLAN_MODE_SUGGESTION_LONG_STEP_SIGNALS = 3;
/** A shorter prompt qualifies with at least this many list items. */
export const PLAN_MODE_SUGGESTION_LIST_WORDS = 40;
export const PLAN_MODE_SUGGESTION_LIST_ITEMS = 3;
/** More nonempty sentences than this add one sequencing signal. */
export const PLAN_MODE_SUGGESTION_SENTENCES = 4;
/** Quiet time after the last text change before a draft is evaluated. */
export const PLAN_MODE_SUGGESTION_DEBOUNCE_MS = 600;

/** Longest first, so `and then` is one signal rather than a `then`. */
const SEQUENCE_PHRASES: readonly string[] = [
  'after that',
  'once that',
  'and then',
  'finally',
  'lastly',
  'second',
  'first',
  'third',
  'then',
  'next',
];

const LIST_MARKER = /^\s*(?:\d+[.)]|[-*•])\s+(?=\S)/;
const FENCE = /^\s*(`{3,}|~{3,})/;

export interface PlanModeSuggestionSignals {
  words: number;
  listItems: number;
  stepSignals: number;
}

/** Lines outside fenced code. An unclosed fence excludes the rest. */
function proseLines(text: string): string[] {
  const lines: string[] = [];
  let fence: string | null = null;
  for (const line of text.split('\n')) {
    const marker = FENCE.exec(line)?.[1];
    if (fence !== null) {
      if (
        marker !== undefined &&
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        line.trim() === marker
      ) {
        fence = null;
      }
      continue;
    }
    if (marker !== undefined) {
      fence = marker;
      continue;
    }
    lines.push(line);
  }
  return lines;
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[\p{L}\p{N}_]/u.test(char);
}

function startsWithPhrase(line: string, index: number): boolean {
  for (const phrase of SEQUENCE_PHRASES) {
    if (
      line.slice(index, index + phrase.length).toLowerCase() === phrase &&
      !isWordChar(line[index + phrase.length])
    ) {
      return true;
    }
  }
  return false;
}

function isBoundary(char: string): boolean {
  return char === '.' || char === '!' || char === '?' || char === ';';
}

function isSentenceTerminator(char: string): boolean {
  return char === '.' || char === '!' || char === '?';
}

/** Count words, list items, and sequencing signals outside fenced code. */
export function countPlanModeSuggestionSignals(
  text: string,
): PlanModeSuggestionSignals {
  let words = 0;
  let listItems = 0;
  let phrases = 0;
  let sentences = 0;
  let sentenceHasContent = false;

  for (const line of proseLines(text)) {
    for (const token of line.split(/\s+/)) {
      if (token !== '') words += 1;
    }
    const marker = LIST_MARKER.exec(line);
    const listItem = marker !== null;
    if (listItem) listItems += 1;
    // A list marker's own `1.` is neither a sentence terminator nor a
    // phrase boundary, and a phrase leading a counted item is not counted.
    const content = listItem ? line.slice(marker[0].length) : line;
    let atBoundary = !listItem;
    for (let index = 0; index < content.length; index += 1) {
      const char = content.charAt(index);
      if (/\s/.test(char)) continue;
      if (atBoundary && startsWithPhrase(content, index)) phrases += 1;
      atBoundary = isBoundary(char);
      if (isSentenceTerminator(char)) {
        if (sentenceHasContent) sentences += 1;
        sentenceHasContent = false;
      } else if (char !== ';') {
        sentenceHasContent = true;
      }
    }
  }
  if (sentenceHasContent) sentences += 1;

  return {
    words,
    listItems,
    stepSignals:
      listItems +
      phrases +
      (sentences > PLAN_MODE_SUGGESTION_SENTENCES ? 1 : 0),
  };
}

/** Whether a composer draft reads like a long, multi-step task. */
export function isLongMultiStepPrompt(text: string): boolean {
  const { words, listItems, stepSignals } =
    countPlanModeSuggestionSignals(text);
  return (
    (words >= PLAN_MODE_SUGGESTION_LONG_WORDS &&
      stepSignals >= PLAN_MODE_SUGGESTION_LONG_STEP_SIGNALS) ||
    (words >= PLAN_MODE_SUGGESTION_LIST_WORDS &&
      listItems >= PLAN_MODE_SUGGESTION_LIST_ITEMS)
  );
}

/** Match the composer's effective provider presentation; keep host rules shared. */
export function isPlanModeReadOnly(provider: string | undefined): boolean {
  return (
    provider === 'cursor' || provider === 'copilot' || provider === 'opencode'
  );
}

/** Snapshot the composer's effective gates for accepted-send lesson retirement. */
export function isGenuinePlanModeUse({
  planMode,
  planReadOnly,
  pipelineMode,
  planAvailable,
}: {
  planMode: boolean;
  planAvailable: boolean;
  planReadOnly: boolean;
  pipelineMode: boolean;
}): boolean {
  return planAvailable && planMode && !planReadOnly && !pipelineMode;
}
