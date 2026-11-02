import { expect } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';

/** Save role choices through the surviving Settings editor. */
export async function selectProfileRoles(window, roles) {
  const app = new CanopyAppDriver(window);
  const current = await window.evaluate(() => window.api.loadPreferences());
  const previous =
    current.profileRoles ?? (current.profileRole ? [current.profileRole] : []);
  await app.openSettings();
  await app.openSettingsSection('canopy');
  await window.getByTestId('settings-profile-role-edit').click();
  for (const role of new Set([...previous, ...roles])) {
    const option = window.getByTestId(`settings-profile-role-option-${role}`);
    if (
      (await option.getAttribute('aria-pressed')) !==
      String(roles.includes(role))
    )
      await option.click();
  }
  await window.getByTestId('settings-profile-role-save').click();
  await expect(window.getByTestId('settings-profile-role-modal')).toHaveCount(
    0,
  );
  await app.closeSettings();
}
