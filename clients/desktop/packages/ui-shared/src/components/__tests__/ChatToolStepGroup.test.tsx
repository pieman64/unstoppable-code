/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChatToolStepGroup } from '../ChatToolStepGroup';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(element: JSX.Element): void {
  act(() => root.render(element));
}

function button(): HTMLButtonElement {
  const found = container.querySelector('button');
  if (!found) throw new Error('Group row not rendered');
  return found;
}

const ALL = (
  <>
    <div data-testid="step" />
    <div data-testid="step" />
    <div data-testid="step" />
    <div data-testid="step" />
  </>
);

describe('ChatToolStepGroup', () => {
  it('shows the summary and running label closed, every step open', () => {
    render(
      <ChatToolStepGroup summary="Read 3 files" runningLabel="Run the tests">
        {ALL}
      </ChatToolStepGroup>,
    );
    expect(
      container.querySelector('[data-testid="chat-tool-step-summary"]')
        ?.textContent,
    ).toBe('Read 3 files');
    expect(
      container.querySelector('[data-testid="chat-tool-step-running"]')
        ?.textContent,
    ).toBe('Run the tests');
    expect(container.querySelectorAll('[data-testid="step"]')).toHaveLength(0);
    act(() => button().click());
    expect(button().getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelectorAll('[data-testid="step"]')).toHaveLength(4);
  });

  it('shows live steps in place of the running label while closed', () => {
    render(
      <ChatToolStepGroup
        summary="Thought, read 3 files"
        runningLabel="Read cache.ts"
        liveSteps={<div data-testid="live-step" />}
      >
        {ALL}
      </ChatToolStepGroup>,
    );
    expect(
      container.querySelector('[data-testid="chat-tool-step-running"]'),
    ).toBeNull();
    expect(
      container.querySelectorAll(
        '[data-testid="chat-tool-step-live"] [data-testid="live-step"]',
      ),
    ).toHaveLength(1);
    act(() => button().click());
    expect(
      container.querySelector('[data-testid="chat-tool-step-live"]'),
    ).toBeNull();
    expect(container.querySelectorAll('[data-testid="step"]')).toHaveLength(4);
    expect(
      container.querySelector('[data-testid="chat-tool-step-running"]')
        ?.textContent,
    ).toBe('Read cache.ts');
  });

  it('opens for a search reveal without being clicked', () => {
    render(
      <ChatToolStepGroup summary="Read 3 files" forceExpanded>
        {ALL}
      </ChatToolStepGroup>,
    );
    expect(container.querySelectorAll('[data-testid="step"]')).toHaveLength(4);
  });
});
