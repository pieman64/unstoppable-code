/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ProviderUsageAccountRow } from '../ProviderUsageAccountRow';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true,
  configurable: true,
  writable: true,
});

describe('ProviderUsageAccountRow session replay', () => {
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

  it('blocks only the account label, not the row copy or its action', () => {
    act(() => {
      root.render(
        <ProviderUsageAccountRow
          accountLabel="alice@example.com"
          statusLabel="Signed in"
        >
          <button type="button">Manage</button>
        </ProviderUsageAccountRow>,
      );
    });
    expect(container.textContent).toBe('Accountalice@example.comManage');
    const blocks = container.querySelectorAll(`.${REPLAY_BLOCK_CLASS}`);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.textContent).toBe('alice@example.com');
    expect(
      container.querySelector('button')?.closest(`.${REPLAY_BLOCK_CLASS}`),
    ).toBeNull();
  });

  it('records the status label when there is no account to name', () => {
    act(() => {
      root.render(
        <ProviderUsageAccountRow
          accountLabel={null}
          statusLabel="Sign in to see usage"
        >
          <button type="button">Sign in</button>
        </ProviderUsageAccountRow>,
      );
    });
    expect(container.textContent).toBe('AccountSign in to see usageSign in');
    expect(container.querySelector(`.${REPLAY_BLOCK_CLASS}`)).toBeNull();
  });
});
