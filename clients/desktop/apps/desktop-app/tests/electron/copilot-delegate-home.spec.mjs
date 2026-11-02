import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { seedAgentModels } from './seeders/index.mjs';
import { launchCopilotSelectionFixture } from './fixtures/copilot-selection.mjs';
import { chooseSettingsOption } from './helpers/settingsSelect.mjs';

for (const inherit of [true, false]) {
  test(`Copilot managed child ${inherit ? 'inherits its parent home skill' : 'honors home inheritance opt-out'}`, async () => {
    test.setTimeout(180_000);
    const f = await launchCopilotSelectionFixture({
      approvalMode: 'full-access',
      seedBeforeLaunch: ({ userDataDir }) => {
        const skill = path.join(
          userDataDir,
          'provider-state',
          'claude',
          'skills',
          'home-delegate',
        );
        mkdirSync(skill, { recursive: true });
        writeFileSync(
          path.join(skill, 'SKILL.md'),
          '---\nname: home-delegate\ndescription: Retained home review\n---\nCOPILOT_HOME_DELEGATE_CANARY\n',
        );
      },
    });
    try {
      await f.connect();
      await f.driver.openSettings();
      await f.driver.openSettingsSection('experiments');
      await chooseSettingsOption(
        f.window.getByTestId('settings-managed-delegation-mode'),
        'explicit-only',
      );
      await f.driver.closeSettings();
      await f.select();
      await f.send(
        `COPILOT_HOME_PARENT${inherit ? '' : ' HOME_OPT_OUT'}: delegate a review using the available home instructions.`,
      );
      await expect(
        f.panel.getByTestId('chat-delegated-agent').first(),
      ).toBeVisible({ timeout: 60_000 });
      await expect(
        f.panel.getByText(
          inherit
            ? /Integrated Copilot child:.*COPILOT_HOME_DELEGATE_CANARY retained and readable/
            : /Integrated Copilot child:.*Copilot home inheritance is disabled/,
        ),
      ).toBeVisible({ timeout: 90_000 });
      await expect(f.panel.getByTestId('chat-stop-generation')).toBeHidden();
    } finally {
      await f.close();
    }
  });
}

test('Copilot keeps skipped home capabilities out of chat and still excludes unsafe instructions from children', async () => {
  test.setTimeout(180_000);
  const f = await launchCopilotSelectionFixture({
    approvalMode: 'full-access',
    seedBeforeLaunch: ({ userDataDir }) => {
      const skills = path.join(
        userDataDir,
        'provider-state',
        'claude',
        'skills',
      );
      for (const [name, instructions] of [
        [
          'safe-home',
          '---\nname: safe-home\ndescription: Safe inherited instructions\n---\nCOPILOT_HOME_DELEGATE_CANARY',
        ],
        [
          'unsafe-hook',
          '---\nname: unsafe-hook\ndescription: Unsupported hook\nhooks:\n  PreToolUse:\n    - matcher: "*"\n      hooks:\n        - type: command\n          command: "printf unmanaged"\n---\nReview changes.',
        ],
        [
          'unsafe-fork',
          '---\nname: unsafe-fork\ndescription: Unsupported fork\ncontext: fork\n---\nReview changes.',
        ],
        [
          'unsafe-agent',
          '---\nname: unsafe-agent\ndescription: Unsupported agent\nagent: Explore\n---\nReview changes.',
        ],
        [
          'unsafe-shell',
          '---\nname: unsafe-shell\ndescription: Unsupported preprocessing\n---\n!`printf unmanaged`',
        ],
      ]) {
        const dir = path.join(skills, name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, 'SKILL.md'), instructions);
      }
    },
  });
  try {
    await f.connect();
    await f.driver.openSettings();
    await f.driver.openSettingsSection('experiments');
    await chooseSettingsOption(
      f.window.getByTestId('settings-managed-delegation-mode'),
      'explicit-only',
    );
    await f.driver.closeSettings();
    await f.select();
    await f.send('Hello Copilot');
    await expect(
      f.panel.getByText('Copilot fixture reply 1.', { exact: true }),
    ).toBeVisible({ timeout: 60_000 });
    const notice = f.panel.getByText(
      /Some home capabilities could not be passed to delegates:/,
    );
    await expect(notice).toHaveCount(0);
    await f.send(
      'COPILOT_HOME_PARENT: delegate a review using the available home instructions.',
    );
    await expect(
      f.panel.getByText(
        /Integrated Copilot child:.*COPILOT_HOME_DELEGATE_CANARY retained and readable/,
      ),
    ).toBeVisible({ timeout: 90_000 });
    await expect(notice).toHaveCount(0);
    for (const name of [
      'unsafe-hook',
      'unsafe-fork',
      'unsafe-agent',
      'unsafe-shell',
    ])
      await expect
        .poll(() =>
          readFileSync(path.join(f.userDataDir, 'logs', 'main.log'), 'utf8'),
        )
        .toContain(name);
    await expect(f.panel.getByTestId('chat-stop-generation')).toBeHidden();
    await f.send('COPILOT_HOME_NOTICE_FOLLOWUP: confirm the next turn.');
    await expect(
      f.panel.getByText('Home notice follow-up completed.', { exact: true }),
    ).toBeVisible({ timeout: 90_000 });
    await expect(notice).toHaveCount(0);
  } finally {
    await f.close();
  }
});

