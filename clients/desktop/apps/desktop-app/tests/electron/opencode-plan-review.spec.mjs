import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { launchOpenCodeSelectionFixture } from './fixtures/opencode-selection.mjs';

test('OpenCode proposes, revises, reloads and implements an explicitly approved plan', async () => {
  const f = await launchOpenCodeSelectionFixture({
    planMode: true,
    env: { OPENCODE_FIXTURE_PLAN: '1' },
  });
  try {
    await f.connect();
    await f.select();
    await f.send('OPENCODE_PROPOSE_PLAN');
    await expect(f.panel.getByTestId('chat-plan-approval')).toBeVisible();
    await expect(
      f.panel.getByRole('heading', {
        name: 'Parser validation (initial)',
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      f.panel.getByTestId('chat-message-list-content'),
    ).not.toContainText('<proposed_plan>');
    const initial = await f.tab();
    expect(initial.planMode).toBe(true);
    expect(initial.trackedPlanSource).toBe('opencode');
    expect(initial.trackedPlanId).toBeTruthy();
    expect(initial.pendingPlanExitRequestId).toBeTruthy();
    await f.send('OPENCODE_REVISE_PLAN');
    await expect.poll(async () => (await f.tab()).latestRevisionNumber).toBe(2);
    const revised = await f.tab();
    expect(revised.trackedPlanId).toBe(initial.trackedPlanId);
    expect(revised.pendingPlanExitRequestId).not.toBe(
      initial.pendingPlanExitRequestId,
    );
    expect(revised.planMode).toBe(true);
    await f.restart();
    await f.openChat();
    await expect(f.panel.getByTestId('chat-plan-approval')).toBeVisible();
    await f.panel.getByTestId('chat-plan-implement').click();
    await expect(
      f.panel.getByText('OpenCode implementation started in default mode.', {
        exact: true,
      }),
    ).toBeVisible();
    await expect.poll(async () => (await f.tab()).planMode).toBe(false);
    expect((await f.tab()).pendingPlanExitRequestId).toBeUndefined();
    expect((await f.tab()).trackedPlanReviewStatus).toBe('approved');
  } finally {
    await f.close();
  }
});

test('OpenCode desktop refuses implementation when the saved plan revision changed', async () => {
  const f = await launchOpenCodeSelectionFixture({
    planMode: true,
    env: { OPENCODE_FIXTURE_PLAN: '1' },
  });
  try {
    await f.connect();
    await f.select();
    await f.send('OPENCODE_PROPOSE_PLAN');
    await expect(f.panel.getByTestId('chat-plan-approval')).toBeVisible();
    await expect(f.panel.getByTestId('chat-stop-generation')).toBeHidden();
    const before = await f.tab();
    const changed = await f.window.evaluate(
      (request) => window.api.activity.plans.update(request),
      {
        projectId: f.target.projectId,
        worktreeId: f.target.worktreeId,
        planId: before.trackedPlanId,
        content:
          '# Changed in another editor\nDo not implement the old proposal.',
      },
    );
    expect(changed.latestRevisionNumber).toBeGreaterThan(
      before.latestRevisionNumber,
    );
    expect((await f.tab()).latestRevisionNumber).toBe(
      before.latestRevisionNumber,
    );
    await f.panel.getByTestId('chat-plan-implement').click();
    await expect(
      f.window.getByTestId('chat-state-command-failed-notice'),
    ).toBeVisible({ timeout: 30_000 });
    const after = await f.tab();
    expect(after.planMode).toBe(true);
    expect(after.pendingPlanExitRequestId).toBe(
      before.pendingPlanExitRequestId,
    );
    expect(after.trackedPlanReviewStatus).toBe('pending');
    await expect(f.panel).not.toContainText(
      'OpenCode implementation started in default mode.',
    );
  } finally {
    await f.close();
  }
});

test('App Advisor preserves the shared plan-mode gate for OpenCode', async () => {
  const f = await launchOpenCodeSelectionFixture({
    env: { OPENCODE_FIXTURE_PLAN: '1' },
  });
  try {
    await f.connect();
    const advisor = await f.driver.openAppAdvisorWindow(f.app);
    await advisor.setViewportSize({ width: 1200, height: 800 });
    const composer = advisor.getByRole('textbox').first();
    await expect(composer).toBeVisible();
    await advisor
      .getByTestId('chat-model-picker')
      .filter({ visible: true })
      .first()
      .click();
    await advisor.getByTestId('chat-model-harness-tab-opencode').click();
    await advisor
      .getByTestId('chat-model-option-opencode:fixture%2Fmodel')
      .click();
    await advisor.getByTestId('chat-input-plus-button').click();
    await expect(
      advisor.getByTestId('chat-input-plan-mode-button'),
    ).toHaveCount(0);
    await advisor.keyboard.press('Escape');
    await composer.fill('OPENCODE_PROPOSE_PLAN');
    await advisor
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await expect(
      advisor
        .getByTestId('chat-message-list-content')
        .getByText('Parser validation (initial)', { exact: false }),
    ).toBeVisible();
    await expect(advisor.getByTestId('chat-stop-generation')).toBeHidden();
    await expect(advisor.getByTestId('chat-plan-approval')).toHaveCount(0);
  } finally {
    await f.close();
  }
});

// Freeze the approval/write interleaving at the real filesystem boundary.
// The unit regression uses the actual plan writer; this flow proves that a
// newer stored revision is rejected when the user clicks Implement.
test('OpenCode rejects a saved plan that changes while approval is being recorded', async () => {
  const f = await launchOpenCodeSelectionFixture({
    planMode: true,
    env: { OPENCODE_FIXTURE_PLAN: '1' },
  });
  try {
    await f.connect();
    await f.select();
    await f.send('OPENCODE_PROPOSE_PLAN');
    await expect(f.panel.getByTestId('chat-plan-approval')).toBeVisible();
    await expect(f.panel.getByTestId('chat-stop-generation')).toBeHidden();
    const before = await f.tab();
    await f.app.evaluate(
      (_electron, target) => {
        const fs = process.getBuiltinModule('fs/promises');
        const { syncBuiltinESMExports } = process.getBuiltinModule('module');
        const original = fs.writeFile;
        globalThis.opencodePlanRaceApplied = false;
        fs.writeFile = async (...args) => {
          const [file, data] = args;
          if (
            typeof file !== 'string' ||
            !file.startsWith(target.userDataDir) ||
            typeof data !== 'string' ||
            !data.includes(target.planId)
          )
            return original(...args);
          let saved;
          try {
            saved = JSON.parse(data);
          } catch {
            return original(...args);
          }
          const plan = saved.plans?.find((entry) => entry.id === target.planId);
          if (
            !plan ||
            plan.reviewStatus !== 'approved' ||
            plan.latestRevisionNumber !== target.revisionNumber
          )
            return original(...args);
          fs.writeFile = original;
          syncBuiltinESMExports();
          await original(...args);
          const content =
            '# Concurrently saved replacement\nThis revision has not been reviewed.';
          const edited = {
            ...plan,
            content,
            latestRevisionNumber: plan.latestRevisionNumber + 1,
            revisions: [
              ...plan.revisions,
              {
                revisionNumber: plan.latestRevisionNumber + 1,
                content,
                source: plan.source,
                reviewStatus: plan.reviewStatus,
                createdAt: new Date().toISOString(),
              },
            ],
          };
          await original(
            file,
            JSON.stringify({
              ...saved,
              plans: saved.plans.map((entry) =>
                entry.id === plan.id ? edited : entry,
              ),
            }),
            'utf8',
          );
          globalThis.opencodePlanRaceApplied = true;
        };
        syncBuiltinESMExports();
      },
      {
        userDataDir: f.userDataDir,
        planId: before.trackedPlanId,
        revisionNumber: before.latestRevisionNumber,
      },
    );
    await f.panel.getByTestId('chat-plan-implement').click();
    await expect
      .poll(() => f.app.evaluate(() => globalThis.opencodePlanRaceApplied))
      .toBe(true);
    await expect(
      f.window.getByTestId('chat-state-command-failed-notice'),
    ).toBeVisible({ timeout: 10_000 });
    const after = await f.tab();
    expect(after.planMode).toBe(true);
    expect(after.pendingPlanExitRequestId).toBe(
      before.pendingPlanExitRequestId,
    );
    await expect(f.panel).not.toContainText(
      'OpenCode implementation started in default mode.',
    );
  } finally {
    await f.close();
  }
});

test('OpenCode refuses an unsynced working-copy edit before plan implementation', async () => {
  const f = await launchOpenCodeSelectionFixture({
    planMode: true,
    env: { OPENCODE_FIXTURE_PLAN: '1' },
  });
  try {
    await f.connect();
    await f.select();
    await f.send('OPENCODE_PROPOSE_PLAN');
    await expect(f.panel.getByTestId('chat-plan-approval')).toBeVisible();
    await expect(f.panel.getByTestId('chat-stop-generation')).toBeHidden();
    const before = await f.tab();
    const planFile = path.join(
      f.userDataDir,
      'workspaces',
      f.target.projectId,
      'worktree-data',
      f.target.worktreeId,
      'plan-explore',
      before.trackedPlanId,
      'plan.md',
    );
    // Change the file immediately before approval, before the sync debounce can
    // publish a newer stored revision. This is the file implementation reads.
    await writeFile(
      planFile,
      '# Unreviewed working copy\nDo not implement the old proposal.',
      'utf8',
    );
    await f.panel.getByTestId('chat-plan-implement').click();
    await expect(
      f.window.getByTestId('chat-state-command-failed-notice'),
    ).toBeVisible({ timeout: 10_000 });
    const after = await f.tab();
    expect(after.planMode).toBe(true);
    expect(after.pendingPlanExitRequestId).toBe(
      before.pendingPlanExitRequestId,
    );
    expect(after.trackedPlanReviewStatus).toBe('pending');
    await expect(f.panel).not.toContainText(
      'OpenCode implementation started in default mode.',
    );
  } finally {
    await f.close();
  }
});
