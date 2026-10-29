/** Catalog identity survives until an installed runtime reference is available. */
export interface TryItCapability {
  kind: 'plugin' | 'mcp' | 'skill';
  /** Full marketplace/source/share identity, never a display name. */
  sourceId: string;
  /** Stable entry key within that source. */
  catalogId: string;
  name: string;
}

/** Recoverable launch state. Persist per account AND capability, before handoff. */
export interface TryItLaunch {
  version: 1;
  accountId: string;
  requestId: string;
  capability: TryItCapability;
  /** Caller-minted id reused by create retries; never infer deletion from a cache miss. */
  chatId: string;
  prompt: string;
  destination: 'cloud' | 'standalone';
  /** Only an acknowledged submission advances to completed. Uncertain responses stay pending. */
  status: 'pending' | 'completed';
}

export const MAX_TRY_IT_CAPABILITIES = 200;

/** `sourceId` of a curated MCP catalog entry; `catalogId` is its catalog key. */
export const CURATED_MCP_TRY_IT_SOURCE_ID = 'curated-mcp';
/** `sourceId` of a device-local MCP server; `catalogId` is its server id. */
export const LOCAL_MCP_TRY_IT_SOURCE_ID = 'local-mcp';
/** `sourceId` of an uncurated account MCP connection; `catalogId` is its server key. */
export const ACCOUNT_MCP_TRY_IT_SOURCE_ID = 'account-mcp';

export function isTryItCapability(value: unknown): value is TryItCapability {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const entry: Record<string, unknown> = { ...value };
  return (
    Object.keys(entry).every((key) =>
      ['kind', 'sourceId', 'catalogId', 'name'].includes(key),
    ) &&
    typeof entry.kind === 'string' &&
    ['plugin', 'mcp', 'skill'].includes(entry.kind) &&
    ['sourceId', 'catalogId', 'name'].every(
      (key) =>
        typeof entry[key] === 'string' &&
        entry[key].trim().length > 0 &&
        entry[key].length <= 256 &&
        entry[key]
          .split('')
          .every(
            (character) =>
              character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
          ),
    )
  );
}

export function isTryItCapabilityArray(
  value: unknown,
): value is TryItCapability[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_TRY_IT_CAPABILITIES &&
    value.every(isTryItCapability)
  );
}

/** Tuple serialization avoids separator collisions and cross-account reuse. */
export function buildTryItCapabilityKey(
  accountId: string,
  capability: TryItCapability,
): string {
  return JSON.stringify([
    accountId,
    capability.kind,
    capability.sourceId,
    capability.catalogId,
  ]);
}

export function normalizeTryItCapabilities(
  values: readonly TryItCapability[],
): TryItCapability[] {
  const seen = new Set<string>();
  return values.flatMap((entry) => {
    const key = buildTryItCapabilityKey('', entry);
    if (seen.has(key)) return [];
    seen.add(key);
    return [
      {
        kind: entry.kind,
        sourceId: entry.sourceId,
        catalogId: entry.catalogId,
        name: entry.name,
      },
    ];
  });
}

export function resolveDetailPrimaryCta(input: {
  account: 'loading' | 'guest' | 'signed-in';
  installation: 'loading' | 'pending' | 'installed' | 'not-installed';
  /**
   * Whether the supported harness facts have resolved. Missing harness setup
   * must retain the Try it launch; it does not change installation state.
   */
  runtime?: 'loading' | 'ready' | 'setup-required';
}): 'try' | 'install' | 'pending' {
  if (
    input.account === 'loading' ||
    input.installation === 'loading' ||
    input.installation === 'pending'
  )
    return 'pending';
  if (input.account === 'signed-in' && input.installation === 'not-installed')
    return 'install';
  if (input.runtime === 'loading') return 'pending';
  return 'try';
}

/** Fallback Try it prompts stay one short sentence. */
export const TRY_IT_PROMPT_MAX_LENGTH = 140;

/**
 * Task verbs a capability description commonly opens with. Third-person,
 * `-ies`, and gerund forms are matched against these bases.
 */
const TASK_VERBS = [
  'access',
  'add',
  'analyze',
  'analyse',
  'answer',
  'audit',
  'automate',
  'book',
  'browse',
  'build',
  'capture',
  'check',
  'clean',
  'compare',
  'compose',
  'convert',
  'create',
  'debug',
  'deploy',
  'design',
  'detect',
  'diagnose',
  'draft',
  'edit',
  'explain',
  'explore',
  'export',
  'extract',
  'fetch',
  'fill',
  'find',
  'fix',
  'format',
  'generate',
  'get',
  'import',
  'inspect',
  'list',
  'look',
  'manage',
  'map',
  'migrate',
  'monitor',
  'organize',
  'organise',
  'plan',
  'post',
  'prepare',
  'process',
  'publish',
  'pull',
  'query',
  'read',
  'record',
  'refactor',
  'reply',
  'report',
  'research',
  'retrieve',
  'review',
  'run',
  'scan',
  'schedule',
  'search',
  'send',
  'share',
  'sort',
  'summarize',
  'summarise',
  'test',
  'track',
  'transcribe',
  'translate',
  'triage',
  'turn',
  'update',
  'upload',
  'validate',
  'view',
  'visualize',
  'write',
];

