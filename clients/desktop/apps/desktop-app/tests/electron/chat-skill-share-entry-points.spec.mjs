import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  closeCanopy,
  launchCanopy,
  removeTestDataDir,
} from './launchCanopy.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  clearScenario,
  registerScenario,
  seedWorkspaceApprovals,
  seedWorktreeChat,
  writeJson,
} from './seeders/index.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import {
  connectChatShareAccount,
  ensureChatLayoutSkill,
  seedChatSkillShare,
  seedUnresolvedChatSkillShare,
  SHARE_SKILL,
  SHARE_CHAT,
  SHARE_WORKSPACE,
  SHARE_WORKTREE,
  registerChatLayoutScenario,
  shareChatLayoutResource,
  resizeChatActivityRail,
  LAYOUT_TEAM_NAME,
} from './seeders/chatSkillShare.mjs';
import { ORG_CONTEXT_ENV } from './seeders/seedOrgContextScoping.mjs';
import { setUiScale } from './uiScale.mjs';

async function expectUsedRowLayout(row) {
  await expect
    .poll(
      () =>
        row.evaluate((element) => {
          const name = element.querySelector(
            '[data-testid="chat-used-invocable-name"]',
          );
          const metadata = element.querySelector(
            '[data-testid="chat-used-invocable-metadata"]',
          );
          const action = element.querySelector('button');
          if (!name || !metadata) return false;
          const bounds = element.getBoundingClientRect();
          const primary = name.getBoundingClientRect();
          const secondary = metadata.getBoundingClientRect();
          const button = action?.getBoundingClientRect();
          const textWithinMetadata = Array.from(
            metadata.querySelectorAll(
              '[data-testid="chat-used-invocable-plugin"], [data-share-audience]',
            ),
          ).every((text) => {
            const box = text.getBoundingClientRect();
            return (
              box.width > 0 &&
              box.left >= secondary.left - 1 &&
              box.right <= secondary.right + 1 &&
              box.top >= secondary.top - 1 &&
              box.bottom <= secondary.bottom + 1
            );
          });
          return (
            textWithinMetadata &&
            primary.width > 20 &&
            Math.abs(primary.x - secondary.x) <= 1 &&
            secondary.top >=
              Math.max(primary.bottom, button?.bottom ?? 0) - 1 &&
            secondary.right <= bounds.right + 1 &&
            (!button ||
              (button.right <= bounds.right + 1 && button.top < primary.bottom))
          );
        }),
      {
        message:
          'metadata must use its own row aligned with the name and stay inside the row',
      },
    )
    .toBe(true);
}

