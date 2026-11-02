/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChatLookProvider } from '@canopy/ui-shared/components';
import type { DisplayBlock } from '../types';
import { CleanToolStepGroup, ToolStepGroup } from '../ToolStepGroup';
import { segmentCleanSteps } from '../tool-step-groups';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

type ToolUseBlock = Extract<DisplayBlock, { type: 'tool_use' }>;

function toolUse(
  id: string,
  toolName: string,
  input: object,
  finished = true,
): ToolUseBlock {
  return {
    type: 'tool_use',
    toolUseId: id,
    toolName,
    input: JSON.stringify(input),
    ...(finished ? { result: { output: 'ok', isError: false } } : {}),
  };
}

const TOOL_USES: ToolUseBlock[] = [
  toolUse('1', 'Grep', { pattern: 'WakeLock' }),
  toolUse('2', 'Read', { file_path: '/repo/WakeLockIndicator.tsx' }),
  toolUse('3', 'Read', { file_path: '/repo/wakeLockStore.ts' }),
];

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

function summary(): string | null | undefined {
  return container.querySelector('[data-testid="chat-tool-step-summary"]')
    ?.textContent;
}

function rowButton(): HTMLButtonElement {
  const button = container.querySelector('button');
  if (!button) throw new Error('Group row not rendered');
  return button;
}

