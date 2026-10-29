/** The hosted Settings page, account pages in their frame. */
export function hostedPage(window, pageKey) {
  return window.locator(
    `[data-testid="hosted-settings-content"][data-hosted-settings-page="${pageKey}"], ` +
      `[data-testid="hosted-settings-frame"][data-hosted-settings-page="${pageKey}"]`,
  );
}
