// Synthetic Claude fixtures for S0.1: every ambient source the pinned CLI could
// read, planted with the run's canary tokens, under the synthetic root only.
// Planning-only evidence tooling; nothing here is a production contract.
//
// Fixture locations are taken from the pinned CLI 2.1.284 (static reading of
// the bundled JS, see run.mjs notes) and the public settings contract. Each
// fixture carries a `liveness` description so the positive control can prove
// the CLI really reads it; a fixture that is not live in the control can only
// yield `blocked`, never `pass`, for its isolated-absence result.
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { writeRecorderScript } from '../shared/canaries.mjs';

export const HOOK_EVENTS_PLANTED = Object.freeze([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
]);

export const FIXTURE_NAMES = Object.freeze({
  skillUser: 'bap0-skill-user',
  skillAgents: 'bap0-skill-agents',
  outputStyle: 'bap0-style',
  marketplace: 'bap0-market',
  plugin: 'bap0-plugin',
  userMcp: 'bap0-user-mcp',
  projectMcp: 'bap0-project-mcp',
});

/** Claude's per-project directory key: every non-alphanumeric becomes `-`. */
export function sanitizeProjectKey(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

/** Auto-memory index path for a working directory (2.1.284: projects/<key>/memory/MEMORY.md). */
export function memoryIndexPath(claudeConfigDir, cwd) {
  return path.join(
    claudeConfigDir,
    'projects',
    sanitizeProjectKey(cwd),
    'memory',
    'MEMORY.md',
  );
}

/** macOS managed-policy locations. Existence is checked, contents are never read. */
export function managedPolicyPaths(platform = process.platform) {
  if (platform === 'darwin') {
    const base = '/Library/Application Support/ClaudeCode';
    return [
      path.join(base, 'CLAUDE.md'),
      path.join(base, 'managed-settings.json'),
      path.join(base, 'managed-settings.d'),
      path.join(base, 'managed-mcp.json'),
      path.join(base, '.claude', 'rules'),
    ];
  }
  if (platform === 'linux') {
    const base = '/etc/claude-code';
    return [
      path.join(base, 'CLAUDE.md'),
      path.join(base, 'managed-settings.json'),
      path.join(base, 'managed-settings.d'),
      path.join(base, 'managed-mcp.json'),
      path.join(base, '.claude', 'rules'),
    ];
  }
  return [];
}

/**
 * Existence-only check (lstat; never opens or reads a file).
 *
 * @param {string[]} paths
 * @param {(p: string) => Promise<{ isFile(): boolean, isDirectory(): boolean }>} [stat]
 */
export async function checkManagedPolicyPaths(paths, stat = lstat) {
  const out = [];
  for (const target of paths) {
    try {
      const info = await stat(target);
      out.push({
        path: target,
        exists: true,
        kind: info.isDirectory()
          ? 'directory'
          : info.isFile()
            ? 'file'
            : 'other',
      });
    } catch (error) {
      out.push({
        path: target,
        exists: false,
        error: error?.code ?? 'unknown',
      });
    }
  }
  return out;
}

async function put(file, text) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, text);
  return file;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Hook settings: one recorder command per event, the hook canary as an argument. */
export function buildHooksSettings(recorderScripts, hookCanary) {
  const hooks = {};
  for (const event of HOOK_EVENTS_PLANTED) {
    const script = recorderScripts[event];
    const entry = {
      type: 'command',
      command: `${shellQuote(script)} ${hookCanary}`,
    };
    hooks[event] =
      event === 'PreToolUse' || event === 'PostToolUse'
        ? [{ matcher: '*', hooks: [entry] }]
        : [{ hooks: [entry] }];
  }
  return hooks;
}

/**
 * User/project settings. The settings canary rides in fields that reach a
 * request when a settings source is live (attribution text is part of the
 * default Bash tool description) plus env and announcements.
 */
