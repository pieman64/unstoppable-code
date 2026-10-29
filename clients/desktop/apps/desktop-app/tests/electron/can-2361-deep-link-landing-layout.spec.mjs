// CAN-2361 follow-up, reworked for CAN-3710 — durable layout coverage for the
// install review a share deep link opens.
//
// CAN-3710 made the review light: the item's name and type, who shared it, a
// description clamped to about three lines, and one primary. The long README
// and the pipeline YAML panel the earlier landing scrolled through are gone, so
// these invariants lock in the light layout instead. The capture spec next
// door produces pictures of those states but, per CLAUDE.md §5, captures
// "never count as durable regression coverage" — so the invariants live here.
//
// Locked in:
//   1. A long description is clamped to three lines, and the card itself never
//      scrolls; the action row sits inside the card.
//   2. A shared pipeline shows no YAML panel, at any length, and no scroller.
//   3. The installed ⋯ menu lines up with the kebab it is anchored to and stays
//      inset from the card's edge, and its first Escape closes only the menu.
//
// Deterministic: a local mock cloud serving pinned public-share snapshots. No
// network, no live agents, no seeded workspaces.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { expect, test } from '@playwright/test';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const SKILL_UUID = '7c1e4a92-8b3f-4d61-9a05-6e2f3c8d1b47';
const PIPELINE_UUID = '5d9b3e17-2a4c-4f80-b6d1-8c7e0a2f4b93';

// Long enough to need more than three lines in the review.
const LONG_SKILL_DESCRIPTION = Array.from(
  { length: 12 },
  (_, index) =>
    `Deterministic deep-link layout fixture skill, sentence ${index + 1}.`,
).join(' ');

// Deliberately long: the pinned-footer assertion is only meaningful when the
// body actually overflows its scroller.
const RAW_SKILL = [
  '---',
  'name: shared-layout-skill',
  'description: Deterministic deep-link layout fixture skill',
  '---',
  '',
  '# Shared Layout Skill',
  '',
  ...Array.from(
    { length: 160 },
    (_unused, index) =>
      `Line ${index + 1} of deliberately long shared skill body copy used to force the landing body to overflow its scroller.`,
  ),
].join('\n');

const LONG_PIPELINE_UUID = '9f2a6c05-1d38-4e7b-8a94-0b5c3e7d2f68';
const MID_PIPELINE_UUID = '0e4d7b62-3f19-4c85-9b27-6a1d8f0c5e34';

const RAW_PIPELINE = [
  'name: shared-layout-pipeline',
  'description: Deterministic deep-link layout fixture pipeline',
  'on:',
  '  dispatch: {}',
  'jobs:',
  '  greet:',
  '    steps:',
  '      - name: Say hello',
  '        run: echo hello',
].join('\n');

// Long enough to exceed the panel's 30rem ceiling, so the clamp's upper bound
// and the textarea's internal scrolling are both exercised.
const RAW_LONG_PIPELINE = [
  'name: shared-layout-pipeline-long',
  'description: Deterministic deep-link layout fixture pipeline (long)',
  'on:',
  '  dispatch: {}',
  'jobs:',
  '  greet:',
  '    steps:',
  ...Array.from({ length: 90 }, (_unused, index) => [
    `      - name: Step ${index + 1}`,
    `        run: echo step ${index + 1}`,
  ]).flat(),
].join('\n');

// Deliberately sized BETWEEN the clamp's floor and ceiling. The short and long
// fixtures both saturate the clamp, so on their own they leave the per-line and
// padding coefficients almost entirely unconstrained — `leading-5` drifting to
// `leading-6` in `RawYamlView` would under-size every real-world panel by 20%
// and neither would fail. This one asserts the model itself.
const RAW_MID_PIPELINE = [
  'name: shared-layout-pipeline-mid',
  'description: Deterministic deep-link layout fixture pipeline (mid)',
  '# Sized to land between the panel clamp floor and ceiling.',
  'on:',
  '  dispatch: {}',
  'jobs:',
  '  greet:',
  '    steps:',
  ...Array.from({ length: 4 }, (_unused, index) => [
    `      - name: Step ${index + 1}`,
    `        run: echo step ${index + 1}`,
  ]).flat(),
].join('\n');

