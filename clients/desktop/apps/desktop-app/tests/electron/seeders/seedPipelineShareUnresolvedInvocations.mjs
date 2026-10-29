import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { writeJson } from './fsHelpers.mjs';
import { seedStoredPipeline } from './seedStoredPipeline.mjs';

/**
 * Fixture for the publisher's "wall of red" case: a pipeline whose prompts mix
 * path-shaped tokens (`/collect.py`, `/notes/report.md`) that are not commands
 * at all, a genuinely unresolvable command used by two steps, one command that
 * really does resolve and package, and a packaged skill carrying a `.git/config`
 * that can never be exported.
 *
 * `.git/config` is the security row on purpose: the export-denied check needs no
 * symlink, no platform-specific mode bits, and no fake credential, so the row is
 * identical on macOS and Windows.
 */

export const UNRESOLVED_INVOCATION_PIPELINE_ID = 'unresolved-invocation-share';
export const UNRESOLVED_TOKEN = '/repair-diffs';
export const IGNORED_PATH_TOKEN = '/collect.py';
export const TRANSITIVE_UNRESOLVED_TOKEN = '$review:gone';
const MARKETPLACE_ID = 'e2e/import-market';
const PLUGIN_NAME = 'review';

function deploySkillSource(includeMissingDependency) {
  return [
    '---',
    'name: deploy',
    'description: Deploy the reviewed change',
    ...(includeMissingDependency ? ['skills:', '  - review:gone'] : []),
    '---',
    '# Deploy',
    'Deploy the reviewed change.',
    '',
  ].join('\n');
}

