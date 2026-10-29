/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActivityActionCardButton } from '../ActivityActionCardButton';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

describe('ActivityActionCardButton', () => {
  it('renders the whole card as one labelled action on the elevated card surface', () => {
    const html = renderToStaticMarkup(
      <ActivityActionCardButton
        icon={<svg data-testid="icon" />}
        label="Add MCP server"
        data-testid="card"
      />,
    );
    expect(html).toContain('data-activity-action-card-button="true"');
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-label="Add MCP server"');
    expect(html).toContain('bg-tertiary');
    expect(html).toContain('rounded-lg shadow-sm');
    expect(html).toContain('min-h-11');
    expect(html).toContain('data-testid="card"');
    expect(html).not.toContain('aria-describedby');
  });

  it('squares its bottom corners when content continues below it', () => {
    const html = renderToStaticMarkup(
      <ActivityActionCardButton icon={null} label="Run pipeline" attached />,
    );
    expect(html).toContain('rounded-t-lg rounded-b-none');
    expect(html).not.toContain('shadow-sm');
  });

  it('describes the empty state after the label and exposes it to assistive technology', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const onClick = jest.fn();
    act(() =>
      root.render(
        <ActivityActionCardButton
          icon={null}
          label="Manage MCP servers"
          description="No MCP servers in this chat."
          onClick={onClick}
        />,
      ),
    );
    const button = container.querySelector('button');
    const describedBy = button?.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(
      container.querySelector(`[id="${describedBy ?? ''}"]`)?.textContent,
    ).toBe('No MCP servers in this chat.');
    expect(button?.getAttribute('aria-label')).toBe('Manage MCP servers');
    act(() => button?.click());
    expect(onClick).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });
});
