/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SlashCommandMenu } from '../editor/SlashCommandMenu';
import type { SlashCommandOption } from '../types';

const DISCOVERED: SlashCommandOption[] = [
  { name: 'review', description: 'Review the diff', displayName: '/review' },
  { name: 'plan', description: 'Plan the work', displayName: '/plan' },
];

const AVAILABLE: SlashCommandOption[] = [
  {
    name: 'summarize',
    description: 'Summarize a file',
    displayName: '/plugin:summarize',
    section: 'available',
    category: 'docs-plugin',
    data: { id: 'summarize' },
  },
  {
    name: 'translate',
    description: 'Translate text',
    displayName: '/plugin:translate',
    section: 'available',
    data: { id: 'translate' },
  },
];

describe('SlashCommandMenu', () => {
  let container: HTMLElement;
  let root: Root;

  beforeAll(() => {
    // jsdom does not implement scrollIntoView; the menu calls it on selection.
    Element.prototype.scrollIntoView = jest.fn();
  });

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

  function render(props: {
    commands: SlashCommandOption[];
    selectedIndex?: number;
    isDiscovering?: boolean;
    itemLabel?: string;
    title?: string;
    pendingCommand?: SlashCommandOption;
  }): void {
    act(() => {
      root.render(
        <SlashCommandMenu
          commands={props.commands}
          selectedIndex={props.selectedIndex ?? 0}
          isDiscovering={props.isDiscovering ?? false}
          itemLabel={props.itemLabel ?? 'commands'}
          title={props.title ?? 'Commands'}
          onSelect={(): void => undefined}
          pendingCommand={props.pendingCommand}
        />,
      );
    });
  }

  function optionButtons(): HTMLElement[] {
    return Array.from(
      container.querySelectorAll<HTMLElement>('[role="option"]'),
    );
  }

  it('renders an "Available to enable" divider before the available rows', () => {
    render({ commands: [...DISCOVERED, ...AVAILABLE] });

    const divider = container.querySelector('[role="presentation"]');
    expect(divider?.textContent).toBe('Available to enable');
  });

  it('treats every command as a selectable option and the divider as a non-option', () => {
    render({ commands: [...DISCOVERED, ...AVAILABLE] });

    // One option per command — the divider is not counted.
    expect(optionButtons()).toHaveLength(4);

    const listbox = container.querySelector('[role="listbox"]');
    const children = Array.from(listbox?.children ?? []);
    // Order: discovered, discovered, divider, available, available.
    expect(children[2]?.getAttribute('role')).toBe('presentation');
    expect(children[0]?.getAttribute('role')).toBe('option');
    expect(children[1]?.getAttribute('role')).toBe('option');
    expect(children[3]?.getAttribute('role')).toBe('option');
  });

  it('keeps the selection index aligned with options across the divider', () => {
    // selectedIndex 2 == the first available row (third command overall).
    render({ commands: [...DISCOVERED, ...AVAILABLE], selectedIndex: 2 });

    const options = optionButtons();
    expect(options[2]?.getAttribute('aria-selected')).toBe('true');
    expect(options[2]?.textContent).toContain('/plugin:summarize');
    // The divider carries no selection state.
    const divider = container.querySelector('[role="presentation"]');
    expect(divider?.getAttribute('aria-selected')).toBeNull();
  });

  it('renders the muted source label for available rows', () => {
    render({ commands: [...DISCOVERED, ...AVAILABLE] });
    expect(container.textContent).toContain('docs-plugin');
  });

  it('disables a command and shows feedback while host preparation is pending', () => {
    render({
      commands: [...DISCOVERED, ...AVAILABLE],
      pendingCommand: AVAILABLE[0],
    });

    const pending = optionButtons()[2];
    expect(pending?.getAttribute('aria-busy')).toBe('true');
    expect(pending).toHaveProperty('disabled', true);
    expect(pending?.textContent).toContain('Enabling…');
  });

  it('keeps unavailable projected commands visible but disabled', () => {
    render({
      commands: [
        {
          name: 'check-docs',
          displayName: '$docs:check-docs',
          disabledReason: 'Unavailable on the Codex harness',
        },
      ],
    });

    const option = optionButtons()[0];
    expect(option).toHaveProperty('disabled', true);
    expect(option?.textContent).toContain('Unavailable on the Codex harness');
  });

  it('shows no divider when there are no available rows', () => {
    render({ commands: DISCOVERED });
    expect(container.querySelector('[role="presentation"]')).toBeNull();
    expect(optionButtons()).toHaveLength(2);
  });

  it('shows provider-aware loading copy while discovering with no rows', () => {
    render({ commands: [], isDiscovering: true, itemLabel: 'skills' });
    expect(container.textContent).toContain('Discovering skills...');

    render({ commands: [], isDiscovering: true, itemLabel: 'commands' });
    expect(container.textContent).toContain('Discovering commands...');
  });

  it('shows provider-aware empty copy after discovery with no rows', () => {
    render({ commands: [], isDiscovering: false, itemLabel: 'skills' });
    expect(container.textContent).toContain('No matching skills');

    render({ commands: [], isDiscovering: false, itemLabel: 'commands' });
    expect(container.textContent).toContain('No matching commands');
  });
});