export function buildSettingsJson({
  settingsCanary,
  hooks,
  includeUserOnly,
  fixtureNames = FIXTURE_NAMES,
  marketplacePath,
}) {
  const settings = {
    attribution: {
      commit: `Probe commit trailer ${settingsCanary}`,
      pr: `Probe PR footer ${settingsCanary}`,
    },
    env: { BAP0_SETTINGS_ENV: settingsCanary },
    companyAnnouncements: [`Probe announcement ${settingsCanary}`],
    hooks,
  };
  if (includeUserOnly) {
    settings.outputStyle = fixtureNames.outputStyle;
    settings.enableAllProjectMcpServers = true;
    settings.extraKnownMarketplaces = {
      [fixtureNames.marketplace]: {
        source: { source: 'directory', path: marketplacePath },
      },
    };
    settings.enabledPlugins = {
      [`${fixtureNames.plugin}@${fixtureNames.marketplace}`]: true,
    };
  }
  return settings;
}

function skillMarkdown(name, canary, where) {
  return `---\nname: ${name}\ndescription: Synthetic probe skill ${canary} (${where}). Never use.\n---\n\nProbe skill body ${canary}.\n`;
}

/**
 * Plant every fixture. Returns the fixture inventory and the recorder names.
 *
 * @param {{ layout: import('../shared/synthetic-root.mjs').SyntheticLayout, canaries: Record<string, string> }} input
 */