function sendJson(response, statusCode, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
  });
  response.end(body);
}

function startPublicShareCloudMock() {
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (
      request.method === 'POST' &&
      url.pathname === '/api/v1/desktop-app/share-events/desktop-handoff'
    ) {
      request.resume();
      request.on('end', () => sendJson(response, 200, { recorded: true }));
      return;
    }
    if (
      url.pathname === `/api/v1/desktop-app/public-shares/skills/${SKILL_UUID}`
    ) {
      sendJson(response, 200, {
        entity: 'skill',
        externalId: SKILL_UUID,
        name: 'Shared Layout Skill',
        description: LONG_SKILL_DESCRIPTION,
        rawSkill: RAW_SKILL,
        contentHash: createHash('sha256').update(RAW_SKILL).digest('hex'),
        dependencies: [],
        authorUsername: 'fixture-author',
        updatedAt: '2026-08-01T00:00:00.000Z',
      });
      return;
    }
    if (
      url.pathname ===
      `/api/v1/desktop-app/public-shares/pipelines/${PIPELINE_UUID}`
    ) {
      sendJson(response, 200, {
        entity: 'pipeline',
        externalId: PIPELINE_UUID,
        name: 'Shared Layout Pipeline',
        description: 'Deterministic deep-link layout fixture pipeline',
        rawPipeline: RAW_PIPELINE,
        contentHash: 'layout-pipeline-hash',
        authorUsername: null,
        updatedAt: '2026-08-01T00:00:00.000Z',
      });
      return;
    }
    if (
      url.pathname ===
      `/api/v1/desktop-app/public-shares/pipelines/${MID_PIPELINE_UUID}`
    ) {
      sendJson(response, 200, {
        entity: 'pipeline',
        externalId: MID_PIPELINE_UUID,
        name: 'Shared Layout Pipeline (mid)',
        description: 'Deterministic deep-link layout fixture pipeline (mid)',
        rawPipeline: RAW_MID_PIPELINE,
        contentHash: 'layout-mid-pipeline-hash',
        authorUsername: null,
        updatedAt: '2026-08-01T00:00:00.000Z',
      });
      return;
    }
    if (
      url.pathname ===
      `/api/v1/desktop-app/public-shares/pipelines/${LONG_PIPELINE_UUID}`
    ) {
      sendJson(response, 200, {
        entity: 'pipeline',
        externalId: LONG_PIPELINE_UUID,
        name: 'Shared Layout Pipeline (long)',
        description: 'Deterministic deep-link layout fixture pipeline (long)',
        rawPipeline: RAW_LONG_PIPELINE,
        contentHash: 'layout-long-pipeline-hash',
        authorUsername: null,
        updatedAt: '2026-08-01T00:00:00.000Z',
      });
      return;
    }
    sendJson(response, 404, { error: 'Share not found' });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function emitOpenUrl(electronApp, url) {
  return electronApp.evaluate(({ app }, targetUrl) => {
    app.emit('open-url', { preventDefault: () => {} }, targetUrl);
  }, url);
}

test('install review clamps its description, shows no YAML, and anchors the kebab menu', async () => {
  const cloud = await startPublicShareCloudMock();
  const { electronApp, userDataDir } = await launchCanopy({
    env: { CANOPY_E2E_CLOUD_BASE_URL: cloud.baseUrl },
  });

  try {
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await expect(window.getByTestId('app-sidebar')).toBeVisible();

    // --- (1) A long description is clamped; the card does not scroll. ---
    await emitOpenUrl(electronApp, `canopy://share/skills/${SKILL_UUID}`);
    const modal = window.getByTestId('deep-link-share-landing');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('Shared Layout Skill');

    const description = modal.getByTestId('share-install-description');
    await expect(description).toBeVisible();
    const clamp = await description.evaluate(
      (element) => getComputedStyle(element).webkitLineClamp,
    );
    expect(clamp).toBe('3');
    const descriptionTruncated = await description.evaluate(
      (element) => element.scrollHeight > element.clientHeight + 1,
    );
    expect(descriptionTruncated).toBe(true);
    // The review shows no README body, package list, or readiness section.
    await expect(modal.getByTestId('deep-link-share-body')).toHaveCount(0);
    const cardOverflows = async () =>
      modal.evaluate(
        (element) => element.scrollHeight > element.clientHeight + 1,
      );
    expect(await cardOverflows()).toBe(false);

    const installButton = modal.getByTestId('deep-link-share-install');
    await expect(installButton).toBeVisible();
    const [cardBox, installBox] = await Promise.all([
      modal.boundingBox(),
      installButton.boundingBox(),
    ]);
    expect(installBox.y + installBox.height).toBeLessThanOrEqual(
      cardBox.y + cardBox.height + 1,
    );
    await window.keyboard.press('Escape');
    await expect(modal).not.toBeVisible();

    // --- (2) A shared pipeline has no YAML panel at any length. ---
    for (const [uuid, name] of [
      [PIPELINE_UUID, 'Shared Layout Pipeline'],
      [MID_PIPELINE_UUID, 'Shared Layout Pipeline (mid)'],
      [LONG_PIPELINE_UUID, 'Shared Layout Pipeline (long)'],
    ]) {
      await emitOpenUrl(electronApp, `canopy://share/pipelines/${uuid}`);
      await expect(modal).toBeVisible();
      await expect(modal).toContainText(name);
      await expect(modal.getByTestId('deep-link-share-yaml-panel')).toHaveCount(
        0,
      );
      await expect(modal.getByTestId('pipeline-raw-yaml-textarea')).toHaveCount(
        0,
      );
      expect(await cardOverflows()).toBe(false);
      await window.keyboard.press('Escape');
      await expect(modal).not.toBeVisible();
    }

    // --- (3) Kebab menu alignment in the installed state. Installing closes
    // the review and lands on the skill; reopening the link shows it
    // installed. ---
    await emitOpenUrl(electronApp, `canopy://share/skills/${SKILL_UUID}`);
    await expect(modal).toBeVisible();
    const kebab = modal.getByTestId('deep-link-share-kebab');
    await expect(installButton.or(kebab)).toBeVisible();
    if (await installButton.isVisible()) {
      await installButton.click();
      await expect(modal).not.toBeVisible();
      await emitOpenUrl(electronApp, `canopy://share/skills/${SKILL_UUID}`);
      await expect(modal).toBeVisible();
    }
    await expect(kebab).toBeVisible();
    await kebab.click();
    // The menu is portaled to the window's floating layer, outside the modal.
    const menu = window.getByTestId('deep-link-share-menu');
    await expect(menu).toBeVisible();

    const [kebabBox, menuBox, installedCardBox] = await Promise.all([
      kebab.boundingBox(),
      menu.boundingBox(),
      modal.boundingBox(),
    ]);
    // The menu is anchored to the kebab, so their right edges line up, which
    // keeps it inset from the card edge rather than flush against it (the card
    // is `overflow-hidden`, which clips a flush menu's shadow).
    expect(
      Math.abs(menuBox.x + menuBox.width - (kebabBox.x + kebabBox.width)),
    ).toBeLessThanOrEqual(1);
    expect(menuBox.x + menuBox.width).toBeLessThan(
      installedCardBox.x + installedCardBox.width,
    );

    // The first Escape must close only the menu. Without the middle assertion
    // this pair also passes in the degraded case where Escape closes the whole
    // modal and takes the menu with it.
    await window.keyboard.press('Escape');
    await expect(menu).not.toBeVisible();
    await expect(modal).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(modal).not.toBeVisible();
  } finally {
    // Electron first, then the mock, preserving the original deep-link race.
    // and `session-transfer.spec.mjs`. `server.close()` only settles once every
    // connection has ended, so closing it first can hang on an in-flight handoff
    // POST and leak the Electron process plus its temp data dir under the
    // host-global serial concurrency guard.
    await closeCanopy(electronApp, userDataDir);
    await cloud.close();
  }
});
