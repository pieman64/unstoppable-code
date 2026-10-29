/** @jest-environment jsdom */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

jest.mock('@/lib/theme', () => ({ applyTheme: jest.fn() }));

import { QuestionFormsLabPage } from '../QuestionFormsLabPage';

describe('QuestionFormsLabPage', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    jest.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<QuestionFormsLabPage />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.useRealTimers();
  });

  function click(element: Element | null): void {
    if (!(element instanceof HTMLElement)) throw new Error('missing element');
    act(() => element.click());
  }

  function buttonByText(text: string): Element | null {
    return (
      Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
        (button: HTMLButtonElement) =>
          (button.textContent ?? '').trim().startsWith(text),
      ) ?? null
    );
  }

  it('docks the shared question card and records the answer after it resolves', () => {
    const dock = container.querySelector('[data-testid="chat-question-dock"]');
    expect(
      dock?.querySelector('[data-testid="ask-user-question-card"]'),
    ).not.toBeNull();

    click(buttonByText('Run tests'));
    click(buttonByText('Send'));
    act(() => jest.advanceTimersByTime(1000));

    expect(
      container.querySelector('[data-testid="chat-question-dock"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="answered-questions"]')
        ?.textContent,
    ).toContain('Run tests');
    expect(
      container.querySelector('[data-testid="question-forms-lab-events"]')
        ?.textContent,
    ).toContain('Answer accepted');
  });

  it('switches presets to a fresh request', () => {
    click(
      container.querySelector(
        '[data-testid="question-forms-lab-preset-release"]',
      ),
    );
    expect(container.textContent).toContain('Environment');
    expect(container.textContent).not.toContain('What happens next?');
  });
});
