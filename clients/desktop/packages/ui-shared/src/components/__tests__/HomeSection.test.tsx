/** @jest-environment jsdom */
import { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { HomeSection, HomeSections } from '../HomeSection';

/** Opens the section's ••• menu and picks Hide section. */
function clickHideSection(root: ParentNode = document): void {
  const trigger = root.querySelector<HTMLButtonElement>(
    '[data-testid^="home-section-more-"]',
  );
  if (!trigger) throw new Error('Missing section menu');
  trigger.focus();
  act(() => trigger.click());
  const menu = document.getElementById(
    trigger.getAttribute('aria-controls') ?? '',
  );
  const hide = menu?.querySelector<HTMLElement>(
    '[data-testid^="home-section-hide-"]',
  );
  if (!hide) throw new Error('Missing Hide section');
  act(() => hide.click());
}
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

describe('Home setup sections', () => {
  it('reports visible state through hide, restore and unmount', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const onVisibilityChange = jest.fn();
    act(() =>
      root.render(
        <HomeSections>
          <HomeSection
            sectionId="continue"
            title="Continue"
            onVisibilityChange={onVisibilityChange}
          >
            <span>Continue content</span>
          </HomeSection>
        </HomeSections>,
      ),
    );
    expect(onVisibilityChange).toHaveBeenLastCalledWith(true);
    clickHideSection(container);
    expect(onVisibilityChange).toHaveBeenLastCalledWith(false);
    const restore = container.querySelector<HTMLButtonElement>('button');
    if (!restore) throw new Error('Missing restore control');
    act(() => restore.click());
    expect(onVisibilityChange).toHaveBeenLastCalledWith(true);
    act(() => root.unmount());
    expect(onVisibilityChange).toHaveBeenLastCalledWith(false);
  });
  it('restores focus to an available section without stealing it on later remounts', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const fallback = createRef<HTMLButtonElement>();
    const render = (showRecent: boolean, showSuggestions = true): void => {
      act(() =>
        root.render(
          <>
            <button ref={fallback}>Composer action</button>
            <HomeSections fallbackFocusRef={fallback}>
              {showRecent && (
                <HomeSection sectionId="recent" title="Continue">
                  Recent work
                </HomeSection>
              )}
              {showSuggestions && (
                <HomeSection sectionId="suggestions" title="Suggestions">
                  Ideas
                </HomeSection>
              )}
            </HomeSections>
          </>,
        ),
      );
    };
    render(true);
    clickHideSection(container);
    render(false);
    const restore = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.startsWith('Show hidden sections'),
    );
    if (!restore) throw new Error('Missing restore action');
    act(() => restore.click());
    expect(document.activeElement).toBe(container.querySelector('h2'));
    const composerAction = container.querySelector('button');
    composerAction?.focus();
    render(true);
    expect(document.activeElement).toBe(composerAction);
    clickHideSection(container);
    render(false, false);
    const restoreEmpty = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.startsWith('Show hidden sections'),
    );
    if (!restoreEmpty) throw new Error('Missing empty-state restore action');
    act(() => restoreEmpty.click());
    expect(document.activeElement).toBe(composerAction);
    act(() => root.unmount());
    container.remove();
  });
  it.each([true, false])(
    'keeps focus through hide/restore (grouped: %s)',
    (grouped) => {
      const container = document.createElement('div');
      document.body.append(container);
      const root = createRoot(container);
      const section = (
        <HomeSection sectionId="continue" title="Continue">
          Recent work
        </HomeSection>
      );
      act(() =>
        root.render(grouped ? <HomeSections>{section}</HomeSections> : section),
      );
      clickHideSection(container);
      const restore = container.querySelector<HTMLButtonElement>('button');
      expect(document.activeElement).toBe(restore);
      if (!restore) throw new Error('Missing restore action');
      act(() => restore.click());
      expect(document.activeElement).toBe(container.querySelector('h2'));
      act(() => root.unmount());
      container.remove();
    },
  );
  it('hides one section without completing or unmounting another, then restores it', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() =>
      root.render(
        <HomeSections>
          <HomeSection sectionId="providers" title="Providers">
            <span>Provider content</span>
          </HomeSection>
          <HomeSection sectionId="import" title="Import">
            <span>Import content</span>
          </HomeSection>
        </HomeSections>,
      ),
    );
    clickHideSection(container);
    expect(container.textContent).not.toContain('Provider content');
    expect(container.textContent).toContain('Import content');
    const restore = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Show hidden sections'),
    );
    if (!restore) throw new Error('Missing restore action');
    act(() => restore.click());
    expect(container.textContent).toContain('Provider content');
    expect(container.textContent).not.toContain('Show hidden sections');
    act(() => root.unmount());
  });
});
