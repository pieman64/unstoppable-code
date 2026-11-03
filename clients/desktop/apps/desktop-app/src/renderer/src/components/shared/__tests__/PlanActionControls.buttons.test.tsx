/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { buttonClassName } from '@canopy/ui-shared/components';
import { PlanActionControls } from '../PlanActionControls';

function controls(executeDisabled = false): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(
    <PlanActionControls
      dataTestIdPrefix="plan"
      planContent="1. Replace the fixed wait."
      onExplore={jest.fn()}
      onImplement={jest.fn()}
      onPipeline={jest.fn()}
      onShare={jest.fn()}
      executeDisabled={executeDisabled}
    />,
  );
  return host;
}

function classesOf(host: HTMLElement, testId: string): DOMTokenList {
  const element = host.querySelector(`[data-testid="${testId}"]`);
  if (!element) throw new Error(`Missing ${testId}`);
  return element.classList;
}

describe('PlanActionControls buttons', () => {
  it('keeps portaled overflow retries keyboard-operable after Execute becomes Open', () => {
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const implement = jest.fn();
    const button = (testId: string): HTMLButtonElement => {
      const found = document.querySelector<HTMLButtonElement>(
        `[data-testid="${testId}"]`,
      );
      if (!found) throw new Error(`Missing ${testId}`);
      return found;
    };
    const press = (key: string): void => {
      act(() => {
        document.activeElement?.dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true }),
        );
      });
    };
    const explore = jest.fn();
    const pipeline = jest.fn();
    const open = jest.fn();
    try {
      act(() =>
        root.render(
          <PlanActionControls
            dataTestIdPrefix="plan"
            planContent="Implement the plan."
            onExplore={explore}
            onImplement={implement}
            onPipeline={pipeline}
            primaryAction="execute"
            openVenue="chat"
            onOpen={open}
          />,
        ),
      );
      expect(button('plan-execute')).toBeDefined();
      act(() =>
        root.render(
          <PlanActionControls
            dataTestIdPrefix="plan"
            planContent="Implement the plan."
            onExplore={explore}
            onImplement={implement}
            onPipeline={pipeline}
            primaryAction="open"
            openVenue="chat"
            onOpen={open}
          />,
        ),
      );
      const trigger = button('plan-more');
      act(() => trigger.focus());
      press('ArrowDown');
      expect(document.activeElement).toBe(button('plan-execute-pipeline'));
      press('ArrowDown');
      expect(document.activeElement).toBe(button('plan-execute-implement'));
      press('Escape');
      expect(document.querySelector('[role="menu"]')).toBeNull();
      expect(document.activeElement).toBe(trigger);
      press('ArrowUp');
      expect(document.activeElement).toBe(button('plan-execute-implement'));
      act(() => button('plan-execute-implement').click());
      expect(implement).toHaveBeenCalledTimes(1);
      expect(document.querySelector('[role="menu"]')).toBeNull();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('uses the shared compact buttons: Explore and Share secondary, Execute primary', () => {
    const host = controls();
    for (const [testId, variant] of [
      ['plan-explore', 'secondary'],
      ['plan-share', 'secondary'],
      ['plan-execute', 'primary'],
    ] as const) {
      const classes = classesOf(host, testId);
      for (const cls of buttonClassName({ variant, size: 'compact' })
        .split(' ')
        .filter(Boolean)) {
        expect(classes.contains(cls)).toBe(true);
      }
    }
    expect(classesOf(host, 'plan-execute').contains('bg-accent')).toBe(true);
    expect(classesOf(host, 'plan-explore').contains('bg-accent')).toBe(false);
    expect(host.textContent).toContain('Explore');
    expect(host.textContent).toContain('Execute');
  });

  it('turns Execute secondary while the plan cannot run', () => {
    expect(
      classesOf(controls(true), 'plan-execute').contains('bg-accent'),
    ).toBe(false);
  });

  it('renders the Execute menu in the action-menu look: small text, tertiary icons', () => {
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
    if (typeof globalThis.ResizeObserver === 'undefined') {
      class NoopResizeObserver {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      }
      Reflect.set(globalThis, 'ResizeObserver', NoopResizeObserver);
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      act(() =>
        root.render(
          <PlanActionControls
            dataTestIdPrefix="plan"
            planContent="1. Replace the fixed wait."
            onExplore={jest.fn()}
            onImplement={jest.fn()}
            onPipeline={jest.fn()}
          />,
        ),
      );
      act(() =>
        container
          .querySelector<HTMLButtonElement>('[data-testid="plan-execute"]')
          ?.click(),
      );
      // Copy plan moved beside Share (CAN-5354); the menu no longer has it.
      expect(container.querySelector('[data-testid="plan-execute-copy"]')).toBe(
        null,
      );
      expect(
        container
          .querySelector('[data-testid="plan-copy"]')
          ?.getAttribute('aria-label'),
      ).toBe('Copy plan');
      for (const testId of [
        'plan-execute-pipeline',
        'plan-execute-implement',
      ]) {
        // The menu portals to the document body.
        const row = document.body.querySelector(`[data-testid="${testId}"]`);
        expect(row?.classList.contains('text-xs')).toBe(true);
        expect(
          row
            ?.querySelector('span[aria-hidden="true"]')
            ?.classList.contains('fg-tertiary'),
        ).toBe(true);
      }
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
