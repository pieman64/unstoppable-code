/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { OnboardingTip, type OnboardingTipProps } from '../OnboardingTip';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

describe('OnboardingTip', () => {
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

  function render(props: Partial<OnboardingTipProps> = {}): jest.Mock {
    const onDismiss = jest.fn();
    act(() => {
      root.render(
        <OnboardingTip
          placement="composer"
          icon={<svg />}
          title="Title"
          onDismiss={onDismiss}
          data-testid="tip"
          {...props}
        >
          Body
        </OnboardingTip>,
      );
    });
    return onDismiss;
  }

  function button(testId: string): HTMLButtonElement | null {
    const element = container.querySelector(`[data-testid="${testId}"]`);
    return element instanceof HTMLButtonElement ? element : null;
  }

  it('keeps Got it and the close button by default, with no verb', () => {
    render();
    expect(button('tip-got-it')?.textContent).toBe('Got it');
    expect(button('tip-dismiss')?.getAttribute('aria-label')).toBe(
      'Dismiss tip',
    );
    expect(container.querySelectorAll('button')).toHaveLength(2);
    expect(container.querySelector('.truncate')).toBeNull();
  });

  it('draws a composer verb, a custom dismiss, and host data attributes', () => {
    const onClick = jest.fn();
    const onDismiss = render({
      action: { label: 'Connect', ariaLabel: 'Connect: Acme', onClick },
      dismissLabel: null,
      dismissAriaLabel: 'Not now: Acme',
      truncate: true,
      'data-host-marker': 'yes',
    });
    const tip = container.querySelector('[data-testid="tip"]');
    expect(tip?.getAttribute('data-host-marker')).toBe('yes');
    expect(tip?.getAttribute('data-onboarding-tip-placement')).toBe('composer');
    expect(button('tip-got-it')).toBeNull();
    expect(tip?.querySelectorAll('.truncate')).toHaveLength(2);
    const verb = container.querySelector('[aria-label="Connect: Acme"]');
    if (!(verb instanceof HTMLButtonElement)) throw new Error('missing verb');
    act(() => verb.click());
    expect(onClick).toHaveBeenCalledTimes(1);
    act(() => button('tip-dismiss')?.click());
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(button('tip-dismiss')?.getAttribute('aria-label')).toBe(
      'Not now: Acme',
    );
  });

  it('ignores a busy verb but keeps dismissal available', () => {
    const onClick = jest.fn();
    const onDismiss = render({
      action: { label: 'Connect', onClick, busy: true, testId: 'tip-verb' },
    });
    const verb = button('tip-verb');
    expect(verb?.getAttribute('aria-busy')).toBe('true');
    expect(verb?.getAttribute('aria-disabled')).toBe('true');
    act(() => verb?.click());
    expect(onClick).not.toHaveBeenCalled();
    expect(button('tip-got-it')).toBeNull();
    act(() => button('tip-dismiss')?.click());
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('omits the inline action row when there is nothing to put in it', () => {
    render({ placement: 'inline', dismissLabel: null });
    const tip = container.querySelector('[data-testid="tip"]');
    expect(tip?.querySelectorAll('button')).toHaveLength(1);
    expect(tip?.querySelector('.mt-2\\.5')).toBeNull();
  });

  it('preserves a notice action label and pending feedback until it settles', () => {
    const onClick = jest.fn();
    const action = {
      label: 'Plan first',
      ariaLabel: 'Plan before applying changes',
      busyText: 'Starting plan…',
      testId: 'tip-verb',
      onClick,
    };
    const onDismiss = render({
      appearance: 'notice',
      action: { ...action, busy: true },
    });
    const verb = button('tip-verb');
    expect(verb?.getAttribute('aria-label')).toBe(action.ariaLabel);
    expect(verb?.getAttribute('aria-busy')).toBe('true');
    expect(verb?.getAttribute('aria-disabled')).toBe('true');
    expect(verb?.textContent).toBe('Starting plan…');
    act(() => verb?.click());
    expect(onClick).not.toHaveBeenCalled();
    act(() => button('tip-dismiss')?.click());
    expect(onDismiss).toHaveBeenCalledTimes(1);
    render({ appearance: 'notice', action: { ...action, busy: false } });
    expect(button('tip-verb')?.textContent).toBe('Plan first');
    expect(button('tip-verb')?.getAttribute('aria-busy')).toBeNull();
    act(() => button('tip-verb')?.click());
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
