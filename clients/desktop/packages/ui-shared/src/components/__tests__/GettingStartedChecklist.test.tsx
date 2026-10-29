/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { GettingStartedChecklist } from '../GettingStartedChecklist';
import { GettingStartedSidebarTile } from '../GettingStartedSidebarTile';
import {
  OnboardingChoiceTile,
  onboardingChoiceTileClassName,
} from '../OnboardingChoiceTile';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('GettingStartedChecklist', () => {
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

  function heading(): HTMLElement {
    const title = container.querySelector('h2');
    if (!title?.parentElement) throw new Error('heading row missing');
    return title.parentElement;
  }

  it('matches the desktop shell: title, progress and arrows share one row above the body', () => {
    act(() => {
      root.render(
        <GettingStartedChecklist
          title="What best describes your work?"
          currentStep={1}
          totalSteps={6}
          completed={false}
          onSkip={() => {}}
        >
          <p data-testid="body">Body</p>
        </GettingStartedChecklist>,
      );
    });
    const row = heading();
    const title = row.querySelector('h2');
    expect(title?.textContent).toBe('What best describes your work?');
    expect(title?.className).toContain('text-m');
    expect(title?.className).toContain('font-medium');
    expect(title?.className).toContain('fg-primary');
    const progress = row.querySelector('[aria-label="Step 1 of 6"]');
    expect(progress?.textContent).toBe('1/6');
    expect(progress?.className).toContain('tabular-nums');
    expect(progress?.className).toContain('fg-tertiary');
    expect(
      row.querySelectorAll('[data-checklist-navigation="true"]'),
    ).toHaveLength(2);
    // No eyebrow label row: the step title is the heading, as on desktop.
    expect(container.textContent).not.toContain('Getting started');
    expect(container.querySelector('section')?.getAttribute('aria-label')).toBe(
      'Getting started',
    );
    const body = container.querySelector('[data-testid="body"]');
    if (!body) throw new Error('body missing');
    expect(
      row.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(container.textContent).not.toContain('Completed');
  });

  it("relabels the forward arrow Next with the step's own action, keeping Back", () => {
    const onBack = jest.fn();
    const onSkip = jest.fn();
    const onNext = jest.fn();
    act(() => {
      root.render(
        <GettingStartedChecklist
          title="Connect your tools"
          currentStep={2}
          totalSteps={6}
          completed={false}
          onBack={onBack}
          onSkip={onSkip}
          next={{ onClick: onNext }}
        />,
      );
    });
    const row = heading();
    const back = row.querySelector<HTMLButtonElement>(
      '[data-testid="web-onboarding-skip-previous"]',
    );
    expect(back?.disabled).toBe(false);
    act(() => back?.click());
    expect(onBack).toHaveBeenCalledTimes(1);
    // One way forward: the arrow keeps its id and relabels to Next.
    const arrow = row.querySelector<HTMLButtonElement>(
      '[data-testid="web-onboarding-skip"]',
    );
    expect(arrow?.getAttribute('aria-label')).toBe('Next');
    expect(arrow?.getAttribute('title')).toBe('Next');
    expect(arrow?.querySelector('svg')).not.toBeNull();
    expect(arrow?.hasAttribute('data-checklist-dismiss')).toBe(false);
    expect(
      row.querySelectorAll('[data-checklist-navigation="true"]'),
    ).toHaveLength(2);
    expect(
      Array.from(row.querySelectorAll('button')).some(
        (button) => button.textContent?.trim() === 'Next',
      ),
    ).toBe(false);
    act(() => arrow?.click());
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onSkip).not.toHaveBeenCalled();
  });

  it('shows a disabled Saving… arrow under the next test id while the action is pending', () => {
    const onNext = jest.fn();
    act(() => {
      root.render(
        <GettingStartedChecklist
          title="What best describes your work?"
          currentStep={1}
          totalSteps={6}
          completed={false}
          onSkip={() => {}}
          next={{
            onClick: onNext,
            testId: 'web-onboarding-next',
            label: 'Saving…',
            disabled: true,
          }}
        />,
      );
    });
    expect(
      container.querySelector('[data-testid="web-onboarding-skip"]'),
    ).toBeNull();
    const arrow = container.querySelector<HTMLButtonElement>(
      '[data-testid="web-onboarding-next"]',
    );
    expect(arrow?.getAttribute('aria-label')).toBe('Saving…');
    expect(arrow?.disabled).toBe(true);
    act(() => arrow?.click());
    expect(onNext).not.toHaveBeenCalled();
  });

  it('takes the Next label from the action, not the completed relabel', () => {
    act(() => {
      root.render(
        <GettingStartedChecklist
          title="Connect your tools"
          currentStep={2}
          totalSteps={6}
          completed
          onSkip={() => {}}
          next={{ onClick: () => {}, label: 'Continue' }}
        />,
      );
    });
    const arrow = container.querySelector(
      '[data-testid="web-onboarding-skip"]',
    );
    expect(arrow?.getAttribute('aria-label')).toBe('Continue');
    expect(arrow?.getAttribute('title')).toBe('Continue');
  });

  it('drops the heading inset for a flush tile body and takes host placement only', () => {
    act(() => {
      root.render(
        <GettingStartedChecklist
          title="What best describes your work?"
          currentStep={1}
          totalSteps={6}
          completed={false}
          headingInset={false}
          className="mx-4"
          onSkip={() => {}}
        />,
      );
    });
    expect(heading().className).toContain('px-0');
    expect(heading().className).not.toContain('px-4');
    const section = container.querySelector('section');
    expect(section?.className).toContain('mx-4');
    expect(section?.className).not.toContain('w-full');
  });

  it('labels the arrow Next and exposes a hidden Completed state when the step is already complete', () => {
    act(() => {
      root.render(
        <GettingStartedChecklist
          title="Add a project"
          currentStep={2}
          totalSteps={6}
          completed
          titleId="step-title"
          onSkip={() => {}}
        />,
      );
    });
    expect(
      container
        .querySelector('[data-testid="web-onboarding-skip"]')
        ?.getAttribute('aria-label'),
    ).toBe('Next');
    const section = container.querySelector('section');
    expect(section?.getAttribute('data-completed')).toBe('true');
    const title = container.querySelector('h2');
    expect(title?.id).toBe('step-title');
    expect(title?.textContent).toBe('Add a project');
    const status = heading().querySelector(
      '[data-testid="web-onboarding-completed"]',
    );
    expect(status?.textContent).toBe('Completed');
    expect(status?.className).toContain('sr-only');
  });

  it('announces a step completing in place, and remounts the status silently on navigation', () => {
    const draw = (title: string, completed: boolean): void =>
      act(() => {
        root.render(
          <GettingStartedChecklist
            title={title}
            currentStep={2}
            totalSteps={6}
            completed={completed}
            onSkip={() => {}}
          />,
        );
      });
    const status = (): Element | null =>
      heading().querySelector('[data-testid="web-onboarding-completed"]');
    draw('Add a project', false);
    const live = status();
    expect(live?.getAttribute('aria-live')).toBe('polite');
    expect(live?.textContent).toBe('');
    // Same step, now complete: the same live node changes text, which is
    // what a screen reader announces.
    draw('Add a project', true);
    expect(status()).toBe(live);
    expect(live?.textContent).toBe('Completed');
    // Back to another already completed step: a new node, so no change is
    // announced on plain navigation.
    draw('Connect your tools', true);
    expect(status()).not.toBe(live);
    expect(status()?.textContent).toBe('Completed');
  });

  it('keeps Skip when no next action is given', () => {
    const onSkip = jest.fn();
    act(() => {
      root.render(
        <GettingStartedChecklist
          title="Connect your tools"
          currentStep={2}
          totalSteps={6}
          completed={false}
          next={undefined}
          onSkip={onSkip}
        />,
      );
    });
    const arrow = container.querySelector<HTMLButtonElement>(
      '[data-testid="web-onboarding-skip"]',
    );
    expect(arrow?.getAttribute('aria-label')).toBe('Skip');
    expect(arrow?.getAttribute('data-checklist-dismiss')).toBe('true');
    act(() => arrow?.click());
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('compact variant is the front card of a deck: title, sentence, action and a Skip ×', () => {
    const onActivate = jest.fn();
    const onSkip = jest.fn();
    act(() => {
      root.render(
        <GettingStartedChecklist
          compact
          title="Describe your work"
          description="Pick the roles that fit you."
          currentStep={1}
          totalSteps={6}
          completed={false}
          onActivate={onActivate}
          onSkip={onSkip}
        />,
      );
    });
    const section = container.querySelector<HTMLElement>(
      '[data-testid="sidebar-onboarding-checklist"]',
    );
    const card = section?.querySelector<HTMLElement>(
      '[data-testid="sidebar-onboarding-suggestion-row"]',
    );
    // A toast card's surface and corners; only the buttons highlight.
    expect(card?.className).toContain('bg-tertiary');
    expect(card?.className).toContain('rounded-2xl');
    expect(card?.className).not.toContain('hover:');
    const title = section?.querySelector<HTMLElement>(
      '[data-testid="sidebar-onboarding-suggestion-title"]',
    );
    expect(title?.textContent).toBe('Describe your work');
    expect(title?.parentElement?.className).toContain('fg-primary');
    const description = section?.querySelector<HTMLElement>(
      '[data-testid="sidebar-onboarding-suggestion-description"]',
    );
    expect(description?.textContent).toBe('Pick the roles that fit you.');
    expect(description?.parentElement?.className).toContain('fg-secondary');
    // The action hugs its label and names the step through the title.
    const cta = section?.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-onboarding-suggestion-cta"]',
    );
    expect(cta?.textContent).toBe('Start');
    expect(cta?.className.split(' ')).not.toContain('w-full');
    expect(cta?.getAttribute('aria-describedby')).toBe(title?.id);
    act(() => cta?.click());
    expect(onActivate).toHaveBeenCalledTimes(1);
    // A click on the card outside any button runs the action too.
    act(() => title?.click());
    expect(onActivate).toHaveBeenCalledTimes(2);
    const skip = section?.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-onboarding-skip"]',
    );
    // Skip is the × in the card's top-right corner, named for what it does.
    expect(skip?.getAttribute('aria-label')).toBe('Skip');
    expect(skip?.querySelector('svg')).not.toBeNull();
    expect(skip?.textContent).toBe('');
    act(() => skip?.click());
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledTimes(2);
    // No step count, dots or arrows: the steps to come peek out instead.
    expect(
      section?.querySelector('[data-testid="sidebar-onboarding-progress"]'),
    ).toBeNull();
    expect(section?.querySelector('h2')).toBeNull();
    expect(
      section?.querySelectorAll(
        '[data-testid="sidebar-onboarding-stack-card"]',
      ),
    ).toHaveLength(2);
  });

  it('peeks one card per step still to come, at most two, and relabels Skip Next once done', () => {
    const render = (currentStep: number, completed = false): void =>
      act(() => {
        root.render(
          <GettingStartedChecklist
            compact
            title="Take a tour"
            currentStep={currentStep}
            totalSteps={5}
            completed={completed}
            onSkip={() => {}}
          />,
        );
      });
    const peeking = (): number =>
      container.querySelectorAll(
        '[data-testid="sidebar-onboarding-stack-card"]',
      ).length;
    render(4);
    expect(peeking()).toBe(1);
    render(5, true);
    expect(peeking()).toBe(0);
    expect(
      container
        .querySelector('[data-testid="sidebar-onboarding-skip"]')
        ?.getAttribute('aria-label'),
    ).toBe('Next');
  });

  it('slides the skipped card away while the next one comes forward', () => {
    jest.useFakeTimers();
    try {
      const render = (entryId: string, title: string): void =>
        act(() => {
          root.render(
            <GettingStartedSidebarTile
              entryId={entryId}
              title={title}
              upcoming={2}
              onSkip={() => {}}
            />,
          );
        });
      render('import-projects', 'Import projects');
      expect(
        container.querySelector(
          '[data-testid="sidebar-onboarding-leaving-card"]',
        ),
      ).toBeNull();
      render('github', 'Connect GitHub');
      const leaving = container.querySelector<HTMLElement>(
        '[data-testid="sidebar-onboarding-leaving-card"]',
      );
      // The old card keeps its copy, hidden from assistive tech and inert.
      expect(leaving?.textContent).toContain('Import projects');
      expect(leaving?.getAttribute('aria-hidden')).toBe('true');
      expect(leaving?.hasAttribute('inert')).toBe(true);
      expect(
        container.querySelector(
          '[data-testid="sidebar-onboarding-suggestion-title"]',
        )?.textContent,
      ).toBe('Connect GitHub');
      expect(
        container.querySelector(
          '[data-testid="sidebar-onboarding-suggestion-row"]',
        )?.className,
      ).toContain('getting-started-stack-enter');
      act(() => {
        jest.advanceTimersByTime(400);
      });
      expect(
        container.querySelector(
          '[data-testid="sidebar-onboarding-leaving-card"]',
        ),
      ).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    ['sidebar-onboarding-skip', 'Skip'],
    ['sidebar-onboarding-suggestion-cta', 'the action'],
  ])(
    'keeps keyboard focus on %s when %s brings the next card forward',
    (testId) => {
      const steps = [
        { entryId: 'import-projects', title: 'Import projects' },
        { entryId: 'github', title: 'Connect GitHub' },
      ];
      let index = 0;
      const render = (): void => {
        const step = steps[index];
        act(() => {
          root.render(
            <GettingStartedSidebarTile
              entryId={step?.entryId}
              title={step?.title}
              upcoming={1}
              onActivate={advance}
              onSkip={advance}
            />,
          );
        });
      };
      function advance(): void {
        index += 1;
        render();
      }
      render();
      const control = (): HTMLButtonElement | null =>
        container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
      const before = control();
      expect(before).toBeInstanceOf(HTMLButtonElement);
      act(() => {
        before?.focus();
      });
      act(() => {
        before?.click();
      });
      const after = control();
      expect(after).toBeInstanceOf(HTMLButtonElement);
      expect(after).not.toBe(before);
      expect(document.activeElement).toBe(after);
    },
  );

  it('keeps a busy sidebar tile inert', () => {
    const onActivate = jest.fn();
    act(() => {
      root.render(
        <GettingStartedSidebarTile
          title="Connect your tools"
          disabled
          onActivate={onActivate}
        />,
      );
    });
    act(() => {
      // The card itself, where a pointer click runs the action when idle.
      container
        .querySelector<HTMLElement>(
          '[data-testid="sidebar-onboarding-suggestion-title"]',
        )
        ?.click();
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="sidebar-onboarding-suggestion-cta"]',
        )
        ?.click();
    });
    expect(onActivate).not.toHaveBeenCalled();
  });
});

