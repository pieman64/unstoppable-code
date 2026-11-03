import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  seedPluginsCache,
  seedCuratedPlugins,
  seedMcpServers,
} from './seeders/index.mjs';

test('Customize sections share installed search, expansion, details and Workflows navigation', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-customize-sections-'),
  );
  seedPluginsCache({
    userDataDir,
    additionalPlugins: [
      { name: 'installed-debugger' },
      {
        name: 'debugger-toolkit',
        externalSource: {
          source: 'github',
          url: 'https://example.com/debugger.git',
        },
        details: null,
      },
    ],
  });
  seedCuratedPlugins({ userDataDir });
  const timestamp = '2026-10-01T00:00:00.000Z';
  seedMcpServers({
    userDataDir,
    servers: [
      {
        definition: {
          id: 'aabbcc',
          name: 'Section MCP',
          description: 'Cached health fixture',
          type: 'http',
          url: 'https://mcp.fixture.test/mcp',
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        configs: [
          {
            id: 'ddeeff',
            name: 'Default',
            description: '',
            enabled: false,
            envVars: {},
            extraArgs: [],
            extraHeaders: {},
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ],
      },
    ],
  });

  // The same custom skill tree written by the skill editor and existing
  // seedHomeComposerSkills fixture; no external catalog or provider is used.
  for (let index = 0; index < 10; index += 1) {
    const name = `section-skill-${index}`;
    const directory = path.join(userDataDir, 'skills', 'custom:app', name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Deterministic Customize section fixture\n---\n\n# ${name}\n`,
    );
  }
  const { electronApp } = await launchCanopy({ userDataDir });
  const window = await electronApp.firstWindow();
  try {
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openPluginsPage();
    const installed = window.getByTestId('customize-section-installed');
    await expect(installed).toBeVisible();
    await expect(installed.locator('li')).toHaveCount(8);
    const showAll = installed.getByRole('button', { name: /^Show all / });
    const total = Number((await showAll.innerText()).match(/\d+/)?.[0]);
    expect(total).toBeGreaterThan(8);
    await showAll.click();
    await expect(installed.locator('li')).toHaveCount(total);
    await window.getByTestId('plugins-search').fill('section-skill');
    await expect(installed.locator('li')).toHaveCount(10);
    // All mixes kinds, so each row names its kind and its source (CAN-4840).
    await expect(
      installed.getByTestId(
        'customize-row-type-skill:custom:app:section-skill-0',
      ),
    ).toBeVisible();
    await expect(
      installed.getByTestId(
        'customize-row-subtitle-skill:custom:app:section-skill-0',
      ),
      // CAN-4844: compact rows show the creator; the edited date is in the source tooltip.
    ).toHaveText('You');
    const skill = installed.getByTestId(
      'customize-row-skill:custom:app:section-skill-0',
    );
    await skill.focus();
    await window.keyboard.press('Enter');
    await expect(window.getByTestId('plugins-entry-detail-page')).toBeVisible();
    // An expanded Installed list stands in for the former management view, so
    // its details keep the Installed level (CAN-4267).
    await expect(
      window.getByTestId('plugins-entry-detail-breadcrumb-installed'),
    ).toHaveCount(1);
    await window.getByTestId('plugins-entry-detail-breadcrumb-root').click();
    await window.getByTestId('plugins-search-clear').click();
    // CAN-4838: the status filter beside the search, the description line,
    // dimmed Disabled rows, and snapshot membership with live dimming.
    const skillId = 'skill:custom:app:section-skill-0';
    const skillPicker = installed.getByTestId(
      `plugins-entry-status-${skillId}`,
    );
    await skillPicker.click();
    await window
      .getByTestId(`plugins-entry-status-${skillId}-option-disabled`)
      .click();
    await expect(skillPicker).toHaveAttribute('data-status', 'disabled');
    await expect(
      installed.getByTestId('customize-installed-status-description'),
    ).toHaveText(
      'Active items are added to every new chat. Available ones load when you or an agent need them. Disabled ones stay installed but are hidden.',
    );
    const skillRow = installed.getByTestId(
      `customize-installed-row-${skillId}`,
    );
    await expect(skillRow).toHaveAttribute('data-dimmed', 'true');
    const statusFilter = window.getByTestId(
      'customize-installed-status-filter',
    );
    await statusFilter.click();
    await window
      .getByTestId('customize-installed-status-filter-option-disabled')
      .click();
    await expect(statusFilter).toHaveAttribute('data-status', 'disabled');
    // The seeded Disabled MCP stays listed; resolved unreadable rows do not.
    await expect(window.getByTestId('customize-section-browse')).toHaveCount(0);
    await expect(skillRow).toBeVisible();
    await expect(
      installed.getByTestId(
        'customize-installed-row-skill:custom:app:section-skill-1',
      ),
    ).toHaveCount(0);
    const filteredCount = Number(
      await window.getByTestId('customize-section-installed-count').innerText(),
    );
    expect(filteredCount).toBeLessThan(total);
    await expect(installed.locator('li')).toHaveCount(filteredCount);
    await skillPicker.click();
    await window
      .getByTestId(`plugins-entry-status-${skillId}-option-available`)
      .click();
    await expect(skillPicker).toHaveAttribute('data-status', 'available');
    // The row keeps its place until the filter changes; dimming is live.
    await expect(installed.locator('li')).toHaveCount(filteredCount);
    await expect(skillRow).toBeVisible();
    await expect(skillRow).not.toHaveAttribute('data-dimmed', 'true');
    // The page holds membership, so its detail and Back keep the row.
    await installed.getByTestId(`customize-row-${skillId}`).click();
    await expect(window.getByTestId('plugins-entry-detail-page')).toBeVisible();
    await window.getByTestId('nav-history-back').click();
    await expect(statusFilter).toHaveAttribute('data-status', 'disabled');
    await expect(installed.locator('li')).toHaveCount(filteredCount);
    await expect(skillRow).toBeVisible();
    await statusFilter.click();
    await window
      .getByTestId('customize-installed-status-filter-option-any')
      .click();
    await expect(statusFilter).toHaveAttribute('data-status', 'any');
    await expect(installed.locator('li')).toHaveCount(total);
    await expect(window.getByTestId('customize-section-browse')).toBeVisible();
    // CAN-5272: each supported filter hides Browse, then Any restores it.
    for (const status of ['active', 'available', 'disabled']) {
      await statusFilter.click();
      await window
        .getByTestId(`customize-installed-status-filter-option-${status}`)
        .click();
      await expect(statusFilter).toHaveAttribute('data-status', status);
      await expect(window.getByTestId('customize-section-browse')).toHaveCount(
        0,
      );
      const count = Number(
        await window
          .getByTestId('customize-section-installed-count')
          .innerText(),
      );
      await expect(installed.locator('li')).toHaveCount(count);
    }
    await statusFilter.click();
    await window
      .getByTestId('customize-installed-status-filter-option-any')
      .click();
    await window.getByTestId('plugins-type-tab-plugin').click();
    await window.getByTestId('plugins-search').fill('debugger');
    await expect(
      installed.getByTestId('customize-row-mkt:demo/market/installed-debugger'),
    ).toBeVisible();
    const browse = window.getByTestId('customize-section-browse');
    await expect(
      browse.getByTestId('plugins-entry-mkt:demo/market/installed-debugger'),
    ).toHaveCount(0);
    await expect(
      browse.getByTestId('plugins-entry-mkt:demo/market/debugger-toolkit'),
    ).toBeVisible();
    await expect(
      window.getByTestId('customize-section-installed-count'),
    ).toHaveText('1');
    await expect(
      window.getByTestId('customize-section-browse-count'),
    ).toHaveText('1');
    await window.getByTestId('plugins-search-clear').click();
    await window.getByTestId('plugins-type-tab-workflow').click();
    // Workflows carry no status, so the filter is hidden there.
    await expect(
      window.getByTestId('customize-installed-status-filter'),
    ).toHaveCount(0);
    await expect(window.getByTestId('plugins-type-tab-pipeline')).toHaveCount(
      0,
    );
    await expect(window.getByTestId('plugins-type-tab-automation')).toHaveCount(
      0,
    );
    await window.getByTestId('plugins-type-tab-app').click();
    // A server that was never checked shows no health chip (CAN-4840).
    await expect(
      installed.getByTestId('plugins-connection-status-mcp-local:aabbcc'),
    ).toHaveCount(0);
    // A single-kind tab already names the kind, so its rows drop the chip
    // (CAN-4840).
    await expect(
      installed.getByTestId('customize-row-type-mcp-local:aabbcc'),
    ).toHaveCount(0);
    // The legacy management event still works, independently of lists: it
    // lands on Skills with Installed expanded (CAN-4267).
    await app.openPluginsTab('skills');
    await expect(
      installed.getByTestId('customize-section-installed-show-all'),
    ).toHaveCount(0);
    await expect(
      installed.getByTestId('customize-row-skill:custom:app:section-skill-9'),
    ).toBeVisible();
    await expect(
      installed.getByTestId('customize-row-mcp-local:aabbcc'),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('All retains shared project templates when searching', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-customize-templates-'),
  );
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    const account = await window.evaluate(() =>
      window.api.saveCanopyCloudApiKey({
        apiKey: 'csk_shared_template_picker_e2e',
      }),
    );
    expect(account.status).toMatchObject({ authenticated: true });
    await app.openPluginsPage();
    const template = window.getByTestId(
      'plugins-entry-blueprint:shared:5a4b3c2d-1e0f-4a5b-8c7d-6e5f4a3b2c1d',
    );
    await expect(template).toContainText('Biology 101');
    await window.getByTestId('plugins-search').fill('Biology 101');
    await expect(template).toBeVisible();
    await expect(window.getByTestId('customize-sections')).toHaveAttribute(
      'data-result-count',
      '1',
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('skill updates keep their batch snapshot, continue after failure and ignore stale checks', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-customize-updates-'),
  );
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await electronApp.evaluate(({ ipcMain }) => {
      const sourceId = 'github:fixture:updates';
      const rows = ['batch-alpha', 'batch-beta', 'batch-gamma'].map((name) => ({
        name,
        sourceId,
        source: 'github',
        description: 'Deterministic update fixture',
        installedAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
        updateAvailable: true,
      }));
      rows.push(
        { ...rows[0], name: 'built-in-excluded', builtIn: true },
        { ...rows[0], name: 'custom-excluded', custom: true },
      );
      const state = {
        calls: [],
        active: 0,
        maxActive: 0,
        checks: 0,
        betaFailures: 0,
      };
      globalThis.__can4261Updates = state;
      for (const channel of [
        'skills:load',
        'skills:check-updates',
        'skills:update',
      ])
        ipcMain.removeHandler(channel);
      // Lists deliberately remain stale after mutations. The pending check
      // completes after the batch, so neither read may restore a success.
      ipcMain.handle('skills:load', () => ({ success: true, data: rows }));
      ipcMain.removeHandler('installed-items:list-status');
      ipcMain.handle('installed-items:list-status', () => ({
        items: rows.map((row, index) => ({
          target: { kind: 'skill', sourceId, skillName: row.name },
          status: ['active', 'available', 'disabled'][index] ?? 'available',
          removable: true,
          notices: [],
        })),
      }));
      ipcMain.handle('skills:check-updates', () => {
        state.checks += 1;
        return new Promise((resolve) => {
          state.finishCheck = () =>
            resolve({
              success: true,
              data: Object.fromEntries(
                rows.map((row) => [`${sourceId}/${row.name}`, true]),
              ),
            });
        });
      });
      ipcMain.handle('skills:update', (_event, _sourceId, name) => {
        state.calls.push(name);
        state.active += 1;
        state.maxActive = Math.max(state.maxActive, state.active);
        return new Promise((resolve) => {
          state.finishUpdate = () => {
            state.active -= 1;
            const failed = name === 'batch-beta' && state.betaFailures++ === 0;
            resolve(
              failed
                ? { success: false, error: 'Fixture update failed' }
                : { success: true },
            );
          };
        });
      });
    });
    await app.openPluginsPage();
    await window.getByTestId('plugins-type-tab-skill').click();
    const updates = window.getByTestId('customize-section-updates');
    await expect(updates.locator('li')).toHaveCount(3);
    // CAN-5272: the real host wiring applies the status predicate to Updates
    // and its batch action, not only Installed. Only eligible skills update.
    const statusFilter = window.getByTestId(
      'customize-installed-status-filter',
    );
    await expect(
      window
        .getByTestId(
          'plugins-entry-status-skill:github:fixture:updates:batch-alpha',
        )
        .first(),
    ).toHaveAttribute('data-status', 'active');
    for (const [status, name] of [
      ['active', 'batch-alpha'],
      ['available', 'batch-beta'],
      ['disabled', 'batch-gamma'],
    ]) {
      await statusFilter.click();
      await window
        .getByTestId(`customize-installed-status-filter-option-${status}`)
        .click();
      await expect(updates.locator('li')).toHaveCount(1);
      await expect(
        updates.getByTestId(
          `customize-row-skill:github:fixture:updates:${name}`,
        ),
      ).toBeVisible();
      await expect(
        window.getByTestId('customize-section-updates-count'),
      ).toHaveText('1');
      await expect(window.getByTestId('customize-update-all')).toHaveCount(0);
    }
    await statusFilter.click();
    await window
      .getByTestId('customize-installed-status-filter-option-any')
      .click();
    await expect(updates.locator('li')).toHaveCount(3);
    await window.getByTestId('plugins-search').fill('batch');
    await window.getByTestId('customize-update-all').evaluate((button) => {
      button.click();
      button.click();
    });
    await expect
      .poll(() => electronApp.evaluate(() => globalThis.__can4261Updates.calls))
      .toEqual(['batch-alpha']);
    await window.getByTestId('plugins-search').fill('batch-beta');
    // Installed rows also show Update, so scope to the Updates section's row.
    const beta = updates.getByTestId(
      'customize-update-skill:github:fixture:updates:batch-beta',
    );
    await expect(beta).toBeDisabled();
    await electronApp.evaluate(() =>
      globalThis.__can4261Updates.finishUpdate(),
    );
    await expect
      .poll(() => electronApp.evaluate(() => globalThis.__can4261Updates.calls))
      .toEqual(['batch-alpha', 'batch-beta']);
    await electronApp.evaluate(() =>
      globalThis.__can4261Updates.finishUpdate(),
    );
    await expect
      .poll(() => electronApp.evaluate(() => globalThis.__can4261Updates.calls))
      .toEqual(['batch-alpha', 'batch-beta', 'batch-gamma']);
    await electronApp.evaluate(() =>
      globalThis.__can4261Updates.finishUpdate(),
    );
    await expect(
      window.getByText('Fixture update failed', { exact: true }),
    ).toBeVisible();
    await window.getByTestId('plugins-search-clear').click();
    await expect(updates.locator('li')).toHaveCount(1);
    await electronApp.evaluate(() => globalThis.__can4261Updates.finishCheck());
    await expect(updates.locator('li')).toHaveCount(1);
    await beta.click();
    await expect
      .poll(() =>
        electronApp.evaluate(() => globalThis.__can4261Updates.calls.length),
      )
      .toBe(4);
    await electronApp.evaluate(() =>
      globalThis.__can4261Updates.finishUpdate(),
    );
    await expect(updates).toHaveCount(0);
    expect(
      await electronApp.evaluate(() => ({
        maxActive: globalThis.__can4261Updates.maxActive,
        checks: globalThis.__can4261Updates.checks,
      })),
    ).toEqual({ maxActive: 1, checks: 1 });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
