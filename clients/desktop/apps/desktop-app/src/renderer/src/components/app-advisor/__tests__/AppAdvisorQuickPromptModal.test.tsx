/**
 * @jest-environment jsdom
 */
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';

jest.mock('@canopy/ui-rich/editor', () => ({
  SlateEditor: (): JSX.Element => <div data-testid="quick-prompt-editor" />,
  createChatEditor: (): object => ({}),
  createEmptyValue: (): unknown[] => [],
  serializeEditorValue: (): { text: string } => ({ text: '' }),
}));

import { AppAdvisorQuickPromptModal } from '../AppAdvisorQuickPromptModal';

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

describe('AppAdvisorQuickPromptModal session-replay privacy', () => {
  it('records the prompt card; the editor blocks its own draft', () => {
    act(() => {
      root.render(<AppAdvisorQuickPromptModal onClose={jest.fn()} />);
    });

    const card = container.querySelector(
      '[data-testid="app-advisor-quick-prompt"]',
    );
    expect(card?.getAttribute('role')).toBe('dialog');
    expect(
      card?.querySelector('[data-testid="quick-prompt-editor"]'),
    ).not.toBeNull();
    expect(card?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(false);
    // The draft lives in `SlateEditor`, which carries its own replay block
    // (pinned by packages/ui-rich SlateEditor tests).
    expect(
      card?.querySelector('[data-testid="app-advisor-quick-prompt-header"]')
        ?.textContent,
    ).toBe('Orchestrator');
  });
});
