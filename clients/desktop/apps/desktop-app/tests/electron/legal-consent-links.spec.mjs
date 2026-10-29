import { createServer } from 'node:http';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// CAN-2621: on the first-run legal gate, clicking "Terms of Service" or
// "Privacy Policy" must open the legal page and leave the acceptance checkbox
// unchecked. The Cloud base URL is pinned through the E2E-only override to a
// refused local port, so the legal URLs are deterministic and nothing reaches
// the network. The E2E build never calls `shell.openExternal`; it posts each
// opened URL to `CANOPY_E2E_EXTERNAL_OPEN_CAPTURE_URL`, a local receiver here.

const CLOUD_BASE_URL = 'http://127.0.0.1:9';

/** Local receiver standing in for the host browser. */
async function startExternalOpenCapture() {
  const opened = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        opened.push(JSON.parse(body).url);
      } catch {
        // Ignore malformed payloads; the assertion reports the gap.
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/__capture/external-open`,
    opened,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
      }),
  };
}

test('legal document links open their page without accepting the terms', async () => {
  test.setTimeout(120_000);

  const externalOpen = await startExternalOpenCapture();
  const { electronApp, userDataDir } = await launchCanopy({
    freshOnboarding: true,
    env: {
      CANOPY_E2E_CLOUD_BASE_URL: CLOUD_BASE_URL,
      CANOPY_E2E_EXTERNAL_OPEN_CAPTURE_URL: externalOpen.url,
    },
  });

  try {
    const openedUrls = () => [...externalOpen.opened];

    const window = await electronApp.firstWindow();
    const gate = window.getByTestId('legal-consent-gate');
    await expect(gate).toBeVisible({ timeout: 30_000 });

    const checkbox = window.getByTestId('legal-consent-checkbox');
    const accept = window.getByTestId('legal-consent-accept');
    const terms = window.getByTestId('legal-consent-terms-link');
    const privacy = window.getByTestId('legal-consent-privacy-link');

    // The links render once the Cloud base URL resolves over IPC.
    await expect(terms).toHaveRole('button');
    await expect(privacy).toHaveRole('button');

    await terms.click();
    await expect.poll(openedUrls).toEqual([`${CLOUD_BASE_URL}/terms`]);
    await expect(checkbox).not.toBeChecked();
    await expect(accept).toBeDisabled();

    await privacy.click();
    await expect
      .poll(openedUrls)
      .toEqual([`${CLOUD_BASE_URL}/terms`, `${CLOUD_BASE_URL}/privacy`]);
    await expect(checkbox).not.toBeChecked();
    await expect(accept).toBeDisabled();

    // The agreement phrase still toggles the checkbox, and acceptance still
    // clears the gate.
    await window.getByTestId('legal-consent-label').click();
    await expect(checkbox).toBeChecked();
    await expect(accept).toBeEnabled();
    await accept.click();
    await expect(gate).toBeHidden({ timeout: 15_000 });

    const app = new CanopyAppDriver(window);
    await app.waitForShell();
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await externalOpen.close();
  }
});
