/**
 * Runtime Early access helpers (Settings → Labs). Early access is a
 * Labs experiment that main evaluates; specs change it through the same
 * `experiments.setChoice` bridge the Settings switch uses, so signed-in
 * sessions save to the account (cloud mock) and signed-out ones save to the
 * machine-local choices. Seed it before launch with `seedEarlyAccess`.
 */

export const EARLY_ACCESS_EXPERIMENT_ID = 'early-access';

/**
 * Saves the Early access choice and resolves with main's effective state.
 * Under the default E2E `offered` rollout the effective state follows the
 * choice.
 *
 * @param {import('@playwright/test').Page} page
 * @param {boolean} enabled
 * @returns {Promise<boolean>}
 */
export async function setEarlyAccess(page, enabled) {
  return page.evaluate(
    async ({ experimentId, value }) =>
      (
        await window.api.experiments.setChoice({
          experimentId,
          enabled: value,
        })
      ).earlyAccessEnabled,
    { experimentId: EARLY_ACCESS_EXPERIMENT_ID, value: enabled },
  );
}

/**
 * Reads main's effective Early access state.
 *
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<boolean>}
 */
export async function readEarlyAccess(page) {
  return page.evaluate(
    async () => (await window.api.experiments.getSnapshot()).earlyAccessEnabled,
  );
}

/** Seed the old feature bundle in legacy behavior specs after extraction. */
export async function setAllLabsFeatures(page, enabled) {
  return page.evaluate(async (value) => {
    const snapshot = await window.api.experiments.getSnapshot();
    const features = snapshot.experiments.filter(
      (entry) =>
        entry.id !== 'early-access' &&
        entry.pages.length === 0 &&
        entry.flagKey.startsWith('canopy-desktop-labs-'),
    );
    for (const entry of features) {
      await window.api.experiments.setChoice({
        experimentId: entry.id,
        enabled: value,
      });
    }
    return value;
  }, enabled);
}
