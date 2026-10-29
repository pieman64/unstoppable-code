/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import type React from 'react';
import { createRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import {
  DetailActionBar,
  DetailActionSlotsProvider,
  DetailPageActions,
  useDetailActionSlots,
} from '../DetailActionBar';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

describe('DetailActionBar', () => {
  it('orders secondary actions, then Share, then the primary action', () => {
    const html = renderToString(
      <DetailActionBar
        primary={<button>Install</button>}
        share={<button>Share</button>}
        secondary={
          <>
            <button>Delete</button>
            <button>Edit</button>
          </>
        }
      />,
    );
    const labels = Array.from(html.matchAll(/<button>([^<]+)<\/button>/g)).map(
      (match) => match[1],
    );
    expect(labels).toEqual(['Delete', 'Edit', 'Share', 'Install']);
  });

  it('leaves Share rightmost when there is no primary action', () => {
    const html = renderToString(
      <DetailActionBar
        share={<button>Share</button>}
        secondary={<button>Update</button>}
      />,
    );
    expect(html.indexOf('Update')).toBeLessThan(html.indexOf('Share'));
    expect(html.trimEnd().endsWith('Share</button></div>')).toBe(true);
  });

  it('renders nothing without actions', () => {
    expect(renderToString(<DetailActionBar />)).toBe('');
  });
});

describe('DetailPageActions', () => {
  function Shell({ children }: { children: React.ReactNode }): JSX.Element {
    const slots = useDetailActionSlots();
    return (
      <>
        <DetailActionBar
          slots={slots}
          secondary={<button>Shell edit</button>}
          share={<button>Share</button>}
        />
        <main>
          <DetailActionSlotsProvider slots={slots}>
            {children}
          </DetailActionSlotsProvider>
        </main>
      </>
    );
  }

  it('renders body actions in the shell bar around its Share', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <Shell>
          <DetailPageActions
            secondary={<button>Delete</button>}
            primary={<button>Install</button>}
          />
          <p>Body</p>
        </Shell>,
      );
    });
    const bar = container.querySelector('[data-testid="detail-action-bar"]');
    expect(
      Array.from(bar?.querySelectorAll('button') ?? []).map(
        (button) => button.textContent,
      ),
    ).toEqual(['Shell edit', 'Delete', 'Share', 'Install']);
    expect(container.querySelector('main')?.querySelector('button')).toBeNull();
    act(() => root.unmount());
  });

  it('renders its own bar in place outside a shell', () => {
    const html = renderToString(
      <DetailPageActions
        share={<button>Share</button>}
        primary={<button>Add</button>}
      />,
    );
    expect(html).toContain('data-testid="detail-action-bar"');
    expect(html.indexOf('Share')).toBeLessThan(html.indexOf('Add'));
  });
});
