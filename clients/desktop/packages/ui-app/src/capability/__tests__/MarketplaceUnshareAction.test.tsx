/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  MarketplaceUnshareError,
  marketplaceUnshareMessage,
} from '@canopy/ui-shared/lib/marketplace-unshare';
import { DetailPageActions } from '@canopy/ui-shared/components/DetailActionBar';
import { DetailMoreMenu } from '@canopy/ui-shared/components/DetailMoreMenu';
import {
  MarketplaceUnshareAction,
  useMarketplaceUnshare,
  type UseMarketplaceUnshareOptions,
} from '../MarketplaceUnshareAction';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason: unknown) => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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
  document.body.innerHTML = '';
});

function byTestId(id: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${id}"]`);
}

function click(id: string): void {
  const element = byTestId(id);
  if (!(element instanceof HTMLButtonElement)) throw new Error(`${id} missing`);
  act(() => element.click());
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('MarketplaceUnshareAction (CAN-4263)', () => {
  it('cancel sends no request and closes the dialog', () => {
    const onUnshare = jest.fn(() => Promise.resolve());
    const onUnshared = jest.fn();
    act(() =>
      root.render(
        <MarketplaceUnshareAction
          kind="skill"
          name="Review helper"
          ownerName="Platform"
          onUnshare={onUnshare}
          onUnshared={onUnshared}
        />,
      ),
    );
    click('marketplace-unshare');
    const dialog = byTestId('marketplace-unshare-dialog');
    expect(dialog?.textContent).toContain('Unshare “Review helper”?');
    expect(dialog?.textContent).toContain(
      marketplaceUnshareMessage('skill', 'Platform'),
    );
    // Cancel takes initial focus so a reflexive Enter backs out.
    expect(document.activeElement).toBe(byTestId('marketplace-unshare-cancel'));
    click('marketplace-unshare-cancel');
    expect(byTestId('marketplace-unshare-dialog')).toBeNull();
    expect(onUnshare).not.toHaveBeenCalled();
    expect(onUnshared).not.toHaveBeenCalled();
  });

  it('marks Unshare with the unshare glyph, not the delete trash can', () => {
    act(() =>
      root.render(
        <MarketplaceUnshareAction
          kind="agent"
          name="Code Reviewer"
          onUnshare={() => Promise.resolve()}
          onUnshared={() => undefined}
        />,
      ),
    );
    const trigger = byTestId('marketplace-unshare');
    expect(trigger?.textContent).toBe('Unshare');
    // Lucide link-2-off: Unshare stops sharing; the trash can means delete.
    expect(trigger?.querySelector('svg')?.getAttribute('data-glyph')).toBe(
      'link-2-off',
    );
  });

  it('masks the user-authored name for session replay', () => {
    act(() =>
      root.render(
        <MarketplaceUnshareAction
          kind="collection"
          name="Secret set"
          onUnshare={() => Promise.resolve()}
          onUnshared={() => undefined}
        />,
      ),
    );
    click('marketplace-unshare');
    const masked = byTestId('marketplace-unshare-dialog')?.querySelector(
      '.ph-mask',
    );
    expect(masked?.textContent).toBe('Secret set');
  });

  it('sends one request on repeated confirms and blocks dismissal while pending', async () => {
    const pending = deferred();
    const onUnshare = jest.fn(() => pending.promise);
    const onUnshared = jest.fn();
    act(() =>
      root.render(
        <MarketplaceUnshareAction
          kind="plugin"
          name="Docs"
          onUnshare={onUnshare}
          onUnshared={onUnshared}
        />,
      ),
    );
    click('marketplace-unshare');
    const confirm = byTestId('marketplace-unshare-confirm');
    if (!(confirm instanceof HTMLButtonElement)) throw new Error('confirm');
    act(() => {
      confirm.click();
      confirm.click();
    });
    expect(onUnshare).toHaveBeenCalledTimes(1);
    expect(confirm.textContent).toContain('Unsharing…');
    expect(confirm.getAttribute('aria-busy')).toBe('true');
    // Escape and Cancel are inert while the delete is in flight.
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(byTestId('marketplace-unshare-dialog')).not.toBeNull();
    expect(
      (byTestId('marketplace-unshare-cancel') as HTMLButtonElement).disabled,
    ).toBe(true);

    pending.resolve();
    await flush();
    expect(onUnshared).toHaveBeenCalledTimes(1);
    expect(byTestId('marketplace-unshare-dialog')).toBeNull();
  });

  it('keeps the dialog open with a retryable error, then succeeds once', async () => {
    const onUnshare = jest
      .fn<Promise<void>, []>()
      .mockRejectedValueOnce(new MarketplaceUnshareError('in-use'))
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(undefined);
    const onUnshared = jest.fn();
    act(() =>
      root.render(
        <MarketplaceUnshareAction
          kind="skill"
          name="Review helper"
          onUnshare={onUnshare}
          onUnshared={onUnshared}
        />,
      ),
    );
    click('marketplace-unshare');
    click('marketplace-unshare-confirm');
    await flush();
    expect(byTestId('confirm-dialog-error')?.textContent).toContain(
      'shared collections include it',
    );
    click('marketplace-unshare-confirm');
    await flush();
    expect(byTestId('confirm-dialog-error')?.textContent).toBe(
      'Couldn’t unshare this skill. Try again.',
    );
    expect(onUnshared).not.toHaveBeenCalled();
    click('marketplace-unshare-confirm');
    await flush();
    expect(onUnshare).toHaveBeenCalledTimes(3);
    expect(onUnshared).toHaveBeenCalledTimes(1);
    expect(byTestId('marketplace-unshare-dialog')).toBeNull();
  });

  it('does not report a post-delete failure as a failed Unshare', async () => {
    const onUnshare = jest.fn(() => Promise.resolve());
    const onUnshared = jest.fn(() => {
      throw new Error('navigation failed');
    });
    act(() =>
      root.render(
        <MarketplaceUnshareAction
          kind="agent"
          name="Reviewer"
          onUnshare={onUnshare}
          onUnshared={onUnshared}
        />,
      ),
    );
    click('marketplace-unshare');
    click('marketplace-unshare-confirm');
    await flush();
    expect(onUnshared).toHaveBeenCalledTimes(1);
    expect(byTestId('marketplace-unshare-dialog')).toBeNull();
    expect(byTestId('confirm-dialog-error')).toBeNull();
    expect(onUnshare).toHaveBeenCalledTimes(1);
    // Navigation can fail after a committed delete. The remaining trigger
    // must never offer another mutation of the now-deleted account share.
    click('marketplace-unshare');
    expect(byTestId('marketplace-unshare-dialog')).toBeNull();
    expect(onUnshare).toHaveBeenCalledTimes(1);
  });

  it('leads the secondaries without displacing Share or the primary', () => {
    act(() =>
      root.render(
        <DetailPageActions
          secondary={
            <>
              <MarketplaceUnshareAction
                kind="collection"
                name="Set"
                onUnshare={() => Promise.resolve()}
                onUnshared={() => undefined}
              />
              <button type="button" data-testid="edit">
                Edit
              </button>
            </>
          }
          share={
            <button type="button" data-testid="share">
              Share
            </button>
          }
          primary={
            <button type="button" data-testid="primary">
              Install
            </button>
          }
        />,
      ),
    );
    const order = Array.from(
      byTestId('detail-action-bar')?.querySelectorAll('button') ?? [],
    ).map((button) => button.dataset.testid);
    expect(order).toEqual(['marketplace-unshare', 'edit', 'share', 'primary']);
  });
});

describe('marketplaceUnshareMessage', () => {
  it('names the owner when known and never invents one', () => {
    expect(marketplaceUnshareMessage('agent', 'Platform')).toBe(
      'People in Platform will no longer find this agent in Marketplace. If it has a public link, that link stops working too.',
    );
    expect(marketplaceUnshareMessage('collection', null)).toBe(
      'People it was shared with will no longer find this collection in Marketplace. If it has a public link, that link stops working too. The skills in it are not unshared.',
    );
  });

  describe('useMarketplaceUnshare (⋯ More placement)', () => {
    function MenuHost(props: UseMarketplaceUnshareOptions): JSX.Element {
      const unshare = useMarketplaceUnshare(props);
      return (
        <>
          <DetailMoreMenu
            name={props.name}
            items={[unshare.item]}
            triggerTestId="more"
            menuTestId="menu"
          />
          {unshare.dialog}
        </>
      );
    }

    it('is the last destructive item with the unshare glyph and the same confirm', async () => {
      const onUnshare = jest.fn(() => Promise.resolve());
      const onUnshared = jest.fn();
      act(() =>
        root.render(
          <MenuHost
            kind="agent"
            name="Code Reviewer"
            ownerName="Platform"
            onUnshare={onUnshare}
            onUnshared={onUnshared}
          />,
        ),
      );
      click('more');
      const item = byTestId('marketplace-unshare');
      expect(item?.textContent).toBe('Unshare');
      expect(item?.querySelector('svg')?.getAttribute('data-glyph')).toBe(
        'link-2-off',
      );
      click('marketplace-unshare');
      const dialog = byTestId('marketplace-unshare-dialog');
      expect(dialog?.textContent).toContain('Unshare “Code Reviewer”?');
      expect(dialog?.textContent).toContain(
        marketplaceUnshareMessage('agent', 'Platform'),
      );
      click('marketplace-unshare-confirm');
      await flush();
      expect(onUnshare).toHaveBeenCalledTimes(1);
      expect(onUnshared).toHaveBeenCalledTimes(1);
      expect(byTestId('marketplace-unshare-dialog')).toBeNull();
    });
  });
});
