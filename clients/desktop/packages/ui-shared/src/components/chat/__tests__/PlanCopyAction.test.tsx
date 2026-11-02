/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChatLookProvider } from '../../chat-look';
import { PlanApprovalPrompt } from '../PlanApprovalPrompt';
import {
  PlanCopyAction,
  type PlanCopyAppearance,
  type PlanCopyState,
} from '../PlanCopyAction';

const PLAN = '\n# Plan ✓\n\n1. Edit `src/a.ts`\n\n```ts\nconst x = 1;\n```\n  ';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  jest.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  jest.useRealTimers();
});

function render(node: ReactNode): void {
  act(() =>
    root.render(<ChatLookProvider value="classic">{node}</ChatLookProvider>),
  );
}

function button(testId = 'copy'): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(
    `[data-testid="${testId}"]`,
  );
  if (!found) throw new Error(`missing ${testId}`);
  return found;
}

function status(testId = 'copy'): string {
  return (
    container.querySelector(`[data-testid="${testId}-status"]`)?.textContent ??
    ''
  );
}

async function click(target: HTMLButtonElement): Promise<void> {
  await act(async () => {
    target.click();
    await Promise.resolve();
  });
}

function advance(ms: number): void {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
}

const ready: PlanCopyState = { status: 'ready', markdown: PLAN };

describe('PlanCopyAction (CAN-5354)', () => {
  it.each(['Enter', ' '])(
    'keeps %s activation inside the Copy action in an interactive card',
    async (key) => {
      const openCard = jest.fn();
      const write = jest.fn<Promise<boolean>, [string]>(() =>
        Promise.resolve(true),
      );
      render(
        <div
          onKeyDown={(event): void => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              openCard();
            }
          }}
        >
          <PlanCopyAction
            state={ready}
            appearance="control"
            dataTestId="copy"
            write={write}
          />
        </div>,
      );
      const event = new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        button().dispatchEvent(event);
      });
      expect(openCard).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
      await click(button());
      expect(write).toHaveBeenCalledWith(PLAN, document);
    },
  );
  it.each<PlanCopyAppearance>(['footer', 'composer', 'control', 'card'])(
    'copies the exact Markdown and announces each copy (%s)',
    async (appearance) => {
      const write = jest.fn<Promise<boolean>, [string]>(() =>
        Promise.resolve(true),
      );
      render(
        <PlanCopyAction
          state={ready}
          appearance={appearance}
          dataTestId="copy"
          write={write}
        />,
      );
      expect(button().getAttribute('aria-label')).toBe('Copy plan');

      await click(button());
      expect(write).toHaveBeenCalledWith(PLAN, document);
      advance(100);
      expect(status()).toBe('Copied');
      expect(button().getAttribute('aria-label')).toBe('Copied');

      // A repeat copy empties and refills the region, so it is announced too.
      await click(button());
      expect(status()).toBe('');
      advance(100);
      expect(status()).toBe('Copied');
      expect(write).toHaveBeenCalledTimes(2);
    },
  );

  it('announces a failed or rejected write without a copied state', async () => {
    const write = jest
      .fn<Promise<boolean>, [string]>()
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error('denied'));
    render(
      <PlanCopyAction
        state={ready}
        appearance="control"
        dataTestId="copy"
        write={write}
      />,
    );
    await click(button());
    advance(100);
    expect(status()).toBe("Couldn't copy the plan");
    expect(button().getAttribute('aria-label')).toBe('Copy plan');

    await click(button());
    advance(100);
    expect(status()).toBe("Couldn't copy the plan");
    expect(button().getAttribute('data-state')).toBe('ready');
  });

  it('keeps an unavailable plan in view, inert, with its reason', async () => {
    const write = jest.fn<Promise<boolean>, [string]>(() =>
      Promise.resolve(true),
    );
    render(
      <PlanCopyAction
        state={{ status: 'unavailable', reason: 'Only part arrived' }}
        appearance="footer"
        dataTestId="copy"
        write={write}
      />,
    );
    const control = button();
    expect(control.getAttribute('aria-label')).toBe('Copy plan');
    expect(control.getAttribute('aria-disabled')).toBe('true');
    const describedBy = control.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.textContent).toBe(
      'Only part arrived',
    );
    await click(control);
    advance(200);
    expect(write).not.toHaveBeenCalled();
    expect(status()).toBe('');
  });

  it('drops feedback when the plan changes', async () => {
    const write = jest.fn<Promise<boolean>, [string]>(() =>
      Promise.resolve(true),
    );
    render(
      <PlanCopyAction
        state={ready}
        appearance="card"
        dataTestId="copy"
        write={write}
      />,
    );
    await click(button());
    advance(100);
    expect(status()).toBe('Copied');
    render(
      <PlanCopyAction
        state={{ status: 'ready', markdown: '# Next' }}
        appearance="card"
        dataTestId="copy"
        write={write}
      />,
    );
    expect(status()).toBe('');
    expect(button().textContent).toBe('Copy');
  });

  it.each<PlanCopyAppearance>(['composer', 'control', 'card'])(
    'shows Copy beside its icon and keeps Copy plan as its name (%s)',
    (appearance) => {
      render(
        <PlanCopyAction
          state={ready}
          appearance={appearance}
          dataTestId="copy"
        />,
      );
      expect(button().textContent).toBe('Copy');
      expect(button().getAttribute('aria-label')).toBe('Copy plan');
      expect(button().querySelector('svg')).not.toBeNull();
    },
  );
});

describe('PlanApprovalPrompt Copy plan', () => {
  it('copies beside Open plan without answering or closing the prompt', async () => {
    const writeText = jest.fn<Promise<void>, [string]>(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const onSelect = jest.fn();
    const onClose = jest.fn();
    const onOpenPlan = jest.fn();
    render(
      <PlanApprovalPrompt
        options={[{ label: 'Yes', onSelect, testId: 'yes' }]}
        onOpenPlan={onOpenPlan}
        planCopy={ready}
        onClose={onClose}
      >
        <textarea />
      </PlanApprovalPrompt>,
    );
    const copy = button('chat-plan-copy');
    // Beside Open plan, in the header, ahead of it in tab order.
    expect(
      copy.compareDocumentPosition(button('chat-plan-explore')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await click(copy);
    expect(writeText).toHaveBeenCalledWith(PLAN);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(onOpenPlan).not.toHaveBeenCalled();
  });

  it('labels its header actions Copy and Open, each with an icon', () => {
    render(
      <PlanApprovalPrompt
        options={[]}
        onOpenPlan={jest.fn()}
        planCopy={ready}
        onClose={jest.fn()}
      >
        <textarea />
      </PlanApprovalPrompt>,
    );
    const open = button('chat-plan-explore');
    expect(open.textContent).toBe('Open');
    expect(open.getAttribute('aria-label')).toBe('Open plan');
    expect(open.querySelector('svg')).not.toBeNull();
    expect(button('chat-plan-copy').textContent).toBe('Copy');
  });

  it('offers no Copy plan without host plan state', () => {
    render(
      <PlanApprovalPrompt options={[]} onClose={jest.fn()}>
        <textarea />
      </PlanApprovalPrompt>,
    );
    expect(container.querySelector('[data-testid="chat-plan-copy"]')).toBe(
      null,
    );
  });
});