describe('ToolStepGroup', () => {
  it('shows one closed row with a plain-words summary', () => {
    render(
      <ChatLookProvider value="classic">
        <ToolStepGroup toolUses={TOOL_USES} streaming={false}>
          <div data-testid="step-rows" />
        </ToolStepGroup>
      </ChatLookProvider>,
    );
    expect(summary()).toBe('Searched 1 time, read 2 files');
    expect(rowButton().getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-testid="step-rows"]')).toBeNull();
  });

  it('opens and closes the rows when the summary is clicked', () => {
    render(
      <ChatLookProvider value="classic">
        <ToolStepGroup toolUses={TOOL_USES} streaming={false}>
          <div data-testid="step-rows" />
        </ToolStepGroup>
      </ChatLookProvider>,
    );
    act(() => rowButton().click());
    expect(rowButton().getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[data-testid="step-rows"]')).not.toBeNull();
    act(() => rowButton().click());
    expect(container.querySelector('[data-testid="step-rows"]')).toBeNull();
  });

  it('opens for a search hit without being clicked', () => {
    render(
      <ChatLookProvider value="classic">
        <ToolStepGroup toolUses={TOOL_USES} streaming={false} forceExpanded>
          <div data-testid="step-rows" />
        </ToolStepGroup>
      </ChatLookProvider>,
    );
    expect(container.querySelector('[data-testid="step-rows"]')).not.toBeNull();
  });

  it('names the call that is still running', () => {
    const running = [
      ...TOOL_USES,
      toolUse(
        '4',
        'Bash',
        { command: 'npx jest WakeLock', description: 'Run the tests' },
        false,
      ),
    ];
    render(
      <ChatLookProvider value="classic">
        <ToolStepGroup toolUses={running} streaming>
          <div />
        </ToolStepGroup>
      </ChatLookProvider>,
    );
    expect(summary()).toBe('Searched 1 time, read 2 files, ran 1 command');
    expect(
      container.querySelector('[data-testid="chat-tool-step-running"]')
        ?.textContent,
    ).toContain('Run the tests');
  });

  it('drops the running call once the turn has stopped', () => {
    const unfinished = [
      ...TOOL_USES,
      toolUse('4', 'Bash', { command: 'npm test' }, false),
    ];
    render(
      <ChatLookProvider value="classic">
        <ToolStepGroup toolUses={unfinished} streaming={false}>
          <div />
        </ToolStepGroup>
      </ChatLookProvider>,
    );
    expect(
      container.querySelector('[data-testid="chat-tool-step-running"]'),
    ).toBeNull();
  });

  describe('live step window (CAN-4274)', () => {
    function liveRows(): string[] {
      return Array.from(
        container.querySelectorAll(
          '[data-testid="chat-tool-step-live"] [data-step]',
        ),
        (row) => row.getAttribute('data-step') ?? '',
      );
    }

    function renderLive(liveSteps: string[] | undefined): void {
      const running = [
        ...TOOL_USES,
        toolUse('4', 'Bash', { command: 'npm test' }, false),
      ];
      render(
        <ChatLookProvider value="classic">
          <ToolStepGroup
            toolUses={running}
            streaming
            liveSteps={
              liveSteps === undefined
                ? undefined
                : liveSteps.map((step) => <div key={step} data-step={step} />)
            }
          >
            {['1', '2', '3', '4'].map((step) => (
              <div key={step} data-testid="all-step" data-step={step} />
            ))}
          </ToolStepGroup>
        </ChatLookProvider>,
      );
    }

    it('shows the newest steps under the closed row while the turn runs', () => {
      renderLive(['2', '3', '4']);
      expect(rowButton().getAttribute('aria-expanded')).toBe('false');
      expect(summary()).toBe('Searched 1 time, read 2 files, ran 1 command');
      expect(liveRows()).toEqual(['2', '3', '4']);
      expect(
        container.querySelectorAll('[data-testid="all-step"]'),
      ).toHaveLength(0);
      // The running row already spins in the window; the summary row does
      // not repeat it with a second spinner.
      expect(
        container.querySelector('[data-testid="chat-tool-step-running"]'),
      ).toBeNull();
    });

    it('opens to every step and closes back to the window', () => {
      renderLive(['2', '3', '4']);
      act(() => rowButton().click());
      expect(rowButton().getAttribute('aria-expanded')).toBe('true');
      expect(
        container.querySelectorAll('[data-testid="all-step"]'),
      ).toHaveLength(4);
      expect(
        container.querySelector('[data-testid="chat-tool-step-live"]'),
      ).toBeNull();
      act(() => rowButton().click());
      expect(liveRows()).toEqual(['2', '3', '4']);
    });

    it('keeps the group mounted while the window moves on', () => {
      renderLive(['1', '2', '3']);
      const group = container.querySelector(
        '[data-testid="chat-tool-step-group"]',
      );
      renderLive(['2', '3', '4']);
      expect(
        container.querySelector('[data-testid="chat-tool-step-group"]'),
      ).toBe(group);
      expect(liveRows()).toEqual(['2', '3', '4']);
    });

    it('compresses to the summary row once the window goes away', () => {
      renderLive(['2', '3', '4']);
      act(() => rowButton().click());
      act(() => rowButton().click());
      renderLive(undefined);
      expect(
        container.querySelector('[data-testid="chat-tool-step-live"]'),
      ).toBeNull();
      expect(
        container.querySelectorAll('[data-testid="all-step"]'),
      ).toHaveLength(0);
      act(() => rowButton().click());
      expect(
        container.querySelectorAll('[data-testid="all-step"]'),
      ).toHaveLength(4);
    });

    it('summarizes thinking steps when they are given', () => {
      render(
        <ChatLookProvider value="classic">
          <ToolStepGroup
            toolUses={[]}
            steps={[
              { type: 'thinking', text: 'Where is the cache?' },
              { type: 'thinking', text: 'Check the store.' },
            ]}
            streaming={false}
          >
            <div />
          </ToolStepGroup>
        </ChatLookProvider>,
      );
      expect(summary()).toBe('Thought 2 times');
    });
  });
});

describe('CleanToolStepGroup live line', () => {
  it('keeps what the running step names out of session replay', () => {
    const [segment] = segmentCleanSteps([
      {
        id: 'm1',
        role: 'assistant',
        timestamp: 1,
        blocks: [toolUse('9', 'Read', { file_path: '/repo/secret.ts' }, false)],
      },
    ]);
    if (segment?.kind !== 'steps') throw new Error('expected a run');
    render(
      <ChatLookProvider value="clean">
        <CleanToolStepGroup segment={segment} live />
      </ChatLookProvider>,
    );
    const blocked = container.querySelector('.ph-no-capture');
    expect(blocked?.textContent).toContain('secret.ts');
    // Only the words: the row and its button stay recordable.
    expect(blocked?.closest('button')).not.toBe(blocked);
    expect(blocked?.tagName).toBe('SPAN');
  });
});
