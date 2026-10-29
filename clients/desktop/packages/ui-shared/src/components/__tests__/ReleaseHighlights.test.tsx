/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReleaseNotesEntry } from '@canopy/protocol/release-notes';
import { ReleaseHighlightsDialog } from '../ReleaseHighlightsDialog';
import { ReleaseHighlightsList } from '../ReleaseHighlightsList';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const activeRoots: Root[] = [];

function render(node: JSX.Element): Root {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  activeRoots.push(root);
  act(() => {
    root.render(node);
  });
  return root;
}

function byTestId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.querySelector<T>(`[data-testid="${id}"]`);
}

function requireTestId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = byTestId<T>(id);
  if (!el) throw new Error(`${id} not found`);
  return el;
}

const ENTRY: ReleaseNotesEntry = {
  version: '1.9.0',
  headline: 'More ways to start work.',
  highlights: [
    { title: 'Start a task from a link', description: 'Paste a link.' },
    { title: 'Preview tickets in chat' },
    { title: 'Open sooner', description: 'Faster first window.' },
  ],
};

afterEach(() => {
  act(() => {
    while (activeRoots.length > 0) activeRoots.pop()?.unmount();
  });
  document.body.innerHTML = '';
});

describe('ReleaseHighlightsList', () => {
  it('renders list semantics with optional descriptions', () => {
    render(
      <ReleaseHighlightsList
        highlights={ENTRY.highlights}
        className="mt-4"
        dataTestId="list"
      />,
    );
    const list = requireTestId('list');
    expect(list.tagName).toBe('UL');
    expect(list.className).toContain('mt-4');
    const items = list.querySelectorAll(':scope > li');
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toBe('Start a task from a linkPaste a link.');
    // No empty secondary line when the description is absent.
    expect(items[1].querySelectorAll('span')).toHaveLength(1);
  });
});

describe('ReleaseHighlightsDialog', () => {
  it('names the dialog and shows the version, headline, and highlights', () => {
    render(
      <ReleaseHighlightsDialog
        appName="Canopy"
        entry={ENTRY}
        onClose={() => undefined}
      />,
    );
    const dialog = requireTestId('release-highlights-dialog');
    expect(dialog.getAttribute('role')).toBe('dialog');
    const labelId = dialog.getAttribute('aria-labelledby');
    expect(labelId).toBeTruthy();
    expect(document.getElementById(labelId ?? '')?.textContent).toBe(
      "What's new in Canopy",
    );
    expect(dialog.textContent).toContain('Version 1.9.0');
    expect(requireTestId('release-highlights-headline').textContent).toBe(
      'More ways to start work.',
    );
    expect(
      requireTestId('release-highlights-list').querySelectorAll('li'),
    ).toHaveLength(3);
  });

  it('omits the headline and full-notes action when absent', () => {
    render(
      <ReleaseHighlightsDialog
        appName="Canopy"
        entry={{ ...ENTRY, headline: undefined }}
        onClose={() => undefined}
      />,
    );
    expect(byTestId('release-highlights-headline')).toBeNull();
    expect(byTestId('release-highlights-full-notes')).toBeNull();
  });

  it('focuses Got it on open and closes through Got it, Escape, and backdrop', () => {
    const onClose = jest.fn();
    render(
      <ReleaseHighlightsDialog
        appName="Canopy"
        entry={ENTRY}
        onClose={onClose}
      />,
    );
    const gotIt = requireTestId<HTMLButtonElement>('release-highlights-got-it');
    expect(document.activeElement).toBe(gotIt);

    act(() => gotIt.click());
    expect(onClose).toHaveBeenCalledTimes(1);

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(onClose).toHaveBeenCalledTimes(2);

    const backdrop = requireTestId('release-highlights-dialog').parentElement;
    act(() => backdrop?.click());
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('restores focus to the opening control on close', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    const root = render(
      <ReleaseHighlightsDialog
        appName="Canopy"
        entry={ENTRY}
        onClose={() => undefined}
      />,
    );
    expect(document.activeElement).not.toBe(trigger);
    act(() => root.render(<></>));
    expect(document.activeElement).toBe(trigger);
  });

  it('renders a functional new-tab link when given only an href', () => {
    render(
      <ReleaseHighlightsDialog
        appName="Canopy"
        entry={ENTRY}
        onClose={() => undefined}
        fullNotesHref="https://example.test/changelog#v1-9-0"
      />,
    );
    const link = requireTestId('release-highlights-full-notes');
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe(
      'https://example.test/changelog#v1-9-0',
    );
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('invokes the host callback, stays open, and contains a rejection', async () => {
    const onClose = jest.fn();
    const onOpenFullNotes = jest.fn(() => Promise.reject(new Error('nope')));
    render(
      <ReleaseHighlightsDialog
        appName="Canopy"
        entry={ENTRY}
        onClose={onClose}
        fullNotesHref="https://example.test/changelog"
        onOpenFullNotes={onOpenFullNotes}
      />,
    );
    const action = requireTestId('release-highlights-full-notes');
    expect(action.tagName).toBe('BUTTON');
    await act(async () => {
      action.click();
      await Promise.resolve();
    });
    expect(onOpenFullNotes).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(byTestId('release-highlights-dialog')).not.toBeNull();
  });

  it('contains a synchronous host failure', () => {
    render(
      <ReleaseHighlightsDialog
        appName="Canopy"
        entry={ENTRY}
        onClose={() => undefined}
        onOpenFullNotes={() => {
          throw new Error('sync');
        }}
      />,
    );
    expect(() =>
      act(() => requireTestId('release-highlights-full-notes').click()),
    ).not.toThrow();
  });

  it('keeps actions outside the scrolling body for long content', () => {
    const highlights = Array.from({ length: 5 }, (_, i) => ({
      title: `Highlight ${i}`,
      description: 'A long description. '.repeat(40),
    }));
    render(
      <ReleaseHighlightsDialog
        appName="Canopy"
        entry={{ ...ENTRY, highlights }}
        onClose={() => undefined}
      />,
    );
    const list = requireTestId('release-highlights-list');
    const scroller = list.parentElement;
    expect(scroller?.className).toContain('overflow-y-auto');
    expect(scroller?.contains(requireTestId('release-highlights-got-it'))).toBe(
      false,
    );
  });
});
