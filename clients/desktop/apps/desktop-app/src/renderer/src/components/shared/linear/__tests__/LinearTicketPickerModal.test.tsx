/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import type { LinearTicketSearchResult } from '@canopy/desktop-shared/types';
import { LinearTicketPickerModal } from '../LinearTicketPickerModal';

describe('LinearTicketPickerModal stacking', () => {
  let container: HTMLElement;
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

  // The Home composer shell is transformed, which makes it a stacking
  // context. A modal rendered inside it cannot rise above later positioned
  // siblings such as the Getting started checklist rows.
  it('portals the dialog out of its host so ancestor stacking contexts cannot trap it', () => {
    container.style.transform = 'translateY(-50%)';
    act(() => {
      root.render(
        <LinearTicketPickerModal
          onSelect={() => undefined}
          onClose={() => undefined}
        />,
      );
    });

    const dialog = document.querySelector(
      '[data-testid="linear-ticket-picker"]',
    );
    if (!(dialog instanceof HTMLElement)) {
      throw new Error('Linear ticket picker not found');
    }

    expect(container.contains(dialog)).toBe(false);
    expect(dialog.parentElement?.parentElement).toBe(document.body);
  });

  it('records the picker card frame in session replay', () => {
    act(() => {
      root.render(
        <LinearTicketPickerModal
          onSelect={() => undefined}
          onClose={() => undefined}
        />,
      );
    });

    const card = document.querySelector('[data-testid="linear-ticket-picker"]');
    expect(card?.getAttribute('role')).toBe('dialog');
    expect(card?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBeNull();
    expect(card?.textContent).toContain('Search Linear tickets by id or title');
  });

  it('renders a result title as one whole text node', async () => {
    const title =
      'Aug 10. Can\u2019t reach the auth server after midnight on Windows';
    const result: LinearTicketSearchResult = {
      id: 'iss_1',
      identifier: 'CAN-1',
      title,
      description: null,
      url: 'https://linear.app/acme/issue/CAN-1',
      priority: 2,
      priorityLabel: 'High',
      branchName: 'can-1',
    };
    const api = Reflect.get(window, 'api');
    const scrollIntoView = Reflect.get(Element.prototype, 'scrollIntoView');
    Reflect.set(window, 'api', {
      searchLinearIssues: jest.fn().mockResolvedValue([result]),
    });
    Reflect.set(Element.prototype, 'scrollIntoView', () => undefined);
    jest.useFakeTimers();
    try {
      act(() => {
        root.render(
          <LinearTicketPickerModal
            onSelect={() => undefined}
            onClose={() => undefined}
          />,
        );
      });
      const input = document.querySelector(
        '[data-testid="linear-ticket-picker-input"]',
      );
      if (!(input instanceof HTMLInputElement)) {
        throw new Error('Linear ticket picker input not found');
      }
      act(() => {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )?.set?.call(input, 'auth');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(300);
      });

      const titleElement = document.querySelector(
        '[data-testid="linear-ticket-picker-result-title"]',
      );
      expect(titleElement?.className).toContain('truncate');
      expect(titleElement?.childNodes).toHaveLength(1);
      expect(titleElement?.firstChild?.nodeType).toBe(Node.TEXT_NODE);
      expect(titleElement?.firstChild?.textContent).toBe(title);
    } finally {
      jest.useRealTimers();
      Reflect.set(window, 'api', api);
      Reflect.set(Element.prototype, 'scrollIntoView', scrollIntoView);
    }
  });

  it('portals into the composer document when it is popped out', () => {
    const popOutDocument = document.implementation.createHTMLDocument();
    act(() => {
      root.render(
        <LinearTicketPickerModal
          onSelect={() => undefined}
          onClose={() => undefined}
          ownerDocument={popOutDocument}
        />,
      );
    });

    expect(
      document.querySelector('[data-testid="linear-ticket-picker"]'),
    ).toBeNull();
    expect(
      popOutDocument.body.querySelector('[data-testid="linear-ticket-picker"]'),
    ).not.toBeNull();
  });
});
