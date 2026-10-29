/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ProfileRoleId } from '@canopy/protocol/plugin-catalog';
import { OnboardingCategoryPicker } from '../OnboardingCategoryPicker';
import {
  ONBOARDING_CATEGORY_ROLES,
  onboardingCategoryOptions,
} from '../../lib/onboarding-recommendations';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('onboardingCategoryOptions', () => {
  it('offers the five leading roles, in order, with their profile labels', () => {
    expect(onboardingCategoryOptions([])).toEqual([
      { id: 'software-engineer', label: 'Software engineer' },
      { id: 'product-manager', label: 'Product manager' },
      { id: 'designer', label: 'Designer' },
      { id: 'founder', label: 'Founder or executive' },
      { id: 'marketing', label: 'Marketing' },
    ]);
    expect(ONBOARDING_CATEGORY_ROLES).toHaveLength(5);
  });

  it('keeps a saved role outside the five visible so it can be turned off', () => {
    const ids = onboardingCategoryOptions(['sales', 'designer']).map(
      (option) => option.id,
    );
    expect(ids).toEqual([...ONBOARDING_CATEGORY_ROLES, 'sales']);
  });
});

describe('OnboardingCategoryPicker', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(
    selected: readonly ProfileRoleId[],
    onToggle: (role: ProfileRoleId) => void = jest.fn(),
  ): void {
    act(() => {
      root.render(
        <OnboardingCategoryPicker
          selected={selected}
          onToggle={onToggle}
          testIdPrefix="picker"
        />,
      );
    });
  }

  it('labels one compact, non-wrapping row of toggles with its heading', () => {
    render(['designer']);
    const group = container.querySelector('[role="group"]');
    const headingId = group?.getAttribute('aria-labelledby');
    expect(headingId).toBeTruthy();
    expect(container.querySelector(`[id="${headingId}"]`)?.textContent).toBe(
      'Pick a category',
    );
    expect(group?.className).toContain('flex-nowrap');
    // A narrow host scrolls the row sideways rather than clipping the
    // trailing tiles, where a saved role outside the top five sits.
    expect(group?.className).toContain('overflow-x-auto');
    expect(group?.className).not.toContain('overflow-hidden');
    const tiles = Array.from(
      group?.querySelectorAll<HTMLButtonElement>('button') ?? [],
    );
    expect(tiles.map((tile) => tile.textContent)).toEqual([
      'Software engineer',
      'Product manager',
      'Designer',
      'Founder or executive',
      'Marketing',
    ]);
    // Smaller than the 40px tool tiles they sit above.
    expect(tiles[0]?.className).toContain('h-7');
    expect(tiles[0]?.className).not.toContain('min-h-10');
    expect(tiles.map((tile) => tile.getAttribute('aria-pressed'))).toEqual([
      'false',
      'false',
      'true',
      'false',
      'false',
    ]);
    expect(
      container
        .querySelector('[data-testid="picker-designer"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('toggles one category at a time so several can be chosen', () => {
    const onToggle = jest.fn();
    render(['designer'], onToggle);
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="picker-marketing"]')
        ?.click();
    });
    expect(onToggle).toHaveBeenCalledWith('marketing');
  });
});
