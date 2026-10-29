import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { seedDemoWorkspaces } from '../demoWorkspaces.mjs';
import { writeJson } from './fsHelpers.mjs';

/** Real on-disk skills exercise provider discovery and inventory enablement. */
export function seedHomeComposerSkills(userDataDir, provider) {
  const model = provider === 'codex' ? 'gpt-5.5' : 'sonnet';
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: {
      defaultWorktreeProvider: provider,
      defaultChatProvider: provider,
      defaultWorktreeModelByProvider: {
        [provider]: { model, thinkingLevel: 'high' },
      },
      defaultChatModelByProvider: {
        [provider]: { model, thinkingLevel: 'high' },
      },
    },
  });
  const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const workspace = seeded.workspaces.find(
    (item) => item.id === 'demo-ts-pnpm-vite',
  );
  if (!workspace?.repoPath) throw new Error('Missing seeded repository');
  const writeSkill = (root, name) => {
    const directory = path.join(root, name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Home composer ${name}\n---\nUse this skill.\n`,
    );
  };
  writeSkill(
    path.join(
      workspace.repoPath,
      provider === 'claude' ? '.claude' : '.agents',
      'skills',
    ),
    'home-project-skill',
  );
  if (provider === 'claude') {
    const directory = path.join(workspace.repoPath, '.claude', 'commands');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, 'home-project-command.md'),
      '---\ndescription: Home composer legacy project command\n---\nReview the project.\n',
    );
  }
  // The default New task target discovers from a repository shadow. A local
  // bare origin exercises that path deterministically without network access.
  execFileSync('git', ['add', provider === 'claude' ? '.claude' : '.agents'], {
    cwd: workspace.repoPath,
  });
  execFileSync('git', ['commit', '-m', 'Seed Home composer capabilities'], {
    cwd: workspace.repoPath,
  });
  const origin = path.join(userDataDir, 'home-skills-origin.git');
  execFileSync('git', ['clone', '--bare', workspace.repoPath, origin]);
  execFileSync('git', ['remote', 'add', 'origin', origin], {
    cwd: workspace.repoPath,
  });
  for (const name of ['home-enabled-skill', 'home-available-skill']) {
    writeSkill(path.join(userDataDir, 'skills', 'custom:app'), name);
  }
  const configPath = path.join(
    userDataDir,
    'workspaces',
    workspace.id,
    'workspace.json',
  );
  writeJson(configPath, {
    ...JSON.parse(readFileSync(configPath, 'utf8')),
    defaultPluginSelections: {
      collectionIds: [],
      pluginRefs: [],
      mcpServerRefs: [],
      skillRefs: [{ sourceId: 'custom:app', skillName: 'home-enabled-skill' }],
    },
  });
  writeJson(path.join(userDataDir, 'invocable-inventory-cache.json'), {
    version: 3,
    builtAt: new Date().toISOString(),
    entries: ['home-enabled-skill', 'home-available-skill'].map((name) => {
      const invocation =
        provider === 'codex' ? `$builtin-app-plugin:${name}` : `/${name}`;
      return {
        id: `${provider}:skill:custom%3Aapp:${name}`,
        provider,
        kind: 'skill',
        name,
        description: `Home composer ${name}`,
        displayName: invocation,
        insertText: `${invocation} `,
        invocationKey: invocation,
        enableRef: { kind: 'skill', sourceId: 'custom:app', skillName: name },
        sourceLabel: 'Custom',
      };
    }),
  });
}
