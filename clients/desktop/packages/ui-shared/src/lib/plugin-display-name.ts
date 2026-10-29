const MARKETPLACE_TITLE_SMALL_WORDS = new Set([
  'a',
  'an',
  'and',
  'at',
  'by',
  'for',
  'from',
  'in',
  'of',
  'on',
  'or',
  'the',
  'to',
  'with',
]);

/** Acronyms and product spellings that generic capitalization would damage. */
const MARKETPLACE_TITLE_WORD_OVERRIDES: Readonly<Record<string, string>> = {
  '2fa': '2FA',
  '3d': '3D',
  '42crunch': '42Crunch',
  ai: 'AI',
  aftership: 'AfterShip',
  api: 'API',
  appfolio: 'AppFolio',
  chatgpt: 'ChatGPT',
  cli: 'CLI',
  clickup: 'ClickUp',
  crowdstrike: 'CrowdStrike',
  css: 'CSS',
  csv: 'CSV',
  dbt: 'dbt',
  github: 'GitHub',
  graphql: 'GraphQL',
  html: 'HTML',
  ios: 'iOS',
  javascript: 'JavaScript',
  json: 'JSON',
  linkedin: 'LinkedIn',
  llm: 'LLM',
  lsp: 'LSP',
  macos: 'macOS',
  mcp: 'MCP',
  mysql: 'MySQL',
  n8n: 'n8n',
  npm: 'npm',
  oauth: 'OAuth',
  openai: 'OpenAI',
  postgresql: 'PostgreSQL',
  qa: 'QA',
  sdk: 'SDK',
  seo: 'SEO',
  sql: 'SQL',
  ssh: 'SSH',
  tiktok: 'TikTok',
  typescript: 'TypeScript',
  ui: 'UI',
  url: 'URL',
  ux: 'UX',
  webgl: 'WebGL',
  webgpu: 'WebGPU',
  xml: 'XML',
  youtube: 'YouTube',
};

function marketplaceTitleWord(
  word: string,
  index: number,
  wordCount: number,
): string {
  if (word === '') return word;
  const lower = word.toLowerCase();
  const override = MARKETPLACE_TITLE_WORD_OVERRIDES[lower];
  if (override !== undefined) return override;
  if (
    index > 0 &&
    index < wordCount - 1 &&
    MARKETPLACE_TITLE_SMALL_WORDS.has(lower)
  ) {
    return lower;
  }
  // Preserve intentional product casing such as AirOps, bioRxiv, iPhone,
  // ChatGPT, and existing acronyms rather than flattening vendor names.
  if (/^[A-Z0-9]+$/.test(word) || /[a-z][A-Z]/.test(word)) {
    return word;
  }
  const firstLetterIndex = word.search(/[A-Za-z]/);
  if (firstLetterIndex < 0) return word;
  return `${word.slice(0, firstLetterIndex)}${word[firstLetterIndex].toUpperCase()}${word
    .slice(firstLetterIndex + 1)
    .toLowerCase()}`;
}

/**
 * Humanize and title-case a Marketplace capability name for display only.
 * Source ids, refs, filenames, and install keys deliberately keep their exact
 * provider values.
 */
export function marketplaceTitleCase(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') return trimmed;
  const identifierLike = /^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)+$/.test(trimmed);
  const words = (identifierLike ? trimmed.replace(/[-_]+/g, ' ') : trimmed)
    .replace(/_+/g, ' ')
    .split(/\s+/);

  return words
    .map((token, index): string => {
      const leading = token.match(/^[^A-Za-z0-9]*/)?.[0] ?? '';
      const trailing = token.match(/[^A-Za-z0-9]*$/)?.[0] ?? '';
      const core = token.slice(leading.length, token.length - trailing.length);
      if (core === '') return token;
      const parts = core.split(/([/+-])/);
      const formatted = parts
        .map((part): string =>
          part === '/' || part === '+' || part === '-'
            ? part
            : marketplaceTitleWord(part, index, words.length),
        )
        .join('');
      return `${leading}${formatted}${trailing}`;
    })
    .join(' ');
}

/** Prefer the manifest's spelling; humanize only identifier fallbacks. */
export function pluginDisplayName(plugin: {
  name: string;
  displayName?: string | null;
}): string {
  const displayName = plugin.displayName?.trim();
  return displayName || marketplaceTitleCase(plugin.name);
}
