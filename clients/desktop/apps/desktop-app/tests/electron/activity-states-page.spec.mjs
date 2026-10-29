import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// Durable coverage for the dev/E2E-only Activity States reference page.
// The gallery is deterministic and props-driven: no worktree, network, or
// agent process is involved.
test('activity states page exposes every card machine and exhaustive catalog', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-activity-states-e2e-'),
  );
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    await window.getByTestId('sidebar-more').click();
    await expect(window.getByTestId('sidebar-more-menu')).toBeVisible();
    // Every dev page lives behind one More entry with tabs.
    await window.getByTestId('sidebar-more-item-dev-pages').click();
    await window.getByTestId('dev-pages-tab-activity-states').click();

    const page = window.getByTestId('page-activity-states');
    await expect(page).toBeVisible();
    const machines = page.locator('[data-testid^="activity-state-machine-"]');
    await expect(machines).toHaveCount(14);

    const summary = page.getByTestId('activity-state-machine-summary');
    const changedFiles = page.getByTestId(
      'activity-state-machine-changed-files',
    );
    await expect(summary).toHaveAttribute('data-current-state', 'ready');
    await expect(changedFiles).toHaveAttribute(
      'data-current-state',
      'modified',
    );

    const additions = changedFiles.locator(
      '[data-activity-gallery-additions="true"]',
    );
    const deletions = changedFiles.locator(
      '[data-activity-gallery-deletions="true"]',
    );
    await expect(additions.first()).toHaveClass(/fg-positive/);
    await expect(deletions.first()).toHaveClass(/fg-destructive/);

    await summary.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(summary).toHaveAttribute('data-current-state', 'generating');
    await summary.getByRole('button', { name: 'Cancel' }).click();
    await expect(summary).toHaveAttribute('data-current-state', 'empty');

    await summary.getByRole('button', { name: 'Refresh', exact: true }).hover();
    await expect(window.getByRole('tooltip')).toHaveText('Refresh');

    await summary.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(summary).toHaveAttribute('data-current-state', 'generating');
    await summary.getByRole('button', { name: 'Ready', exact: true }).click();
    await expect(summary).toHaveAttribute('data-current-state', 'ready');

    await summary.getByTestId('activity-state-advance-summary').click();
    await expect(summary).toHaveAttribute('data-current-state', 'stale');
    await expect(changedFiles).toHaveAttribute(
      'data-current-state',
      'modified',
    );

    const plans = page.getByTestId('activity-state-machine-plans');
    await expect(plans).toHaveAttribute('data-current-state', 'empty');
    await plans.getByRole('button', { name: 'Import plan' }).click();
    await expect(plans).toHaveAttribute('data-current-state', 'tracked');

    await page.getByTestId('activity-gallery-view-catalog').click();
    const catalog = page.getByTestId('activity-gallery-catalog');
    await expect(catalog).toBeVisible();
    await expect(
      catalog.getByTestId('activity-gallery-catalog-plans-empty'),
    ).toBeVisible();
    await expect(
      catalog.getByRole('button', { name: 'Import plan', exact: true }),
    ).toBeVisible();
    await expect(
      catalog.getByTestId('activity-gallery-catalog-hooks-failed'),
    ).toBeVisible();
    await expect(
      catalog.getByTestId('activity-gallery-catalog-attachments-failed'),
    ).toBeVisible();

    const headerActionIcons = catalog.locator(
      '[data-header-action-button="true"] svg',
    );
    expect(await headerActionIcons.count()).toBeGreaterThan(0);
    for (let index = 0; index < (await headerActionIcons.count()); index += 1) {
      await expect(headerActionIcons.nth(index)).toHaveAttribute(
        'data-app-icon',
        'true',
      );
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('chat playground exercises question submission, recovery and terminal states', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'chat-playground-e2e-'),
  );
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await window.getByTestId('sidebar-more').click();
    await window.getByTestId('sidebar-more-item-dev-pages').click();
    await window.getByTestId('dev-pages-tab-activity-states').click();
    // Observe real main-process IPC handlers without replacing renderer APIs.
    // Any accidental live chat/attachment/recording dispatch fails this flow.
    await electronApp.evaluate(({ ipcMain }) => {
      const calls = [];
      globalThis.__sandboxMutationCalls = calls;
      for (const [channel, handler] of ipcMain._invokeHandlers) {
        if (
          /^(chat:|voice:start$|terminal:spawn$|worktree:import-attachments$|workspace-items:import-attachments$)/.test(
            channel,
          )
        ) {
          ipcMain._invokeHandlers.set(channel, (event, ...args) => {
            calls.push(channel);
            return handler(event, ...args);
          });
        }
      }
    });
    await window
      .getByTestId('activity-gallery-view-chat')
      .click({ timeout: 10_000 });
    const playground = window.getByTestId('chat-question-playground');

    await playground
      .getByRole('button', { name: 'Project brief', exact: true })
      .click();
    const chat = playground.getByTestId('playground-chat');
    await expect(chat.getByTestId('chat-message-list-content')).toBeVisible();
    await expect(chat.locator('[data-chat-composer-root]')).toBeVisible();
    await expect(chat.getByTestId('chat-input-plus-button')).toBeDisabled();
    const voice = chat.getByTestId('voice-input-button');
    if (await voice.count()) await expect(voice).toBeDisabled();
    const editor = chat.locator('[data-chat-textarea]');
    await editor.press('ControlOrMeta+u');
    await editor.evaluate((element) => {
      const files = new DataTransfer();
      files.items.add(
        new File(['sandbox fixture'], 'sandbox.txt', { type: 'text/plain' }),
      );
      element.dispatchEvent(
        new ClipboardEvent('paste', {
          clipboardData: files,
          bubbles: true,
          cancelable: true,
        }),
      );
      element.dispatchEvent(
        new DragEvent('drop', {
          dataTransfer: files,
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    // The composer box asks the question; its own input is the answer.
    const prompt = chat.getByTestId('chat-question-prompt');
    const composer = chat.locator('[data-chat-textarea]');
    const send = chat.getByTestId('chat-question-send');
    await expect(
      chat.locator('[data-composer-layout="question"]'),
    ).toBeVisible();
    await expect(prompt).toContainText('Before we start building');
    // The cursor waits in the composer's input as the question shows.
    await expect(composer).toBeFocused();
    await expect(
      prompt
        .getByRole('list', { name: 'Question progress' })
        .getByRole('listitem'),
    ).toHaveCount(2);
    // Until something is written, Skip takes send's place.
    await expect(send).toHaveCount(0);
    await expect(prompt.getByTestId('chat-question-skip')).toBeVisible();
    await composer.fill('Atlas');
    await expect(prompt.getByTestId('chat-question-skip')).toHaveCount(0);
    await send.click();
    await expect(
      prompt.getByRole('listitem', { name: 'Question 2 of 2', exact: true }),
    ).toHaveAttribute('aria-current', 'step');
    await expect(prompt).toContainText('What should the first version');
    await expect(chat.getByTestId('chat-question-back')).toBeVisible();
    // Enter sends the answer, as it sends a message.
    await composer.fill('A quiet place for team notes.');
    await composer.press('Enter');
    await expect(playground).toHaveAttribute('data-state', 'submitting');
    await playground
      .getByRole('button', { name: 'Fail request', exact: true })
      .click();
    // A failed send keeps the answers and offers to try again.
    await expect(prompt.getByRole('alert')).toContainText("Couldn't send");
    await prompt.getByTestId('chat-question-retry').click();
    await expect(playground).toHaveAttribute('data-state', 'submitting');
    await playground
      .getByRole('button', { name: 'Resolve request', exact: true })
      .click();
    await expect(playground).toHaveAttribute('data-state', 'answered');
    await expect(prompt).toHaveCount(0);
    await expect(chat.getByTestId('answered-questions')).toContainText('Atlas');
    await expect(chat.getByTestId('answered-question')).toHaveCount(2);
    await expect(chat.getByTestId('answered-question').first()).toContainText(
      'so a working title is completely fine.',
    );

    // Disconnected, the prompt cannot answer; Skip dismisses once back.
    await playground
      .getByRole('button', { name: 'Start again', exact: true })
      .click();
    await playground
      .getByRole('button', { name: 'Disconnect', exact: true })
      .click();
    await composer.fill('Offline answer');
    await expect(send).toBeDisabled();
    await expect(prompt).toContainText('Reconnect to answer this question.');
    await playground
      .getByRole('button', { name: 'Reconnect', exact: true })
      .click();
    // The composer comes back a moment after the click. A clear issued before
    // then does not take: the offline text stays and Skip never replaces
    // send. Wait for the reconnected composer, then clear until it holds.
    await expect(prompt).not.toContainText(
      'Reconnect to answer this question.',
    );
    await expect(send).toBeEnabled();
    await expect(async () => {
      await composer.fill('');
      await expect(prompt.getByTestId('chat-question-skip')).toBeVisible({
        timeout: 2_000,
      });
    }).toPass({ timeout: 15_000 });
    await prompt.getByTestId('chat-question-skip').click();
    await playground
      .getByRole('button', { name: 'Resolve request', exact: true })
      .click();
    await expect(playground).toHaveAttribute('data-state', 'dismissed');
    await expect(chat).toContainText('Question dismissed');

    // Several choices toggle, then go out with send.
    await composer.fill('');
    await playground
      .getByRole('button', { name: 'Multiple choices', exact: true })
      .click();
    await prompt.getByRole('button', { name: 'Search', exact: true }).click();
    await prompt
      .getByRole('button', { name: 'Analytics', exact: true })
      .click();
    await expect(
      prompt.getByRole('button', { name: 'Search', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await send.click();
    await playground
      .getByRole('button', { name: 'Resolve request', exact: true })
      .click();
    await expect(chat.getByTestId('answered-questions')).toContainText(
      'Search',
    );
    await expect(chat.getByTestId('answered-questions')).toContainText(
      'Analytics',
    );
    // With no question waiting, the composer sends messages again.
    await composer.fill('Now help me plan the second release.');
    await composer.press('Enter');
    await expect(playground).toHaveAttribute('data-state', 'pending');
    await expect(chat.getByTestId('chat-message-list-content')).toContainText(
      'Now help me plan the second release.',
    );
    await expect(chat.getByTestId('answered-questions')).toContainText(
      'Analytics',
    );
    // The new question asks again; typed text is the person's own answer.
    await expect(prompt).toBeVisible();
    await expect(composer.locator('[data-slate-placeholder]')).toContainText(
      'Or type your own answer',
    );
    await composer.fill('Offline mode');
    await composer.press('Enter');
    await expect(playground).toHaveAttribute('data-state', 'submitting');
    await playground
      .getByRole('button', { name: 'Resolve request', exact: true })
      .click();
    await expect(chat.getByTestId('answered-questions').last()).toContainText(
      'Offline mode',
    );
    const mutationCalls = await electronApp.evaluate(
      () => globalThis.__sandboxMutationCalls,
    );
    // Read-only model/feedback probes can share the chat namespace.
    expect(
      mutationCalls.filter(
        (channel) =>
          ![
            'chat:get-state',
            'chat:load-tabs',
            'chat:load-archives',
            'chat:read-archive',
            'chat:active-sessions',
            'chat:queue-get-snapshot',
            'chat:transient-retry-get-snapshot',
          ].includes(channel),
      ),
    ).toEqual([]);
    const chatBounds = await chat.boundingBox();
    const composerBounds = await chat
      .locator('[data-chat-composer-root]')
      .boundingBox();
    expect(chatBounds).not.toBeNull();
    expect(composerBounds).not.toBeNull();
    expect(composerBounds.y + composerBounds.height).toBeLessThanOrEqual(
      chatBounds.y + chatBounds.height,
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a written answer uses the composer and survives closing the prompt', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'question-reference-'),
  );
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell();
    await window.getByTestId('sidebar-more').click();
    await window.getByTestId('sidebar-more-item-dev-pages').click();
    await window.getByTestId('dev-pages-tab-activity-states').click();
    await window.getByTestId('activity-gallery-view-chat').click();
    const playground = window.getByTestId('chat-question-playground');
    await playground
      .getByRole('button', { name: 'Free reply', exact: true })
      .click();
    const chat = playground.getByTestId('playground-chat');
    const composer = chat.locator('[data-chat-composer-root]');
    const prompt = composer.getByTestId('chat-question-prompt');
    await expect(prompt).toBeVisible();
    await expect(composer).toHaveAttribute('data-question-prompt', 'true');
    const editor = composer.locator('[contenteditable=true]');
    // The cursor waits in the composer's input as the question shows.
    await expect(editor).toBeFocused();
    // The question's own placeholder sits in the composer's input.
    await expect(composer.locator('[data-slate-placeholder]')).toContainText(
      'Reply…',
    );
    const send = composer.getByTestId('chat-question-send');
    await expect(send).toHaveCount(0);
    await expect(prompt.getByTestId('chat-question-skip')).toBeVisible();
    await editor.fill('Start with the controls.');
    await expect(send).toBeEnabled();

    // x closes the prompt and keeps the question waiting behind its chip;
    // the typed answer stays in the composer.
    await prompt.getByTestId('chat-question-close').click();
    await expect(prompt).toHaveCount(0);
    await expect(composer).toHaveAttribute('data-question-prompt', 'false');
    await expect(playground).toHaveAttribute('data-state', 'pending');
    const chip = composer.getByTestId('chat-input-question-ready-chip');
    await expect(chip).toBeVisible();
    await expect(editor).toContainText('Start with the controls.');
    await chip.click();
    await expect(prompt).toBeVisible();
    await expect(editor).toContainText('Start with the controls.');

    await send.click();
    await expect(playground).toHaveAttribute('data-state', 'submitting');
    await playground
      .getByRole('button', { name: 'Resolve request', exact: true })
      .click();
    await expect(chat.getByTestId('answered-questions')).toContainText(
      'Start with the controls.',
    );
    await expect(composer).toHaveAttribute('data-question-prompt', 'false');
    await expect(editor).not.toContainText('Start with the controls.');

    // Skip dismisses without answering.
    await playground
      .getByRole('button', { name: 'Start again', exact: true })
      .click();
    await prompt.getByTestId('chat-question-skip').click();
    await expect(playground).toHaveAttribute('data-state', 'dismissing');
    await playground
      .getByRole('button', { name: 'Resolve request', exact: true })
      .click();
    await expect(playground).toHaveAttribute('data-state', 'dismissed');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('question controls answer by number, field, and private value', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'question-controls-polish-'),
  );
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell();
    await window.getByTestId('sidebar-more').click();
    await window.getByTestId('sidebar-more-item-dev-pages').click();
    await window.getByTestId('dev-pages-tab-activity-states').click();
    await window.getByTestId('activity-gallery-view-chat').click();
    const playground = window.getByTestId('chat-question-playground');
    const prompt = playground.getByTestId('chat-question-prompt');
    const send = playground.getByTestId('chat-question-send');
    await playground
      .getByRole('button', { name: 'Multiple choices', exact: true })
      .click();
    // Four choices should leave room for the conversation above the box.
    await expect(prompt).toBeVisible();
    const desktopBounds = await prompt.boundingBox();
    expect(desktopBounds.height).toBeLessThanOrEqual(360);
    await window.evaluate(() =>
      document.documentElement.setAttribute('data-ui-scale', '125'),
    );
    await playground
      .getByRole('button', { name: 'Compact width', exact: true })
      .click();
    const search = prompt.getByRole('button', { name: 'Search', exact: true });
    const optionBounds = await search.boundingBox();
    const panelBounds = await prompt.boundingBox();
    expect(optionBounds.x + optionBounds.width).toBeLessThanOrEqual(
      panelBounds.x + panelBounds.width,
    );

    // With an answer focused, its number picks it.
    await search.focus();
    await search.press('1');
    await search.press('2');
    await expect(
      prompt.getByRole('button', { name: 'Analytics', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(search).toHaveAttribute('aria-pressed', 'true');
    await send.click();
    await playground
      .getByRole('button', { name: 'Fail request', exact: true })
      .click();
    await expect(prompt.getByRole('alert')).toBeVisible();
    await expect(search).toHaveAttribute('aria-pressed', 'true');
    await prompt.getByTestId('chat-question-retry').click();
    await playground
      .getByRole('button', { name: 'Resolve request', exact: true })
      .click();
    await expect(playground.getByTestId('answered-questions')).toContainText(
      'Search, Analytics',
    );

    // A list, a number, and a date, one step at a time.
    await playground
      .getByRole('button', { name: 'Release details', exact: true })
      .click();
    await prompt.getByRole('button', { name: 'Staging', exact: true }).click();
    const field = prompt.getByTestId('chat-question-field');
    await expect(field).toHaveAttribute('type', 'number');
    // A step with a field puts the cursor in it.
    await expect(field).toBeFocused();
    await expect(prompt.getByTestId('chat-question-skip')).toBeVisible();
    await field.fill('25');
    await send.click();
    await expect(field).toHaveAttribute('type', 'date');
    await field.fill('2026-10-01');
    // Enter in a field sends it, as send does.
    await field.press('Enter');
    await playground
      .getByRole('button', { name: 'Resolve request', exact: true })
      .click();
    await expect(playground.getByTestId('answered-questions')).toContainText(
      '2026-10-01',
    );

    // A private value is masked and never shown in the answers.
    await playground
      .getByRole('button', { name: 'Private answer', exact: true })
      .click();
    await expect(field).toHaveAttribute('type', 'password');
    await field.fill('private-sandbox-fixture');
    await send.click();
    await playground
      .getByRole('button', { name: 'Resolve request', exact: true })
      .click();
    await expect(playground.getByTestId('answered-questions')).toContainText(
      '[hidden]',
    );
    await expect(playground).not.toContainText('private-sandbox-fixture');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a long single-choice question lists its answers as rows, not a select', async () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'question-select-'));
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell();
    await window.getByTestId('sidebar-more').click();
    await window.getByTestId('sidebar-more-item-dev-pages').click();
    await window.getByTestId('dev-pages-tab-activity-states').click();
    await window.getByTestId('activity-gallery-view-chat').click();
    const playground = window.getByTestId('chat-question-playground');
    const prompt = playground.getByTestId('chat-question-prompt');
    await playground
      .getByRole('button', { name: 'Long list', exact: true })
      .click();

    // Six options read as numbered rows: no dropdown, native or drawn.
    await expect(prompt).toHaveAttribute('data-question-kind', 'choice');
    await expect(prompt.locator('select')).toHaveCount(0);
    await expect(prompt.getByRole('combobox')).toHaveCount(0);
    await expect(
      prompt.locator('[data-testid^="chat-question-option-"]'),
    ).toHaveCount(6);

    // The last row is reachable inside the box and answers right away.
    const last = prompt.getByRole('button', { name: 'Asia East', exact: true });
    await last.scrollIntoViewIfNeeded();
    await prompt.getByRole('button', { name: 'US West', exact: true }).click();
    await expect(playground).toHaveAttribute('data-state', 'submitting');
    await playground
      .getByRole('button', { name: 'Resolve request', exact: true })
      .click();
    await expect(playground.getByTestId('answered-questions')).toContainText(
      'US West',
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('question answer labels remain fully readable in a narrow composer', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'question-long-options-'),
  );
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell();
    await window.getByTestId('sidebar-more').click();
    await window.getByTestId('sidebar-more-item-dev-pages').click();
    await window.getByTestId('dev-pages-tab-activity-states').click();
    await window.getByTestId('activity-gallery-view-chat').click();
    const playground = window.getByTestId('chat-question-playground');
    await playground
      .getByRole('button', { name: 'Quick decision', exact: true })
      .click();
    const prompt = playground.getByTestId('chat-question-prompt');
    await prompt.evaluate((element) => {
      element.style.width = '280px';
    });
    const option = prompt.getByTestId('chat-question-option-0');
    const label = option.locator('span.min-w-0 > span').first();
    const longLabel =
      'Review the complete implementation and verify that the desktop and web versions preserve every existing keyboard interaction';
    await label.evaluate((element, text) => {
      element.textContent = text;
    }, longLabel);
    await option.scrollIntoViewIfNeeded();
    await expect
      .poll(() =>
        label.evaluate(
          (element) => element.scrollWidth <= element.clientWidth + 1,
        ),
      )
      .toBe(true);
    await expect(label).toHaveText(longLabel);
    await expect
      .poll(() => label.evaluate((element) => element.clientHeight))
      .toBeGreaterThan(24);
    await option.click();
    await expect(playground).toHaveAttribute('data-state', 'submitting');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
