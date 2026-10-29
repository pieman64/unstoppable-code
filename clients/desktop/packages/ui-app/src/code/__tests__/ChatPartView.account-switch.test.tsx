/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChatPartView } from '../ChatPartView';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

describe('ChatPartView account proxy switch (CAN-4021)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('loads the switch line on demand and blocks the names from replay', async () => {
    await act(async () => {
      root.render(
        <ChatPartView
          part={{
            kind: 'account_switch',
            data: {
              occurredAt: 1,
              account: 'sam@example.com',
              previousAccount: 'ops@example.com',
              previousAtLimit: true,
            },
          }}
        />,
      );
      await import('@canopy/ui-shared/components/chat/AccountProxySwitchLine');
    });
    const line = container.querySelector(
      '[data-testid="account-proxy-switch-line"]',
    );
    expect(line?.textContent).toBe(
      'ops@example.com reached its usage limit. Continued on sam@example.com.',
    );
    expect(
      Array.from(
        line?.querySelectorAll('.ph-no-capture') ?? [],
        (name) => name.textContent,
      ),
    ).toEqual(['ops@example.com', 'sam@example.com']);
  });
});
