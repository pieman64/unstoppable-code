/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  AccountProxySwitchLine,
  AccountProxySwitchPart,
} from '../chat/AccountProxySwitchLine';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

describe('AccountProxySwitchLine', () => {
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

  function line(): HTMLElement | null {
    return container.querySelector('[data-testid="account-proxy-switch-line"]');
  }

  it('says the account it left reached its limit', () => {
    act(() =>
      root.render(
        <AccountProxySwitchLine
          account="sam@example.com"
          previousAccount="ops@example.com"
          previousAtLimit
        />,
      ),
    );
    expect(line()?.textContent).toBe(
      'ops@example.com reached its usage limit. Continued on sam@example.com.',
    );
    // Both names are blocked from session replay; the sentence is not.
    expect(
      Array.from(
        line()?.querySelectorAll('.ph-no-capture') ?? [],
        (name) => name.textContent,
      ),
    ).toEqual(['ops@example.com', 'sam@example.com']);
  });

  it('names both accounts when the reason is not known', () => {
    act(() =>
      root.render(
        <AccountProxySwitchLine
          account="sam@example.com"
          previousAccount="ops@example.com"
        />,
      ),
    );
    expect(line()?.textContent).toBe(
      'The account proxy moved this chat from ops@example.com to sam@example.com.',
    );
  });

  it('names the new account alone when the previous one is not known', () => {
    act(() =>
      root.render(<AccountProxySwitchLine account="sam@example.com" />),
    );
    expect(line()?.textContent).toBe('Continued on sam@example.com.');
  });

  it('reads a Portal part, and renders nothing without its account', () => {
    act(() =>
      root.render(
        <AccountProxySwitchPart
          data={{
            occurredAt: 1,
            account: 'sam@example.com',
            previousAccount: 'ops@example.com',
            previousAtLimit: true,
          }}
        />,
      ),
    );
    expect(line()?.textContent).toBe(
      'ops@example.com reached its usage limit. Continued on sam@example.com.',
    );
    act(() =>
      root.render(
        <AccountProxySwitchPart data={{ occurredAt: 1, account: 7 }} />,
      ),
    );
    expect(line()).toBeNull();
    act(() => root.render(<AccountProxySwitchPart data={null} />));
    expect(line()).toBeNull();
  });
});
