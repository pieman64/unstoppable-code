/**
 * @jest-environment jsdom
 */
import type { JSX } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { AccountProxyErrorMessage } from '../AccountProxyErrorMessage';

function render(element: JSX.Element): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(element);
  return host;
}

describe('AccountProxyErrorMessage', () => {
  it.each(['unreachable', 'not-proxy'] as const)(
    'keeps the server host out of session replay for %s',
    (code) => {
      const host = render(
        <AccountProxyErrorMessage code={code} host="proxy.internal:8317" />,
      );
      const blocked = host.querySelector(`.${POSTHOG_REPLAY_BLOCK_CLASS}`);
      expect(blocked?.textContent).toBe('proxy.internal:8317');
      // The host appears nowhere outside the blocked element.
      blocked?.remove();
      expect(host.textContent).not.toContain('proxy.internal');
      expect(host.textContent?.length).toBeGreaterThan(10);
    },
  );

  it('needs no blocking when the message names no host', () => {
    const host = render(<AccountProxyErrorMessage code="unauthorized" />);
    expect(host.querySelector(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBeNull();
    expect(host.textContent).toContain("That key didn't work");
  });
});
