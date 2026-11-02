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
  // show/hide toggle is seated over the input by a wrapper instead.
  it('positions the show/hide toggle with a wrapper, not on the Button', () => {
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
    expect(toggle?.parentElement?.classList.contains('absolute')).toBe(true);
  });
});
