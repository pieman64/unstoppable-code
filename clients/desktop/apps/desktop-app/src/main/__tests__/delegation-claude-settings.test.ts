import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  delegatedClaudeConfigDirectory,
  resolveAmbientClaudePluginIds,
} from '../agents/delegation/claude-settings';

let home: string;
let cwd: string;

async function settings(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    typeof value === 'string' ? value : JSON.stringify(value),
  );
}

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'delegate-settings-home-'));
  cwd = await mkdtemp(path.join(os.tmpdir(), 'delegate-settings-project-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

describe('ambient Claude plugin discovery for delegates', () => {
  it('collects plugins enabled by user, project and local settings', async () => {
    await settings(path.join(home, '.claude', 'settings.json'), {
      enabledPlugins: { 'formatter@tools': true, 'old@tools': false },
    });
    await settings(path.join(cwd, '.claude', 'settings.json'), {
      enabledPlugins: { 'linter@tools': ['^1.0.0'] },
    });
    await settings(path.join(cwd, '.claude', 'settings.local.json'), {
      enabledPlugins: { 'reviewer@team': { version: '2' } },
    });
    await expect(resolveAmbientClaudePluginIds({ home, cwd })).resolves.toEqual(
      ['formatter@tools', 'linter@tools', 'reviewer@team'],
    );
  });

  it('ignores missing, malformed and plugin-free settings files', async () => {
    await settings(path.join(home, '.claude', 'settings.json'), '{ not json');
    await settings(path.join(cwd, '.claude', 'settings.json'), {
      permissions: { allow: ['Bash(ls)'] },
    });
    await expect(resolveAmbientClaudePluginIds({ home, cwd })).resolves.toEqual(
      [],
    );
  });

  it('reads user settings from the host Claude config directory when set', async () => {
    const configDir = path.join(home, 'custom-claude-config');
    await settings(path.join(configDir, 'settings.json'), {
      enabledPlugins: { 'configured@tools': true },
    });
    await settings(path.join(home, '.claude', 'settings.json'), {
      enabledPlugins: { 'default-home@tools': true },
    });
    await expect(
      resolveAmbientClaudePluginIds({ home, cwd, configDir }),
    ).resolves.toEqual(['configured@tools']);
  });

  it('uses only an absolute host CLAUDE_CONFIG_DIR', () => {
    expect(
      delegatedClaudeConfigDirectory({ CLAUDE_CONFIG_DIR: '/isolated/claude' }),
    ).toBe('/isolated/claude');
    expect(
      delegatedClaudeConfigDirectory({ CLAUDE_CONFIG_DIR: 'relative/claude' }),
    ).toBeUndefined();
    expect(
      delegatedClaudeConfigDirectory({ CLAUDE_CONFIG_DIR: '' }),
    ).toBeUndefined();
    expect(delegatedClaudeConfigDirectory({})).toBeUndefined();
  });

  it('keeps one entry for a plugin enabled in several layers', async () => {
    await settings(path.join(home, '.claude', 'settings.json'), {
      enabledPlugins: { 'formatter@tools': true },
    });
    await settings(path.join(cwd, '.claude', 'settings.json'), {
      enabledPlugins: { 'formatter@tools': true },
    });
    await expect(resolveAmbientClaudePluginIds({ home, cwd })).resolves.toEqual(
      ['formatter@tools'],
    );
  });
});
