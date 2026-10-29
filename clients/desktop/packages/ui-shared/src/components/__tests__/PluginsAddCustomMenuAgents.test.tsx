/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { PluginsAddCustomMenu } from '../PluginsAddCustomMenu';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

describe('PluginsAddCustomMenu agent creation', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('offers New agent only when the host supplies a creator', () => {
    const onCreateAgent = jest.fn();
    act(() =>
      root.render(
        <PluginsAddCustomMenu
          onAddMcpServer={jest.fn()}
          onCreateAgent={onCreateAgent}
        />,
      ),
    );
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="plugins-add-custom-menu"]',
        )
        ?.click(),
    );
    const item = container.querySelector<HTMLElement>(
      '[data-testid="plugins-add-custom-agent"]',
    );
    expect(item?.textContent).toContain('New agent');
    act(() => item?.click());
    expect(onCreateAgent).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector('[data-testid="plugins-add-custom-agent"]'),
    ).toBeNull();
  });

  it('omits New agent for hosts without local agents', () => {
    const html = renderToStaticMarkup(
      <PluginsAddCustomMenu
        onAddMcpServer={jest.fn()}
        onCreateCollection={jest.fn()}
      />,
    );
    expect(html).not.toContain('plugins-add-custom-agent');
  });
});
