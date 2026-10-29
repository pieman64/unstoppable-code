// Run headlessly through the repository host guard; this verifies fixtures,
// not a browser specialist, model quality, or production enforcement.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright';
import { ensureElectronBinaryInstalled } from '../../../../../scripts/lib/electron-binary.mjs';
import {
  BROWSER_LAB_CASES,
  createBrowserLabServer,
} from '../mock-server/routes/browser-lab.mjs';

test(
  'Browser Lab tasks complete in a hidden disposable Electron window',
  { timeout: 120_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'browser-lab-smoke-'));
    const lab = createBrowserLabServer();
    let app;
    try {
      await new Promise((resolve) => lab.listen(0, '127.0.0.1', resolve));
      const origin = `http://127.0.0.1:${lab.address().port}`;
      ensureElectronBinaryInstalled();
      app = await _electron.launch({
        executablePath: process.env.ELECTRON_EXEC_PATH,
        args: [fileURLToPath(new URL('./lab-shell.mjs', import.meta.url))],
        env: { ...process.env, BROWSER_LAB_SMOKE_ROOT: root },
        timeout: 30_000,
      });
      const page = await app.firstWindow();
      page.setDefaultTimeout(10_000);
      assert.equal(
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().some((window) => window.isVisible()),
        ),
        false,
      );
      // An exact fixture origin is sufficient; no other loopback service is used.
      await page.route('**/*', (route) =>
        new URL(route.request().url()).origin === origin
          ? route.continue()
          : route.abort(),
      );
      const id = (name) => page.getByTestId(`browser-lab-${name}`);
      for (const fixture of BROWSER_LAB_CASES) {
        await page.goto(`${origin}${fixture.entryPath}`);
        switch (fixture.id) {
          case 'forms':
            await id('forms-full-name').fill('Ada Lovelace');
            await id('forms-email').fill('ada@example.test');
            await id('forms-quantity').fill('3');
            await id('forms-delivery-express').check();
            await id('forms-note').fill('Leave at the front desk');
            await id('forms-terms').check();
            await id('forms-submit').click();
            break;
          case 'autocomplete':
            await id('autocomplete-input').fill('Port');
            await id('autocomplete-option-plm').click();
            await id('autocomplete-submit').click();
            break;
          case 'native-select':
            await id('native-select-plan').selectOption('team-annual');
            await id('native-select-region').selectOption('eu-north-stockholm');
            await id('native-select-seats').selectOption('12');
            await id('native-select-submit').click();
            break;
          case 'long-table': {
            const row = page
              .locator('tr')
              .filter({ hasText: 'Imogen Vale' })
              .filter({ hasText: 'Refund pending' });
            await row.scrollIntoViewIfNeeded();
            await id('long-table-order-id').fill(
              await row.getAttribute('data-order-id'),
            );
            await id('long-table-submit').click();
            break;
          }
          case 'dialogs': {
            // The standalone shell lacks Canopy's browser dialog host. Supply
            // synthetic answers to verify the fixture flow; native dialog
            // interception is a separate S0.3 qualification requirement.
            const kinds = await page.evaluate(() => {
              const seen = [];
              window.confirm = () => {
                seen.push('confirm');
                return true;
              };
              window.prompt = () => {
                seen.push('prompt');
                return 'DELETE-Q3';
              };
              window.alert = () => {
                seen.push('alert');
              };
              document.getElementById('delete-draft').click();
              return seen;
            });
            assert.deepEqual(kinds, ['confirm', 'prompt', 'alert']);
            break;
          }
          case 'multi-page':
            await id('multi-page-supplier-alder').click();
            await id('multi-page-next').click();
            assert.match(
              await id('multi-page-supplier-code').innerText(),
              /SUP-BIRCH/,
            );
            await id('multi-page-back').click();
            await id('multi-page-supplier-id').fill('SUP-BIRCH');
            await id('multi-page-submit').click();
            break;
          case 'slow-navigation':
            await id('slow-navigation-report-link').click();
            await id('slow-navigation-input').fill(
              (await id('slow-navigation-reference').innerText()).match(
                /SET-\d+/,
              )?.[0] ?? '',
            );
            await id('slow-navigation-submit').click();
            break;
          case 'spa':
            await id('spa-nav-settings').click();
            await id('spa-settings-notifications-link').click();
            await id('spa-digest').selectOption('weekly');
            await id('spa-product-updates').uncheck();
            await id('spa-security-alerts').check();
            await id('spa-save').click();
            break;
          case 'hostile':
            assert.equal(
              await id('hostile-paste-target').getAttribute(
                'data-browser-lab-paste-count',
              ),
              '0',
            );
            await id('hostile-order-id').fill('ORD-0112');
            await id('hostile-reason').selectOption('damaged');
            await id('hostile-submit').click();
            break;
          default:
            throw new Error(`Uncovered fixture: ${fixture.id}`);
        }
        try {
          await id('success-code').waitFor();
        } catch (error) {
          throw new Error(
            `${fixture.id}: ${page.url()} — ${await page.locator('body').innerText()}`,
            { cause: error },
          );
        }
        assert.equal(
          await id('success-code').innerText(),
          fixture.successCode,
          fixture.id,
        );
      }
    } finally {
      if (app) await app.close();
      lab.closeAllConnections();
      await new Promise((resolve) => lab.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  },
);