export async function writeClaudeFixtures({ layout, canaries }) {
  const fixtures = [];
  const recorders = {};
  const add = (id, info) => fixtures.push({ id, ...info });
  const records = layout.records;

  // Instruction files.
  const userFiles = [
    await put(
      path.join(layout.claudeConfigDir, 'CLAUDE.md'),
      `# Probe user instructions\n${canaries.userInstructions}\n`,
    ),
    await put(
      path.join(layout.claudeHomeDir, 'CLAUDE.md'),
      `# Probe user instructions (home)\n${canaries.userInstructions}\n`,
    ),
  ];
  add('userInstructions', { paths: userFiles, live: { request: true } });
  add('ancestorInstructions', {
    paths: [
      await put(
        path.join(layout.ancestor, 'CLAUDE.md'),
        `# Probe ancestor instructions\n${canaries.ancestorInstructions}\n`,
      ),
    ],
    live: { request: true },
  });
  add('projectInstructions', {
    paths: [
      await put(
        path.join(layout.project, 'CLAUDE.md'),
        `# Probe project instructions\n${canaries.projectInstructions}\n`,
      ),
    ],
    live: { request: true },
  });
  add('projectOverrideInstructions', {
    paths: [
      await put(
        path.join(layout.project, 'CLAUDE.local.md'),
        `# Probe local override\n${canaries.projectOverrideInstructions}\n`,
      ),
    ],
    live: { request: true },
  });

  // Hook recorders: one per event so the control shows which events fire.
  const hookScripts = {};
  for (const event of HOOK_EVENTS_PLANTED) {
    const name = `hook-${event.toLowerCase()}`;
    hookScripts[event] = await writeRecorderScript(
      records,
      name,
      canaries.hook,
    );
    recorders[name] = hookScripts[event];
  }
  const hooks = buildHooksSettings(hookScripts, canaries.hook);

  // Plugin marketplace fixture in the user plugin location.
  const marketplace = path.join(
    layout.claudeConfigDir,
    'plugins',
    FIXTURE_NAMES.marketplace,
  );
  const pluginDir = path.join(marketplace, 'plugins', FIXTURE_NAMES.plugin);
  const pluginFiles = [
    await put(
      path.join(marketplace, '.claude-plugin', 'marketplace.json'),
      JSON.stringify(
        {
          name: FIXTURE_NAMES.marketplace,
          owner: { name: 'probe' },
          plugins: [
            {
              name: FIXTURE_NAMES.plugin,
              source: `./plugins/${FIXTURE_NAMES.plugin}`,
              description: `Probe plugin ${canaries.plugin}`,
            },
          ],
        },
        null,
        2,
      ),
    ),
    await put(
      path.join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify(
        {
          name: FIXTURE_NAMES.plugin,
          version: '0.0.1',
          description: `Probe plugin ${canaries.plugin}`,
        },
        null,
        2,
      ),
    ),
    await put(
      path.join(pluginDir, 'skills', 'bap0-plugin-skill', 'SKILL.md'),
      skillMarkdown('bap0-plugin-skill', canaries.plugin, 'plugin skill'),
    ),
  ];
  add('plugin', {
    paths: pluginFiles,
    live: {
      init: { field: 'plugins', includes: FIXTURE_NAMES.plugin },
      request: true,
    },
    unverified:
      'Plugin registration through settings extraKnownMarketplaces(directory)+enabledPlugins is inferred from the settings contract; the control init.plugins decides liveness.',
  });

  // Settings (user config dir, ~/.claude, project/.claude).
  const settingsCanary = canaries.settings;
  const userSettings = buildSettingsJson({
    settingsCanary,
    hooks,
    includeUserOnly: true,
    marketplacePath: marketplace,
  });
  const projectSettings = buildSettingsJson({
    settingsCanary,
    hooks,
    includeUserOnly: false,
  });
  const settingsFiles = [
    await put(
      path.join(layout.claudeConfigDir, 'settings.json'),
      JSON.stringify(userSettings, null, 2),
    ),
    await put(
      path.join(layout.claudeHomeDir, 'settings.json'),
      JSON.stringify(
        buildSettingsJson({ settingsCanary, hooks, includeUserOnly: false }),
        null,
        2,
      ),
    ),
    await put(
      path.join(layout.project, '.claude', 'settings.json'),
      JSON.stringify(projectSettings, null, 2),
    ),
  ];
  add('settings', {
    paths: settingsFiles,
    live: {
      request: true,
      recorder: HOOK_EVENTS_PLANTED.map(
        (event) => `hook-${event.toLowerCase()}`,
      ),
    },
  });
  add('hook', {
    paths: settingsFiles,
    live: {
      recorder: HOOK_EVENTS_PLANTED.map(
        (event) => `hook-${event.toLowerCase()}`,
      ),
    },
    recorders: Object.keys(hookScripts).map(
      (event) => `hook-${event.toLowerCase()}`,
    ),
  });

  // MCP servers: user config (.claude.json in the config dir and $HOME) and project .mcp.json.
  const userMcp = await writeRecorderScript(
    records,
    'mcp-user',
    canaries.mcpUserConfig,
  );
  const projectMcp = await writeRecorderScript(
    records,
    'mcp-project',
    canaries.mcpUserConfig,
  );
  recorders['mcp-user'] = userMcp;
  recorders['mcp-project'] = projectMcp;
  const mcpFiles = [
    await put(
      path.join(layout.claudeConfigDir, '.claude.json'),
      JSON.stringify(
        {
          mcpServers: {
            [FIXTURE_NAMES.userMcp]: {
              type: 'stdio',
              command: userMcp,
              args: [canaries.mcpUserConfig],
            },
          },
        },
        null,
        2,
      ),
    ),
    await put(
      path.join(layout.home, '.claude.json'),
      JSON.stringify(
        {
          mcpServers: {
            [FIXTURE_NAMES.userMcp]: {
              type: 'stdio',
              command: userMcp,
              args: [canaries.mcpUserConfig],
            },
          },
        },
        null,
        2,
      ),
    ),
    await put(
      path.join(layout.project, '.mcp.json'),
      JSON.stringify(
        {
          mcpServers: {
            [FIXTURE_NAMES.projectMcp]: {
              type: 'stdio',
              command: projectMcp,
              args: [canaries.mcpUserConfig],
            },
          },
        },
        null,
        2,
      ),
    ),
  ];
  add('mcpUserConfig', {
    paths: mcpFiles,
    recorders: ['mcp-user', 'mcp-project'],
    live: {
      recorder: ['mcp-user', 'mcp-project'],
      init: { field: 'mcp_servers', includes: 'bap0-' },
    },
  });

  // Skills.
  const skillFiles = [
    await put(
      path.join(
        layout.claudeConfigDir,
        'skills',
        FIXTURE_NAMES.skillUser,
        'SKILL.md',
      ),
      skillMarkdown(FIXTURE_NAMES.skillUser, canaries.skillUser, 'config dir'),
    ),
    await put(
      path.join(
        layout.claudeHomeDir,
        'skills',
        `${FIXTURE_NAMES.skillUser}-home`,
        'SKILL.md',
      ),
      skillMarkdown(
        `${FIXTURE_NAMES.skillUser}-home`,
        canaries.skillUser,
        'home .claude',
      ),
    ),
  ];
  add('skillUser', {
    paths: skillFiles,
    live: {
      request: true,
      init: { field: 'skills', includes: FIXTURE_NAMES.skillUser },
    },
  });
  add('skillAgentsDir', {
    paths: [
      await put(
        path.join(
          layout.home,
          '.agents',
          'skills',
          FIXTURE_NAMES.skillAgents,
          'SKILL.md',
        ),
        skillMarkdown(
          FIXTURE_NAMES.skillAgents,
          canaries.skillAgentsDir,
          'agents dir',
        ),
      ),
    ],
    live: {
      request: true,
      init: { field: 'skills', includes: FIXTURE_NAMES.skillAgents },
    },
    unverified:
      '~/.agents/skills appears in the pinned CLI only as a foreign-tool import source, not as a native discovery root; the control decides whether it is live.',
  });

  // Output style.
  const styleBody = `---\nname: ${FIXTURE_NAMES.outputStyle}\ndescription: Probe style ${canaries.outputStyle}\n---\n\nProbe style instructions ${canaries.outputStyle}.\n`;
  add('outputStyle', {
    paths: [
      await put(
        path.join(
          layout.claudeConfigDir,
          'output-styles',
          `${FIXTURE_NAMES.outputStyle}.md`,
        ),
        styleBody,
      ),
      await put(
        path.join(
          layout.claudeHomeDir,
          'output-styles',
          `${FIXTURE_NAMES.outputStyle}.md`,
        ),
        styleBody,
      ),
    ],
    live: {
      request: true,
      init: { field: 'output_style', includes: FIXTURE_NAMES.outputStyle },
    },
  });

  // Fixtures the orchestrator plants; nothing written here.
  add('hostEnvironment', {
    paths: [],
    orchestratorPlanted: true,
    live: { notRequired: true },
  });
  add('hostFile', {
    paths: [],
    orchestratorPlanted: true,
    live: { notRequired: true },
  });

  return { fixtures, recorders, settingsCanary };
}