/** Setup verbs say how a capability is wired, not what to try with it. */
const SETUP_VERBS = ['connect', 'integrate', 'link', 'sync'];

const DANGLING_WORDS = new Set([
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
  'my',
  'of',
  'on',
  'or',
  'the',
  'to',
  'with',
  'your',
]);

function verbBase(word: string): string | null {
  const lower = word.toLowerCase();
  for (const base of TASK_VERBS.concat(SETUP_VERBS)) {
    if (
      lower === base ||
      lower === `${base}s` ||
      lower === `${base}es` ||
      (base.endsWith('y') && lower === `${base.slice(0, -1)}ies`) ||
      lower === `${base}ing` ||
      lower === `${base}${base.slice(-1)}ing` ||
      (base.endsWith('e') && lower === `${base.slice(0, -1)}ing`)
    )
      return base;
  }
  return null;
}

/** First sentence of the first paragraph, as plain text. */
function firstSentence(description: string): string {
  const paragraph =
    description
      .split(/\n\s*\n/)
      .map((part) => part.trim())
      .find((part) => part.length > 0) ?? '';
  const plain = paragraph
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_>#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.split(/(?<=[.!?])\s/)[0]?.replace(/[.!?\s]+$/, '') ?? '';
}

/** Cuts a phrase at its first subordinate clause and swaps in first person. */
function taskClause(phrase: string): string {
  return phrase
    .split(
      /\s*[;:(]\s*|\s+[-\u2013\u2014]\s+|,?\s+(?:so|while|when|whenever|because|which|without|where)\s+/i,
    )[0]
    .replace(/\byour\b/gi, 'my')
    .replace(/\byours\b/gi, 'mine')
    .trim();
}

/** A verb phrase as an imperative, or `null` when it does not open with one. */
function imperative(phrase: string, allowSetup = false): string | null {
  const [first, ...rest] = phrase.split(' ');
  const base = first ? verbBase(first) : null;
  if (!first || !base || (!allowSetup && SETUP_VERBS.includes(base)))
    return null;
  // `Summarizes PRs and drafts replies`: verbs listed after a third-person
  // opener are third-person too, so they take the imperative as well.
  const thirdPerson = first.toLowerCase() !== base;
  const words = rest.map((word, index) => {
    const previous = rest[index - 1] ?? '';
    const listed =
      ['and', 'or'].includes(previous.toLowerCase()) || previous.endsWith(',');
    const listedBase = listed ? verbBase(word) : null;
    return thirdPerson && listedBase && word.toLowerCase().endsWith('s')
      ? listedBase
      : word;
  });
  return [base, ...words].join(' ');
}

function fitTask(prefix: string, task: string): string | null {
  const words = task.split(' ');
  while (words.length > 0) {
    while (
      words.length > 0 &&
      DANGLING_WORDS.has(
        words[words.length - 1].toLowerCase().replace(/,$/, ''),
      )
    )
      words.pop();
    const sentence = `${prefix}${words.join(' ').replace(/,$/, '')}.`;
    if (words.length >= 2 && sentence.length <= TRY_IT_PROMPT_MAX_LENGTH)
      return sentence;
    words.pop();
  }
  return null;
}

/**
 * A short, runnable example task built from a description's opening
 * sentence: never the description itself.
 */
function exampleTask(name: string, description: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sentence = firstSentence(description);
  let subject = sentence
    .replace(new RegExp(`^${escaped}(?:'s)?\\s+`, 'i'), '')
    .replace(
      /^(?:(?:this|the|a|an|official)\s+)*(?:[\w-]+\s+){0,3}?(?:plugin|skill|mcp server|mcp|server|integration|tool|toolkit|connector|extension|app)\b\s*/i,
      '',
    );
  const nounMatch = /^(?:is|are)\s+((?:a|an|the)\s+.+)$/i.exec(subject);
  if (nounMatch) {
    const noun = taskClause(nounMatch[1]);
    const sentenceWithNoun = `Try one quick, real task with ${name}, ${noun}, and show me the result.`;
    return sentenceWithNoun.length <= TRY_IT_PROMPT_MAX_LENGTH
      ? sentenceWithNoun
      : null;
  }
  subject = subject
    .replace(/^(?:is|are)\s+/i, '')
    .replace(/^(?:that|which)\s+/i, '')
    .replace(
      /^(?:lets|helps|allows|enables)\s+(?:you|users|claude|codex|agents?|(?:your|the)\s+(?:agent|assistant)|ai assistants?|assistants?)\s+(?:to\s+)?/i,
      '',
    )
    .replace(/^(?:helps|lets)\s+/i, '')
    .replace(/^(?:used to|designed to|built to|a way to|to|for)\s+/i, '');
  const prefix = `Using ${name}, `;
  // `X connects your notes so your assistant can pull context`: the purpose
  // clause is the task, the opening verb only names the wiring.
  const purpose =
    /\b(?:so(?:\s+that)?|letting|allowing)\s+(?:you|users|claude|codex|agents?|(?:your|the)\s+(?:agent|assistant|ai))\s+(?:can\s+|to\s+)?(.+)$/i.exec(
      subject,
    )?.[1];
  const candidates = [
    imperative(taskClause(subject)),
    purpose ? imperative(taskClause(purpose), true) : null,
  ];
  for (const task of candidates) {
    const fitted = task ? fitTask(prefix, task) : null;
    if (fitted) return fitted;
  }
  return null;
}

export function buildTryItPrompt(input: {
  kind: TryItCapability['kind'];
  name: string;
  description?: string | null;
  tryNowPrompt?: string | null;
  frontmatter?: Record<string, unknown> | null;
}): string {
  const explicit = input.tryNowPrompt?.trim();
  if (explicit) return explicit;
  if (input.kind === 'skill') {
    for (const key of ['example', 'usage', 'example_prompt']) {
      const value = input.frontmatter?.[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  const kind = input.kind === 'mcp' ? 'MCP server' : input.kind;
  const name = input.name.trim().replace(/\s+/g, ' ');
  return (
    exampleTask(name, input.description ?? '') ??
    `Using the ${name} ${kind}, run one quick, real example and show me the result.`
  );
}

/** Harnesses a Try it chat can run on, in fallback order. */
export const TRY_IT_HARNESSES = ['claude', 'codex', 'cursor'] as const;
export type TryItHarness = (typeof TRY_IT_HARNESSES)[number];

export interface TryItHarnessOption {
  harness: TryItHarness;
  /** The capability runs on this harness (the detail page's Harness rows). */
  supported: boolean;
  /** This viewer can start a chat on it now. */
  available: boolean;
}

/**
 * The harness a Try it chat starts on: the viewer's default when the
 * capability runs there, else the first supported, available harness in
 * `options` order. `null` means setup is required; never start a chat on an
 * unsupported harness.
 */
export function resolveTryItHarness(input: {
  preferred: TryItHarness | null;
  options: readonly TryItHarnessOption[];
}): TryItHarness | null {
  const usable = input.options.filter(
    (option) => option.supported && option.available,
  );
  return (
    usable.find((option) => option.harness === input.preferred)?.harness ??
    usable[0]?.harness ??
    null
  );
}

/** The catalog fields `resolveTryItModelId` reads from a model row. */
export interface TryItModelOption {
  id: string;
  provider: string;
  /** Execution harness; a native row runs on its provider. */
  harness?: string;
  available: boolean;
  libraryEligibility?: 'available' | 'locked';
}

/**
 * The model to pin so a Try it chat runs on a supported harness, by the
 * `resolveTryItHarness` rule over a host's model catalog. `undefined` keeps
 * `currentModelId`: it is supported, or nothing supported can run.
 */
export function resolveTryItModelId(input: {
  models: readonly TryItModelOption[];
  currentModelId: string | undefined;
  support: Partial<Record<TryItHarness, boolean>>;
}): string | undefined {
  const harnessOf = (option: TryItModelOption): TryItHarness | null =>
    TRY_IT_HARNESSES.find(
      (harness) => harness === (option.harness ?? option.provider),
    ) ?? null;
  const usable = input.models.filter(
    (option) => option.available && option.libraryEligibility !== 'locked',
  );
  const current = input.models.find(
    (option) => option.id === input.currentModelId,
  );
  const preferred = current ? harnessOf(current) : null;
  const chosen = resolveTryItHarness({
    preferred,
    options: TRY_IT_HARNESSES.map((harness) => ({
      harness,
      supported: input.support[harness] === true,
      available:
        harness === preferred ||
        usable.some((option) => harnessOf(option) === harness),
    })),
  });
  if (!chosen || chosen === preferred) return undefined;
  return usable.find((option) => harnessOf(option) === chosen)?.id;
}

/** Legacy skill helper signature, shared with the public-share adapter. */
export function buildSkillStarterPrompt(input: {
  name: string;
  description: string;
  frontmatter: Record<string, unknown> | null;
}): string {
  return buildTryItPrompt({ ...input, kind: 'skill' });
}