export function seedPipelineShareUnresolvedInvocations(userDataDir) {
  const pluginRoot = path.join(userDataDir, 'fixtures', 'import-plugin');
  const deployDir = path.join(pluginRoot, 'skills', 'deploy');
  const deployGitDir = path.join(deployDir, '.git');
  const commandsDir = path.join(pluginRoot, 'commands');
  mkdirSync(deployGitDir, { recursive: true });
  mkdirSync(commandsDir, { recursive: true });

  writeFileSync(path.join(deployDir, 'SKILL.md'), deploySkillSource(true));
  // Never exportable, and never dismissible.
  writeFileSync(
    path.join(deployGitDir, 'config'),
    '[core]\n\trepositoryformatversion = 0\n',
  );
  writeFileSync(
    path.join(commandsDir, 'open-pr.md'),
    '# Open PR\n\nOpen a pull request for the current branch.\n',
  );

  const codexDetails = {
    skills: [
      {
        name: 'deploy',
        description: 'Deploy the reviewed change',
        path: 'skills/deploy',
      },
    ],
    agents: [],
    commands: [],
    apps: [],
    hooks: [],
    mcpServers: [],
    lspServers: [],
    hasReadme: false,
  };
  const claudeDetails = {
    skills: [],
    agents: [],
    commands: [
      {
        name: 'open-pr',
        description: 'Open a pull request',
        filePath: 'commands/open-pr.md',
      },
    ],
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
        name: 'E2E Import Market',
        sourceType: 'github',
        sourceUrl: 'e2e/import-market',
        installLocation: pluginRoot,
        pluginCount: 1,
        plugins: [
          {
            name: PLUGIN_NAME,
            description: 'Import plugin fixture',
            sourcePath: pluginRoot,
            marketplaceId: MARKETPLACE_ID,
            providerSupport: { claude: 'native', codex: 'native' },
            facets: {
              claude: {
                provider: 'claude',
                mode: 'native',
                name: PLUGIN_NAME,
                installLocation: pluginRoot,
                sourcePath: './fixtures/import-plugin',
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
    version: 2,
    builtAt: '2026-08-31T00:00:00.000Z',
    entries: [
      {
        id: `codex:plugin_skill:${MARKETPLACE_ID}:${PLUGIN_NAME}:deploy`,
        provider: 'codex',
        kind: 'plugin_skill',
        name: 'deploy',
        displayName: `$${PLUGIN_NAME}:deploy`,
        description: 'Deploy the reviewed change',
        insertText: `$${PLUGIN_NAME}:deploy `,
        invocationKey: `$${PLUGIN_NAME}:deploy`,
        enableRef: {
          kind: 'plugin',
          marketplaceId: MARKETPLACE_ID,
          pluginName: PLUGIN_NAME,
        },
        sourceLabel: PLUGIN_NAME,
      },
      {
        id: `claude:plugin_command:${MARKETPLACE_ID}:${PLUGIN_NAME}:open-pr`,
        provider: 'claude',
        kind: 'plugin_command',
        name: 'open-pr',
        displayName: '/open-pr',
        description: 'Open a pull request',
        insertText: '/open-pr ',
        invocationKey: '/open-pr',
        enableRef: {
          kind: 'plugin',
          marketplaceId: MARKETPLACE_ID,
          pluginName: PLUGIN_NAME,
        },
        sourceLabel: PLUGIN_NAME,
      },
    ],
  });

  seedStoredPipeline({
    userDataDir,
    id: UNRESOLVED_INVOCATION_PIPELINE_ID,
    name: 'Unresolved Invocation Share',
    description: 'Mixes path tokens, a missing command, and a real one',
    yaml: [
      'name: Unresolved Invocation Share',
      'description: Mixes path tokens, a missing command, and a real one',
      'on: dispatch',
      'jobs:',
      '  build:',
      '    steps:',
      '      - id: collect',
      '        uses: builtin/agent-prompt',
      '        with:',
      '          model: opus',
      `          prompt: Run ${IGNORED_PATH_TOKEN} and read /notes/report.md.`,
      '      - id: recollect',
      '        uses: builtin/agent-prompt',
      '        with:',
      '          model: opus',
      `          prompt: Run ${IGNORED_PATH_TOKEN} once more.`,
      '      - id: collect_report',
      '        uses: builtin/agent-prompt',
      '        with:',
      '          model: opus',
      `          prompt: Mention ${IGNORED_PATH_TOKEN} in the report.`,
      '  ship:',
      '    steps:',
      '      - id: open_pr',
      '        uses: builtin/agent-prompt',
      '        with:',
      '          model: opus',
      '          prompt: Run /open-pr.',
      '      - id: repair',
      '        uses: builtin/agent-prompt',
      '        with:',
      '          model: opus',
      `          prompt: Run ${UNRESOLVED_TOKEN} on the output.`,
      '      - id: verify',
      '        uses: builtin/agent-prompt',
      '        with:',
      '          model: opus',
      `          prompt: Run ${UNRESOLVED_TOKEN} one more time.`,
      '      - id: deploy',
      '        uses: builtin/agent-prompt',
      '        with:',
      '          model: gpt-5.6-sol',
      `          prompt: Run $${PLUGIN_NAME}:deploy.`,
      '',
    ].join('\n'),
  });
}

/** Remove the two real non-dismissible findings while keeping the prompt miss. */
export function clearPipelineShareSecurityAndFrontmatterProblems(userDataDir) {
  const deployDir = path.join(
    userDataDir,
    'fixtures',
    'import-plugin',
    'skills',
    'deploy',
  );
  rmSync(path.join(deployDir, '.git', 'config'));
  writeFileSync(path.join(deployDir, 'SKILL.md'), deploySkillSource(false));
}

export const EXPRESSION_MODEL_PIPELINE_ID = 'expression-model-share';

/**
 * A pipeline whose step model is chosen at run time by a `providers` choice
 * input, through an expression containing whitespace. The prompt picks a
 * Claude command for "Claude only" and plain text for "Codex only", so the
 * analysis resolves `/open-pr` only for the Claude variant. Reuses the
 * import-plugin fixture above for the `/open-pr` command.
 */
export function seedPipelineShareExpressionModel(userDataDir) {
  seedPipelineShareUnresolvedInvocations(userDataDir);
  seedStoredPipeline({
    userDataDir,
    id: EXPRESSION_MODEL_PIPELINE_ID,
    name: 'Expression Model Share',
    description: 'Picks its model from a providers input at run time',
    yaml: [
      'name: Expression Model Share',
      'description: Picks its model from a providers input at run time',
      'on:',
      '  dispatch:',
      '    inputs:',
      '      providers:',
      '        type: choice',
      '        default: Claude only',
      '        options: [Claude only, Codex only]',
      'jobs:',
      '  ship:',
      '    steps:',
      '      - id: open_pr',
      '        uses: builtin/agent-prompt',
      '        with:',
      `          model: \${{ parseJson('{"Claude only":"opus","Codex only":"$sol"}')[inputs.providers] }}`,
      `          prompt: \${{ parseJson('{"Claude only":"Run /open-pr.","Codex only":"Open a pull request."}')[inputs.providers] }}`,
      '',
    ].join('\n'),
  });
}