/**
 * Auto-memory fixture for one working directory (the store is keyed by cwd).
 * Call again for each fresh epoch directory that should have a planted store.
 */
export async function writeMemoryFixture({ layout, canaries, cwd }) {
  const real = await realpath(cwd);
  const files = [];
  for (const root of [layout.claudeConfigDir, layout.claudeHomeDir]) {
    const index = memoryIndexPath(root, real);
    files.push(
      await put(index, `- [Probe memory](probe.md): ${canaries.memory}\n`),
    );
    files.push(
      await put(
        path.join(path.dirname(index), 'probe.md'),
        `---\nname: probe\ndescription: ${canaries.memory}\ntype: user\n---\n\nProbe memory ${canaries.memory}.\n`,
      ),
    );
  }
  return { cwd: real, key: sanitizeProjectKey(real), paths: files };
}

/** A recorder that stands in for `security`, so keychain attempts are observable and refused. */
export async function writeKeychainShim({ layout }) {
  const dir = path.join(layout.root, 'shim-bin');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const log = path.join(layout.records, 'security.log');
  const script = path.join(dir, 'security');
  await writeFile(
    script,
    `#!/bin/sh\n# Probe stand-in for /usr/bin/security: records argv, answers "item not found" (exit 44).\n/bin/echo "security $(/bin/date +%s) argc=$# args=$*" >> ${shellQuote(log)}\nexit 44\n`,
    { mode: 0o700 },
  );
  return { dir, script, log };
}

/** Whether a fixture is live given the control's observations. */
export function isFixtureLive(
  fixture,
  { requestHit, recorderDelta = {}, init = null },
) {
  const live = fixture.live ?? {};
  if (live.notRequired)
    return {
      live: true,
      basis: 'not a file the CLI discovers; absence is asserted directly',
    };
  const reasons = [];
  if (live.request && requestHit)
    reasons.push('canary present in a captured control request');
  for (const name of live.recorder ?? [])
    if ((recorderDelta[name] ?? 0) > 0)
      reasons.push(`recorder ${name} invoked ${recorderDelta[name]}x`);
  if (live.init && init) {
    const value = init[live.init.field];
    const text = JSON.stringify(value ?? null);
    if (text.includes(live.init.includes))
      reasons.push(`init.${live.init.field} lists ${live.init.includes}`);
  }
  return reasons.length > 0
    ? { live: true, basis: reasons.join('; ') }
    : { live: false, basis: 'not observed live in the positive control' };
}
