// CAN-5172: snapshot-bound passage choices preserve disjoint edits.
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  EDIT_ENTRY,
  FINDINGS_NAME,
  completeAgentFileEdit,
  seedAgentEditViewer,
} from './file-viewer-agent-edit-fixture.mjs';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/** Write from outside the app with a clearly newer mtime. */
function externalWrite(filePath, content, offsetSeconds) {
  writeFileSync(filePath, content, 'utf8');
  const when = Date.now() / 1000 + offsetSeconds;
  utimesSync(filePath, when, when);
}

// CAN-5172: real editor, shared comparison, conditional disk writes.
test('resolves passages inline, defers safely, and rechecks third writes', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can5172-overlap-'));
  const { filePath } = seedAgentEditViewer(userDataDir);
  const base =
    Array.from({ length: 170 }, (_, i) =>
      i === 79
        ? 'Get started today'
        : i === 139
          ? 'Closing message'
          : `Line ${i + 1}`,
    ).join('\n') + '\n';
  externalWrite(filePath, base, 0);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const page = await electronApp.firstWindow();
    const app = new CanopyAppDriver(page);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await page.getByTestId(`sidebar-work-entry-${EDIT_ENTRY}`).click();
    await expect(page.getByTestId('cowork-top-bar')).toBeVisible();
    await page.keyboard.press(`${MOD}+p`);
    await page.getByTestId('file-search-palette-input').fill(FINDINGS_NAME);
    await page
      .getByTestId('file-search-palette-result')
      .filter({ hasText: FINDINGS_NAME })
      .first()
      .click();
    const editor = page.getByTestId('monaco-file-editor');
    if (!(await editor.isVisible()))
      await page.getByTestId('file-view-toggle-source').click();
    await expect(editor).toBeVisible();
    const edit = async (content) => {
      await editor.click();
      await page.keyboard.press(`${MOD}+a`);
      await page.keyboard.insertText(content);
    };
    const notice = page.getByTestId('file-overlap-notice');
    const passages = notice.getByTestId('file-overlap-passage');
    const dirty = page.getByTestId('file-viewer-dirty');
    const save = page.getByTestId('file-save');
    const mine = base.replace('Get started today', 'Try it free');
    const agent = base
      .replace('Line 1\n', 'Agent heading\n')
      .replace('Get started today', 'Start your trial');
    await edit(mine);
    externalWrite(filePath, agent, 10);
    await completeAgentFileEdit(electronApp, filePath, 'inline-cta');
    await expect(notice).toHaveCount(1);
    await expect(notice).toHaveAttribute('data-origin', 'refresh');
    await expect(notice.getByTestId('file-overlap-quote-ours')).toHaveText(
      'Try it free',
    );
    await expect(notice.getByTestId('file-overlap-quote-theirs')).toHaveText(
      'Start your trial',
    );
    await expect(page.getByTestId('file-external-change-notice')).toHaveCount(
      0,
    );
    await expect(page.getByTestId('file-save-conflict-notice')).toHaveCount(0);
    await expect(
      editor.locator('.view-line').filter({ hasText: 'Try it free' }),
    ).toBeInViewport();
    await expect(
      editor.locator('.canopy-editor-reveal-flash').first(),
    ).toBeInViewport();
    expect(
      await page.evaluate(
        () =>
          document.activeElement?.closest(
            '[data-testid="monaco-file-editor"]',
          ) != null,
      ),
    ).toBe(true);

    // Defer, re-read the same version, and explicitly Save to re-open it.
    await notice.getByTestId('file-overlap-decide-later').click();
    await completeAgentFileEdit(electronApp, filePath, 'same-version');
    await expect(notice).toHaveCount(0);
    await save.click();
    await expect(notice).toHaveAttribute('data-origin', 'save');
    await expect(notice.getByTestId('file-overlap-choose-ours')).toBeFocused();
    await notice.getByTestId('file-overlap-choose-ours').click();
    await expect(notice).toHaveCount(0);
    expect(readFileSync(filePath, 'utf8')).toBe(agent); // resolution never writes
    await save.click();
    const resolved = mine.replace('Line 1\n', 'Agent heading\n');
    await expect.poll(() => readFileSync(filePath, 'utf8')).toBe(resolved);
    await expect(dirty).toHaveCount(0);

    // Two independent passages, including a long quote, and mixed choices.
    const longMine = Array.from(
      { length: 9 },
      (_, i) => `Mine CTA ${i + 1}`,
    ).join('\n');
    await edit(
      resolved
        .replace('Try it free', longMine)
        .replace('Closing message', 'Mine closing'),
    );
    const rival = resolved
      .replace('Try it free', 'Latest CTA')
      .replace('Closing message', 'Latest closing');
    externalWrite(filePath, rival, 20);
    await completeAgentFileEdit(electronApp, filePath, 'multiple-passages');
    await expect(passages).toHaveCount(2);
    await expect(
      editor.locator('.view-line').filter({ hasText: 'Mine CTA 1' }),
    ).toBeInViewport();
    await expect(passages.nth(0)).toContainText('Passage 1 of 2');
    await passages.nth(0).getByTestId('file-overlap-choose-theirs').click();
    await expect(
      passages.nth(1).getByTestId('file-overlap-choose-ours'),
    ).toBeFocused();
    await passages.nth(0).getByTestId('file-overlap-choose-ours').click();
    await expect(
      passages.nth(0).getByTestId('file-overlap-choose-ours'),
    ).toHaveAttribute('aria-pressed', 'true');
    await passages.nth(1).getByTestId('file-overlap-choose-theirs').click();
    const mixed = rival.replace('Latest CTA', longMine);
    expect(readFileSync(filePath, 'utf8')).toBe(rival);

    // An overlapping third write before Save requires another decision.
    const third = rival.replace('Latest CTA', 'Third CTA');
    externalWrite(filePath, third, 30);
    await save.click();
    await expect(notice.getByTestId('file-overlap-quote-theirs')).toHaveText(
      'Third CTA',
    );
    expect(readFileSync(filePath, 'utf8')).toBe(third);
    await notice.getByTestId('file-overlap-choose-ours').click();
    await save.click();
    await expect.poll(() => readFileSync(filePath, 'utf8')).toBe(mixed);

    // Theirs alone resolves clean without a write.
    await edit(mixed.replace('Mine CTA', 'My next CTA'));
    const latest = mixed.replace('Mine CTA', 'Newest CTA');
    externalWrite(filePath, latest, 40);
    await completeAgentFileEdit(electronApp, filePath, 'take-theirs');
    await notice.getByTestId('file-overlap-choose-theirs').click();
    await expect(dirty).toHaveCount(0);
    expect(readFileSync(filePath, 'utf8')).toBe(latest);

    await app.openSettings();
    await app.openSettingsSection('files');
    const autoSave = page.getByTestId('settings-files-auto-save');
    if ((await autoSave.getAttribute('aria-checked')) !== 'true')
      await autoSave.click();
    await app.closeSettings();
    await edit(latest.replace('Newest CTA', 'Auto CTA'));
    externalWrite(filePath, latest.replace('Newest CTA', 'Autosave rival'), 50);
    await completeAgentFileEdit(electronApp, filePath, 'autosave-paused');
    await expect(notice).toBeVisible();
    await notice.getByTestId('file-overlap-decide-later').click();
    await editor.click();
    await page.waitForTimeout(3_000); // multiple existing autosave debounce intervals
    await expect(notice).toHaveCount(0);
    expect(readFileSync(filePath, 'utf8')).toContain('Autosave rival');
    expect(
      await page.evaluate(
        () =>
          document.activeElement?.closest(
            '[data-testid="monaco-file-editor"]',
          ) != null,
      ),
    ).toBe(true);
    await save.click();
    await expect(notice.getByTestId('file-overlap-choose-ours')).toBeFocused();
    await notice.getByTestId('file-overlap-choose-ours').click();
    await expect
      .poll(() => readFileSync(filePath, 'utf8'))
      .toContain('Auto CTA');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// CAN-5362: a rewritten list compares only the bullet both sides changed,
// shows the user's correction, and saves each choice with the newer bullets.
test('narrows a rewritten list to the corrected bullet and saves either choice', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can5362-bullets-'));
  const { filePath } = seedAgentEditViewer(userDataDir);
  const list = (...bullets) =>
    ['## Outcomes', ...bullets, '', 'Budget follows.']
      .map((line) => `${line}\n`)
      .join('');
  const base = list(
    '- 80% of participants complete the program',
    '- Twelve workshops per year',
    '- Quarterly reports to the board',
  );
  const mine = base.replace('80%', '85%');
  const agentBullets = [
    '- Most participants finish the program',
    '- A workshop every month',
    '- Board updates each quarter',
  ];
  const agent = list(...agentBullets);
  externalWrite(filePath, base, 0);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const page = await electronApp.firstWindow();
    const app = new CanopyAppDriver(page);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await page.getByTestId(`sidebar-work-entry-${EDIT_ENTRY}`).click();
    await expect(page.getByTestId('cowork-top-bar')).toBeVisible();
    await page.keyboard.press(`${MOD}+p`);
    await page.getByTestId('file-search-palette-input').fill(FINDINGS_NAME);
    await page
      .getByTestId('file-search-palette-result')
      .filter({ hasText: FINDINGS_NAME })
      .first()
      .click();
    const editor = page.getByTestId('monaco-file-editor');
    if (!(await editor.isVisible()))
      await page.getByTestId('file-view-toggle-source').click();
    await expect(editor).toBeVisible();
    const edit = async (content) => {
      await editor.click();
      await page.keyboard.press(`${MOD}+a`);
      await page.keyboard.insertText(content);
    };
    const notice = page.getByTestId('file-overlap-notice');
    const save = page.getByTestId('file-save');

    const compare = async (label, offset) => {
      await edit(mine);
      externalWrite(filePath, agent, offset);
      await completeAgentFileEdit(electronApp, filePath, label);
      await expect(notice.getByTestId('file-overlap-passage')).toHaveCount(1);
      await expect(notice).toContainText('Everything else is kept.');
      await expect(notice.getByTestId('file-overlap-quote-ours')).toHaveText(
        '- 85% of participants complete the program',
      );
      await expect(
        notice.getByTestId('file-overlap-quote-ours').locator('mark'),
      ).toHaveText('85%');
      await expect(
        notice.getByTestId('file-overlap-consequence-theirs'),
      ).toHaveText('Drops your change: 80% → 85%');
      await expect(notice.getByTestId('file-overlap-choose-ours')).toHaveText(
        'Keep mine',
      );
      await expect(notice.getByTestId('file-overlap-ask-keep')).toBeVisible();
    };

    // The newer wording: every agent bullet, Rosa's correction removed.
    await compare('bullets-theirs', 10);
    await notice.getByTestId('file-overlap-choose-theirs').click();
    await expect(notice).toHaveCount(0);
    await expect.poll(() => readFileSync(filePath, 'utf8')).toBe(agent);

    // Fresh comparison: keep the corrected bullet with the newer two.
    externalWrite(filePath, base, 20);
    await completeAgentFileEdit(electronApp, filePath, 'bullets-reset');
    await compare('bullets-ours', 30);
    await notice.getByTestId('file-overlap-choose-ours').click();
    await expect(notice).toHaveCount(0);
    expect(readFileSync(filePath, 'utf8')).toBe(agent); // choosing never writes
    await save.click();
    await expect
      .poll(() => readFileSync(filePath, 'utf8'))
      .toBe(
        list(
          '- 85% of participants complete the program',
          ...agentBullets.slice(1),
        ),
      );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// CAN-5362: the follow-up draft joins the existing composer text; nothing is
// sent, saved, chosen, or dismissed.
test('drafts a follow-up for an overlapping paragraph without resolving it', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can5362-draft-'));
  const { filePath } = seedAgentEditViewer(userDataDir);
  const need =
    'Our county has 1,200 families waiting for housing support, and the waitlist has grown every year since the program began in 2019.';
  const base = `## Statement of need\n\n${need}\n`;
  const mine = base.replace('1,200', '1,350');
  const agent =
    '## Statement of need\n\nOur county has 1,200 families waiting for housing support.\n';
  externalWrite(filePath, base, 0);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const page = await electronApp.firstWindow();
    const app = new CanopyAppDriver(page);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await page.getByTestId(`sidebar-work-entry-${EDIT_ENTRY}`).click();
    await expect(page.getByTestId('cowork-top-bar')).toBeVisible();
    const composer = page.locator(
      '[data-testid="panel-content-chat"]:visible [data-chat-textarea][contenteditable="true"]',
    );
    await composer.fill('Existing note for later');
    await page.keyboard.press(`${MOD}+p`);
    await page.getByTestId('file-search-palette-input').fill(FINDINGS_NAME);
    await page
      .getByTestId('file-search-palette-result')
      .filter({ hasText: FINDINGS_NAME })
      .first()
      .click();
    const editor = page.getByTestId('monaco-file-editor');
    if (!(await editor.isVisible()))
      await page.getByTestId('file-view-toggle-source').click();
    await expect(editor).toBeVisible();
    await editor.click();
    await page.keyboard.press(`${MOD}+a`);
    await page.keyboard.insertText(mine);
    externalWrite(filePath, agent, 10);
    await completeAgentFileEdit(electronApp, filePath, 'paragraph');

    const notice = page.getByTestId('file-overlap-notice');
    await expect(
      notice.getByTestId('file-overlap-quote-ours').locator('mark'),
    ).toHaveText('1,350');
    // Canopy's shorter wording strikes the clause it removed.
    await expect(
      notice.getByTestId('file-overlap-quote-theirs').locator('del'),
    ).toContainText('the waitlist has grown');
    await expect(
      notice.getByTestId('file-overlap-consequence-theirs'),
    ).toHaveText('Drops your change: 1,200 → 1,350');
    await expect(notice.getByTestId('file-overlap-ask-keep')).toHaveText(
      'Combine with AI',
    );
    await notice.getByTestId('file-overlap-ask-keep').click();

    await expect(composer).toContainText('Existing note for later');
    await expect(composer).toContainText('1,200 → 1,350');
    await expect(composer).toContainText('The newer wording');
    await notice.getByTestId('file-overlap-ask-keep').focus();
    await page.keyboard.press('Enter');
    await expect(composer).toContainText('Existing note for later');
    await expect
      .poll(
        async () =>
          (await composer.innerText()).split('1,200 → 1,350').length - 1,
      )
      .toBe(2);
    // Sending would clear the composer; the comparison stays unresolved.
    await expect(notice).toHaveCount(1);
    await expect(
      notice.getByTestId('file-overlap-choose-ours'),
    ).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('file-viewer-dirty')).toHaveCount(1);
    expect(readFileSync(filePath, 'utf8')).toBe(agent);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
