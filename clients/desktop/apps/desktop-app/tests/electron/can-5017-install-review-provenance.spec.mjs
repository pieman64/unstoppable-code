// CAN-5017 — the install review says who shared a skill, who owns it, who can
// see it, and what installing does.
//
// An organization skill link opens the review with its authenticated
// provenance (sharer, owning organization, audience) rather than a public
// username, and one line on where the copy lands and that later edits do not
// update it. Focus starts on the close button and stays in the review; Escape
// dismisses it without writing, and the same link reopens it. A team skill
// shows its parent organization and team. With context scoping off the same
// scoped share installs as a custom skill in every context, and the review
// says so.
//
// Deterministic: the local mock Cloud serves the scoped skills (or main's
// fetch is stubbed with context scoping off); installs write only isolated
// test data and the normal mock subscription receipt.
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { selectWorkspaceContext } from './workspaceContextMenu.mjs';
import {
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  registerShareMembership,
  seedOrgContextScoping,
  ORG_CONTEXT_A,
  ORG_CONTEXT_B,
  ORG_CONTEXT_ENV,
  ORG_CONTEXT_ORGANIZATIONS,
} from './seeders/index.mjs';

const ORG_SKILL_ID = 'fa500170-0000-4000-8000-000000000001';
const TEAM_SKILL_ID = 'fa500170-0000-4000-8000-000000000002';
const ACME = { type: 'organization', id: ORG_CONTEXT_A, name: 'Acme' };
const PLATFORM = {
  type: 'team',
  id: '7c1e5b0d-3f4a-4a8e-9c2d-1e6f7a8b9c0d',
  name: 'Platform',
  organization: { id: ACME.id, name: ACME.name },
};
const NOTE =
  "Later edits to the shared skill won't automatically update this copy.";

function scopedSkill({ id, name, shareScope, owner }) {
  const at = '2026-10-27T00:00:00.000Z';
  const rawSkill = `---\nname: ${name}\ndescription: Release notes.\n---\n\nWrite release notes.\n`;
  return {
    id,
    name,
    description: 'Writes release notes from merged pull requests.',
    rawSkill,
    contentHash: createHash('sha256').update(rawSkill).digest('hex'),
    shareScope,
    owner,
    createdBy: { id: 'lena', name: 'Lena Park', email: null },
    createdAt: at,
    updatedAt: at,
    canUpdate: false,
    canDelete: false,
    publicShare: null,
  };
}

async function launchRecipient() {
  const apiKey = 'csk_can5017_review_recipient';
  await registerShareMembership(apiKey);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can5017-review-'));
  const { electronApp } = await launchCanopy({ userDataDir });
  const window = await electronApp.firstWindow();
  await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
  await window.evaluate(
    (key) => window.api.saveCanopyCloudApiKey({ apiKey: key }),
    apiKey,
  );
  await window.evaluate(() =>
    window.dispatchEvent(new Event('canopy:cloud-account-changed')),
  );
  return { electronApp, userDataDir, window };
}

/** Serve each scoped skill read from main's fetch, with its provenance. */
async function stubScopedSkills(electronApp, skills) {
  await electronApp.evaluate((_electron, entries) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const { pathname } = new URL(String(input));
      const entry = entries.find(
        (skill) =>
          pathname.includes(`/public-shares/skills/${skill.id}`) ||
          pathname.endsWith(`/skills/${skill.id}`),
      );
      if (entry === undefined) return originalFetch(input, init);
      const found = !pathname.includes('/public-shares/');
      return new Response(
        JSON.stringify(found ? entry : { error: 'Not found' }),
        {
          status: found ? 200 : 404,
          headers: { 'content-type': 'application/json' },
        },
      );
    };
  }, skills);
}

function openShareLink(electronApp, id, audience) {
  return electronApp.evaluate(
    ({ app }, url) => app.emit('open-url', { preventDefault() {} }, url),
    `canopy://share/skills/${id}?audience=${audience}`,
  );
}

