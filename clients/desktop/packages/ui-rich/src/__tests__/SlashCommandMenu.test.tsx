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
    hiddenCount?: number;
    totalCount?: number;
    onShowAll?: () => void;
    onSelect?: (command: SlashCommandOption) => void;
  }): void {
    act(() => {
      root.render(
        <SlashCommandMenu
          commands={props.commands}
          selectedIndex={props.selectedIndex ?? 0}
          isDiscovering={props.isDiscovering ?? false}
          itemLabel={props.itemLabel ?? 'commands'}
          title={props.title ?? 'Commands'}
          onSelect={props.onSelect ?? ((): void => undefined)}
          pendingCommand={props.pendingCommand}
          hiddenCount={props.hiddenCount}
          totalCount={props.totalCount}
          onShowAll={props.onShowAll}
        />,
      );
    });
  }

  function optionButtons(): HTMLElement[] {
    return Array.from(
      container.querySelectorAll<HTMLElement>('[role="option"]'),
    );
  }

  it('CAN-5271 renders available tags only on available rows without headings', () => {
    render({ commands: [...DISCOVERED, ...AVAILABLE] });
    expect(container.querySelector('[role="presentation"]')).toBeNull();
    expect(optionButtons()).toHaveLength(4);
    expect(
      optionButtons().map(
        (row) =>
          row.querySelector('[data-testid="slash-command-availability-tag"]')
            ?.textContent ?? null,
      ),
    ).toEqual([null, null, 'Available · enable', 'Available · enable']);
  });

  it('CAN-5271 keeps the flat selection index aligned with every option', () => {
    render({ commands: [...DISCOVERED, ...AVAILABLE], selectedIndex: 2 });
    const options = optionButtons();
    expect(
      options.map((option) => option.getAttribute('aria-selected')),
    ).toEqual(['false', 'false', 'true', 'false']);
    expect(options[2]?.textContent).toContain('/plugin:summarize');
    expect(container.querySelector('[role="presentation"]')).toBeNull();
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

  it('CAN-5271 preserves interleaved relevance order without section headings', () => {
    const [review, plan] = DISCOVERED;
    const [summarize, translate] = AVAILABLE;
    if (!review || !plan || !summarize || !translate)
      throw new Error('fixture');
    render({
      commands: [
        { ...review, menuGroup: 'Actions' },
        summarize,
        { ...plan, menuGroup: 'Actions' },
        translate,
      ],
    });
    expect(container.querySelector('[role="presentation"]')).toBeNull();
    expect(optionButtons().map((option) => option.textContent)).toEqual([
      expect.stringContaining('/review'),
      expect.stringContaining('/plugin:summarize'),
      expect.stringContaining('/plan'),
      expect.stringContaining('/plugin:translate'),
    ]);
  });

  it('renders Show all as the last option and expands without selecting', () => {
    const onShowAll = jest.fn();
    const onSelect = jest.fn();
    render({
      commands: DISCOVERED,
      hiddenCount: 3,
      totalCount: 5,
      selectedIndex: 2,
      onShowAll,
      onSelect,
    });
    const showAll = container.querySelector<HTMLElement>(
      '[data-testid="slash-command-show-all"]',
    );
    expect(showAll?.textContent).toBe('Show all 5');
    const options = optionButtons();
    expect(options[options.length - 1]).toBe(showAll);
    expect(showAll?.getAttribute('aria-selected')).toBe('true');
    act(() => showAll?.click());
    expect(onShowAll).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('omits Show all when nothing is hidden', () => {
    render({ commands: DISCOVERED, hiddenCount: 0, onShowAll: jest.fn() });
    expect(
      container.querySelector('[data-testid="slash-command-show-all"]'),
    ).toBeNull();
  });
});
