/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PluginAccountConnection } from '../PluginAccountConnection';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('PluginAccountConnection', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function statusLine(status: string): HTMLElement {
    act(() => {
      root.render(<PluginAccountConnection status={status} />);
    });
    const line = container.querySelector('[aria-live="polite"]');
    if (!(line instanceof HTMLElement)) throw new Error('Missing status line');
    return line;
  }

  it.each(['Signed in', 'Connected'])(
    'shows the check for the %s status',
    (status) => {
      const line = statusLine(status);
      expect(line.textContent).toBe(status);
      expect(line.querySelector('svg')).not.toBeNull();
    },
  );

  it.each(['Not signed in', 'Needs reconnecting'])(
    'shows no check for the %s status',
    (status) => {
      const line = statusLine(status);
      expect(line.textContent).toBe(status);
      expect(line.querySelector('svg')).toBeNull();
    },
  );

  it('nests its heading one level down inside a titled route', () => {
    act(() => {
      root.render(<PluginAccountConnection status="Connected" />);
    });
    expect(container.querySelector('h3')?.textContent).toBe('Connection');
    act(() => {
      root.render(
        <PluginAccountConnection status="Connected" headingLevel={4} />,
      );
    });
    expect(container.querySelector('h3')).toBeNull();
    expect(container.querySelector('h4')?.textContent).toBe('Connection');
  });
});
