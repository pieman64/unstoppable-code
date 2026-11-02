// The chat composer's layout: a one-line box that opens up for more than a
// line, the model, effort, folder, permission and usage in the row under it,
// Plan mode as a removable chip picked from +, the microphone standing in for
// Send in an empty box, terminal mode on the default box, files dropped
// anywhere on the chat, and the transcript fading into the composer while
// scrolled up. Replaces the density-ladder checks of the composer that kept its
// settings inside the box and moved them into + as the box narrowed.
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { CHAT_EFFORT_TRIGGER_TEST_ID } from './effortPanel.mjs';
import { seedPreferences } from './codexPipelineRuntime.mjs';
import { DEFAULT_MOCK_BASE_URL, registerScenario } from './seeders/index.mjs';
import { connectMockCloudAccount } from './seeders/connectMockCloudAccount.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';

async function openSeededChat({
  tabs,
  env,
  viewportSize,
  apps,
  providerType = 'claude',
} = {}) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-composer-layout-'),
  );
  const demoApps = apps ?? ['ts-pnpm-vite'];
  seedDemoWorkspaces({ userDataDir, apps: demoApps, checkRuntimes: false });
  if (providerType === 'codex') seedPreferences(userDataDir);
  seedWorktreeChat({
    userDataDir,
    workspaceId:
      demoApps[0] === 'ts-pnpm-vite' ? WORKSPACE_ID : `demo-${demoApps[0]}`,
    worktreeId: WORKTREE_ID,
    providerType,
    tabs: tabs ?? [{ id: 't1', title: 'Chat' }],
  });
  const launched = await launchCanopy({
    userDataDir,
    viewportSize: viewportSize ?? { width: 1400, height: 900 },
    ...(env ? { env } : {}),
  });
  const window = await launched.electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_BRANCH);
  const composer = window.locator('[data-chat-composer-root]:visible').first();
  await expect(composer).toBeVisible();
  return { ...launched, userDataDir, window, composer };
}

/** How far a row's content overflows its own box, in CSS px. */
function overflowOf(locator) {
  return locator.evaluate(
    (element) => element.scrollWidth - element.clientWidth,
  );
}

