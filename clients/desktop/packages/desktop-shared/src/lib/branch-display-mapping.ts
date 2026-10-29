import type { BranchDisplayMapping } from '../types';

const BUILTIN_BRANCH_DISPLAY_MAPPINGS: BranchDisplayMapping[] = [
  {
    id: 'builtin-strip-path-date',
    label: 'Strip path + date prefix',
    matcher: '^(?:[^\\/]+\\/)+\\d{4}-\\d{2}-\\d{2}-(.+)$',
    result: '$1',
    settings: { replaceHyphens: true, capitalize: true },
    enabled: false,
    builtin: true,
    examples: [
      'tirish/2026-04-30-something-here',
      'user/my-feature',
      'user/ticket-1234-my-feature',
      'feature/my-feature',
    ],
    readonlyExampleCount: 4,
  },
  {
    id: 'builtin-extract-ticket',
    label: 'Extract ticket',
    matcher: '^(?:[^\\/]+\\/)+([a-zA-Z]+-\\d+)[\\/-](.+)$',
    result: '[$1] $2',
    settings: { replaceHyphens: true, capitalize: true },
    enabled: false,
    builtin: true,
    examples: [
      'user/ticket-1234/my-feature',
      'user/my-feature',
      'user/ticket-1234-my-feature',
      'feature/my-feature',
    ],
    readonlyExampleCount: 4,
  },
  {
    id: 'builtin-ticket-prefix',
    label: 'Strip ticket prefix',
    matcher: '^(?:[^\\/]+\\/)*[a-zA-Z]+-\\d+[/_-](.+)$',
    result: '$1',
    settings: { replaceHyphens: true, capitalize: true },
    enabled: false,
    builtin: true,
    examples: [
      'PROJ-123-fix-login-bug',
      'JIRA-456_add-dark-mode',
      'user/my-feature',
      'user/ticket-1234-my-feature',
      'user/ticket-1234/my-feature',
    ],
    readonlyExampleCount: 5,
  },
  {
    id: 'builtin-branch-type',
    label: 'Strip branch type',
    matcher: '^(?:feature|fix|hotfix|bugfix|chore|refactor)[/_-](.+)$',
    result: '$1',
    settings: { replaceHyphens: true, capitalize: true },
    enabled: false,
    builtin: true,
    examples: [
      'feature/dark-mode',
      'fix-broken-login',
      'user/my-feature',
      'user/ticket-1234-my-feature',
      'feature/my-feature',
    ],
    readonlyExampleCount: 5,
  },
  {
    id: 'builtin-strip-path',
    label: 'Strip path prefix',
    matcher: '^(?:[^\\/]+\\/)+(.+)$',
    result: '$1',
    settings: { replaceHyphens: true, capitalize: true },
    enabled: false,
    builtin: true,
    examples: [
      'feature/dark-mode-support',
      'user/my-feature',
      'user/ticket-1234-my-feature',
      'feature/my-feature',
    ],
    readonlyExampleCount: 4,
  },
  {
    id: 'builtin-no-prefix',
    label: 'No prefix',
    matcher: '^([^\\/]+)$',
    result: '$1',
    settings: { replaceHyphens: true, capitalize: true },
    enabled: false,
    builtin: true,
    examples: [
      'my-feature-branch',
      'user/my-feature',
      'user/ticket-1234-my-feature',
      'feature/my-feature',
    ],
    readonlyExampleCount: 4,
  },
];

function postProcess(
  value: string,
  settings: BranchDisplayMapping['settings'],
): string {
  let result = value;
  if (settings.replaceHyphens) {
    // Replace hyphens/underscores between alphanumeric and letter chars,
    // preserving tokens like "ticket-123" (letter-hyphen-digit stays)
    result = result.replace(/(?<=[a-zA-Z0-9])[-_](?=[a-zA-Z])/g, ' ');
  }
  if (settings.capitalize) {
    result = result.replace(/\b\w/g, (ch) => ch.toUpperCase());
  }
  return result;
}

export function applyBranchDisplayMapping(
  branchName: string,
  mapping: BranchDisplayMapping,
): string | null {
  try {
    const regex = new RegExp(mapping.matcher);
    const match = regex.exec(branchName);
    if (!match) return null;
    const replaced = mapping.result.replace(
      /\$(\d+)/g,
      (_full, groupIndex: string) => {
        const idx = parseInt(groupIndex, 10);
        return match[idx] ?? '';
      },
    );
    return postProcess(replaced, mapping.settings);
  } catch {
    return null;
  }
}

export function applyBranchDisplayMappings(
  branchName: string,
  mappings: BranchDisplayMapping[],
): string {
  for (const mapping of mappings) {
    if (!mapping.enabled) continue;
    const result = applyBranchDisplayMapping(branchName, mapping);
    if (result !== null) return result;
  }
  return branchName;
}

export function isValidRegex(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

export function mergeMappingsWithBuiltins(
  persisted: BranchDisplayMapping[],
): BranchDisplayMapping[] {
  const builtinMap = new Map<string, BranchDisplayMapping>(
    BUILTIN_BRANCH_DISPLAY_MAPPINGS.map((b) => [b.id, b]),
  );
  const seenBuiltinIds = new Set<string>();

  const result: BranchDisplayMapping[] = persisted.map((m) => {
    const builtin = builtinMap.get(m.id);
    if (!builtin) return m;
    seenBuiltinIds.add(m.id);
    // User-added examples are those beyond the old readonly count
    const userExamples = m.examples.slice(m.readonlyExampleCount);
    return {
      ...builtin,
      enabled: m.enabled,
      examples: [...builtin.examples, ...userExamples],
      readonlyExampleCount: builtin.readonlyExampleCount,
    };
  });

  for (const builtin of BUILTIN_BRANCH_DISPLAY_MAPPINGS) {
    if (!seenBuiltinIds.has(builtin.id)) {
      result.push(builtin);
    }
  }

  return result;
}
