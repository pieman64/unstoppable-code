/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { OPERATIONAL_STATUS_COLORS } from '../../lib/operational-status-colors';
import {
  McpSignInPendingActions,
  McpSignInPendingStatus,
} from '../McpSignInPending';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const SIGN_IN_URL = 'https://auth.example/authorize';

describe('McpSignInPending', () => {
  let container: HTMLElement;
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

  function byTestId<T extends HTMLElement = HTMLElement>(
    testId: string,
  ): T | null {
    return container.querySelector<T>(`[data-testid="${testId}"]`);
  }

  it('announces the wait in full, or as a row pill', () => {
    act(() => {
      root.render(
        <>
          <McpSignInPendingStatus dataTestId="inline" />
          <McpSignInPendingStatus variant="pill" dataTestId="pill" />
        </>,
      );
    });
    expect(byTestId('inline')?.textContent).toBe('Waiting for sign-in');
    expect(byTestId('inline')?.getAttribute('role')).toBe('status');
    expect(byTestId('pill')?.textContent).toBe('Waiting for sign-in');
    expect(byTestId('pill')?.getAttribute('role')).toBe('status');
    // The spinner is decoration beside the words, not a second name.
    expect(container.querySelector('[aria-label="Loading"]')).toBeNull();
    // Waiting is an operational state: the active status palette, never the
    // brand accent.
    const active = OPERATIONAL_STATUS_COLORS.active;
    expect(byTestId('pill')?.className).toContain(active.backgroundBadge);
    expect(byTestId('pill')?.className).toContain(active.foreground);
    expect(
      byTestId('inline')?.querySelector('[aria-hidden="true"]')?.className,
    ).toContain(active.foreground);
    expect(container.innerHTML).not.toContain('accent');
    act(() => {
      root.render(
        <McpSignInPendingStatus
          variant="pill"
          serviceName="Linear"
          dataTestId="named"
        />,
      );
    });
    // The row shows the name; only assistive technology hears it again.
    expect(byTestId('named')?.textContent).toBe('Waiting for sign-in');
    expect(byTestId('named')?.getAttribute('aria-label')).toBe(
      'Waiting for Linear sign-in',
    );
  });

  it('offers Cancel and Reopen sign-in in a footer', () => {
    const onCancel = jest.fn();
    act(() => {
      root.render(
        <McpSignInPendingActions
          authorizationUrl={SIGN_IN_URL}
          onCancel={onCancel}
          dataTestId="footer"
        />,
      );
    });
    const reopen = byTestId<HTMLAnchorElement>('footer-reopen');
    expect(reopen?.textContent).toBe('Reopen sign-in');
    expect(reopen?.getAttribute('href')).toBe(SIGN_IN_URL);
    expect(reopen?.getAttribute('target')).toBe('_blank');
    expect(reopen?.getAttribute('rel')).toBe('noopener noreferrer');
    const cancel = byTestId('footer-cancel');
    expect(cancel?.textContent).toBe('Cancel');
    expect(container.textContent).toBe('CancelReopen sign-in');
    act(() => cancel?.click());
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('names a footer dismiss that closes its dialog', () => {
    act(() => {
      root.render(
        <McpSignInPendingActions
          authorizationUrl={SIGN_IN_URL}
          onCancel={jest.fn()}
          cancelLabel="Done"
          dataTestId="footer"
        />,
      );
    });
    expect(byTestId('footer-cancel')?.textContent).toBe('Done');
  });

  it('offers Reopen and an icon-only cancel on a row, or only Reopen without a cancel', () => {
    const onCancel = jest.fn();
    act(() => {
      root.render(
        <McpSignInPendingActions
          variant="compact"
          authorizationUrl={SIGN_IN_URL}
          onCancel={onCancel}
          dataTestId="row"
        />,
      );
    });
    const reopen = byTestId<HTMLAnchorElement>('row-reopen');
    expect(reopen?.textContent).toBe('Reopen');
    expect(reopen?.getAttribute('aria-label')).toBe('Reopen sign-in');
    expect(reopen?.getAttribute('href')).toBe(SIGN_IN_URL);
    const cancel = byTestId('row-cancel');
    expect(cancel?.getAttribute('aria-label')).toBe('Cancel sign-in');
    act(() => cancel?.click());
    expect(onCancel).toHaveBeenCalledTimes(1);
    act(() => {
      root.render(
        <McpSignInPendingActions
          variant="compact"
          authorizationUrl={SIGN_IN_URL}
          dataTestId="row"
        />,
      );
    });
    expect(byTestId('row-cancel')).toBeNull();
    expect(byTestId('row-reopen')).not.toBeNull();
  });
});
