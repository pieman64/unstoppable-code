import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeCanopy, launchCanopyApp } from './launchCanopy.mjs';
import {
  chooseCloneDestination,
  fillCloneUrl,
} from './helpers/add-project.mjs';
import { createControlledPortalClone } from './portal/cloneProgressFixture.mjs';
import { writeUnauthenticatedGhFixture } from './ghAuthFixture.mjs';

const ROOT_URL = 'https://github.com/cursor/plugins';
const FILES = {
  'README.md': '# Default branch\n',
  'pstack/README.md': '# Default pstack\n',
};

for (const [suffix, background] of [
  ['', false],
  ['/tree/main/pstack', false],
  ['/tree/linked/pstack', true],
  ['/blob/linked/pstack/README.md', false],
]) {
  test(`CAN-4342: clones the whole default branch from ${suffix || 'root'} (${background ? 'background' : 'foreground'})`, async () => {
    test.skip(process.platform === 'win32', 'POSIX controlled Git fixture');
    test.setTimeout(120_000);
    const clone = createControlledPortalClone({
      remoteUrl: ROOT_URL,
      files: FILES,
      linkedFiles: {
        'README.md': '# Linked branch\n',
        'pstack/README.md': '# Linked pstack\n',
      },
    });
    const root = mkdtempSync(path.join(os.tmpdir(), 'can4342-'));
    const destination = path.join(root, 'repos');
    mkdirSync(destination);
    let launched;
    try {
      if (!background) clone.release();
      launched = await launchCanopyApp({
        env: {
          ...clone.env,
          GH_EXECUTABLE: writeUnauthenticatedGhFixture(path.join(root, 'gh')),
        },
      });
      const { window, electronApp } = launched;
      await launched.app.openMainPage();
      await window.getByTestId('sidebar-section-code-add').focus();
      await window.getByTestId('sidebar-section-code-add').press('Enter');
      await window.getByTestId('add-workspace-mode-remote').click();
      await fillCloneUrl(window, ROOT_URL + suffix);
      await chooseCloneDestination(electronApp, window, destination);
      await window.getByTestId('add-workspace-clone-submit').click();
      await expect.poll(() => clone.arguments()).toEqual([ROOT_URL]);
      if (background) {
        await expect(
          window.getByTestId('clone-progress-sidebar'),
        ).toBeVisible();
        clone.release();
      }
      await expect(
        window.getByTestId('add-workspace-remote-url-input'),
      ).toHaveCount(0);
      await expect
        .poll(() => {
          try {
            return clone.verifyCheckout(path.join(destination, 'plugins'));
          } catch {
            return null;
          }
        })
        .toEqual({ branch: 'main', files: FILES });
    } finally {
      clone.release();
      if (launched)
        await closeCanopy(launched.electronApp, launched.userDataDir);
      clone.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
