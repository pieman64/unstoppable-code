/**
 * @jest-environment jsdom
 */
/**
 * Unit coverage for the portal {@link PortalDirectoryPicker} (CAN-1216). The
 * picker's trigger reuses the shared composer chip; the popup is an ARIA
 * listbox. Selecting the workspace root reports `undefined` (matching desktop),
 * and selecting a child repo reports its id — the value carried inline on the
 * next `portal.chat.send` as `selectedRepoId`.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PortalDirectoryPicker } from '../PortalDirectoryPicker';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const childRepos = [
  { id: 'repo-a', name: 'API' },
  { id: 'repo-b', name: 'Web' },
];

describe('PortalDirectoryPicker', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function mount(
    currentRepoId: string | undefined,
    onSelect: (repoId: string | undefined) => void,
    disabled = false,
  ): void {
    act(() => {
      root.render(
        <PortalDirectoryPicker
          currentRepoId={currentRepoId}
          childRepos={childRepos}
          onSelect={onSelect}
          disabled={disabled}
        />,
      );
    });
  }

  function click(el: Element | null): void {
    act(() => {
      el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  it('draws the capsule chip with a 14px folder glyph like desktop', () => {
    mount('repo-a', () => {});
    const trigger = container.querySelector(
      '[data-testid="portal-chat-directory-picker"]',
    );
    // The app `FolderIcon` desktop's `DirectoryPicker` draws, at the
    // capsule's 16px box (app icons size through their inline style).
    const glyph = trigger?.querySelector('[data-app-icon="true"]');
    expect(glyph).not.toBeNull();
    expect(glyph?.getAttribute('style')).toContain('width: 14px');
    expect(glyph?.getAttribute('style')).toContain('height: 14px');
  });

  it('labels the trigger with the selected repo name and opens the listbox', () => {
    mount('repo-a', () => {});
    const trigger = container.querySelector(
      '[data-testid="portal-chat-directory-picker"]',
    );
    expect(trigger?.textContent).toContain('API');
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    // No menu until opened.
    expect(
      document.querySelector('[data-testid="portal-chat-directory-menu"]'),
    ).toBeNull();

    click(trigger);
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    const menu = document.querySelector(
      '[data-testid="portal-chat-directory-menu"]',
    );
    const options = document.querySelectorAll(
      '[data-testid="portal-chat-directory-option"]',
    );
    // Workspace root + two child repos.
    expect(options).toHaveLength(3);
    expect(container.contains(menu)).toBe(false);
    expect(menu?.className).toContain('canopy-floating-menu');
    expect(menu?.className).toContain('bg-quaternary');
    expect(options[0]?.className).toContain('h-8');
    expect(document.activeElement).toBe(options[1]);
  });

  it('reports undefined when the project root is selected', () => {
    const picks: Array<string | undefined> = [];
    mount('repo-a', (repoId) => picks.push(repoId));
    click(
      document.querySelector('[data-testid="portal-chat-directory-picker"]'),
    );
    const options = Array.from(
      document.querySelectorAll('[data-testid="portal-chat-directory-option"]'),
    );
    const rootOption = options.find((o) =>
      o.textContent?.includes('Project root'),
    );
    click(rootOption ?? null);
    expect(picks).toEqual([undefined]);
  });

  it('reports the child repo id when a child is selected', () => {
    const picks: Array<string | undefined> = [];
    mount(undefined, (repoId) => picks.push(repoId));
    click(
      document.querySelector('[data-testid="portal-chat-directory-picker"]'),
    );
    const options = Array.from(
      document.querySelectorAll('[data-testid="portal-chat-directory-option"]'),
    );
    const web = options.find((o) => o.textContent?.includes('Web'));
    click(web ?? null);
    expect(picks).toEqual(['repo-b']);
  });

  it('consumes Escape (preventDefault) so it does not close the surrounding drawer', () => {
    mount('repo-a', () => {});
    click(
      document.querySelector('[data-testid="portal-chat-directory-picker"]'),
    );
    expect(
      document.querySelector('[data-testid="portal-chat-directory-menu"]'),
    ).not.toBeNull();

    const escape = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      document.dispatchEvent(escape);
    });
    // The picker handled and consumed the Escape, so an ancestor drawer's
    // `useOverlayEscape` (which ignores a defaultPrevented Escape) stays open.
    expect(escape.defaultPrevented).toBe(true);
    expect(
      document.querySelector('[data-testid="portal-chat-directory-menu"]'),
    ).toBeNull();
  });

  it('is locked (non-interactive) once the chat session has started', () => {
    const picks: Array<string | undefined> = [];
    mount('repo-a', (repoId) => picks.push(repoId), true);
    const trigger = container.querySelector<HTMLElement>(
      '[data-testid="portal-chat-directory-picker"]',
    );
    // Disabled trigger: no popup affordance, and a lock tooltip. The tooltip
    // is the shared rich `Tooltip` (never a native `title`, CAN-2799); it is
    // reached by hovering its wrapper, since a disabled button cannot focus.
    expect(trigger?.hasAttribute('disabled')).toBe(true);
    expect(trigger?.hasAttribute('aria-haspopup')).toBe(false);
    expect(trigger?.hasAttribute('title')).toBe(false);
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    act(() => {
      trigger?.parentElement?.dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true }),
      );
    });
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(
      'locked',
    );
    act(() => {
      trigger?.parentElement?.dispatchEvent(
        new MouseEvent('mouseout', { bubbles: true }),
      );
    });
    // Clicking must not open the listbox or emit a selection.
    click(trigger);
    expect(
      document.querySelector('[data-testid="portal-chat-directory-menu"]'),
    ).toBeNull();
    expect(picks).toEqual([]);
    // The label still reflects the locked working directory.
    expect(trigger?.textContent).toContain('API');
  });
});
