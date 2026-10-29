/**
 * @jest-environment jsdom
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PanelSection as SharedPanelSection } from '@canopy/ui-shared/components';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { ActivitySectionChromeContext, PanelSection } from '..';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

/**
 * Session replay records a section's chrome and title. A section whose body
 * holds conversation, output, or file content blocks that body element
 * itself, below the title, so the section wrapper adds no block of its own.
 */
describe('PanelSection session replay', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function render(children: ReactNode): void {
    act(() => {
      root.render(children);
    });
  }

  function expectNoBlock(): void {
    expect(
      container.querySelector(`.${POSTHOG_REPLAY_BLOCK_CLASS}`),
    ).toBeNull();
  }

  it('records the frameless section root and body', () => {
    render(
      <ActivitySectionChromeContext.Provider value="frameless">
        <PanelSection icon={<svg />} title="Notes" subtitle="1 note">
          <p>Release checklist</p>
        </PanelSection>
      </ActivitySectionChromeContext.Provider>,
    );

    expect(
      container
        .querySelector('[data-activity-chrome="frameless"]')
        ?.className.split(' '),
    ).toEqual(['flex', 'h-full', 'min-h-0', 'flex-col']);
    expect(
      container.querySelector('[data-testid="frameless-section-body"]')
        ?.className,
    ).toBe('min-h-0 flex-1 overflow-y-auto px-3 pb-3');
    expectNoBlock();
  });

  it.each([
    [false, null],
    [true, 'overflow-hidden rounded-lg bg-tertiary shadow-sm'],
  ])(
    'records the body-only action card (showBodyWithActionCard=%s)',
    (showBodyWithActionCard, expected) => {
      render(
        <SharedPanelSection icon={<span />} title="Shared header">
          <ActivitySectionChromeContext.Provider value="body-only">
            <PanelSection
              icon={<svg />}
              title="Notes"
              hasExpandableContent={false}
              actionOnlyCard
              actionOnlyLabel="Add note"
              showBodyWithActionCard={showBodyWithActionCard}
              headerAction={<button type="button">Add</button>}
            >
              <p>Release checklist</p>
            </PanelSection>
          </ActivitySectionChromeContext.Provider>
        </SharedPanelSection>,
      );

      expect(
        container
          .querySelector('[data-testid="action-card-container"]')
          ?.getAttribute('class'),
      ).toBe(expected);
      expectNoBlock();
    },
  );

  it('records the card chrome section, title included', () => {
    render(
      <PanelSection icon={<svg />} title="Notes">
        <p data-testid="card-body">Release checklist</p>
      </PanelSection>,
    );

    const section = container.querySelector('section[data-collapsible]');
    expect(section).not.toBeNull();
    expect(section?.textContent).toContain('Notes');
    expectNoBlock();
  });
});
