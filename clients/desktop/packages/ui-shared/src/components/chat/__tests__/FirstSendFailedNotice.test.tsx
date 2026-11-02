/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  FirstSendFailedNotice,
  type FirstSendFailedNoticeProps,
} from '../FirstSendFailedNotice';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const TITLE = 'Couldn’t send';
const MESSAGE =
  'Example Model isn’t available on AI Credits. Choose another model.';

describe('FirstSendFailedNotice', () => {
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

  function render(overrides: Partial<FirstSendFailedNoticeProps> = {}): void {
    const props: FirstSendFailedNoticeProps = {
      title: TITLE,
      message: MESSAGE,
      onChooseModel: () => undefined,
      onRetry: () => undefined,
      ...overrides,
    };
    act(() => root.render(<FirstSendFailedNotice {...props} />));
  }

  function notice(): HTMLElement {
    const element = container.querySelector<HTMLElement>(
      '[data-testid="first-send-failed-notice"]',
    );
    if (element === null) throw new Error('notice not rendered');
    return element;
  }

  function button(suffix: 'choose-model' | 'retry'): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>(
      `[data-testid="first-send-failed-notice-${suffix}"]`,
    );
  }

  function chooseModel(): HTMLButtonElement {
    const element = button('choose-model');
    if (element === null) throw new Error('primary action not rendered');
    return element;
  }

  it('is a single destructive alert with the title and message', () => {
    render();
    const alerts = container.querySelectorAll('[role="alert"]');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toBe(notice());
    expect(container.querySelectorAll('[aria-live]')).toHaveLength(1);
    expect(notice().getAttribute('data-notice-intent')).toBe('destructive');
    expect(notice().textContent).toContain(`${TITLE}.`);
    expect(notice().textContent).toContain(MESSAGE);
    expect(notice().hasAttribute('aria-busy')).toBe(false);
  });

  it('labels the actions in sentence case with the primary last', () => {
    render();
    const labels = Array.from(container.querySelectorAll('button')).map(
      (element) => element.textContent,
    );
    expect(labels).toEqual(['Try again', 'Choose another model']);
  });

  it('calls the matching callback for each action', () => {
    const onChooseModel = jest.fn();
    const onRetry = jest.fn();
    render({ onChooseModel, onRetry });
    act(() => chooseModel().click());
    expect(onChooseModel).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
    act(() => button('retry')?.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('hides Try again when no retry is offered', () => {
    render({ onRetry: undefined });
    expect(button('retry')).toBeNull();
    expect(chooseModel().textContent).toBe('Choose another model');
  });

  it('disables both actions and marks the notice busy while a retry runs', () => {
    const onChooseModel = jest.fn();
    const onRetry = jest.fn();
    render({ busy: true, onChooseModel, onRetry });
    expect(notice().getAttribute('aria-busy')).toBe('true');
    expect(chooseModel().disabled).toBe(true);
    const retry = button('retry');
    expect(retry?.disabled).toBe(true);
    expect(retry?.getAttribute('aria-busy')).toBe('true');
    expect(retry?.textContent).toBe('Trying again…');
    act(() => {
      chooseModel().click();
      retry?.click();
    });
    expect(onChooseModel).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('focuses the primary action once for each new focus key', () => {
    render({ focusKey: 'failure-1' });
    expect(document.activeElement).toBe(chooseModel());

    const elsewhere = document.createElement('input');
    document.body.append(elsewhere);
    elsewhere.focus();
    render({ focusKey: 'failure-1', message: `${MESSAGE} ` });
    expect(document.activeElement).toBe(elsewhere);

    render({ focusKey: 'failure-2' });
    expect(document.activeElement).toBe(chooseModel());
    elsewhere.remove();
  });

  it('never takes focus without a focus key', () => {
    const elsewhere = document.createElement('input');
    document.body.append(elsewhere);
    elsewhere.focus();
    render({ focusKey: null });
    expect(document.activeElement).toBe(elsewhere);
    render({ focusKey: undefined });
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it('holds a focus key that arrives during a retry until the retry settles', () => {
    const elsewhere = document.createElement('input');
    document.body.append(elsewhere);
    elsewhere.focus();
    render({ busy: true, focusKey: 'failure-1' });
    expect(document.activeElement).toBe(elsewhere);
    render({ busy: false, focusKey: 'failure-1' });
    expect(document.activeElement).toBe(chooseModel());
    elsewhere.remove();
  });

  it('takes a host test id for the notice and its actions', () => {
    render({ 'data-testid': 'home-first-send-failed' });
    expect(
      container.querySelector('[data-testid="home-first-send-failed"]'),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="home-first-send-failed-choose-model"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="home-first-send-failed-retry"]'),
    ).not.toBeNull();
  });
});
