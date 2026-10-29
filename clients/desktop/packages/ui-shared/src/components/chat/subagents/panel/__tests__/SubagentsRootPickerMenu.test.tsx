/** @jest-environment jsdom */

import { renderToStaticMarkup } from 'react-dom/server';
import {
  SubagentsRootPickerMenu,
  type SubagentsRootPickerItem,
} from '../SubagentsPanelParts';

const finished: SubagentsRootPickerItem = {
  id: 'finished-root',
  title: 'Finished root',
  total: 3,
  live: 0,
  lastActivityAt: 0,
};
const active: SubagentsRootPickerItem = {
  id: 'active-root',
  title: 'Active root',
  total: 9,
  live: 2,
};

function picker(
  roots: readonly SubagentsRootPickerItem[],
  selectedRootId: string | null,
): HTMLElement {
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(
    <SubagentsRootPickerMenu
      roots={roots}
      selectedRootId={selectedRootId}
      onSelectRoot={(): void => undefined}
    />,
  );
  return container;
}

function option(container: HTMLElement, id: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(
    `[data-testid="subagents-root-option-${id}"]`,
  );
  if (!element) throw new Error(`missing option ${id}`);
  return element;
}

describe('SubagentsRootPickerMenu', () => {
  it('draws a divider above Finished only when Active is above it', () => {
    const finishedOnly = picker([finished], null);
    expect(finishedOnly.textContent).toContain('Finished');
    expect(
      finishedOnly.querySelector('.canopy-picker-menu-section'),
    ).toBeNull();

    const both = picker([active, finished], null);
    expect(both.querySelector('.canopy-picker-menu-section')).not.toBeNull();
  });

  it('gives each root one leading status column', () => {
    const container = picker([active, finished], 'finished-root');
    for (const id of ['active-root', 'finished-root']) {
      const row = option(container, id);
      expect(
        row.querySelectorAll('[data-testid="subagents-root-status"]'),
      ).toHaveLength(1);
      // No second, reserved check column before the status.
      expect(
        row.querySelector('[data-picker-selected-check="false"]'),
      ).toBeNull();
    }
    const spinner = option(container, 'active-root').querySelector(
      '[data-testid="subagents-root-status"] [aria-label="Thinking"]',
    );
    expect(spinner).not.toBeNull();
    // The chat tab's 12px spinner.
    expect(spinner?.getAttribute('style')).toBe('gap:3px');

    // The selection check sits after the title.
    const selected = option(container, 'finished-root');
    const check = selected.querySelector('[data-picker-selected-check="true"]');
    expect(check).not.toBeNull();
    expect(selected.lastElementChild).toBe(check);
  });
});
