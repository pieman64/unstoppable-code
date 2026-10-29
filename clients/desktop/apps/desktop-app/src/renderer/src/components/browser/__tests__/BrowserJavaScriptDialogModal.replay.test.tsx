/** @jest-environment jsdom */
import { renderToStaticMarkup } from 'react-dom/server';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { BrowserJavaScriptDialogModal } from '../BrowserJavaScriptDialogModal';

describe('BrowserJavaScriptDialogModal session replay', () => {
  it('blocks a page-written message but records its origin', () => {
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(
      <BrowserJavaScriptDialogModal
        browserId="b"
        dialog={{
          id: 'd',
          browserId: 'b',
          type: 'alert',
          message: 'Your one-time code is 123456',
          url: 'https://example.com/login',
          openedAt: 0,
        }}
      />,
    );
    const block = `.${POSTHOG_REPLAY_BLOCK_CLASS}`;
    const message = Array.from(host.querySelectorAll('p')).find(
      (element) => element.textContent === 'Your one-time code is 123456',
    );
    expect(message).toBeDefined();
    expect(message?.closest(block)).not.toBeNull();
    const origin = host.querySelector('h2');
    expect(origin?.textContent).toContain('example.com');
    expect(origin?.closest(block)).toBeNull();
  });
});