for (const long of [false, true]) {
  test(`used row layout at normal/minimum widths and enlarged scale (${long ? 'long' : 'normal'} names)`, async () => {
    test.setTimeout(180_000);
    const apiKey = `csk_can3633_layout_${long ? 'long' : 'normal'}`;
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can3633-layout-'));
    let electronApp;
    try {
      seedChatSkillShare(userDataDir, {
        transcript: true,
        ...(long
          ? {
              pluginDisplayName:
                'Release tools for engineering deployment readiness and cross-team coordination',
              pluginSkillName:
                'plugin-review-for-release-readiness-and-deployment-coordination',
            }
          : {}),
      });
      await registerChatLayoutScenario(apiKey);
      ({ electronApp } = await launchCanopy({
        userDataDir,
        env: ORG_CONTEXT_ENV,
      }));
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await connectChatShareAccount(window, apiKey);
      await ensureChatLayoutSkill(window);
      await app.openMainPage();
      await app.selectWorktree(SHARE_WORKTREE);
      const rows = window.getByTestId('chat-used-invocable-row');
      const plugin = rows.filter({ hasText: 'plugin-review' });
      const standalone = rows.filter({ hasText: '/share-review' });
      await expectUsedRowLayout(plugin);
      await expect(
        standalone.getByTestId('chat-used-invocable-metadata'),
      ).toHaveCount(0);
      await expect
        .poll(() =>
          standalone.evaluate((element) => {
            const name = element.querySelector(
              '[data-testid="chat-used-invocable-name"]',
            );
            const button = element.querySelector('button');
            if (!name || !button) return false;
            const primary = name.getBoundingClientRect();
            const action = button.getBoundingClientRect();
            return (
              getComputedStyle(element).display === 'flex' &&
              action.top < primary.bottom &&
              primary.top < action.bottom &&
              element.children.length === 3
            );
          }),
        )
        .toBe(true);
      await resizeChatActivityRail(window, 320);
      const beforeWidth = await plugin
        .getByTestId('chat-used-invocable-name')
        .evaluate((element) => element.getBoundingClientRect().width);
      await shareChatLayoutResource(window, standalone, 'skill', 'team');
      await shareChatLayoutResource(
        window,
        plugin,
        'plugin',
        long ? 'team' : 'organization',
      );
      await expect(
        plugin.getByTestId('chat-used-invocable-audience'),
      ).toHaveText(long ? `Team: ${LAYOUT_TEAM_NAME}` : 'Organization');
      await expect(
        standalone.getByTestId('chat-used-invocable-audience'),
      ).toHaveText('Team');
      await resizeChatActivityRail(window, 320);
      await expect
        .poll(() =>
          plugin
            .getByTestId('chat-used-invocable-name')
            .evaluate((element) => element.getBoundingClientRect().width),
        )
        .toBeCloseTo(beforeWidth, 0);
      for (const { scale, width } of [
        { scale: 100, width: 480 },
        { scale: 100, width: 320 },
        { scale: 125, width: 320 },
      ]) {
        await setUiScale(window, scale);
        await resizeChatActivityRail(window, width);
        await expect
          .poll(
            async () =>
              (
                await window
                  .getByTestId('panel-group-group-activity')
                  .boundingBox()
              )?.width,
          )
          .toBeCloseTo(width, 0);
        await expectUsedRowLayout(plugin);
        await expectUsedRowLayout(standalone);
        for (const testId of [
          'chat-used-invocable-name',
          'chat-used-invocable-plugin',
        ]) {
          const text = plugin.getByTestId(testId);
          expect(await text.getAttribute('title')).toBe(
            await text.textContent(),
          );
          const geometry = await text.evaluate((element) => {
            const style = getComputedStyle(element);
            return {
              overflow: style.overflowX,
              ellipsis: style.textOverflow,
              whiteSpace: style.whiteSpace,
              clipped: element.scrollWidth > element.clientWidth,
            };
          });
          expect(geometry).toMatchObject({
            overflow: 'hidden',
            ellipsis: 'ellipsis',
            whiteSpace: 'nowrap',
          });
          if (long && width === 320) expect(geometry.clipped).toBe(true);
        }
        const audience = plugin.locator('[data-share-audience]');
        expect(
          await audience.evaluate((element) => {
            const style = getComputedStyle(element);
            return {
              overflow: style.overflowX,
              ellipsis: style.textOverflow,
              whiteSpace: style.whiteSpace,
            };
          }),
        ).toEqual({
          overflow: 'hidden',
          ellipsis: 'ellipsis',
          whiteSpace: 'nowrap',
        });
        expect(await audience.getAttribute('title')).toBe(
          await audience.textContent(),
        );
        if (long)
          expect(
            await audience.evaluate(
              (element) => element.scrollWidth > element.clientWidth,
            ),
          ).toBe(true);
      }
      for (const [row, modalId] of [
        [standalone, 'share-skill-modal'],
        [plugin, 'share-plugin-modal'],
      ]) {
        const action = row.getByTestId('chat-used-invocable-share');
        await action.focus();
        await window.keyboard.press('Enter');
        await expect(window.getByTestId(modalId)).toBeVisible();
        // A dialog takes Escape once it holds focus: its Escape listener and
        // focus trap attach together, just after it first paints.
        await expect(window.getByTestId(modalId).locator(':focus')).toHaveCount(
          1,
        );
        await window.keyboard.press('Escape');
        await expect(window.getByTestId(modalId)).toHaveCount(0);
        await expect(action).toBeFocused();
      }
    } finally {
      try {
        if (electronApp) await closeCanopy(electronApp, userDataDir);
        else {
          await removeTestDataDir(userDataDir);
          await removeTestDataDir(`${userDataDir}-secure`);
        }
      } finally {
        await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
      }
    }
  });
}

