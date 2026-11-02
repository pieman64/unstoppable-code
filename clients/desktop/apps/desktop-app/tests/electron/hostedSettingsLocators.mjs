/** The hosted Settings page, account pages in their frame. */
export function hostedPage(window, pageKey) {
  return window.locator(
    `[data-testid="hosted-settings-content"][data-hosted-settings-page="${pageKey}"], ` +
      `[data-testid="hosted-settings-frame"][data-hosted-settings-page="${pageKey}"]`,
  );
}

/**
 * Open the scope menu at the top of the Settings rail and choose one of its
 * items: `account`, an organization id, `all-organizations` or
 * `create-organization`. The menu renders in a portal on the document body.
 */
export async function chooseSettingsScope(window, item) {
  await window.getByTestId('settings-nav-scope-picker').click();
  const testId =
    item === 'all-organizations' || item === 'create-organization'
      ? `settings-nav-scope-${item}`
      : `settings-nav-scope-option-${item}`;
  await window.getByTestId(testId).click();
}

/** Open the Organizations list from the rail's scope menu. */
export async function openOrganizationsList(window) {
  await chooseSettingsScope(window, 'all-organizations');
}
