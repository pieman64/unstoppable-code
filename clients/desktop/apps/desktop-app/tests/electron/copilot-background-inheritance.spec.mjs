import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { launchCopilotSelectionFixture } from './fixtures/copilot-selection.mjs';
import { seedStoredPipeline } from './seeders/index.mjs';
import { openWorkspaceAndRun } from './codexPipelineRuntime.mjs';

test('Copilot desktop pipeline inherits a home skill without an explicit picker selection', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const f = await launchCopilotSelectionFixture({
    seedBeforeLaunch: ({ userDataDir }) => {
      const skill = path.join(
        userDataDir,
        'provider-state',
        'claude',
        'skills',
        'home-review',
      );
      mkdirSync(skill, { recursive: true });
      writeFileSync(
        path.join(skill, 'SKILL.md'),
        '---\nname: home-review\ndescription: Home pipeline review\n---\nCOPILOT_PIPELINE_SKILL_SENTINEL\n',
      );
    },
  });
  try {
    const name = 'Copilot inherited home skill';
    seedStoredPipeline({
      userDataDir: f.userDataDir,
      id: 'copilot-inherited-home',
      name,
      yaml: [
        `name: ${name}`,
        'on: dispatch',
        'jobs:',
        '  verify:',
        '    steps:',
        '      - id: copilot',
        '        uses: builtin/agent-prompt',
        '        timeout_minutes: 1',
        '        with:',
        '          model: copilot:fixture-model',
        '          permission_preset: read_only',
        '          prompt: COPILOT_SELECTED_SKILL',
        '',
      ].join('\n'),
    });
    await f.restart();
    await f.connect();
    const card = await openWorkspaceAndRun(f.window, name);
    await expect(card).toContainText(/success|failure/, { timeout: 60_000 });
    const executions = path.join(f.userDataDir, 'pipeline-executions');
    for (const name of readdirSync(executions).filter((name) =>
      name.endsWith('.json'),
    )) {
      await testInfo.attach(`pipeline-${name}`, {
        body: readFileSync(path.join(executions, name)),
        contentType: 'application/json',
      });
    }
    await expect(card).toContainText('success');
  } finally {
    await f.close();
  }
});
