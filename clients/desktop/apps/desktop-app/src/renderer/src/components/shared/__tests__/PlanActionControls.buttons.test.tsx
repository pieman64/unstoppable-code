/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
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
  it('uses the shared 28px control buttons: Explore and Share secondary, Execute primary', () => {
    const host = controls();
    for (const testId of ['plan-explore', 'plan-share', 'plan-execute']) {
      const classes = classesOf(host, testId);
      for (const cls of ['h-7', 'rounded-md', 'text-xs']) {
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
      for (const testId of [
        'plan-execute-pipeline',
        'plan-execute-implement',
        'plan-execute-copy',
      ]) {
        const row = container.querySelector(`[data-testid="${testId}"]`);
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
