/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ToggleSwitch } from '../../ToggleSwitch';
import { SettingsRowsGroup, SettingsRowsRow } from '../SettingsRows';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('SettingsRowsGroup disabled', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderGroup(disabled: boolean): HTMLButtonElement {
    act(() => {
      root.render(
        <SettingsRowsGroup ariaLabel="Digest" disabled={disabled}>
          <SettingsRowsRow
            label="Weekly digest"
            control={
              <ToggleSwitch
                checked={false}
                label="Weekly digest"
                onChange={jest.fn()}
              />
            }
          />
        </SettingsRowsGroup>,
      );
    });
    const toggle = container.querySelector('[role="switch"]');
    if (!(toggle instanceof HTMLButtonElement)) throw new Error('no switch');
    return toggle;
  }

  // jsdom does not enforce `inert`; browsers keep focus, clicks, and key
  // presses out of an inert subtree, so the attribute is the contract.
  it('keeps the keyboard out of the rows a parent setting turned off', () => {
    const toggle = renderGroup(true);
    const group = container.querySelector('[role="group"]');
    expect(group?.getAttribute('aria-disabled')).toBe('true');
    expect(toggle.closest('[inert]')).toBe(group);
  });

  it('leaves enabled rows reachable', () => {
    const toggle = renderGroup(false);
    expect(toggle.closest('[inert]')).toBeNull();
  });
});