test('CAN-5017: an organization skill review names its provenance and effect, and keeps keyboard focus', async () => {
  test.setTimeout(180_000);
  const key = 'csk_can5017_org_review';
  await registerScenario(DEFAULT_MOCK_BASE_URL, key, {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      sharedSkills: [
        scopedSkill({
          id: ORG_SKILL_ID,
          name: 'org-release-notes',
          shareScope: 'organization',
          owner: ACME,
        }),
        scopedSkill({
          id: TEAM_SKILL_ID,
          name: 'team-release-notes',
          shareScope: 'team',
          owner: PLATFORM,
        }),
      ],
    },
  });
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can5017-org-'));
  seedOrgContextScoping(userDataDir);
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: ORG_CONTEXT_ENV,
  });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, key);
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await openShareLink(electronApp, ORG_SKILL_ID, 'ORGANIZATION');
    const landing = window.getByTestId('deep-link-share-landing');
    await expect(landing).toContainText('org-release-notes');
    await expect(window.getByTestId('share-install-publisher')).toHaveText(
      'Shared by Lena Park · Acme · Organization',
    );
    await expect(window.getByTestId('share-install-effect')).toHaveText(
      `Adds a copy to this device for the Acme context. ${NOTE}`,
    );
    await expect(
      window.getByTestId('share-install-publisher').locator('.ph-no-capture'),
    ).toHaveText(['Lena Park', 'Acme']);
    await expect(
      window.getByTestId('share-install-effect').locator('.ph-no-capture'),
    ).toHaveText('Acme');
    await expect(landing.getByRole('button', { name: 'Cancel' })).toHaveCount(
      0,
    );

    // Focus starts on close; a bounded Shift+Tab/Tab pair stays inside.
    const close = landing.getByRole('button', { name: 'Close' });
    const install = window.getByTestId('deep-link-share-install');
    await expect(install).toBeEnabled();
    await expect(close).toBeFocused();
    await window.keyboard.press('Shift+Tab');
    await expect(install).toBeFocused();
    await window.keyboard.press('Tab');
    await expect(close).toBeFocused();

    // Escape dismisses without writing; the same link reopens the review.
    await window.keyboard.press('Escape');
    await expect(landing).toHaveCount(0);
    await openShareLink(electronApp, ORG_SKILL_ID, 'ORGANIZATION');
    await expect(window.getByTestId('share-install-publisher')).toHaveText(
      'Shared by Lena Park · Acme · Organization',
    );
    await window.keyboard.press('Escape');
    await expect(landing).toHaveCount(0);

    await openShareLink(electronApp, TEAM_SKILL_ID, 'TEAM');
    await expect(landing).toContainText('team-release-notes');
    await expect(window.getByTestId('share-install-publisher')).toHaveText(
      'Shared by Lena Park · Acme · Team: Platform',
    );
    await expect(window.getByTestId('share-install-effect')).toHaveText(
      `Adds a copy to this device for the Acme context. ${NOTE}`,
    );
    await window.keyboard.press('Escape');

    // Customize must open the same review. Count calls to the actual write
    // handler while retaining all of its authorization and persistence.
    await electronApp.evaluate(({ ipcMain }) => {
      const channel = 'skills:write-raw';
      const original = ipcMain._invokeHandlers.get(channel);
      if (!original) throw new Error('Skill write handler is missing');
      globalThis.__can5017Writes = 0;
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (event, request) => {
        globalThis.__can5017Writes += 1;
        await new Promise((resolve) => {
          globalThis.__can5017ReleaseWrite = resolve;
        });
        return original(event, request);
      });
    });
    const app = new CanopyAppDriver(window);
    await app.openPluginsPage();
    await app.openPluginsTab('skills');
    await window.getByTestId('plugins-search').fill('org-release-notes');
    await window
      .getByTestId(`plugins-entry-skill:shared:${ORG_SKILL_ID}`)
      .click();
    const opener = window.getByTestId('detail-primary-cta');
    await opener.click();
    await expect(window.getByTestId('share-install-publisher')).toHaveText(
      'Shared by Lena Park · Acme · Organization',
    );
    await expect(window.getByTestId('share-install-effect')).toHaveText(
      `Adds a copy to this device for the Acme context. ${NOTE}`,
    );
    await expect(landing.getByRole('button', { name: 'Cancel' })).toHaveCount(
      0,
    );
    await expect(close).toBeFocused();
    await window.keyboard.press('Escape');
    await expect(landing).toHaveCount(0);
    await expect(opener).toBeFocused();
    expect(await electronApp.evaluate(() => globalThis.__can5017Writes)).toBe(
      0,
    );
    await opener.click();
    await expect(install).toBeEnabled();
    await expect(close).toBeFocused();
    await window.keyboard.press('Tab');
    await expect(install).toBeFocused();
    await window.keyboard.press('Enter');
    await expect
      .poll(() => electronApp.evaluate(() => globalThis.__can5017Writes))
      .toBe(1);
    await expect(install).toBeDisabled();
    await window.keyboard.press('Tab');
    await window.keyboard.press('Enter');
    await window.keyboard.press('Escape');
    await expect(landing).toBeVisible();
    expect(
      await landing.evaluate((dialog) =>
        dialog.contains(document.activeElement),
      ),
    ).toBe(true);
    expect(await electronApp.evaluate(() => globalThis.__can5017Writes)).toBe(
      1,
    );
    await electronApp.evaluate(() => globalThis.__can5017ReleaseWrite());
    await expect(landing).toHaveCount(0, { timeout: 60_000 });
    await expect(window.getByTestId('skill-read-detail-edit')).toBeVisible();
    expect(await electronApp.evaluate(() => globalThis.__can5017Writes)).toBe(
      1,
    );

    // A custom:app row alone cannot prove binding. Check its annotated
    // source and read access, then both listing and read denial elsewhere.
    const localId = 'custom:app/org-release-notes';
    const availability = () =>
      window.evaluate(async (id) => {
        const result = await window.skills.loadSkills();
        const rows = (result.data ?? []).filter(
          (row) => `${row.sourceId}/${row.name}` === id,
        );
        let readable = false;
        try {
          readable = (await window.skills.readRawSkill(id)).includes(
            'Write release notes.',
          );
        } catch {
          // The read must reject outside the receipt's owning context.
        }
        return { rows, readable };
      }, localId);
    const installed = await availability();
    expect(installed.rows).toHaveLength(1);
    expect(installed.rows[0]).toMatchObject({
      installedFromShare: { remoteId: ORG_SKILL_ID },
    });
    expect(installed.readable).toBe(true);
    for (const context of ['personal', ORG_CONTEXT_B]) {
      await selectWorkspaceContext(window, context);
      await expect
        .poll(availability)
        .toMatchObject({ rows: [], readable: false });
    }
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await expect.poll(async () => (await availability()).readable).toBe(true);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('CAN-5017: with context scoping off, a scoped skill review says the copy is available everywhere', async () => {
  test.setTimeout(180_000);
  const { electronApp, userDataDir, window } = await launchRecipient();
  try {
    await stubScopedSkills(electronApp, [
      scopedSkill({
        id: ORG_SKILL_ID,
        name: 'org-release-notes',
        shareScope: 'organization',
        owner: ACME,
      }),
    ]);
    await openShareLink(electronApp, ORG_SKILL_ID, 'ORGANIZATION');
    await expect(window.getByTestId('deep-link-share-landing')).toContainText(
      'org-release-notes',
    );
    await expect(window.getByTestId('share-install-publisher')).toHaveText(
      'Shared by Lena Park · Acme · Organization',
    );
    await expect(window.getByTestId('share-install-effect')).toHaveText(
      `Adds a copy to this device, available in every context. ${NOTE}`,
    );
    await window.keyboard.press('Escape');
    const longName = 'LongName'.repeat(35);
    await stubScopedSkills(electronApp, [
      {
        ...scopedSkill({
          id: TEAM_SKILL_ID,
          name: 'long-provenance',
          shareScope: 'team',
          owner: {
            ...PLATFORM,
            name: longName,
            organization: { ...PLATFORM.organization, name: longName },
          },
        }),
        createdBy: { id: 'lena', name: longName, email: null },
      },
    ]);
    await openShareLink(electronApp, TEAM_SKILL_ID, 'TEAM');
    const review = window.getByTestId('deep-link-share-landing');
    await expect(window.getByTestId('share-install-publisher')).toHaveText(
      `Shared by ${longName} · ${longName} · Team: ${longName}`,
    );
    const layout = await review.evaluate((dialog) => {
      const subtitle = dialog
        .querySelector('[data-testid="share-install-publisher"]')
        ?.closest('p');
      const card = dialog.getBoundingClientRect();
      return {
        subtitleFits:
          subtitle !== null &&
          subtitle !== undefined &&
          subtitle.scrollWidth <= subtitle.clientWidth,
        controlsFit: Array.from(dialog.querySelectorAll('button')).every(
          (button) => {
            const rect = button.getBoundingClientRect();
            return rect.left >= card.left && rect.right <= card.right;
          },
        ),
      };
    });
    expect(layout).toEqual({ subtitleFits: true, controlsFit: true });
    await expect(review.getByRole('button', { name: 'Close' })).toBeFocused();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
