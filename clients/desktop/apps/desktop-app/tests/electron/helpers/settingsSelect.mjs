/**
 * UI automation for the shared Settings dropdown (`SettingsSelect` in
 * `@canopy/ui-shared/components`). It is a Canopy-drawn listbox, not a native
 * `<select>`, so Playwright's `selectOption` and `toHaveValue` do not apply:
 * choose with `chooseSettingsOption` and read the chosen value from the
 * trigger's `data-value` (`expect(trigger).toHaveAttribute('data-value', v)`).
 */

/**
 * The trigger alone: its open menu carries the same accessible name, so a
 * `getByLabel` locator would match both once the menu opens.
 *
 * @param {import('@playwright/test').Locator} trigger
 */
function comboboxOf(trigger) {
  return trigger.and(trigger.page().locator('[role="combobox"]'));
}

/**
 * Opens the dropdown behind `trigger` (its `role="combobox"` button) and
 * chooses the option whose value is `choice`, or whose label is `choice` when
 * no value matches, the way `selectOption` accepts either. Pass
 * `{ label }` or `{ value }` to be explicit.
 *
 * @param {import('@playwright/test').Locator} trigger
 * @param {string | { value: string } | { label: string }} choice
 */
export async function chooseSettingsOption(trigger, choice) {
  const page = trigger.page();
  trigger = comboboxOf(trigger);
  await trigger.click();
  const listId = await trigger.getAttribute('aria-controls');
  const listbox = listId
    ? page.locator(`[id="${listId}"]`)
    : page.getByRole('listbox');
  await listbox.waitFor({ state: 'visible' });
  const option = await settingsOptionLocator(listbox, choice);
  await option.click();
  await listbox.waitFor({ state: 'detached' });
}

/**
 * @param {import('@playwright/test').Locator} listbox
 * @param {string | { value: string } | { label: string }} choice
 */
async function settingsOptionLocator(listbox, choice) {
  if (typeof choice === 'object' && 'label' in choice) {
    return listbox.getByRole('option', { name: choice.label, exact: true });
  }
  const value = typeof choice === 'object' ? choice.value : choice;
  const byValue = listbox.locator(
    `[role="option"][data-value=${JSON.stringify(value)}]`,
  );
  if (typeof choice === 'object' || (await byValue.count()) > 0) {
    return byValue;
  }
  return listbox.getByRole('option', { name: value, exact: true });
}

/**
 * The labels a dropdown offers, in order, read by opening and closing it.
 *
 * @param {import('@playwright/test').Locator} trigger
 * @returns {Promise<string[]>}
 */
export async function settingsOptionLabels(trigger) {
  const page = trigger.page();
  trigger = comboboxOf(trigger);
  await trigger.click();
  const listId = await trigger.getAttribute('aria-controls');
  const listbox = listId
    ? page.locator(`[id="${listId}"]`)
    : page.getByRole('listbox');
  await listbox.waitFor({ state: 'visible' });
  const labels = await listbox.getByRole('option').allTextContents();
  await page.keyboard.press('Escape');
  await listbox.waitFor({ state: 'detached' });
  return labels.map((label) => label.trim());
}

/**
 * The values a dropdown offers, in order, read by opening and closing it.
 *
 * @param {import('@playwright/test').Locator} trigger
 * @returns {Promise<string[]>}
 */
export async function settingsOptionValues(trigger) {
  const page = trigger.page();
  trigger = comboboxOf(trigger);
  await trigger.click();
  const listId = await trigger.getAttribute('aria-controls');
  const listbox = listId
    ? page.locator(`[id="${listId}"]`)
    : page.getByRole('listbox');
  await listbox.waitFor({ state: 'visible' });
  const values = await listbox
    .getByRole('option')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-value')));
  await page.keyboard.press('Escape');
  await listbox.waitFor({ state: 'detached' });
  return values.map((value) => value ?? '');
}

/**
 * The label and disabled state of the option whose value is `value`, read by
 * opening and closing the dropdown; `null` when no option has that value.
 *
 * @param {import('@playwright/test').Locator} trigger
 * @param {string | null} value
 * @returns {Promise<{ label: string, disabled: boolean } | null>}
 */
export async function settingsOptionState(trigger, value) {
  const page = trigger.page();
  trigger = comboboxOf(trigger);
  await trigger.click();
  const listId = await trigger.getAttribute('aria-controls');
  const listbox = listId
    ? page.locator(`[id="${listId}"]`)
    : page.getByRole('listbox');
  await listbox.waitFor({ state: 'visible' });
  const option = listbox.locator(
    `[role="option"][data-value=${JSON.stringify(value ?? '')}]`,
  );
  const state =
    (await option.count()) === 0
      ? null
      : {
          label: ((await option.textContent()) ?? '').trim(),
          disabled: await option.isDisabled(),
        };
  await page.keyboard.press('Escape');
  await listbox.waitFor({ state: 'detached' });
  return state;
}

/**
 * Chooses in a control that is a native `<select>` on one surface and the
 * shared Settings dropdown on another (a runtime picker in a panel and on a
 * settings page).
 *
 * @param {import('@playwright/test').Locator} control
 * @param {string | { value: string } | { label: string }} choice
 */
export async function chooseOption(control, choice) {
  const tag = await control.evaluate((element) => element.tagName);
  if (tag === 'SELECT') {
    await control.selectOption(choice);
    return;
  }
  await chooseSettingsOption(control, choice);
}

/**
 * The chosen value of a native `<select>` or a Settings dropdown.
 *
 * @param {import('@playwright/test').Locator} control
 * @returns {Promise<string>}
 */
export async function chosenValue(control) {
  const tag = await control.evaluate((element) => element.tagName);
  if (tag === 'SELECT') return control.inputValue();
  return (await control.getAttribute('data-value')) ?? '';
}