describe('OnboardingChoiceTile', () => {
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

  it('is a pressed toggle on the accent ring when selected and the quiet ring otherwise', () => {
    act(() => {
      root.render(
        <>
          <OnboardingChoiceTile selected onClick={() => {}}>
            Designer
          </OnboardingChoiceTile>
          <OnboardingChoiceTile
            selected={false}
            icon={<svg data-testid="tile-icon" />}
            onClick={() => {}}
          >
            Founder
          </OnboardingChoiceTile>
        </>,
      );
    });
    const [selected, idle] = Array.from(container.querySelectorAll('button'));
    expect(selected?.getAttribute('aria-pressed')).toBe('true');
    expect(selected?.className).toContain('ring-line-accent');
    expect(selected?.className).toContain('bg-accent-subtle');
    expect(idle?.getAttribute('aria-pressed')).toBe('false');
    expect(idle?.className).toContain('ring-line-base');
    expect(idle?.className).toContain('bg-secondary');
    expect(idle?.querySelector('[data-testid="tile-icon"]')).not.toBeNull();
    // The option form is the desktop role tile: compact, text only, and the
    // weight does not change with selection, so toggling causes no reflow.
    expect(selected?.className).not.toContain('min-h-10');
    expect(selected?.className).not.toContain('font-medium');
    expect(selected?.className).toBe(
      idle?.className.replace(
        'ring-line-base bg-secondary fg-secondary hover:bg-subtle hover:fg-primary disabled:opacity-60',
        'ring-line-accent bg-accent-subtle fg-primary hover:bg-accent-subtle/80',
      ),
    );
    expect(onboardingChoiceTileClassName(true)).toBe(selected?.className);
    expect(onboardingChoiceTileClassName(false)).toBe(idle?.className);
  });

  it('tool form reads at the 40px row height with a medium label and a boxed logo', () => {
    act(() => {
      root.render(
        <OnboardingChoiceTile
          selected
          variant="tool"
          icon={<svg data-testid="tool-logo" />}
          trailing={<svg data-testid="tool-check" />}
          onClick={() => {}}
        >
          GitHub
        </OnboardingChoiceTile>,
      );
    });
    const tile = container.querySelector('button');
    expect(tile?.className).toContain('min-h-10');
    expect(tile?.className).toContain('font-medium');
    expect(tile?.className).toContain('ring-line-accent');
    expect(
      tile?.querySelector('[data-testid="tool-logo"]')?.parentElement
        ?.className,
    ).toContain('h-5 w-5');
    expect(tile?.querySelector('[data-testid="tool-check"]')).not.toBeNull();
    expect(onboardingChoiceTileClassName(true, 'tool')).toBe(tile?.className);
  });
});
