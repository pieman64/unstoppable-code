/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChatToolStepGroup } from '../ChatToolStepGroup';
import { ChatLookProvider } from '../chat-look';
import { getToolDisplayInfo } from '../chat/tool-display';

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
      <ChatLookProvider value="classic">
        <ChatToolStepGroup summary="Read 3 files" runningLabel="Run the tests">
          {ALL}
        </ChatToolStepGroup>
      </ChatLookProvider>,
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
      <ChatLookProvider value="classic">
        <ChatToolStepGroup
          summary="Thought, read 3 files"
          runningLabel="Read cache.ts"
          liveSteps={<div data-testid="live-step" />}
        >
          {ALL}
        </ChatToolStepGroup>
      </ChatLookProvider>,
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
      <ChatLookProvider value="classic">
        <ChatToolStepGroup summary="Read 3 files" forceExpanded>
          {ALL}
        </ChatToolStepGroup>
      </ChatLookProvider>,
    );
    expect(container.querySelectorAll('[data-testid="step"]')).toHaveLength(4);
  });

  it('opens on request as saved state, so the person can close it again', () => {
    const request = {};
    render(
      <ChatLookProvider value="classic">
        <ChatToolStepGroup summary="Ran 2 commands" openRequest={request}>
          {ALL}
        </ChatToolStepGroup>
      </ChatLookProvider>,
    );
    expect(button().getAttribute('aria-expanded')).toBe('true');
    act(() => button().click());
    expect(button().getAttribute('aria-expanded')).toBe('false');
    // The same request doesn't reopen it; a new one does.
    render(
      <ChatLookProvider value="classic">
        <ChatToolStepGroup summary="Ran 2 commands" openRequest={request}>
          {ALL}
        </ChatToolStepGroup>
      </ChatLookProvider>,
    );
    expect(button().getAttribute('aria-expanded')).toBe('false');
    render(
      <ChatLookProvider value="classic">
        <ChatToolStepGroup summary="Ran 2 commands" openRequest={{}}>
          {ALL}
        </ChatToolStepGroup>
      </ChatLookProvider>,
    );
    expect(button().getAttribute('aria-expanded')).toBe('true');
  });
});

describe('ChatToolStepGroup interrupted steps (CAN-5178)', () => {
  it('says interrupted steps after errors, under the clean look', () => {
    render(
      <ChatLookProvider value="clean">
        <ChatToolStepGroup
          summary="Read 1 file, edited 1 file"
          failedCount={1}
          interruptedCount={1}
        >
          {ALL}
        </ChatToolStepGroup>
      </ChatLookProvider>,
    );
    expect(
      container.querySelector('[data-testid="chat-tool-step-failed"]')
        ?.textContent,
    ).toBe('· 1 error');
    expect(
      container.querySelector('[data-testid="chat-tool-step-interrupted"]')
        ?.textContent,
    ).toBe('· 1 interrupted');
  });

  it('says an interruption-only run without an error count', () => {
    render(
      <ChatLookProvider value="clean">
        <ChatToolStepGroup summary="Edited 1 file" interruptedCount={1}>
          {ALL}
        </ChatToolStepGroup>
      </ChatLookProvider>,
    );
    expect(
      container.querySelector('[data-testid="chat-tool-step-failed"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="chat-tool-step-interrupted"]')
        ?.textContent,
    ).toBe('· 1 interrupted');
  });
});

describe('ChatToolStepGroup live line waiting for approval (CAN-5291)', () => {
  const bash = JSON.stringify({ command: 'pnpm test' });

  it('says the call waits, without shimmer', () => {
    render(
      <ChatLookProvider value="clean">
        <ChatToolStepGroup
          summary=""
          live={{
            label: getToolDisplayInfo('Bash', bash).label,
            icon: null,
            waiting: true,
          }}
        />
      </ChatLookProvider>,
    );
    const group = container.querySelector(
      '[data-testid="chat-tool-step-group"]',
    );
    expect(group?.getAttribute('data-tool-approval')).toBe('waiting');
    expect(group?.textContent).toContain('Waiting to run pnpm test');
    expect(container.querySelector('.canopy-text-shimmer-strong')).toBeNull();
    expect(
      container.querySelector('[data-testid="chat-tool-step-waiting"]'),
    ).toBeNull();
  });

  it('names the wait beside a label without a verb', () => {
    render(
      <ChatLookProvider value="clean">
        <ChatToolStepGroup
          summary=""
          live={{ label: 'Create issue', icon: null, waiting: true }}
        />
      </ChatLookProvider>,
    );
    expect(
      container.querySelector('[data-testid="chat-tool-step-waiting"]')
        ?.textContent,
    ).toBe('Waiting for approval');
  });

  it('shimmers the running call once approval clears', () => {
    render(
      <ChatLookProvider value="clean">
        <ChatToolStepGroup
          summary=""
          live={{ label: getToolDisplayInfo('Bash', bash).label, icon: null }}
        />
      </ChatLookProvider>,
    );
    expect(container.textContent).toContain('Running pnpm test');
    expect(
      container.querySelector('.canopy-text-shimmer-strong'),
    ).not.toBeNull();
    expect(container.querySelector('[data-tool-approval]')).toBeNull();
  });

  it('drops the classic spinner for a waiting running label', () => {
    render(
      <ChatLookProvider value="classic">
        <ChatToolStepGroup
          summary="Ran 1 command"
          runningLabel="pnpm test"
          runningWaiting
        />
      </ChatLookProvider>,
    );
    expect(
      container.querySelector('[data-testid="chat-tool-step-waiting"]')
        ?.textContent,
    ).toBe('Waiting for approval');
  });
});