for (const budget of [false, true]) {
  test(`Copilot home inheritance ${budget ? 'keeps Agent selections within the combined budget' : 'accepts a skill name with spaces'}`, async () => {
    test.setTimeout(180_000);
    const f = await launchCopilotSelectionFixture({
      approvalMode: 'full-access',
      seedBeforeLaunch: ({ userDataDir }) => {
        const root = path.join(userDataDir, 'provider-state/claude/skills');
        const safe = path.join(root, 'safe-home');
        mkdirSync(safe, { recursive: true });
        writeFileSync(
          path.join(safe, 'SKILL.md'),
          `---\nname: ${budget ? 'safe-home' : 'PDF Helper'}\ndescription: Safe home instructions\n---\nCOPILOT_HOME_DELEGATE_CANARY`,
        );
        if (budget) {
          for (const directory of [
            path.join(root, 'large-home'),
            path.join(userDataDir, 'skills/custom:app/selected-review'),
          ]) {
            mkdirSync(directory, { recursive: true });
            const selected = directory.endsWith('selected-review');
            writeFileSync(
              path.join(directory, 'SKILL.md'),
              `---\nname: ${selected ? 'selected-review' : 'large-home'}\ndescription: Bounded guidance\n---\n${selected ? 'SELECTED_AGENT_CANARY' : 'OPTIONAL_HOME_CANARY'}\n`,
            );
            // Each file fits the native reader's 64 KiB limit. Together these
            // two independently valid skills exceed the retained overlay budget.
            for (let index = 0; index < 10; index += 1) {
              writeFileSync(
                path.join(directory, `guidance-${index}.md`),
                'Guidance '.repeat(6_500),
              );
            }
          }
          seedAgentModels(userDataDir, [
            {
              id: 'agent_model_copilot_home_budget',
              name: 'Copilot home budget',
              baseModel: 'copilot:fixture-model',
              instructions: 'Read selected review instructions.',
              pluginSelections: {
                collectionIds: [],
                skillRefs: [
                  { sourceId: 'custom:app', skillName: 'selected-review' },
                ],
                pluginRefs: [],
                mcpServerRefs: [],
              },
              createdAt: '2026-10-13T00:00:00.000Z',
              updatedAt: '2026-10-13T00:00:00.000Z',
            },
          ]);
        }
      },
    });
    try {
      await f.connect();
      await f.driver.openSettings();
      await f.driver.openSettingsSection('experiments');
      await chooseSettingsOption(
        f.window.getByTestId('settings-managed-delegation-mode'),
        'explicit-only',
      );
      await f.driver.closeSettings();
      await f.select();
      await f.send(
        `COPILOT_HOME_PARENT${budget ? ' HOME_BUDGET' : ''}: delegate a review using home instructions.`,
      );
      await expect(
        f.panel.getByText(
          /Integrated Copilot child:.*COPILOT_HOME_DELEGATE_CANARY retained and readable/,
        ),
      ).toBeVisible({ timeout: 90_000 });
      if (budget) {
        const collapsedSteps = f.panel.getByRole('button', {
          name: /^Agent steps:/,
          expanded: false,
        });
        if (await collapsedSteps.count()) await collapsedSteps.first().click();
        const card = f.panel.getByTestId('chat-delegated-agent').first();
        await expect(card).toBeVisible();
        await card
          .getByRole('button', { name: 'Expand delegated task' })
          .click();
        await card.getByTestId('delegated-agent-capabilities-toggle').click();
        await expect(
          card.getByTestId('delegated-agent-capability-skipped'),
        ).toContainText('large-home');
      }
      await expect(f.panel.getByTestId('chat-stop-generation')).toBeHidden();
    } finally {
      await f.close();
    }
  });
}
