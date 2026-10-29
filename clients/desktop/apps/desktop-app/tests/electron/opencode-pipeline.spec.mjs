import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { openWorkspaceAndRun } from './codexPipelineRuntime.mjs';
import {
  cleanupDemoWorkspaces,
  seedDemoWorkspaces,
} from './demoWorkspaces.mjs';
import { openCodeConnectionFixture } from './fixtures/opencode-connection.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedWorkspaceApprovals } from './seeders/seedWorkspaceApprovals.mjs';
import { seedStoredPipeline } from './seeders/seedStoredPipeline.mjs';

// Dispatch through the real workspace pipeline UI and installed offline ACP
// runtime. Verify the persisted execution and native file effect, not a mock
// renderer response. Retry-usage totals have separate runner regression tests.
for (const { preset, savedDeny = false, startupError = false } of [
  { preset: 'read_only' },
  { preset: 'dangerous_all' },
  { preset: 'dangerous_all', savedDeny: true },
  { preset: 'none', startupError: true },
]) {
  test(`OpenCode pipeline native Write honors ${preset}${savedDeny ? ' with saved deny' : ''}${startupError ? ' with startup error' : ''}`, async ({}, testInfo) => {
    test.setTimeout(120_000);
    const fixture = await openCodeConnectionFixture();
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'opencode-pipeline-'),
    );
    const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    const name = `OpenCode pipeline ${preset}`;
    const workspace = seeded.workspaces.find(
      (item) => item.id === 'demo-ts-pnpm-vite',
    );
    // Child process cwd is canonical (for example /private/var on macOS).
    // Persist a rule for that same file identity.
    const sentinel = path.join(
      realpathSync(workspace.worktreePath),
      'sentinel.txt',
    );
    if (startupError)
      writeFileSync(
        path.join(workspace.worktreePath, '.opencode-fixture-fail-session'),
        'fail',
      );
    if (savedDeny)
      seedWorkspaceApprovals({
        userDataDir,
        workspaceId: workspace.id,
        rules: [
          {
            id: 'deny-write',
            behavior: 'deny',
            target: { kind: 'file-write', path: sentinel },
            origin: 'settings',
            createdAt: new Date().toISOString(),
          },
        ],
      });
    seedStoredPipeline({
      userDataDir,
      id: `opencode-${preset}`,
      name,
      yaml: [
        `name: ${name}`,
        'on: dispatch',
        'jobs:',
        '  verify:',
        '    steps:',
        '      - id: opencode',
        '        uses: builtin/agent-prompt',
        '        timeout_minutes: 1',
        '        with:',
        '          model: opencode:fixture%2Fmodel',
        `          permission_preset: ${preset}`,
        '          prompt: WRITE',
        '',
      ].join('\n'),
    });
    let launched;
    try {
      launched = await launchCanopy({ userDataDir, env: fixture.env });
      const window = await launched.electronApp.firstWindow();
      await new CanopyAppDriver(window).waitForShell();
      await window.evaluate(() => window.api.opencodeConnection.connect());
      const card = await openWorkspaceAndRun(window, name);
      await expect(card).toContainText(startupError ? 'failure' : 'success', {
        timeout: 60_000,
      });
      const dir = path.join(userDataDir, 'pipeline-executions');
      const entry = readdirSync(dir).find((file) => file.endsWith('.json'));
      expect(entry).toBeDefined();
      const state = JSON.parse(readFileSync(path.join(dir, entry), 'utf8'));
      await testInfo.attach('pipeline-execution', {
        body: JSON.stringify(state),
        contentType: 'application/json',
      });
      const allowed = preset === 'dangerous_all' && !savedDeny;
      if (startupError) {
        // The ACP transport intentionally removes raw provider content. Preserve
        // its safe error instead of substituting a missing-session error.
        expect(state.jobs.verify.steps.opencode.error).toBe(
          'ACP agent request failed',
        );
        expect(JSON.stringify(state.jobs.verify.steps.opencode)).not.toContain(
          'fixture provider authentication failed',
        );
        expect(JSON.stringify(state.jobs.verify.steps.opencode)).not.toContain(
          'did not create a session',
        );
      } else
        expect(state.jobs.verify.steps.opencode).toMatchObject({
          status: 'success',
          outputs: {
            text_response: allowed ? 'Write allowed.' : 'Write denied.',
          },
        });
      expect(existsSync(sentinel)).toBe(allowed);
      if (allowed) expect(readFileSync(sentinel, 'utf8')).toBe('approved');
      await expect(window.getByTestId('tool-approval-card')).toHaveCount(0);
    } finally {
      if (launched) await closeCanopy(launched.electronApp, userDataDir);
      await fixture.close();
      cleanupDemoWorkspaces(seeded);
    }
  });
}
