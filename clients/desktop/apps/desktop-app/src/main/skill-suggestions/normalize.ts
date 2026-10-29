/**
 * Prompt normalization and similarity for repeat-task skill suggestions
 * (CAN-385). Clustering and live matching both score pairs through
 * {@link pairScore}, so the two can never drift apart.
 */

/** Stored excerpts and tokenized text are at most this long. */
export const MAX_PROMPT_EXCERPT_CHARS = 1000;
/**
 * Prompts are cut to this length before any regular expression runs. The
 * margin past the excerpt cap lets redaction see a whole secret that crosses
 * the cap before the excerpt is cut.
 */
export const MAX_PROMPT_INPUT_CHARS = MAX_PROMPT_EXCERPT_CHARS + 256;

export const SLOT_TOKENS = [
  '<url>',
  '<path>',
  '<ticket>',
  '<num>',
  '<sha>',
  '<quote>',
] as const;
const SLOT_TOKEN_SET: ReadonlySet<string> = new Set(SLOT_TOKENS);

const PROMPT_WEIGHT = 0.75;
const TOOL_WEIGHT = 0.25;

// Ordered: a URL contains a path, a quoted string can contain anything.
const SLOT_PASSES: ReadonlyArray<{ pattern: RegExp; slot: string }> = [
  { pattern: /\bhttps?:\/\/[^\s<>"'`]+/gi, slot: ' <url> ' },
  { pattern: /"[^"\n]{1,200}"|`[^`\n]{1,200}`/g, slot: ' <quote> ' },
  {
    pattern:
      /(?:~|\.{1,2})?(?:\/[\w.@-]+){2,}\/?|\b[\w-]+(?:\/[\w.@-]+)+\.[a-z0-9]{1,8}\b|\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|rb|go|rs|java|kt|swift|yml|yaml|toml|css|scss|html|sql|sh|txt)\b/gi,
    slot: ' <path> ',
  },
  { pattern: /\b[A-Z][A-Z0-9]{1,9}-\d+\b/g, slot: ' <ticket> ' },
  { pattern: /(?:^|\s)#\d+\b/g, slot: ' <ticket> ' },
  {
    pattern: /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/gi,
    slot: ' <sha> ',
  },
  { pattern: /\b\d+(?:[.,:]\d+)*\b/g, slot: ' <num> ' },
];

const STOPWORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'can',
  'could',
  'do',
  'for',
  'from',
  'have',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'just',
  'me',
  'my',
  'of',
  'on',
  'or',
  'our',
  'please',
  's',
  'so',
  't',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'this',
  'to',
  'up',
  'us',
  'was',
  'we',
  'what',
  'when',
  'with',
  'would',
  'you',
  'your',
]);

// Letters and digits, including non-Latin scripts; the general punctuation
// block is excluded. Main targets below ES2015, so no `u` flag.
const TOKEN_PATTERN =
  /<(?:url|path|ticket|num|sha|quote)>|[a-z0-9\u00c0-\u1fff\u2070-\u2dff\u3040-\ufeff]+/g;
// A skill name starts with a letter, so `$5` or `/2` is never a skill.
const LEADING_SKILL_PATTERN = /^\s*[/$]([a-z][\w.:-]{0,79})(?=\s|$)/i;

export interface PromptShape {
  /** De-duplicated, sorted prompt tokens, slot tokens included. */
  tokens: readonly string[];
  /** Ordered, de-duplicated tool shape. */
  tools: readonly string[];
}

/** The skill a prompt invokes with a leading `/name` or `$name`, if any. */
export function leadingSkillInvocation(text: string): string | null {
  const match = LEADING_SKILL_PATTERN.exec(
    text.slice(0, MAX_PROMPT_EXCERPT_CHARS),
  );
  const name = match?.[1];
  return name ? name.toLowerCase() : null;
}

/**
 * Lowercased tokens of a prompt with volatile values replaced by slot tokens
 * and stopwords removed. A leading skill invocation is not part of the text;
 * it is recorded in the tool shape instead.
 */
export function normalizePromptTokens(text: string): string[] {
  let working = text.slice(0, MAX_PROMPT_EXCERPT_CHARS);
  working = working.replace(LEADING_SKILL_PATTERN, ' ');
  for (const { pattern, slot } of SLOT_PASSES) {
    working = working.replace(pattern, slot);
  }
  const tokens = new Set<string>();
  const lowered = working.toLowerCase();
  const pattern = new RegExp(TOKEN_PATTERN.source, TOKEN_PATTERN.flags);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(lowered)) !== null) {
    const token = match[0];
    if (!STOPWORDS.has(token)) tokens.add(token);
  }
  return Array.from(tokens).sort();
}

export function isSlotToken(token: string): boolean {
  return SLOT_TOKEN_SET.has(token);
}

/** Tokens that carry meaning: slot tokens never count. */
export function countContentTokens(tokens: readonly string[]): number {
  let count = 0;
  for (const token of tokens) if (!isSlotToken(token)) count += 1;
  return count;
}

export function sharedContentTokenCount(
  a: readonly string[],
  b: readonly string[],
): number {
  const right = new Set(b);
  let shared = 0;
  for (const token of Array.from(new Set(a))) {
    if (!isSlotToken(token) && right.has(token)) shared += 1;
  }
  return shared;
}

/**
 * Clustering and live matching both require this many shared content tokens
 * on top of the pair score, so near-empty prompts never link on the score
 * alone.
 */
export const MIN_SHARED_CONTENT_TOKENS = 3;

/** Jaccard similarity of two token sets; two empty sets are identical. */
export function jaccard(a: readonly string[], b: readonly string[]): number {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const token of Array.from(left)) {
    if (right.has(token)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** 0.75 × prompt Jaccard + 0.25 × tool-shape Jaccard. Symmetric. */
export function pairScore(a: PromptShape, b: PromptShape): number {
  return (
    PROMPT_WEIGHT * jaccard(a.tokens, b.tokens) +
    TOOL_WEIGHT * jaccard(a.tools, b.tools)
  );
}

/** Appends `entry` to an ordered tool shape unless it is already present. */
export function appendToolShape(tools: string[], entry: string): void {
  if (!tools.includes(entry)) tools.push(entry);
}

/** Maps a provider tool name to its tool-shape entry, or `null` to skip it. */
export function toolShapeEntry(
  name: string,
  input?: { skill?: unknown },
): string | null {
  if (name === 'Task' || name === 'Agent' || name === 'spawnAgent') return null;
  if (name === 'Skill') {
    const skill =
      typeof input?.skill === 'string' ? input.skill.trim().toLowerCase() : '';
    return skill ? `skill:${skill}` : null;
  }
  if (name.startsWith('mcp__')) {
    const server = name.split('__')[1];
    return server ? `mcp:${server}` : null;
  }
  return name;
}

/** Skill names (without the `skill:` prefix) from a tool shape, in order. */
export function skillsInToolShape(tools: readonly string[]): string[] {
  const skills: string[] = [];
  for (const entry of tools) {
    if (entry.startsWith('skill:')) skills.push(entry.slice('skill:'.length));
  }
  return skills;
}
