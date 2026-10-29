/** @jest-environment jsdom */
// CAN-3119 (F2): the memories dialog shows organization memory text.
// `DialogModal` records its card, so each fact carries its own block. This pins
// that the fact text renders in a blocked region of the recorded card.

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryUsedButton } from '../MemoryUsedDialog';
import { expectBlockedInRecordedDialogCard } from '@/test-utils/replay';

const FACT_TEXT = 'The staging database password rotates every Tuesday.';

describe('MemoryUsedDialog session replay', () => {
  const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');
  let root: Root | null = null;

  beforeEach(() => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getOrgMemoryFeedback: jest
          .fn()
          .mockResolvedValue({ feedback: null, canSubmit: true }),
        submitOrgMemoryFeedback: jest.fn(),
        loadCanopyCloudAccount: jest
          .fn()
          .mockResolvedValue({ capabilities: [] }),
      },
    });
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = '';
    if (originalApiDescriptor) {
      Object.defineProperty(window, 'api', originalApiDescriptor);
    } else {
      Reflect.deleteProperty(window, 'api');
    }
  });

  it('blocks the memory fact text inside the recorded DialogModal card', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root?.render(
        <MemoryUsedButton
          memory={{
            facts: [
              {
                factText: FACT_TEXT,
                validAt: '2026-07-13',
                sourceTurnIds: ['turn-1'],
              },
            ],
          }}
        />,
      );
    });

    act(() => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="memory-used-button"]')
        ?.click();
    });

    const fact = Array.from(document.querySelectorAll('p')).find(
      (paragraph) => paragraph.textContent === FACT_TEXT,
    );
    if (fact === undefined) throw new Error('Memory fact text not rendered');
    // The dialog portals out of the button's host, so the block must come
    // from the dialog content rather than anything the host renders.
    expect(host.contains(fact)).toBe(false);
    const card = expectBlockedInRecordedDialogCard(fact);
    expect(card.getAttribute('data-testid')).toBe('memory-used-dialog');
  });
});
