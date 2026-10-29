/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PluginSelectionScopeHelp } from '../PluginSelectionScopeHelp';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

describe('PluginSelectionScopeHelp', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<PluginSelectionScopeHelp />));
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  it('shows one line with a labelled info button', () => {
    const help = container.querySelector(
      '[data-testid="workspace-plugin-scope-help"]',
    );
    expect(help?.textContent).toBe(
      'Defaults for every chat in this project. A chat can still turn one off.',
    );
    const button = help?.querySelector('button');
    expect(button?.getAttribute('aria-label')).toBe(
      'How project defaults work',
    );
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
  });

  it('keeps the full guidance in the popover', () => {
    act(() => {
      container.querySelector('button')?.dispatchEvent(
        new MouseEvent('mouseover', {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
    });

    const details = document.body.querySelector(
      '[data-testid="workspace-plugin-scope-help-details"]',
    );
    expect(details?.getAttribute('role')).toBe('tooltip');
    const text = details?.textContent ?? '';
    for (const sentence of [
      'This list comes from your available skills, plugin marketplaces, collections, and configured MCP servers.',
      'Source shows where each item comes from.',
      'Selections apply to every chat in this project, including existing chats, from their next message.',
      'A chat can still turn a default off.',
      'Selections do not install plugins.',
      'Chats can also inherit global defaults and account-managed connectors.',
    ]) {
      expect(text).toContain(sentence);
    }
  });
});
