/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { OnboardingNavigationControls } from '../OnboardingNavigationControls';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('OnboardingNavigationControls', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function forward(testId: string): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>(
      `[data-testid="${testId}"]`,
    );
    if (!button) throw new Error(`${testId} missing`);
    return button;
  }

  it('renders a Skip arrow that dismisses by default', () => {
    const onSkip = jest.fn();
    act(() => {
      root.render(
        <OnboardingNavigationControls
          previousDisabled={false}
          skipLabel="Skip roles"
          testId="nav"
          onPrevious={() => {}}
          onSkip={onSkip}
        />,
      );
    });
    const arrow = forward('nav');
    expect(arrow.getAttribute('aria-label')).toBe('Skip roles');
    expect(arrow.getAttribute('title')).toBe('Skip');
    expect(arrow.getAttribute('data-checklist-dismiss')).toBe('true');
    expect(arrow.getAttribute('data-checklist-navigation')).toBe('true');
    expect(arrow.hasAttribute('data-checklist-next')).toBe(false);
    act(() => arrow.click());
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('relabels the same arrow Next without adding a second control', () => {
    const onSkip = jest.fn();
    const onNext = jest.fn();
    act(() => {
      root.render(
        <OnboardingNavigationControls
          previousDisabled={false}
          skipLabel="Skip roles"
          testId="nav"
          onPrevious={() => {}}
          onSkip={onSkip}
          next={{ onClick: onNext, testId: 'nav-next' }}
        />,
      );
    });
    expect(container.querySelector('[data-testid="nav"]')).toBeNull();
    expect(container.querySelectorAll('button')).toHaveLength(2);
    const arrow = forward('nav-next');
    expect(arrow.getAttribute('aria-label')).toBe('Next');
    expect(arrow.getAttribute('title')).toBe('Next');
    expect(arrow.getAttribute('data-checklist-next')).toBe('true');
    expect(arrow.getAttribute('data-checklist-navigation')).toBe('true');
    expect(arrow.hasAttribute('data-checklist-dismiss')).toBe(false);
    expect(arrow.querySelector('svg')).not.toBeNull();
    expect(arrow.className).not.toContain('bg-accent');
    expect(arrow.className).toBe(forward('nav-previous').className);
    act(() => arrow.click());
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onSkip).not.toHaveBeenCalled();
  });

  it('honors a disabled Next arrow', () => {
    const onNext = jest.fn();
    act(() => {
      root.render(
        <OnboardingNavigationControls
          previousDisabled
          skipLabel="Skip"
          testId="nav"
          onPrevious={() => {}}
          onSkip={() => {}}
          next={{ onClick: onNext, label: 'Saving…', disabled: true }}
        />,
      );
    });
    const arrow = forward('nav');
    expect(arrow.disabled).toBe(true);
    expect(arrow.getAttribute('aria-label')).toBe('Saving…');
    act(() => arrow.click());
    expect(onNext).not.toHaveBeenCalled();
  });
});