test('an unresolved used plugin retains attribution without reserving action space', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'can3633-unresolved-'),
  );
  let electronApp;
  try {
    seedUnresolvedChatSkillShare(userDataDir);
    ({ electronApp } = await launchCanopy({ userDataDir }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await connectChatShareAccount(window);
    await app.openMainPage();
    await app.selectWorktree(SHARE_WORKTREE);
    await resizeChatActivityRail(window, 320);
    const row = window.getByTestId('chat-used-invocable-row');
    await expect(row.getByTestId('chat-used-invocable-plugin')).toHaveText(
      'From Unresolved plugin',
    );
    await expect(row.getByTestId('chat-used-invocable-share')).toHaveCount(0);
    await expectUsedRowLayout(row);
    expect(
      await row.evaluate(
        (element) =>
          getComputedStyle(element).gridTemplateColumns.split(' ').length,
      ),
    ).toBe(2);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    else {
      await removeTestDataDir(userDataDir);
      await removeTestDataDir(`${userDataDir}-secure`);
    }
  }
});

test('mention replaces details with sharing and used rows share the standalone skill or owning plugin', async () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can3611-entry-'));
  seedChatSkillShare(userDataDir, { transcript: true });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await connectChatShareAccount(window);
    await app.openMainPage();
    await app.selectWorktree(SHARE_WORKTREE);
    const panel = window.getByTestId('panel-content-chat');
    const card = panel.getByTestId('agent-artifact-skill');
    await expect(card).toBeVisible();
    await expect(card.locator('button')).toHaveCount(0);
    await expect(panel.getByTestId('agent-artifact-share')).toBeVisible();
    const cardBounds = await card.boundingBox();
    const artifactShareBounds = await panel
      .getByTestId('agent-artifact-share')
      .boundingBox();
    expect(cardBounds).not.toBeNull();
    expect(artifactShareBounds).not.toBeNull();
    expect(
      artifactShareBounds.x + artifactShareBounds.width,
    ).toBeLessThanOrEqual(cardBounds.x + cardBounds.width);
    await panel.getByTestId('agent-artifact-share').click();
    await expect(window.getByTestId('share-skill-modal')).toBeVisible();
    await expect(window.getByTestId('share-skill-submit')).toBeVisible();
    // Share is the only way to publish; there is no definition-only action.
    await expect(window.getByTestId('share-skill-definition-only')).toHaveCount(
      0,
    );
    await expect(panel).toBeVisible();
    await expect(window.getByTestId('view-skill-modal')).toHaveCount(0);
    await expect(
      window.getByTestId('share-skill-modal').locator(':focus'),
    ).toHaveCount(1);
    await window.keyboard.press('Escape');
    await panel
      .getByRole('button', { name: /Open .*share-review.* details/ })
      .first()
      .click();
    const share = window.getByTestId('invocable-mention-detail-share');
    await expect(share).toHaveAccessibleName(`Share ${SHARE_SKILL}`);
    await share.click();
    await expect(window.locator('#invocable-mention-detail-title')).toHaveCount(
      0,
    );
    await expect(window.getByTestId('share-skill-modal')).toBeVisible();
    await expect(
      window.getByTestId('share-skill-modal').locator(':focus'),
    ).toHaveCount(1);
    await window.keyboard.press('Escape');
    await expect(window.getByTestId('share-skill-modal')).toHaveCount(0);
    const rows = window.getByTestId('chat-used-invocable-row');
    const standalone = rows.filter({ hasText: SHARE_SKILL });
    await expect(standalone).toBeVisible();
    const standaloneShare = standalone.getByRole('button', {
      name: `Share ${SHARE_SKILL}`,
    });
    await standaloneShare.click();
    await expect(window.getByTestId('share-skill-modal')).toBeVisible();
    await expect(
      window.getByTestId('share-skill-modal').locator(':focus'),
    ).toHaveCount(1);
    await window.keyboard.press('Escape');
    await expect(window.getByTestId('share-skill-modal')).toHaveCount(0);
    await expect(standaloneShare).toBeFocused();
    const plugin = rows.filter({ hasText: 'plugin-review' });
    await expect(plugin).toContainText('From Release tools');
    const pluginShare = plugin.getByRole('button', {
      name: 'Share Release tools',
    });
    await expect(pluginShare).toBeVisible();
    await expect
      .poll(
        async () => {
          const attribution = await plugin
            .getByTestId('chat-used-invocable-plugin')
            .boundingBox();
          const action = await pluginShare.boundingBox();
          return attribution && action
            ? attribution.y - (action.y + action.height)
            : Number.NEGATIVE_INFINITY;
        },
        {
          message:
            'used plugin attribution must be below the first-line Share action',
        },
      )
      .toBeGreaterThanOrEqual(-1);
    const railBounds = await window
      .getByTestId('activity-section-plugins')
      .boundingBox();
    const shareBounds = await pluginShare.boundingBox();
    expect(railBounds).not.toBeNull();
    expect(shareBounds).not.toBeNull();
    expect(shareBounds.x + shareBounds.width).toBeLessThanOrEqual(
      railBounds.x + railBounds.width,
    );
    await plugin.getByRole('button', { name: 'Share Release tools' }).click();
    await expect(window.getByTestId('share-plugin-modal')).toBeVisible();
    await expect(window.getByTestId('share-plugin-modal')).toContainText(
      'Release tools',
    );
    await expect(
      window.getByTestId('share-plugin-modal').locator(':focus'),
    ).toHaveCount(1);
    await window.keyboard.press('Escape');
    await expect(window.getByTestId('share-plugin-modal')).toHaveCount(0);
    await expect(pluginShare).toBeFocused();
    await expect(panel).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('agent dispatch uses the main-window bridge and reports a request without an artifact', async () => {
  test.setTimeout(180_000);
  const marker = 'Canopy-CAN3611SHARE';
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: {
      steps: [
        {
          toolCalls: [
            {
              name: 'mcp__canopy__DispatchAction',
              input: {
                action: {
                  type: 'sharing.open_dialog',
                  target: { kind: 'skill', name: SHARE_SKILL },
                },
              },
            },
          ],
          stopReason: 'tool_use',
        },
        {
          text: 'Share dialog requested; the user confirms in the app.',
          stopReason: 'end_turn',
        },
      ],
    },
  });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'can3611-agent-share-'),
  );
  seedChatSkillShare(userDataDir);
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: {
      onboardingCompleted: ['v1'],
      defaultWorktreeProvider: 'claude',
      defaultChatProvider: 'claude',
      defaultWorktreeModelByProvider: {
        claude: { model: 'sonnet', thinkingLevel: 'off' },
      },
    },
  });
  seedWorkspaceApprovals({
    userDataDir,
    workspaceId: SHARE_WORKSPACE,
    defaultMode: 'full-access',
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: SHARE_WORKSPACE,
    worktreeId: SHARE_WORKTREE,
    providerType: 'claude',
    tabs: [{ id: SHARE_CHAT, title: 'Agent share' }],
  });
  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({ userDataDir }),
  );
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await connectChatShareAccount(window, 'csk_can3611_agent_share');
    await app.openMainPage();
    await app.selectWorktree(SHARE_WORKTREE);
    const panel = window.getByTestId('panel-content-chat');
    await panel
      .getByRole('textbox')
      .first()
      .fill(`[${marker}] Share the installed skill.`);
    await panel.getByRole('button', { name: 'Send message' }).click();
    await expect(window.getByTestId('share-skill-modal')).toBeVisible({
      timeout: 120_000,
    });
    await expect(panel.getByTestId('agent-artifact-skill')).toHaveCount(0);
    await window.keyboard.press('Escape');
    await expect(
      panel.getByText('Share dialog requested; the user confirms in the app.', {
        exact: true,
      }),
    ).toBeVisible({ timeout: 60_000 });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
