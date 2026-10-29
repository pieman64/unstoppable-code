import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createCanarySet,
  readRecorderInvocations,
} from '../../shared/canaries.mjs';
import {
  FIXTURE_NAMES,
  HOOK_EVENTS_PLANTED,
  checkManagedPolicyPaths,
  isFixtureLive,
  managedPolicyPaths,
  memoryIndexPath,
  sanitizeProjectKey,
  writeClaudeFixtures,
  writeKeychainShim,
  writeMemoryFixture,
} from '../fixtures.mjs';

async function fakeLayout() {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'bap0-fixture-test-')),
  );
  const layout = {
    root,
    home: path.join(root, 'home'),
    claudeHomeDir: path.join(root, 'home', '.claude'),
    claudeConfigDir: path.join(root, 'claude-config'),
    ancestor: path.join(root, 'ancestor'),
    project: path.join(root, 'ancestor', 'project'),
    records: path.join(root, 'records'),
    epochs: path.join(root, 'epochs'),
  };
  for (const dir of [
    layout.home,
    layout.claudeHomeDir,
    layout.claudeConfigDir,
    layout.project,
    layout.records,
    layout.epochs,
  ])
    await mkdir(dir, { recursive: true });
  return layout;
}

test('fixtures plant every claude canary in the documented places', async () => {
  const layout = await fakeLayout();
  try {
    const canaries = createCanarySet();
    const { fixtures, recorders } = await writeClaudeFixtures({
      layout,
      canaries,
    });
    const ids = fixtures.map((fixture) => fixture.id);
    for (const id of [
      'userInstructions',
      'ancestorInstructions',
      'projectInstructions',
      'projectOverrideInstructions',
      'settings',
      'hook',
      'mcpUserConfig',
      'skillUser',
      'skillAgentsDir',
      'outputStyle',
      'plugin',
      'hostEnvironment',
      'hostFile',
    ])
      assert.ok(ids.includes(id), id);
    const text = async (...parts) => readFile(path.join(...parts), 'utf8');
    assert.match(
      await text(layout.claudeConfigDir, 'CLAUDE.md'),
      new RegExp(canaries.userInstructions),
    );
    assert.match(
      await text(layout.claudeHomeDir, 'CLAUDE.md'),
      new RegExp(canaries.userInstructions),
    );
    assert.match(
      await text(layout.ancestor, 'CLAUDE.md'),
      new RegExp(canaries.ancestorInstructions),
    );
    assert.match(
      await text(layout.project, 'CLAUDE.md'),
      new RegExp(canaries.projectInstructions),
    );
    assert.match(
      await text(layout.project, 'CLAUDE.local.md'),
      new RegExp(canaries.projectOverrideInstructions),
    );
    assert.match(
      await text(
        layout.claudeConfigDir,
        'skills',
        FIXTURE_NAMES.skillUser,
        'SKILL.md',
      ),
      new RegExp(canaries.skillUser),
    );
    assert.match(
      await text(
        layout.home,
        '.agents',
        'skills',
        FIXTURE_NAMES.skillAgents,
        'SKILL.md',
      ),
      new RegExp(canaries.skillAgentsDir),
    );
    assert.match(
      await text(
        layout.claudeConfigDir,
        'output-styles',
        `${FIXTURE_NAMES.outputStyle}.md`,
      ),
      new RegExp(canaries.outputStyle),
    );
    assert.match(
      await text(
        layout.claudeConfigDir,
        'plugins',
        FIXTURE_NAMES.marketplace,
        'plugins',
        FIXTURE_NAMES.plugin,
        '.claude-plugin',
        'plugin.json',
      ),
      new RegExp(canaries.plugin),
    );
    for (const dir of [
      layout.claudeConfigDir,
      layout.claudeHomeDir,
      path.join(layout.project, '.claude'),
    ]) {
      const settings = JSON.parse(await text(dir, 'settings.json'));
      assert.match(JSON.stringify(settings), new RegExp(canaries.settings));
      assert.deepEqual(
        Object.keys(settings.hooks).sort(),
        [...HOOK_EVENTS_PLANTED].sort(),
      );
      assert.match(
        settings.hooks.SessionStart[0].hooks[0].command,
        new RegExp(canaries.hook),
      );
    }
    const userSettings = JSON.parse(
      await text(layout.claudeConfigDir, 'settings.json'),
    );
    assert.equal(userSettings.outputStyle, FIXTURE_NAMES.outputStyle);
    assert.ok(
      userSettings.enabledPlugins[
        `${FIXTURE_NAMES.plugin}@${FIXTURE_NAMES.marketplace}`
      ],
    );
    assert.equal(
      userSettings.extraKnownMarketplaces[FIXTURE_NAMES.marketplace].source
        .source,
      'directory',
    );
    for (const file of [
      path.join(layout.claudeConfigDir, '.claude.json'),
      path.join(layout.home, '.claude.json'),
    ]) {
      const mcp = JSON.parse(await readFile(file, 'utf8'));
      assert.equal(
        mcp.mcpServers[FIXTURE_NAMES.userMcp].command,
        recorders['mcp-user'],
      );
    }
    assert.ok(
      JSON.parse(await text(layout.project, '.mcp.json')).mcpServers[
        FIXTURE_NAMES.projectMcp
      ],
    );
    for (const script of Object.values(recorders))
      assert.ok(
        ((await stat(script)).mode & 0o100) !== 0,
        `${script} is executable`,
      );
    assert.equal(
      Object.keys(recorders).filter((name) => name.startsWith('hook-')).length,
      HOOK_EVENTS_PLANTED.length,
    );
    // The recorder really records (plain /bin/sh script, no provider involved).
    execFileSync(recorders['hook-sessionstart'], ['x']);
    assert.equal(
      (await readRecorderInvocations(layout.records))['hook-sessionstart']
        .length,
      1,
    );
  } finally {
    await rm(layout.root, { recursive: true, force: true });
  }
});

