/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { IconShareAndroid } from '@canopy/ui-shared/icons/AppGlyphs.generated';
import { createRoot, type Root } from 'react-dom/client';
import type { ShareRunActionController } from '@/hooks/useShareRunAction';
import { ShareSessionControl } from '../ShareSessionControl';

let mockShareEntryVisible = true;

jest.mock('@/lib/share-targets', () => ({
  useTeamOrgShareEntryVisible: (): boolean => mockShareEntryVisible,
}));

jest.mock('@/hooks/useShareRunAction', () => ({
  useShareRunAction: (): ShareRunActionController => ({
    entryVisible: jest.fn(() => true),
    target: { chatId: 'chat-1', title: 'Session title' },
    open: jest.fn(),
    close: jest.fn(),
    submit: jest.fn(),
    checkEligibility: jest.fn(),
    onShared: jest.fn(),
  }),
}));

jest.mock('../ShareRunModal', () => ({
  ShareRunModal: (): ReactNode => (
    <div data-testid="share-run-modal">Share run</div>
  ),
}));

jest.mock('@/components/shared/ActionTooltip', () => ({
  ActionTooltip: ({ children }: { children: ReactNode }): ReactNode => children,
}));

describe('ShareSessionControl', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mockShareEntryVisible = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(variant: 'icon-button' | 'menu-item' = 'icon-button'): void {
    act(() => {
      root.render(
        <ShareSessionControl
          projectId="project-1"
          worktreeId="worktree-1"
          chatId="chat-1"
          title="Session title"
          hasMessages
          busy={false}
          variant={variant}
        />,
      );
    });
  }

  function pathData(element: Element | null): string[] {
    return Array.from(element?.querySelectorAll('path') ?? [], (path) =>
      path.getAttribute('d'),
    )
      .filter((d): d is string => d !== null)
      .sort();
  }

  const shareGlyphPaths = Array.from(
    renderToString(<IconShareAndroid />).matchAll(/ d="([^"]+)"/g),
    (match) => match[1],
  ).sort();

  it.each(['icon-button', 'menu-item'] as const)(
    'draws the shared share-nodes glyph as the %s',
    (variant) => {
      render(variant);
      const control = container.querySelector(
        '[data-testid="share-session-control"]',
      );
      expect(control).not.toBeNull();
      expect(pathData(control)).toEqual(shareGlyphPaths);
    },
  );

  it('gives every shared-session row an icon and ends with Unshare in its own group', () => {
    act(() => {
      root.render(
        <ShareSessionControl
          projectId="project-1"
          worktreeId="worktree-1"
          chatId="chat-1"
          title="Session title"
          hasMessages
          busy={false}
          variant="menu-item"
          sharedRun={{
            externalId: 'run-1',
            teamName: 'Core',
            shareScope: 'team',
            sharedAt: '2026-10-21T00:00:00.000Z',
          }}
        />,
      );
    });
    const children = Array.from(container.children).filter(
      (element) => element.getAttribute('data-testid') !== 'share-run-modal',
    );
    expect(
      children.map((element) =>
        element.getAttribute('role') === 'separator'
          ? 'divider'
          : (element.getAttribute('data-testid') ?? ''),
      ),
    ).toEqual([
      'share-session-control',
      'share-session-control-comments',
      'divider',
      'share-session-control-unshare',
    ]);
    for (const row of children.filter(
      (element) => element.getAttribute('role') === 'menuitem',
    )) {
      expect(row.firstElementChild?.querySelector('svg')).toBeInstanceOf(
        Element,
      );
    }
  });

  it('keeps an open share modal mounted when Personal hides its trigger', () => {
    render();
    expect(
      container.querySelector('[data-testid="share-session-control"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="share-run-modal"]'),
    ).not.toBeNull();

    mockShareEntryVisible = false;
    render();

    expect(
      container.querySelector('[data-testid="share-session-control"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="share-run-modal"]'),
    ).not.toBeNull();
  });
});
