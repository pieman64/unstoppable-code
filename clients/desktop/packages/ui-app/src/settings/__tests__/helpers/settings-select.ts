import { act } from 'react';

/**
 * Drives a `SettingsSelect` the way a person does: click the combobox
 * trigger, then a row in the menu it opens. The menu renders outside the
 * page container, so rows are found through the trigger's `aria-controls`.
 */

/** The combobox trigger matching `selector` under `root`. */
export function settingsSelectTrigger(
  root: ParentNode,
  selector: string,
): HTMLButtonElement {
  const trigger = root.querySelector(selector);
  if (
    !(trigger instanceof HTMLButtonElement) ||
    trigger.getAttribute('role') !== 'combobox'
  ) {
    throw new Error(`No settings select matches ${selector}`);
  }
  return trigger;
}

function openListbox(trigger: HTMLButtonElement): HTMLElement {
  if (trigger.getAttribute('aria-expanded') !== 'true') {
    act(() => trigger.click());
  }
  const listId = trigger.getAttribute('aria-controls');
  const listbox = listId ? document.getElementById(listId) : null;
  if (!(listbox instanceof HTMLElement)) {
    throw new Error('The settings select did not open its menu');
  }
  return listbox;
}

function closeListbox(trigger: HTMLButtonElement): void {
  if (trigger.getAttribute('aria-expanded') === 'true') {
    act(() => trigger.click());
  }
}

/** The option rows' values, in order; the menu is closed again after. */
export function settingsSelectOptionValues(
  trigger: HTMLButtonElement,
): string[] {
  const listbox = openListbox(trigger);
  const values = Array.from(
    listbox.querySelectorAll<HTMLElement>('[role="option"]'),
  ).map((row) => row.dataset.value ?? '');
  closeListbox(trigger);
  return values;
}

/** The option rows' labels, in order; the menu is closed again after. */
export function settingsSelectOptionLabels(
  trigger: HTMLButtonElement,
): string[] {
  const listbox = openListbox(trigger);
  const labels = Array.from(
    listbox.querySelectorAll<HTMLElement>('[role="option"]'),
  ).map((row) => row.textContent ?? '');
  closeListbox(trigger);
  return labels;
}

/** Opens the menu and chooses the row whose value is `value`. */
export async function chooseSettingsOption(
  trigger: HTMLButtonElement,
  value: string,
): Promise<void> {
  const listbox = openListbox(trigger);
  const row = Array.from(
    listbox.querySelectorAll<HTMLElement>('[role="option"]'),
  ).find((candidate) => candidate.dataset.value === value);
  if (!row) {
    closeListbox(trigger);
    throw new Error(`The settings select has no option ${value}`);
  }
  await act(async () => {
    row.click();
    await Promise.resolve();
  });
}

/** The chosen value, as a native `<select>`'s `value` reads. */
export function settingsSelectValue(trigger: HTMLButtonElement): string {
  return trigger.dataset.value ?? '';
}

/** Every settings select trigger under `root`, in document order. */
export function settingsSelectTriggers(root: ParentNode): HTMLButtonElement[] {
  return Array.from(
    root.querySelectorAll<HTMLButtonElement>('button[role="combobox"]'),
  );
}

/**
 * Opens the menu and chooses the row whose value is `value`, inside one
 * synchronous `act`, for tests that assert right after a change event.
 */
export function chooseSettingsOptionSync(
  trigger: HTMLButtonElement,
  value: string,
): void {
  const listbox = openListbox(trigger);
  const row = Array.from(
    listbox.querySelectorAll<HTMLElement>('[role="option"]'),
  ).find((candidate) => candidate.dataset.value === value);
  if (!row) {
    closeListbox(trigger);
    throw new Error(`The settings select has no option ${value}`);
  }
  act(() => row.click());
}

/** The menu's group headings, in order; the menu is closed again after. */
export function settingsSelectGroupLabels(
  trigger: HTMLButtonElement,
): string[] {
  const listbox = openListbox(trigger);
  const labels = Array.from(
    listbox.querySelectorAll<HTMLElement>('.canopy-picker-menu-section-label'),
  ).map((heading) => heading.textContent ?? '');
  closeListbox(trigger);
  return labels;
}

/** The option row for `value`, with its label and disabled state. */
export function settingsSelectOption(
  trigger: HTMLButtonElement,
  value: string,
): { readonly label: string; readonly disabled: boolean } | null {
  const listbox = openListbox(trigger);
  const row = Array.from(
    listbox.querySelectorAll<HTMLElement>('[role="option"]'),
  ).find((candidate) => candidate.dataset.value === value);
  const option = row
    ? {
        label: row.textContent ?? '',
        disabled:
          row.getAttribute('aria-disabled') === 'true' ||
          (row instanceof HTMLButtonElement && row.disabled),
      }
    : null;
  closeListbox(trigger);
  return option;
}

export interface SettingsSelectProbeOption {
  readonly value: string;
  readonly textContent: string;
  readonly disabled: boolean;
}

/**
 * A live view of one settings select with the parts of a native
 * `<select>`'s API tests read: `value`, `disabled`, `options`, plus
 * `choose(value)` in place of setting `value` and dispatching `change`.
 */
export interface SettingsSelectProbe {
  readonly trigger: HTMLButtonElement;
  readonly value: string;
  readonly disabled: boolean;
  readonly options: readonly SettingsSelectProbeOption[];
  choose(value: string): void;
}

export function probeSettingsSelect(
  trigger: HTMLButtonElement,
): SettingsSelectProbe {
  return {
    trigger,
    get value(): string {
      return settingsSelectValue(trigger);
    },
    get disabled(): boolean {
      return trigger.disabled;
    },
    get options(): readonly SettingsSelectProbeOption[] {
      const listbox = openListbox(trigger);
      const rows = Array.from(
        listbox.querySelectorAll<HTMLElement>('[role="option"]'),
      ).map(
        (row): SettingsSelectProbeOption => ({
          value: row.dataset.value ?? '',
          textContent: row.textContent ?? '',
          disabled: row instanceof HTMLButtonElement && row.disabled,
        }),
      );
      closeListbox(trigger);
      return rows;
    },
    choose(value: string): void {
      chooseSettingsOptionSync(trigger, value);
    },
  };
}

/** The probe for the settings select matching `selector`, or `null`. */
export function querySettingsSelect(
  root: ParentNode,
  selector: string,
): SettingsSelectProbe | null {
  const trigger = root.querySelector(selector);
  return trigger instanceof HTMLButtonElement &&
    trigger.getAttribute('role') === 'combobox'
    ? probeSettingsSelect(trigger)
    : null;
}

/** Probes for every settings select under `root`, in document order. */
export function querySettingsSelects(root: ParentNode): SettingsSelectProbe[] {
  return settingsSelectTriggers(root).map(probeSettingsSelect);
}
