/**
 * @jest-environment jsdom
 */
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

jest.mock('../suggestedPromptTelemetry', () => ({
  trackSuggestedPromptImpression: jest.fn(),
  trackSuggestedPromptSelection: jest.fn(),
}));

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import type { SuggestedPrompt } from '../mcpPromptIndex';
import { SuggestedPromptChips } from '../SuggestedPromptChips';
import {
  GENERIC_PROMPT_ICON_GLYPHS,
  GENERIC_PROMPT_ICONS,
} from '../genericPromptIcons';
import { trackSuggestedPromptSelection } from '../suggestedPromptTelemetry';

const trackSelectionMock = jest.mocked(trackSuggestedPromptSelection);

const PROMPTS: SuggestedPrompt[] = [
  { id: 'github-1', curatedKey: 'github', text: 'Do a github thing' },
  { id: 'generic-1', curatedKey: null, text: 'Do a generic thing' },
];

const listCuratedMock = jest.fn();

describe('SuggestedPromptChips', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    jest.clearAllMocks();
    listCuratedMock.mockResolvedValue({
      version: 1,
      servers: [
        {
          key: 'github',
          name: 'GitHub',
          shortDescription: '',
          url: 'https://github.example.test/mcp',
          transport: 'http',
          logoUrl: 'https://cdn.example.test/github.png',
          categories: [],
          popular: true,
          sortOrder: 1,
          updatedAt: '2026-08-05T00:00:00.000Z',
        },
      ],
    });
    Object.defineProperty(window, 'mcpServers', {
      configurable: true,
      value: { listCurated: listCuratedMock },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
  });

  async function render(
    prompts: readonly SuggestedPrompt[],
    onSelect: (p: SuggestedPrompt) => void,
  ): Promise<void> {
    await act(async () => {
      root.render(
        <SuggestedPromptChips
          prompts={prompts}
          surface="chat"
          onSelect={onSelect}
        />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  it('renders one row per prompt with stable testids and icons', async () => {
    await render(PROMPTS, jest.fn());
    expect(
      container.querySelectorAll('[data-testid="suggested-prompt-chips"]'),
    ).toHaveLength(1);
    const rows = container.querySelectorAll(
      '[data-testid="suggested-prompt-chip"]',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].getAttribute('data-suggestion-id')).toBe('github-1');
    expect(rows[0].textContent).toBe('Do a github thing');
    // MCP-specific row shows the curated logo (or its MCP-icon fallback);
    // generic rows never do.
    expect(
      rows[0].querySelector(
        '[data-testid="suggested-prompt-logo"], [data-testid="suggested-prompt-logo-fallback"]',
      ),
    ).not.toBeNull();
    expect(
      rows[1].querySelector(
        '[data-testid="suggested-prompt-logo"], [data-testid="suggested-prompt-logo-fallback"]',
      ),
    ).toBeNull();
  });

  it('blocks project starter prompts and records catalog prompts', async () => {
    await render(
      [
        ...PROMPTS,
        {
          id: 'starter-1',
          curatedKey: null,
          text: 'Audit our billing tables',
          userAuthored: true,
        },
      ],
      jest.fn(),
    );
    const blocked = (text: string): boolean => {
      const span = Array.from(container.querySelectorAll('span')).find(
        (node) => node.childElementCount === 0 && node.textContent === text,
      );
      if (!span) throw new Error(`${text} not rendered`);
      return span.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`) !== null;
    };
    expect(blocked('Audit our billing tables')).toBe(true);
    expect(blocked('Do a github thing')).toBe(false);
    expect(blocked('Do a generic thing')).toBe(false);
  });

  it('provides an icon for every generic fallback pool id', () => {
    for (const id of [
      'generic-1',
      'generic-2',
      'generic-3',
      'generic-4',
      'generic-5',
      'generic-home-1',
      'generic-home-2',
      'generic-home-3',
      'generic-home-4',
      'generic-home-5',
      'generic-home-6',
    ]) {
      expect(GENERIC_PROMPT_ICONS[id]).toBeDefined();
    }
  });

  // CAN-2700 QA: the Home pool aliases the CAN-1809 developer glyphs, which are
  // bespoke artwork drawn for a specific developer prompt each. Reusing the
  // debugging glyph (`generic-2`, "Find and fix a small bug worth cleaning up")
  // for "Make sense of a spreadsheet or data file" puts a literal bug next to a
  // non-technical prompt — the exact developer-coded signal this ticket removes
  // from the zero-setup surface. `toBeDefined()` above cannot catch an alias.
  it('does not reuse the debugging glyph for a non-developer Home prompt', () => {
    expect(GENERIC_PROMPT_ICON_GLYPHS['generic-home-5']).not.toBe(
      GENERIC_PROMPT_ICON_GLYPHS['generic-2'],
    );
  });

  it('falls back gracefully when a generic prompt has no mapped icon', async () => {
    await render(
      [{ id: 'generic-unknown', curatedKey: null, text: 'Unknown prompt' }],
      jest.fn(),
    );
    expect(
      container.querySelector('[data-suggestion-id="generic-unknown"] svg'),
    ).not.toBeNull();
  });

  it('renders nothing for an empty prompt list', async () => {
    await render([], jest.fn());
    expect(container.innerHTML).toBe('');
  });

  it('fires selection telemetry and onSelect on click', async () => {
    const onSelect = jest.fn();
    await render(PROMPTS, onSelect);
    const row = container.querySelectorAll<HTMLButtonElement>(
      '[data-testid="suggested-prompt-chip"]',
    )[1];
    act(() => {
      row.click();
    });
    expect(onSelect).toHaveBeenCalledWith(PROMPTS[1]);
    expect(trackSelectionMock).toHaveBeenCalledTimes(1);
    expect(trackSelectionMock).toHaveBeenCalledWith('chat', PROMPTS[1], 1);
  });
});
