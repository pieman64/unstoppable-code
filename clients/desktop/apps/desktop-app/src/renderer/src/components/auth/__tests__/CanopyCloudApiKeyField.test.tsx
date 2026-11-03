/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CanopyCloudApiKeyField } from '../CanopyCloudApiKeyField';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

describe('CanopyCloudApiKeyField', () => {
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

  // Button's base class carries `relative`, which Tailwind emits after
  // `absolute`, so a position class on the Button itself never applies. The
  // show/hide toggle sits in the field's trailing slot instead, in the flow
  // of the field box, with no position class of its own.
  it('seats the show/hide toggle in the field trailing slot, not by position classes', () => {
    act(() =>
      root.render(
        <CanopyCloudApiKeyField
          value="csk_secret"
          onChange={(): void => undefined}
          visible={false}
          onToggleVisible={(): void => undefined}
        />,
      ),
    );
    const toggle = container.querySelector('[aria-label="Show API key"]');
    expect(toggle).toBeInstanceOf(HTMLButtonElement);
    expect(toggle?.classList.contains('absolute')).toBe(false);
    expect(toggle?.parentElement?.getAttribute('data-field-adornment')).toBe(
      'trailing',
    );
  });
});
