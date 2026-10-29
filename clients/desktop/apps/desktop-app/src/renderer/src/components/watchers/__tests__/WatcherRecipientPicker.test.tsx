/**
 * @jest-environment jsdom
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  WatcherRecipientPicker,
  type WatcherRecipientGroup,
} from '@/components/watchers/WatcherRecipientPicker';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  type AppAdvisorWatcherDestination,
} from '@canopy/desktop-shared/types';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const groups: WatcherRecipientGroup[] = [
  {
    key: 'app-advisor',
    label: 'App Advisor',
    options: [
      {
        label: 'Advisor One',
        destination: {
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: APP_ADVISOR_WORKTREE_ID,
          chatId: 'advisor-1',
        },
      },
    ],
  },
  {
    key: 'worktree',
    label: 'This worktree',
    options: [
      {
        label: 'Worktree Chat',
        destination: {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'wt-chat-1',
        },
      },
    ],
  },
];

describe('WatcherRecipientPicker', () => {
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
    // The menu is portaled to document.body; clean up any lingering nodes.
    document
      .querySelectorAll('[data-testid="watcher-recipient-picker-menu"]')
      .forEach((node) => node.remove());
  });

  function trigger(): HTMLButtonElement {
    const el = container.querySelector<HTMLButtonElement>(
      '[data-testid="watcher-recipient-picker-trigger"]',
    );
    if (!el) throw new Error('trigger not found');
    return el;
  }

  it('opens grouped options and reports the chosen destination', () => {
    const onChange = jest.fn<void, [AppAdvisorWatcherDestination]>();
    act(() => {
      root.render(
        createElement(WatcherRecipientPicker, {
          groups,
          value: null,
          onChange,
        }),
      );
    });

    // Closed by default — the portaled menu is absent.
    expect(
      document.body.querySelector(
        '[data-testid="watcher-recipient-picker-menu"]',
      ),
    ).toBeNull();

    act(() => {
      trigger().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // Both groups' options are rendered in the portaled menu.
    const worktreeOption = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="watcher-recipient-picker-option-wt-chat-1"]',
    );
    expect(
      document.body.querySelector(
        '[data-testid="watcher-recipient-picker-option-advisor-1"]',
      ),
    ).not.toBeNull();
    expect(worktreeOption).not.toBeNull();

    act(() => {
      worktreeOption?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'wt-chat-1',
    });
    // Menu closes after selection.
    expect(
      document.body.querySelector(
        '[data-testid="watcher-recipient-picker-menu"]',
      ),
    ).toBeNull();
  });

  it('disables the trigger when there are no options', () => {
    act(() => {
      root.render(
        createElement(WatcherRecipientPicker, {
          groups: [{ key: 'app-advisor', label: 'App Advisor', options: [] }],
          value: null,
          onChange: jest.fn(),
        }),
      );
    });
    expect(trigger().disabled).toBe(true);
  });

  it('renders the selected group icon before the label on the trigger', () => {
    act(() => {
      root.render(
        createElement(WatcherRecipientPicker, {
          groups,
          value: {
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            chatId: 'wt-chat-1',
          },
          onChange: jest.fn(),
        }),
      );
    });

    const el = trigger();
    // Two SVGs: the leading group icon plus the chevron.
    expect(el.querySelectorAll('svg').length).toBe(2);
    expect(el.textContent).toContain('Worktree Chat');

    // The leading icon precedes the label within the same flex span.
    const labelRow = el.querySelector('span.flex.items-center');
    expect(labelRow?.querySelector('svg')).not.toBeNull();
  });

  it('renders a group icon in every group header when open', () => {
    act(() => {
      root.render(
        createElement(WatcherRecipientPicker, {
          groups,
          value: null,
          onChange: jest.fn(),
        }),
      );
    });
    act(() => {
      trigger().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const headers = Array.from(
      document.body.querySelectorAll(
        '[data-testid="watcher-recipient-picker-menu"] .text-3xs',
      ),
    );
    expect(headers.length).toBe(2);
    for (const header of headers) {
      expect(header.querySelector('svg')).not.toBeNull();
    }
  });

  it('labels the listbox and closes it from the focused trigger with Escape', () => {
    act(() => {
      root.render(
        createElement(WatcherRecipientPicker, {
          groups,
          value: null,
          onChange: jest.fn(),
        }),
      );
    });
    act(() => {
      trigger().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const menu = document.body.querySelector(
      '[data-testid="watcher-recipient-picker-menu"]',
    );
    expect(menu?.getAttribute('role')).toBe('listbox');
    expect(menu?.getAttribute('aria-label')).toBe('Watcher recipient');

    act(() => {
      trigger().dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    expect(
      document.body.querySelector(
        '[data-testid="watcher-recipient-picker-menu"]',
      ),
    ).toBeNull();
  });
});
