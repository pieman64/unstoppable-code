import type { SlashCommandOption } from '../../types';
import { SOURCE_MEMBERS } from './commandSearch.benchmark.fixtures';

export interface BenchmarkCommand extends SlashCommandOption {
  readonly id: string;
  readonly plugin: string;
}

// Copied from composerCommands.ts, deliberately frozen rather than importing
// desktop code into this browser-safe, pure ranker benchmark.
const ACTIONS: readonly (readonly [string, string])[] = [
  ['plugins', 'Choose plugins and skills for this chat'],
  ['attach', 'Add an attachment to the draft'],
  ['workspace', 'Choose the parent workspace'],
  ['model', 'Choose the model for this chat'],
  ['thinking', 'Cycle the thinking level'],
  ['plan', 'Toggle plan mode'],
  ['fast', 'Cycle the Codex speed'],
  ['schedule', 'Schedule this message'],
  ['pipeline', 'Prepare a workflow task'],
  ['commands', 'Browse all commands'],
  ['help', 'Browse all commands'],
];

/** Scenario models, not forensic copies of Michael's or Sergii's machine. */
export const SCENARIOS = [
  {
    id: 'michael-chat',
    description:
      'Existing chat: PostHog and Slack discovered/enabled; UD plugins available.',
    enabledPlugins: ['posthog', 'slack'],
    inventoryOnly: false,
  },
  {
    id: 'sergii-home-cowork',
    description:
      'Cowork Home before discovery: PostHog selected, UD plugins available; all inventory fallbacks marked available by useComposerInventoryCommands.',
    enabledPlugins: ['posthog'],
    inventoryOnly: true,
  },
] as const;

export function buildBenchmarkInventory(
  scenario: (typeof SCENARIOS)[number],
): BenchmarkCommand[] {
  const actions = ACTIONS.map(
    ([name, description]): BenchmarkCommand => ({
      id: `action:${name}`,
      plugin: 'action',
      name,
      description,
      menuGroup: ['plugins', 'attach', 'model'].includes(name)
        ? 'Actions'
        : 'More actions',
    }),
  );
  const enabled: ReadonlySet<string> = new Set(scenario.enabledPlugins);
  const members = SOURCE_MEMBERS.map((member): BenchmarkCommand => {
    const discovered = !scenario.inventoryOnly && enabled.has(member.plugin);
    const qualifiedName = member.name.includes(':')
      ? member.name
      : `${member.plugin}:${member.name}`;
    // Match the Claude SDK's discovery DTO versus the cached Claude inventory
    // projection (plugin skills qualified in displayName, commands use name).
    return {
      id: member.id,
      plugin: member.plugin,
      name: discovered ? qualifiedName : member.name,
      displayName: discovered
        ? undefined
        : `/${member.kind === 'skill' ? qualifiedName : member.name}`,
      description: member.description,
      category: discovered ? undefined : member.plugin,
      namespace: member.plugin,
      section: discovered ? 'discovered' : 'available',
      menuGroup: 'Skills and commands',
    };
  });
  // Stable ordinal comparison avoids a machine-locale dependency. Production
  // inputs are alphabetically ordered discovery, then sorted cached fallbacks.
  members.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return [
    ...actions.filter((action) => action.menuGroup === 'Actions'),
    ...members.filter((member) => member.section !== 'available'),
    ...actions.filter((action) => action.menuGroup === 'More actions'),
    ...members.filter((member) => member.section === 'available'),
  ];
}

export interface GoldenQuery {
  readonly query: string;
  readonly kind: string;
  /** Any of these is an acceptable first answer; recall@3 uses the whole set. */
  readonly expected: readonly string[];
  /** Closed-world relevance labels, independent of current ranker output. */
  readonly relevant: readonly string[];
  readonly mustNotTop5: readonly string[];
}

const allIds = [
  ...SOURCE_MEMBERS.map((member) => member.id),
  ...ACTIONS.map(([name]) => `action:${name}`),
];

function label(
  query: string,
  kind: string,
  expected: readonly string[],
  relevantPrefixes: readonly string[] = expected,
): GoldenQuery {
  const relevant = allIds.filter((id) =>
    relevantPrefixes.some((prefix) => id === prefix || id.startsWith(prefix)),
  );
  return {
    query,
    kind,
    expected,
    relevant,
    mustNotTop5: allIds.filter((id) => !relevant.includes(id)),
  };
}

const ecom = 'ud-ecom-debugger:ecom-debugger';
const reviewer = 'ud-code-review:code-reviewer';
function namespaceLabel(query: string, plugin: string): GoldenQuery {
  return label(
    query,
    'namespace',
    SOURCE_MEMBERS.filter((member) => member.plugin === plugin).map(
      (member) => member.id,
    ),
    [`${plugin}:`],
  );
}
const reviewFamily = [
  'ud-code-review:',
  'code-review:',
  'pr-review-toolkit:',
  'superpowers:requesting-code-review',
  'superpowers:receiving-code-review',
  'builtin-orchestrate:review',
  'posthog:review-hog-perspective-',
  'posthog:review-hog-validation-criteria',
  'posthog:review-hog-blind-spots-',
];

function shortPrefixLabel(query: string): GoldenQuery {
  const expected = [
    ...SOURCE_MEMBERS.filter(
      (member) =>
        member.name.startsWith(query) || member.plugin.startsWith(query),
    ).map((member) => member.id),
    ...ACTIONS.filter(([name]) => name.startsWith(query)).map(
      ([name]) => `action:${name}`,
    ),
  ];
  return label(query, 'short', expected);
}