test('memory fixture is keyed by the realpath cwd and planted in both config roots', async () => {
  const layout = await fakeLayout();
  try {
    const canaries = createCanarySet();
    const cwd = path.join(layout.epochs, 'iso-b');
    await mkdir(cwd);
    const fixture = await writeMemoryFixture({ layout, canaries, cwd });
    assert.equal(fixture.key, sanitizeProjectKey(cwd));
    assert.ok(fixture.key.startsWith('-'));
    assert.equal(fixture.paths.length, 4);
    const index = await readFile(
      memoryIndexPath(layout.claudeConfigDir, cwd),
      'utf8',
    );
    assert.match(index, new RegExp(canaries.memory));
  } finally {
    await rm(layout.root, { recursive: true, force: true });
  }
});

test('keychain shim records argv and answers item-not-found', async () => {
  const layout = await fakeLayout();
  try {
    const shim = await writeKeychainShim({ layout });
    let status = 0;
    try {
      execFileSync(shim.script, [
        'find-generic-password',
        '-a',
        'user',
        '-w',
        '-s',
        'svc',
      ]);
    } catch (error) {
      status = error.status;
    }
    assert.equal(status, 44);
    assert.match(
      await readFile(shim.log, 'utf8'),
      /args=find-generic-password -a user -w -s svc/,
    );
    assert.equal(
      (await readRecorderInvocations(layout.records)).security.length,
      1,
    );
  } finally {
    await rm(layout.root, { recursive: true, force: true });
  }
});

test('managed policy existence check never reads contents', async () => {
  assert.ok(
    managedPolicyPaths('darwin')[0].startsWith(
      '/Library/Application Support/ClaudeCode',
    ),
  );
  assert.deepEqual(managedPolicyPaths('win32'), []);
  const seen = [];
  const results = await checkManagedPolicyPaths(
    ['/a/CLAUDE.md', '/a/managed-settings.d'],
    async (target) => {
      seen.push(target);
      if (target.endsWith('.d'))
        return { isFile: () => false, isDirectory: () => true };
      throw Object.assign(new Error('nope'), { code: 'ENOENT' });
    },
  );
  assert.deepEqual(seen, ['/a/CLAUDE.md', '/a/managed-settings.d']);
  assert.deepEqual(
    results.map((entry) => [entry.exists, entry.kind ?? entry.error]),
    [
      [false, 'ENOENT'],
      [true, 'directory'],
    ],
  );
});

test('isFixtureLive requires an observation in the control', () => {
  const fixture = {
    id: 'hook',
    live: {
      recorder: ['hook-stop'],
      init: { field: 'skills', includes: 'bap0-skill' },
    },
  };
  assert.equal(isFixtureLive(fixture, { requestHit: false }).live, false);
  assert.equal(
    isFixtureLive(fixture, {
      requestHit: false,
      recorderDelta: { 'hook-stop': 2 },
    }).live,
    true,
  );
  assert.equal(
    isFixtureLive(fixture, {
      requestHit: false,
      init: { skills: ['bap0-skill-user'] },
    }).live,
    true,
  );
  assert.equal(
    isFixtureLive({ id: 'x', live: { request: true } }, { requestHit: true })
      .live,
    true,
  );
  assert.equal(
    isFixtureLive(
      { id: 'hostFile', live: { notRequired: true } },
      { requestHit: false },
    ).live,
    true,
  );
});
