/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { PluginsAddCustomMenu } from '../PluginsAddCustomMenu';

describe('PluginsAddCustomMenu', () => {
  it('keeps its trigger out of the window drag region on every host', () => {
    const html = renderToStaticMarkup(
      <PluginsAddCustomMenu
        onAddMarketplace={jest.fn()}
        onAddMcpServer={jest.fn()}
        onInstallSkillsFromGitHub={jest.fn()}
        onCreateCustomSkill={jest.fn()}
      />,
    );
    // The no-drag region is the trigger's wrapper, which covers the trigger.
    const wrapper =
      /<div[^>]*class="([^"]*)"[^>]*>\s*<button[^>]*data-testid="plugins-add-custom-menu"/.exec(
        html,
      )?.[1] ?? '';

    expect(wrapper.split(/\s+/)).toContain('electron-no-drag');
  });
});

it('shows the same Add custom menu when custom MCP is the only action', () => {
  // CAN-4261: web and desktop read the same, whatever the host supports.
  const html = renderToStaticMarkup(
    <PluginsAddCustomMenu onAddMcpServer={jest.fn()} />,
  );
  expect(html).toContain('data-testid="plugins-add-custom-menu"');
  expect(html).toContain('Add custom');
  expect(html).not.toContain('Add custom server');
  expect(html).toContain('aria-haspopup="menu"');
});

it('renders its rows in the action-menu look: small text, tertiary icons', () => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    act(() =>
      root.render(
        <PluginsAddCustomMenu
          onAddMarketplace={jest.fn()}
          onAddMcpServer={jest.fn()}
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
    for (const id of ['mcp', 'marketplace']) {
      expect(
        container.querySelector(`[data-testid="plugins-add-custom-${id}"]`)
          ?.className,
      ).toContain('text-xs');
      expect(
        container.querySelector(`[data-testid="plugins-add-custom-${id}-icon"]`)
          ?.className,
      ).toContain('fg-tertiary');
    }
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
