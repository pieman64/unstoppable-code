/** @jest-environment jsdom */

import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CreditsRecoveryNotice } from '../CreditsRecoveryNotice';
import { CONTACT_ORG_ADMIN_COPY } from '../creditsRecoveryCopy';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * CAN-4764 — the shared out-of-credits notice renders the host's detail lines
 * in order, closes them with the contact-admin line when asked, and passes
 * every other notice prop through untouched.
 */
describe('CreditsRecoveryNotice', () => {
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

  function notice(): HTMLElement {
    const element = container.querySelector<HTMLElement>(
      '[data-testid="recovery"]',
    );
    if (element === null) throw new Error('notice not rendered');
    return element;
  }

  it('renders the detail lines in order with the contact-admin line last', () => {
    act(() =>
      root.render(
        <CreditsRecoveryNotice
          data-testid="recovery"
          title="Out of credits"
          detailLines={['Refill line.', <em key="drip">Drip line.</em>]}
          contactAdmin
          contactAdminTestId="recovery-contact-admin"
        >
          Message.
        </CreditsRecoveryNotice>,
      ),
    );

    const lines = Array.from(notice().querySelectorAll('span.block')).map(
      (line) => line.textContent,
    );
    expect(lines).toEqual([
      'Refill line.',
      'Drip line.',
      CONTACT_ORG_ADMIN_COPY,
    ]);
    expect(
      container.querySelector('[data-testid="recovery-contact-admin"]')
        ?.textContent,
    ).toBe(CONTACT_ORG_ADMIN_COPY);
  });

  it('leaves out the contact-admin line unless asked', () => {
    act(() =>
      root.render(
        <CreditsRecoveryNotice
          data-testid="recovery"
          title="Out of credits"
          detailLines={['Refill line.']}
        >
          Message.
        </CreditsRecoveryNotice>,
      ),
    );

    expect(notice().textContent).toContain('Refill line.');
    expect(notice().textContent).not.toContain(CONTACT_ORG_ADMIN_COPY);
  });

  it('renders no detail row without lines', () => {
    act(() =>
      root.render(
        <CreditsRecoveryNotice data-testid="recovery" title="Out of credits">
          Message.
        </CreditsRecoveryNotice>,
      ),
    );

    expect(notice().querySelector('.fg-tertiary.mt-0\\.5')).toBeNull();
    expect(notice().querySelectorAll('span.block')).toHaveLength(0);
  });

  it('passes the notice props through', () => {
    const ref = createRef<HTMLDivElement>();
    const onDismiss = jest.fn();
    act(() =>
      root.render(
        <CreditsRecoveryNotice
          ref={ref}
          data-testid="recovery"
          className="mx-4"
          title="Out of credits"
          onDismiss={onDismiss}
          dismissTestId="recovery-dismiss"
          actions={<button type="button">Buy</button>}
          actionsPlacement="below"
        >
          Message.
        </CreditsRecoveryNotice>,
      ),
    );

    expect(ref.current).toBe(notice());
    expect(notice().className).toContain('mx-4');
    // `below` actions top-align the row; trailing ones center it.
    expect(notice().className).toContain('items-start');
    expect(notice().textContent).toContain('Out of credits');
    expect(notice().textContent).toContain('Message.');
    expect(notice().querySelector('button')?.textContent).toBe('Buy');

    const dismiss = container.querySelector<HTMLButtonElement>(
      '[data-testid="recovery-dismiss"]',
    );
    act(() => dismiss?.click());
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
