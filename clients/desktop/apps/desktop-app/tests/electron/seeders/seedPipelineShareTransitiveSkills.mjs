import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { writeJson } from './fsHelpers.mjs';
import { seedStoredPipeline } from './seedStoredPipeline.mjs';

export const TRANSITIVE_SKILL_PIPELINE_ID = 'transitive-skill-share';
const MARKETPLACE_ID = 'e2e/review-market';
const PLUGIN_NAME = 'review';

export function seedPipelineShareTransitiveSkills(userDataDir) {
  const pluginRoot = path.join(userDataDir, 'fixtures', 'review-plugin');
  const loopDir = path.join(pluginRoot, 'skills', 'review-loop');
  const multiDir = path.join(pluginRoot, 'skills', 'review-multi');
  const commandsDir = path.join(pluginRoot, 'commands');
  mkdirSync(loopDir, { recursive: true });
  mkdirSync(multiDir, { recursive: true });
  mkdirSync(commandsDir, { recursive: true });
  writeFileSync(
    path.join(loopDir, 'SKILL.md'),
    [
      '---',
      'name: review-loop',
      'description: Iterate reviews until approval',
      '---',
      '# Review loop',
      'Parse $ARGUMENTS and resolve $OWNER/$REPO#$PR_NUMBER.',
      'Read $HEAD_SHA, $LAST_BODY, $TRAILER, and $COMBINED_SCORE/10.',
      'Use the Perl expression /<!-- data: (\\{.*?\\}) -->/g.',
      'Inspect `docs/projects/<repo-name>/` in the target repository.',
      'Use [this placeholder](../path/to/page.md) as a link template.',
      'Re-gather with `--state-token=<token>` after each action.',
      'Invoke $review:review-multi after parsing the shell values.',
      '',
    ].join('\n'),
  );
  writeFileSync(
    path.join(multiDir, 'SKILL.md'),
    [
      '---',
      'name: review-multi',
      'description: Review with multiple models',
      '---',
      '# Multi review',
      'Review the current change.',
      '',
    ].join('\n'),
  );
  writeFileSync(
    path.join(commandsDir, 'open-pr.md'),
    '# Open PR\n\nRun /review:review-multi before opening the PR.\n',
  );
  writeFileSync(
    path.join(commandsDir, 'review-multi.md'),
    '# Multi review\n\nReview the current change.\n',
  );

  const skills = [
    {
      name: 'review-loop',
      description: 'Iterate reviews until approval',
      path: 'skills/review-loop',
    },
    {
      name: 'review-multi',
      description: 'Review with multiple models',
      path: 'skills/review-multi',
    },
  ];
  const codexDetails = {
    skills,
    agents: [],
    commands: [],
    apps: [],
    hooks: [],
    mcpServers: [],
    lspServers: [],
    hasReadme: false,
  };
  const claudeCommands = [
    {
      name: 'open-pr',
      description: 'Open a pull request',
      filePath: 'commands/open-pr.md',
    },
    {
      name: 'review-multi',
      description: 'Review with multiple models',
      filePath: 'commands/review-multi.md',
    },
  ];
  const claudeDetails = {
    skills: [],
    agents: [],
    commands: claudeCommands,
    apps: [],
    hooks: [],
    mcpServers: [],
    lspServers: [],
    hasReadme: false,
  };
  writeJson(path.join(userDataDir, 'plugins-cache.json'), {
    version: 2,
    lastRefreshed: '2026-08-31T00:00:00.000Z',
    lastProviderRefreshAt: '2026-08-31T00:00:00.000Z',
    marketplaces: [
      {
        id: MARKETPLACE_ID,
        name: 'E2E Review Market',
        sourceType: 'github',
        sourceUrl: 'e2e/review-market',
        installLocation: pluginRoot,
        pluginCount: 1,
        plugins: [
          {
            name: PLUGIN_NAME,
            description: 'Review plugin fixture',
            sourcePath: pluginRoot,
            marketplaceId: MARKETPLACE_ID,
            providerSupport: { claude: 'native', codex: 'native' },
            facets: {
              claude: {
                provider: 'claude',
                mode: 'native',
                name: PLUGIN_NAME,
                installLocation: pluginRoot,
                sourcePath: './fixtures/review-plugin',
                details: claudeDetails,
              },
              codex: {
                provider: 'codex',
                mode: 'native',
                name: PLUGIN_NAME,
                installLocation: pluginRoot,
                sourcePath: pluginRoot,
                details: codexDetails,
              },
            },
          },
        ],
        providerStatus: {
          claude: {
            provider: 'claude',
            state: 'valid',
            accepted: true,
            pluginCount: 1,
            lastCheckedAt: '2026-08-31T00:00:00.000Z',
          },
          codex: {
            provider: 'codex',
            state: 'valid',
            accepted: true,
            pluginCount: 1,
            lastCheckedAt: '2026-08-31T00:00:00.000Z',
          },
        },
        validProviders: ['claude', 'codex'],
      },
    ],
  });
  writeJson(path.join(userDataDir, 'invocable-inventory-cache.json'), {
    version: 3,
    builtAt: '2026-08-31T00:00:00.000Z',
    entries: [
      ...skills.map((skill) => ({
        id: `codex:plugin_skill:${MARKETPLACE_ID}:${PLUGIN_NAME}:${skill.name}`,
        provider: 'codex',
        kind: 'plugin_skill',
        name: skill.name,
        displayName: `$${PLUGIN_NAME}:${skill.name}`,
        description: skill.description,
        insertText: `$${PLUGIN_NAME}:${skill.name} `,
        invocationKey: `$${PLUGIN_NAME}:${skill.name}`,
        enableRef: {
          kind: 'plugin',
          marketplaceId: MARKETPLACE_ID,
          pluginName: PLUGIN_NAME,
        },
        sourceLabel: PLUGIN_NAME,
      })),
      ...claudeCommands.map((command) => ({
        id: `claude:plugin_command:${MARKETPLACE_ID}:${PLUGIN_NAME}:${command.name}`,
        provider: 'claude',
        kind: 'plugin_command',
        name: command.name,
        displayName: `/${command.name}`,
        description: command.description,
        insertText: `/${command.name} `,
        invocationKey: `/${command.name}`,
        enableRef: {
          kind: 'plugin',
          marketplaceId: MARKETPLACE_ID,
          pluginName: PLUGIN_NAME,
        },
        sourceLabel: PLUGIN_NAME,
      })),
    ],
  });
  seedStoredPipeline({
    userDataDir,
    id: TRANSITIVE_SKILL_PIPELINE_ID,
    name: 'Transitive Skill Share',
    description: 'Packages a review skill closure',
    yaml: [
      'name: Transitive Skill Share',
      'description: Packages a review skill closure',
      'on: dispatch',
      'jobs:',
      '  review:',
      '    steps:',
      '      - id: open_pr',
      '        uses: builtin/agent-prompt',
      '        with:',
      '          model: opus',
      '          prompt: Run /open-pr.',
      '      - id: loop',
      '        uses: builtin/agent-prompt',
      '        with:',
      '          model: gpt-5.6-sol',
      '          prompt: Run $review:review-loop.',
      '',
    ].join('\n'),
  });
}
