import { expect, test } from '@playwright/test';
import {
  chmodSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import path from 'node:path';
import { launchCopilotSelectionFixture } from './fixtures/copilot-selection.mjs';
import { seedStoredPipeline } from './seeders/index.mjs';
import { openWorkspaceAndRun } from './codexPipelineRuntime.mjs';

test('Copilot pipeline explains how to recover an unreadable instruction file', async ({}, testInfo) => {
  test.skip(
    process.platform === 'win32',
    'POSIX file permissions are required',
  );
  test.setTimeout(120_000);
  const f = await launchCopilotSelectionFixture();
  const instruction = path.join(f.worktreePath, 'CLAUDE.md');
  try {
    writeFileSync(instruction, 'PRIVATE_POLICY');
    chmodSync(instruction, 0o000);
    const name = 'Copilot unreadable repository instructions';
    seedStoredPipeline({
      userDataDir: f.userDataDir,
      id: 'copilot-unreadable-instructions',
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
        '          prompt: COPILOT_REPOSITORY_POLICY',
        '',
      ].join('\n'),
    });
    await f.restart();
    await f.connect();
    const card = await openWorkspaceAndRun(f.window, name);
    await expect(card).toContainText('failure', { timeout: 60_000 });
    const executions = path.join(f.userDataDir, 'pipeline-executions');
    const entries = readdirSync(executions).filter((entry) =>
      entry.endsWith('.json'),
    );
    expect(entries).toHaveLength(1);
    const state = JSON.parse(
      readFileSync(path.join(executions, entries[0]), 'utf8'),
    );
    await testInfo.attach('unreadable-instruction-execution', {
      body: JSON.stringify(state),
      contentType: 'application/json',
    });
    expect(state.jobs.verify.steps.copilot.error).toContain('CLAUDE.md');
    expect(state.jobs.verify.steps.copilot.error).toContain(
      'Check its permissions',
    );
    expect(state.jobs.verify.steps.copilot.error).not.toContain('EACCES');
  } finally {
    chmodSync(instruction, 0o644);
    await f.close();
  }
});

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

for (const legacyReplay of [false, true]) {
  test(`Copilot pipeline receives root and scoped repository instructions on ${legacyReplay ? 'legacy top-level rerun' : 'create and resume'}`, async ({}, testInfo) => {
    test.setTimeout(120_000);
    const f = await launchCopilotSelectionFixture();
    try {
      const cwd = path.join(f.worktreePath, 'policy-step');
      mkdirSync(cwd, { recursive: true });
      writeFileSync(
        path.join(f.worktreePath, 'CLAUDE.md'),
        'ROOT_POLICY_SENTINEL\n',
      );
      writeFileSync(path.join(cwd, 'AGENTS.md'), 'DESKTOP_POLICY_SENTINEL\n');
      const name = 'Copilot repository instructions';
      seedStoredPipeline({
        userDataDir: f.userDataDir,
        id: 'copilot-repository-instructions',
        name,
        yaml: [
          `name: ${name}`,
          'on: dispatch',
          'jobs:',
          '  verify:',
          '    steps:',
          ...['first', 'resumed'].flatMap((id) => [
            `      - id: ${id}`,
            `        uses: builtin/${id === 'first' ? 'agent-prompt' : 'agent-resume'}`,
            '        working_directory: policy-step',
            '        timeout_minutes: 1',
            '        with:',
            ...(id === 'resumed'
              ? ['          session_id: ${{ steps.first.outputs.session_id }}']
              : []),
            '          model: copilot:fixture-model',
            '          permission_preset: read_only',
            '          prompt: COPILOT_REPOSITORY_POLICY',
          ]),
          '',
        ].join('\n'),
      });
      await f.restart();
      await f.connect();
      const card = await openWorkspaceAndRun(f.window, name);
      await expect(card).toContainText(/success|failure/, { timeout: 60_000 });
      const executions = path.join(f.userDataDir, 'pipeline-executions');
      const entries = readdirSync(executions).filter((entry) =>
        entry.endsWith('.json'),
      );
      expect(entries).toHaveLength(1);
      const state = JSON.parse(
        readFileSync(path.join(executions, entries[0]), 'utf8'),
      );
      await testInfo.attach('repository-instructions-execution', {
        body: JSON.stringify(state),
        contentType: 'application/json',
      });
      expect(
        state.jobs.verify.steps.first,
        JSON.stringify(state.jobs.verify.steps.first),
      ).toMatchObject({ status: 'success' });
      expect(
        state.jobs.verify.steps.resumed,
        JSON.stringify(state.jobs.verify.steps.resumed),
      ).toMatchObject({ status: 'success' });
      await expect(card).toContainText('success');
      if (legacyReplay) {
        delete state.execution_checkout_root;
        writeFileSync(path.join(executions, entries[0]), JSON.stringify(state));
        await f.restart();
        await f.driver.openMainPage();
        await f.driver.selectWorktree('demo-main');
        await f.window.getByTestId(`pipeline-run-rerun-${state.id}`).click();
        const cards = f.window
          .locator('[data-testid^="pipeline-run-card-"]')
          .filter({ hasText: name });
        await expect(cards).toHaveCount(2, { timeout: 60_000 });
        const newCard = f.window
          .locator(
            `[data-testid^="pipeline-run-card-"]:not([data-testid="pipeline-run-card-${state.id}"])`,
          )
          .filter({ hasText: name });
        await expect(newCard).toContainText(/success|failure/, {
          timeout: 60_000,
        });
        const replayFiles = readdirSync(executions).filter(
          (entry) => entry.endsWith('.json') && entry !== entries[0],
        );
        expect(replayFiles).toHaveLength(1);
        const replayed = JSON.parse(
          readFileSync(path.join(executions, replayFiles[0]), 'utf8'),
        );
        await testInfo.attach('legacy-rerun-state', {
          body: JSON.stringify(replayed),
          contentType: 'application/json',
        });
        expect(
          replayed.jobs.verify.steps.first,
          JSON.stringify(replayed.jobs.verify.steps.first),
        ).toMatchObject({ status: 'success' });
        expect(replayed.execution_checkout_root).toBe(state.target.path);
        expect(replayed.jobs.verify.steps.first.status).toBe('success');
        expect(replayed.jobs.verify.steps.resumed.status).toBe('success');
      }
    } finally {
      await f.close();
    }
  });
}