// Labels express a task, not merely string overlap. Broad/short queries accept
// several top answers and are reported separately from exact-name queries.
// Multi-word intents are ranker probes: today's inline trigger closes on space.
export const GOLDEN_QUERIES: readonly GoldenQuery[] = [
  label('ecom-debugger', 'exact', [ecom]),
  label('/ecom-debugger', 'trigger', [ecom]),
  label('$ecom-debugger', 'trigger', [ecom]),
  label('ECOM-DEBUGGER', 'case', [ecom]),
  label('  ECOM-DEBUGGER  ', 'case', [ecom]),
  label('ud-ecom-debugger:ecom-debugger', 'qualified', [ecom]),
  label('/ud-ecom-debugger:ecom-debugger', 'trigger', [ecom]),
  namespaceLabel('ud-ecom-debugger', 'ud-ecom-debugger'),
  label('ud-ecom', 'prefix', [ecom], ['ud-ecom-debugger:']),
  label('ecomm-debugger', 'typo', [ecom]),
  label('/ecomm-debugger', 'typo', [ecom]),
  label('ecom-debbuger', 'typo', [ecom]),
  label('debugger', 'partial', [ecom]),
  label('ecom debug', 'tokens', [ecom]),
  label('ecom_debugger', 'separator', [ecom]),
  label(
    'investigate',
    'exact',
    ['ud-ecom-debugger:investigate'],
    ['ud-ecom-debugger:'],
  ),
  label('investigate order', 'intent', [ecom, 'ud-ecom-debugger:investigate']),
  label('payment problems', 'intent', [ecom]),
  label('domain/order', 'description', [ecom]),
  label('code-reviewer', 'skill', [reviewer]),
  label('ud-code-review:code-reviewer', 'qualified', [reviewer]),
  namespaceLabel('ud-code-review', 'ud-code-review'),
  namespaceLabel('/ud-code-review', 'ud-code-review'),
  label('code review', 'tokens', [reviewer], reviewFamily),
  label(
    'review',
    'partial',
    [reviewer, 'ud-code-review:review', 'builtin-orchestrate:review'],
    reviewFamily,
  ),
  label('reveiw', 'typo', [reviewer, 'ud-code-review:review'], reviewFamily),
  label(
    'review my pr',
    'intent',
    [reviewer, 'ud-code-review:review-multi'],
    reviewFamily,
  ),
  label('review-loop', 'exact', ['ud-code-review:review-loop']),
  label('make-pr-green', 'exact', ['ud-code-review:make-pr-green']),
  label('make pr green', 'tokens', ['ud-code-review:make-pr-green']),
  label('docs-triage', 'exact', ['ud-code-review:docs-triage']),
  label('review-multi', 'exact', ['ud-code-review:review-multi']),
  namespaceLabel('superpowers', 'superpowers'),
  label('systematic-debugging', 'exact', ['superpowers:systematic-debugging']),
  label('brainstorm', 'prefix', [
    'superpowers:brainstorming',
    'superpowers:brainstorm',
  ]),
  label('writing-plans', 'exact', ['superpowers:writing-plans']),
  label('test-driven-development', 'exact', [
    'superpowers:test-driven-development',
  ]),
  namespaceLabel('plugin-dev', 'plugin-dev'),
  label('mcp-integration', 'exact', ['plugin-dev:mcp-integration']),
  label('plugin settings', 'tokens', ['plugin-dev:plugin-settings']),
  label('playground', 'exact', ['playground:playground']),
  namespaceLabel('posthog', 'posthog'),
  label('debugging-experiments', 'exact', ['posthog:debugging-experiments']),
  label('triaging-error-issues', 'exact', ['posthog:triaging-error-issues']),
  namespaceLabel('slack', 'slack'),
  label('slack-search', 'exact', ['slack:slack-search']),
  label('summarize-channel', 'exact', ['slack:summarize-channel']),
  label('find-discussions', 'exact', ['slack:find-discussions']),
  namespaceLabel('builtin-gh', 'builtin-gh'),
  label('open-pr', 'exact', ['builtin-gh:open-pr', 'ud-git:open-pr']),
  label('plugins', 'action', ['action:plugins']),
  label('attach', 'action', ['action:attach']),
  label('workspace', 'action', ['action:workspace']),
  label('model', 'action', ['action:model']),
  label('thinking', 'action', ['action:thinking']),
  label('plan', 'action', ['action:plan']),
  label('fast', 'action', ['action:fast']),
  label('schedule', 'action', ['action:schedule']),
  label('pipeline', 'action', ['action:pipeline']),
  label('commands', 'action', ['action:commands', 'action:help']),
  label('help', 'action', ['action:help']),
  label('/MODEL', 'trigger', ['action:model']),
  label('$attach', 'trigger', ['action:attach']),
  shortPrefixLabel('p'),
  shortPrefixLabel('re'),
  shortPrefixLabel('ec'),
  label(
    'ph',
    'short',
    SOURCE_MEMBERS.filter((member) => member.plugin === 'posthog').map(
      (member) => member.id,
    ),
    ['posthog:'],
  ),
];

/** The editor consumes one trigger; searchSlashCommands itself does not. */
export function rankerQuery(input: string): string {
  return input.trim().replace(/^[$/]/, '');
}