test.describe('chat composer layout', () => {
  // Speed rides in the effort panel's corner bolt, as on develop: Regular,
  // Fast (accent) and, where the route offers it, Ultra fast (purple).
  const FAST_TIER = {
    id: 'priority',
    name: 'Fast',
    description: 'Faster inference',
  };
  const ULTRA_TIER = {
    id: 'ultrafast',
    name: 'Ultra fast',
    description: 'Highest speed',
  };

  async function openSpeedChat({ scenarioKey, serviceTiers, speed }) {
    await registerScenario(DEFAULT_MOCK_BASE_URL, scenarioKey, {
      codexAccountModels: [
        { id: 'gpt-6-astra', model: 'gpt-6-astra', serviceTiers },
      ],
    });
    const opened = await openSeededChat({
      providerType: 'codex',
      tabs: [
        {
          id: 'speed',
          title: 'Speed',
          model: 'gpt-6-astra',
          modelConfig: { speed, fastMode: speed === 'fast' },
        },
      ],
      env: { CANOPY_MOCK_API_KEY: scenarioKey },
    });
    const trigger = opened.composer.getByTestId(CHAT_EFFORT_TRIGGER_TEST_ID);
    const persistedSpeed = () =>
      opened.window.evaluate(
        async (target) => {
          const persisted = await window.api.chat.loadTabs(target);
          return persisted.tabs.find((tab) => tab.id === 'speed')?.modelConfig
            ?.speed;
        },
        { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
      );
    return { ...opened, trigger, persistedSpeed };
  }

  test('shows Ultra fast as the purple third state of the effort bolt', async () => {
    test.setTimeout(90_000);
    const { electronApp, userDataDir, composer, window, trigger } =
      await openSpeedChat({
        scenarioKey: 'composer-speed-ultra',
        serviceTiers: [FAST_TIER, ULTRA_TIER],
        speed: 'ultrafast',
      });
    try {
      // No separate speed chip sits in the composer.
      await expect(
        composer.getByTestId('chat-input-fast-mode-button'),
      ).toHaveCount(0);
      await expect(trigger).toHaveAttribute(
        'aria-label',
        /, ultra fast mode on$/,
      );
      await expect(
        trigger.getByTestId(`${CHAT_EFFORT_TRIGGER_TEST_ID}-speed-bolt`),
      ).toHaveClass(/fg-special/);
      await trigger.click();
      const bolt = window.getByTestId(
        `${CHAT_EFFORT_TRIGGER_TEST_ID}-fast-mode`,
      );
      await expect(bolt).toHaveAttribute('data-speed', 'ultrafast');
      await expect(bolt).toHaveClass(/fg-special/);
      // Regular → Fast → Ultra fast, wrapping round.
      await bolt.click();
      await expect(bolt).toHaveAttribute('data-speed', 'standard');
      await expect(trigger).not.toHaveAttribute('aria-label', /mode on/);
      await bolt.click();
      await expect(bolt).toHaveAttribute('data-speed', 'fast');
      await expect(bolt).toHaveClass(/fg-accent/);
      // Ultra fast joins the cycle once its availability is confirmed.
      await expect(async () => {
        if ((await bolt.getAttribute('data-speed')) !== 'ultrafast') {
          await bolt.click();
        }
        await expect(bolt).toHaveAttribute('data-speed', 'ultrafast', {
          timeout: 1_000,
        });
      }).toPass({ timeout: 15_000 });
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('steps Ultra fast down to Fast on a model that does not offer it', async () => {
    test.setTimeout(90_000);
    const { electronApp, userDataDir, window, trigger, persistedSpeed } =
      await openSpeedChat({
        scenarioKey: 'composer-speed-downgrade',
        serviceTiers: [FAST_TIER],
        speed: 'ultrafast',
      });
    try {
      await expect(trigger).toHaveAttribute('aria-label', /, fast mode on$/);
      await expect.poll(persistedSpeed).toBe('fast');
      await trigger.click();
      const bolt = window.getByTestId(
        `${CHAT_EFFORT_TRIGGER_TEST_ID}-fast-mode`,
      );
      await expect(bolt).toHaveAttribute('data-speed', 'fast');
      // No warning: the cycle offers only the speeds this model runs.
      await bolt.click();
      await expect(bolt).toHaveAttribute('data-speed', 'standard');
      await bolt.click();
      await expect(bolt).toHaveAttribute('data-speed', 'fast');
      await bolt.click();
      await expect(bolt).toHaveAttribute('data-speed', 'standard');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('rests as one line and opens up for more than a line', async () => {
    const { electronApp, userDataDir, composer, window } =
      await openSeededChat();
    try {
      const box = composer.locator('[data-composer-layout]');
      await expect(box).toHaveAttribute('data-composer-layout', 'one-line');

      const editor = composer.getByRole('textbox').first();
      await editor.click();
      await window.keyboard.type('One short line');
      // A line that fits keeps the box on one line.
      await expect(box).toHaveAttribute('data-composer-layout', 'one-line');

      await window.keyboard.press('Shift+Enter');
      await window.keyboard.type('A second line');
      await expect(box).toHaveAttribute('data-composer-layout', 'full');

      // Emptied again, the box goes back to one line. Deleted a key at a
      // time, as a person would: select-all raced the typed text here.
      const typed = 'One short line\nA second line';
      for (let key = 0; key < typed.length; key += 1) {
        await window.keyboard.press('Backspace');
      }
      await expect(editor).not.toContainText('One short line');
      await expect(box).toHaveAttribute('data-composer-layout', 'one-line');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('keeps the model, effort, permission and usage in the row under the box', async () => {
    const { electronApp, userDataDir, composer } = await openSeededChat();
    try {
      const box = composer.locator('[data-composer-layout]');
      const row = composer.getByTestId('chat-composer-status-row');
      await expect(row).toBeVisible();
      // Model and effort lead the row; the permission and usage close it.
      const model = row.getByTestId('chat-model-picker');
      const effort = row.getByTestId(CHAT_EFFORT_TRIGGER_TEST_ID);
      const approval = row.getByTestId('approval-mode-picker');
      const usage = row.getByTestId('usage-indicator');
      for (const control of [model, effort, approval, usage]) {
        await expect(control).toBeVisible();
      }
      await expect(approval).toHaveText(/^(Ask|Accept edits|Full access)$/);
      const [boxRect, rowRect, modelRect, effortRect, approvalRect, usageRect] =
        await Promise.all(
          [box, row, model, effort, approval, usage].map((locator) =>
            locator.boundingBox(),
          ),
        );
      expect(rowRect.y).toBeGreaterThanOrEqual(boxRect.y + boxRect.height - 1);
      expect(modelRect.x).toBeLessThan(effortRect.x);
      expect(effortRect.x).toBeLessThan(approvalRect.x);
      expect(approvalRect.x).toBeLessThan(usageRect.x);
      // Nothing else sits in the box's own row but +, the editor, mic and
      // send: the settings are not duplicated inside it.
      await expect(box.getByTestId('chat-model-picker')).toHaveCount(0);
      await expect(box.getByTestId('approval-mode-picker')).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('a narrow panel truncates the row rather than dropping settings', async () => {
    const { electronApp, userDataDir, composer, window } = await openSeededChat(
      { viewportSize: { width: 800, height: 700 } },
    );
    try {
      const row = composer.getByTestId('chat-composer-status-row');
      await expect(row).toBeVisible();
      for (const testId of [
        'chat-model-picker',
        CHAT_EFFORT_TRIGGER_TEST_ID,
        'approval-mode-picker',
        'usage-indicator',
      ]) {
        await expect(row.getByTestId(testId)).toBeVisible();
      }
      // The row never spills past its own edge; the model name gives way.
      expect(await overflowOf(row)).toBeLessThanOrEqual(1);
      const box = composer.locator('[data-composer-layout]');
      expect(await overflowOf(box)).toBeLessThanOrEqual(1);
      // The model menu still opens from a truncated trigger.
      await row.getByTestId('chat-model-picker').click();
      await expect(window.getByTestId('chat-model-menu')).toBeVisible();
      await window.keyboard.press('Escape');
      await expect(window.getByTestId('chat-model-menu')).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('Plan mode is picked in + and shows as a chip that removes it', async () => {
    const { electronApp, userDataDir, composer, window } =
      await openSeededChat();
    try {
      const chip = composer.getByTestId('chat-input-plan-mode-inline-button');
      await expect(chip).toHaveCount(0);
      await composer.getByTestId('chat-input-plus-button').click();
      await window.getByTestId('chat-input-plan-mode-button').click();
      await expect(chip).toHaveAttribute('aria-pressed', 'true');
      await expect(chip).toContainText('Plan');
      // The chip is the way back out.
      await chip.click();
      await expect(chip).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('chips share the one line, and draw small in a narrow box', async () => {
    const { electronApp, userDataDir, composer, window } =
      await openSeededChat();
    try {
      const box = composer.locator('[data-composer-layout]');
      const plus = composer.getByTestId('chat-input-plus-button');
      await composer.getByTestId('chat-input-plus-button').click();
      await window.getByTestId('chat-input-plan-mode-button').click();
      const chip = composer.getByTestId('chat-input-plan-mode-inline-button');
      await expect(chip).toBeVisible();
      // A wide box: Plan by name, beside + on the one line.
      await expect(chip).toContainText('Plan');
      await expect(box).toHaveAttribute('data-composer-layout', 'one-line');
      const [chipRect, plusRect] = await Promise.all([
        chip.boundingBox(),
        plus.boundingBox(),
      ]);
      expect(Math.abs(chipRect.y - plusRect.y)).toBeLessThan(1);
      expect(chipRect.x).toBeGreaterThan(plusRect.x + plusRect.width);

      // A narrow box: the glyph alone, still beside +.
      await window.setViewportSize({ width: 800, height: 700 });
      await expect(chip).not.toContainText('Plan');
      await expect(chip).toHaveAttribute('aria-label', 'Disable plan mode');
      const [narrowChip, narrowPlus] = await Promise.all([
        chip.boundingBox(),
        plus.boundingBox(),
      ]);
      expect(Math.round(narrowChip.width)).toBe(32);
      expect(Math.abs(narrowChip.y - narrowPlus.y)).toBeLessThan(1);

      // Removing the chip leaves the one line.
      await chip.click();
      await expect(chip).toHaveCount(0);
      await expect(box).toHaveAttribute('data-composer-layout', 'one-line');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('switching chats shows the placeholder without animating it', async () => {
    const { electronApp, userDataDir, window } = await openSeededChat({
      tabs: [
        { id: 't1', title: 'First chat' },
        { id: 't2', title: 'Second chat' },
      ],
    });
    try {
      const chatTabs = window.locator('[role="tab"][data-panel-kind="chat"]');
      await expect(chatTabs).toHaveCount(2);
      for (const index of [1, 0]) {
        await chatTabs.nth(index).click();
        await expect(chatTabs.nth(index)).toHaveAttribute(
          'aria-selected',
          'true',
        );
        const placeholder = window
          .locator('[data-chat-composer-root]:visible [data-slate-placeholder]')
          .first();
        await expect(placeholder).toBeVisible();
        // The editor remounts on the switch; a fade on the placeholder
        // blinked it in each time.
        const animated = await placeholder.evaluate((element) =>
          [element, ...element.querySelectorAll('*')]
            .map((node) => getComputedStyle(node).animationName)
            .filter((name) => name !== 'none'),
        );
        expect(animated).toEqual([]);
      }
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('the microphone stands in for Send while the box is empty', async () => {
    test.skip(
      process.platform !== 'darwin',
      'Voice dictation is macOS-only; the E2E access flow is gated to it.',
    );
    const { electronApp, userDataDir, composer, window } = await openSeededChat(
      { env: { CANOPY_E2E_VOICE_ACCESS_FLOW: 'grant-after-request' } },
    );
    try {
      const send = composer.getByRole('button', {
        name: 'Send message',
        exact: true,
      });
      const mic = composer.getByTestId('voice-input-button');
      await expect(mic).toHaveAttribute('data-emphasis', 'primary');
      await expect(send).toHaveCount(0);

      await composer.getByRole('textbox').first().click();
      await window.keyboard.type('Ready to send');
      await expect(send).toBeVisible();
      await expect(mic).toBeVisible();
      await expect(mic).not.toHaveAttribute('data-emphasis', 'primary');
      // Beside Send the microphone rests in the primary ink, like the +.
      const inks = await mic.evaluate((button) => {
        const probe = document.createElement('span');
        probe.className = 'fg-primary';
        document.body.append(probe);
        const primary = getComputedStyle(probe).color;
        probe.remove();
        return { mic: getComputedStyle(button).color, primary };
      });
      expect(inks.mic).toBe(inks.primary);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('the transcript fades into the composer only while scrolled up', async () => {
    const longReply = Array.from(
      { length: 80 },
      (_, index) =>
        `Line ${index + 1}: enough text to push the transcript well past one screen.`,
    ).join('\n\n');
    const { electronApp, userDataDir, window } = await openSeededChat({
      tabs: [
        {
          id: 't1',
          title: 'Long chat',
          blocks: [{ type: 'text', text: longReply }],
        },
      ],
    });
    try {
      const list = window
        .locator('[data-testid="chat-message-list-scroll"]:visible')
        .first();
      await expect(list).toBeVisible();
      const scrollTo = (where) =>
        list.evaluate((element, target) => {
          element.scrollTop =
            target === 'bottom'
              ? element.scrollHeight
              : element.scrollHeight / 3;
          element.dispatchEvent(new Event('scroll'));
        }, where);
      const mask = () => list.evaluate((element) => element.style.maskImage);

      await scrollTo('middle');
      await expect.poll(mask).toContain('linear-gradient');
      // Only the bottom edge fades: the top stays solid for the pinned bubble.
      await expect.poll(mask).toMatch(/^linear-gradient\(black, black 0px/);

      await scrollTo('bottom');
      await expect.poll(mask).not.toContain('linear-gradient');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('multi-repo: the folder picker follows effort in the row and fits at the minimum width', async () => {
    const { electronApp, userDataDir, composer, window } = await openSeededChat(
      { apps: ['multi-repo-fullstack'] },
    );
    try {
      const row = composer.getByTestId('chat-composer-status-row');
      const box = composer.locator('[data-composer-layout]');
      const directory = row.getByRole('button', {
        name: /^Select working directory/,
      });
      await expect(directory).toBeVisible();
      await expect(directory).toContainText('Project root');
      // Out of the box: + and the editor keep its one line.
      await expect(
        box.getByRole('button', { name: /^Select working directory/ }),
      ).toHaveCount(0);
      await expect(box).toHaveAttribute('data-composer-layout', 'one-line');
      const [effortRect, directoryRect, approvalRect] = await Promise.all(
        [
          row.getByTestId(CHAT_EFFORT_TRIGGER_TEST_ID),
          directory,
          row.getByTestId('approval-mode-picker'),
        ].map((locator) => locator.boundingBox()),
      );
      expect(effortRect.x).toBeLessThan(directoryRect.x);
      expect(directoryRect.x).toBeLessThan(approvalRect.x);

      // Its menu opens over the row.
      await directory.click();
      const menu = window.getByTestId('chat-directory-menu');
      await expect(menu).toBeVisible();
      const menuRect = await menu.boundingBox();
      expect(menuRect.y + menuRect.height).toBeLessThanOrEqual(directoryRect.y);
      const rootOption = menu.getByRole('option', { name: 'Project root' });
      await expect(rootOption).toHaveAttribute('aria-selected', 'true');
      const childOption = menu.getByRole('option').nth(1);
      const childName = (await childOption.innerText()).trim();
      await childOption.click();
      await expect(menu).toHaveCount(0);
      await expect(directory).toContainText(childName);
      await directory.click();
      await expect(
        menu.getByRole('option', { name: childName, exact: true }),
      ).toHaveAttribute('aria-selected', 'true');
      await rootOption.click();
      await expect(directory).toContainText('Project root');
      await directory.click();
      await window.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);

      await composer.getByTestId('chat-input-plus-button').click();
      const plusMenu = window.getByTestId('chat-input-plus-menu');
      await expect(plusMenu).toBeVisible();
      const insets = await plusMenu.evaluate((menuElement) => {
        const rect = menuElement.getBoundingClientRect();
        return { left: rect.left, right: window.innerWidth - rect.right };
      });
      expect(insets.left).toBeGreaterThanOrEqual(0);
      expect(insets.right).toBeGreaterThanOrEqual(0);
      await window.keyboard.press('Escape');
      await expect(plusMenu).toHaveCount(0);

      await window.setViewportSize({ width: 800, height: 500 });
      await expect(directory).toBeVisible();
      expect(await overflowOf(box)).toBeLessThanOrEqual(1);
      expect(await overflowOf(row)).toBeLessThanOrEqual(1);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('terminal mode keeps the default box with a dashed warning edge and only the run button', async () => {
    const { electronApp, userDataDir, composer, window } = await openSeededChat(
      process.platform === 'darwin'
        ? { env: { CANOPY_E2E_VOICE_ACCESS_FLOW: 'grant-after-request' } }
        : {},
    );
    try {
      const box = composer.locator('[data-composer-layout]');
      const shellBackground = await box.evaluate(
        (element) => getComputedStyle(element).backgroundColor,
      );
      const run = composer.getByRole('button', {
        name: 'Run terminal command',
        exact: true,
      });
      const label = composer.getByTestId('chat-input-terminal-mode-label');

      await composer.getByRole('textbox').first().click();
      await window.keyboard.type('!');
      await expect(label).toHaveText('Terminal mode');
      await expect(run).toBeDisabled();
      // A shell command is typed, not dictated.
      await expect(composer.getByTestId('voice-input-button')).toHaveCount(0);
      const expected = await box.evaluate(() => {
        const probe = document.createElement('span');
        probe.className = 'outline-line-attention bg-warning fg-warning';
        document.body.append(probe);
        const tokens = getComputedStyle(probe);
        const colors = {
          line: tokens.outlineColor,
          warning: tokens.backgroundColor,
          warningInk: tokens.color,
        };
        probe.remove();
        return colors;
      });
      const boxStyle = (property) =>
        box.evaluate(
          (element, name) => getComputedStyle(element).getPropertyValue(name),
          property,
        );
      // The default box, with the dashed warning edge on top. The shell
      // transitions its colors, so the edge settles rather than snaps.
      expect(await boxStyle('background-color')).toBe(shellBackground);
      expect(await boxStyle('outline-style')).toBe('dashed');
      expect(await boxStyle('border-top-width')).toBe('0px');
      await expect.poll(() => boxStyle('outline-color')).toBe(expected.line);
      expect(
        await label.evaluate((element) => getComputedStyle(element).color),
      ).toBe(expected.warningInk);

      await window.keyboard.type('ls');
      await expect(run).toBeEnabled();
      await expect
        .poll(() =>
          run.evaluate((element) => getComputedStyle(element).backgroundColor),
        )
        .toBe(expected.warning);

      // Clearing the ! returns the ordinary composer. Arrow keys move Slate's
      // own selection; Home moves only the DOM caret, which Slate syncs on a
      // 100ms throttle, so a render in that window snaps it back to the end.
      for (let i = 0; i < '!ls'.length; i += 1)
        await window.keyboard.press('ArrowLeft');
      await window.keyboard.press('Delete');
      await expect(composer.getByRole('textbox').first()).toHaveText('ls');
      await expect(label).toHaveCount(0);
      expect(await boxStyle('outline-style')).toBe('none');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('files dropped anywhere on the chat attach to the composer while the chat dims', async () => {
    const { electronApp, userDataDir, composer, window } =
      await openSeededChat();
    try {
      // Attachments need sign-in; a guest drop opens the sign-in prompt.
      await connectMockCloudAccount(window, 'csk_composer_density_drop_e2e');
      const zone = window.locator('[data-chat-drop-zone]:visible').first();
      await expect(zone).toBeVisible();
      const overlay = zone.getByTestId('chat-drop-overlay');
      const box = composer.locator('[data-composer-layout]');
      // Drags start over the transcript, well above the composer.
      const dispatch = (type, withFile) =>
        zone.evaluate(
          (element, args) => {
            const transfer = new DataTransfer();
            if (args.withFile) {
              transfer.items.add(
                new File(['upload failed: timeout'], 'upload-test.log', {
                  type: 'text/plain',
                }),
              );
            } else {
              transfer.setData('text/plain', 'some text');
            }
            const composerRoot = element.querySelector(
              '[data-chat-composer-root]',
            );
            const rect = element.getBoundingClientRect();
            const target =
              document
                .elementsFromPoint(rect.left + rect.width / 2, rect.top + 40)
                .find(
                  (node) =>
                    element.contains(node) && !composerRoot?.contains(node),
                ) ?? element;
            const event = new DragEvent(args.type, {
              dataTransfer: transfer,
              bubbles: true,
              cancelable: true,
            });
            target.dispatchEvent(event);
            return event.defaultPrevented;
          },
          { type, withFile },
        );

      // A drag without files leaves the chat as it is.
      await dispatch('dragenter', false);
      await expect(overlay).toHaveCount(0);
      expect(await dispatch('drop', false)).toBe(false);

      await dispatch('dragenter', true);
      await expect(overlay).toBeVisible();
      await expect(overlay).toHaveText('Drop files to attach');
      // The whole chat dims, not just the composer.
      const [zoneRect, overlayRect] = await Promise.all([
        zone.boundingBox(),
        overlay.boundingBox(),
      ]);
      expect(Math.abs(overlayRect.height - zoneRect.height)).toBeLessThan(2);
      // The box keeps its own look under the overlay.
      await expect(box).toHaveAttribute('data-composer-layout', 'one-line');

      expect(await dispatch('drop', true)).toBe(true);
      await expect(overlay).toHaveCount(0);
      const tile = composer.getByTestId('attachment-pill');
      await expect(tile).toHaveCount(1);
      // A file card above the text, named by its file.
      await expect(tile.locator('[data-attachment-kind="file"]')).toBeVisible();
      await expect(tile).toContainText('upload-test.log');
      await expect(box).toHaveAttribute('data-composer-layout', 'full');
      const [tileRect, textRect] = await Promise.all([
        tile.boundingBox(),
        composer.getByRole('textbox').first().boundingBox(),
      ]);
      expect(tileRect.y + tileRect.height).toBeLessThanOrEqual(textRect.y);

      // Its corner x appears on hover and removes it.
      const remove = tile.getByRole('button', {
        name: 'Remove upload-test.log',
      });
      await expect(remove).toHaveCSS('opacity', '0');
      await tile.hover();
      await expect(remove).toHaveCSS('opacity', '1');
      await remove.click();
      await expect(tile).toHaveCount(0);
      await expect(box).toHaveAttribute('data-composer-layout', 'one-line');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});

// CAN-2050: the new suggestion menu and user pins share the existing density
// contract. Seed approval through the public API; review itself has its own flow.
test('CAN-2050 script suggestions and pins keep composer and launch controls usable as width shrinks', async () => {
  test.setTimeout(120_000);
  const { openScriptActionsFixture, SCRIPT_CONTEXT } =
    await import('./script-actions-fixture.mjs');
  const fixture = await openScriptActionsFixture();
  const { window } = fixture;
  try {
    await window.evaluate(async (context) => {
      const snapshot = await window.api.scriptActions.list(context);
      const hold = snapshot.actions.find(
        (action) => action.name === 'hold' && action.kind === 'detected',
      );
      if (!hold) throw new Error('Missing hold fixture');
      await window.api.scriptActions.review({
        ...context,
        entries: [{ id: hold.id, revision: hold.revision }],
        decision: 'approve',
      });
      await window.api.scriptActions.setPinned({
        ...context,
        id: hold.id,
        pinned: true,
      });
    }, SCRIPT_CONTEXT);
    const composer = window
      .locator('[data-chat-composer-root]:visible')
      .first();
    const editor = composer.locator('[contenteditable="true"]').first();
    const topbar = window.getByTestId('worktree-top-bar');
    for (const [width, variant] of [
      [1400, 'labelled'],
      [1000, 'compact'],
      [640, null],
    ]) {
      await window.setViewportSize({ width, height: 900 });
      if (variant) {
        await expect(
          window.getByTestId(`worktree-top-pin-${variant}`),
        ).toBeVisible();
      } else {
        await expect(window.getByTestId('worktree-top-pins')).toBeHidden();
      }
      await expect(
        topbar.getByRole('button', { name: /^Open in/ }).first(),
      ).toBeVisible();
      await editor.fill('!hold');
      await expect(window.getByTestId('chat-input-scripts-menu')).toBeVisible();
      expect(await overflowOf(composer)).toBeLessThanOrEqual(1);
      await editor.press('Escape');
      await editor.fill('');
      // Escape dismissed the `hold` query until the draft changes; let the
      // empty draft render before retyping, or both edits can commit as one
      // and the next `!hold` stays dismissed.
      await expect(composer.locator('[data-slate-placeholder]')).toBeVisible();
    }
  } finally {
    await fixture.close();
  }
});
