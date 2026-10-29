/** @jest-environment jsdom */

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MobileAppStoreLink } from '@canopy/ui-shared/components/StoreBadgeLink';
import { useStoreQrCodes, type StoreQrCodes } from '../useStoreQrCodes';

const toDataURL = jest.fn();

jest.mock('qrcode', () => ({
  __esModule: true,
  default: {
    toDataURL: (...args: unknown[]): unknown => toDataURL(...args),
  },
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const LINKS: readonly MobileAppStoreLink[] = [
  {
    store: 'apple-app-store',
    url: 'https://apps.example.com/app',
    badgeSrc: 'data:image/png;base64,apple',
  },
  {
    store: 'google-play',
    url: 'https://play.example.com/app',
    badgeSrc: 'data:image/png;base64,play',
  },
];

describe('useStoreQrCodes', () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: StoreQrCodes;

  function Probe({
    links,
    enabled,
  }: {
    links: readonly MobileAppStoreLink[];
    enabled: boolean;
  }): JSX.Element {
    latest = useStoreQrCodes(links, enabled);
    return <div />;
  }

  async function render(
    links: readonly MobileAppStoreLink[],
    enabled: boolean,
  ): Promise<void> {
    await act(async () => {
      root.render(<Probe links={links} enabled={enabled} />);
      // Let the effect's generation promises settle inside this act scope.
      await Promise.resolve();
    });
  }

  beforeEach(() => {
    toDataURL.mockReset();
    latest = {};
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  it('generates nothing while disabled', async () => {
    await render(LINKS, false);

    expect(toDataURL).not.toHaveBeenCalled();
    expect(latest).toEqual({});
  });

  it('generates nothing when the brand declares no listings', async () => {
    await render([], true);

    expect(toDataURL).not.toHaveBeenCalled();
    expect(latest).toEqual({});
  });

  it('keys successful data URIs by store once enabled', async () => {
    toDataURL.mockImplementation((url: string) =>
      Promise.resolve(`data:image/png;base64,${url}`),
    );

    await render(LINKS, true);

    // All stores are encoded up front so the toggle switches instantly.
    expect(toDataURL).toHaveBeenCalledTimes(2);
    // margin 4 is the spec-required quiet zone; the tile's CSS padding is a
    // fixed pixel amount and cannot stand in for it.
    expect(toDataURL).toHaveBeenCalledWith(LINKS[0].url, {
      margin: 4,
      width: 288,
    });
    expect(latest).toEqual({
      'apple-app-store': `data:image/png;base64,${LINKS[0].url}`,
      'google-play': `data:image/png;base64,${LINKS[1].url}`,
    });
  });

  it('omits a store whose encode rejects without leaving an unhandled rejection', async () => {
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      toDataURL.mockImplementation((url: string) =>
        url === LINKS[0].url
          ? Promise.reject(new Error('encode failed'))
          : Promise.resolve('data:image/png;base64,play-qr'),
      );

      await render(LINKS, true);
      await act(async () => {
        await Promise.resolve();
      });

      expect(latest).toEqual({
        'google-play': 'data:image/png;base64,play-qr',
      });
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('does not regenerate when links are re-derived with identical contents', async () => {
    toDataURL.mockResolvedValue('data:image/png;base64,qr');

    await render(LINKS, true);
    expect(toDataURL).toHaveBeenCalledTimes(2);

    // A fresh array with the same store/url pairs, as an adapter re-deriving
    // its links each render would produce.
    await render(
      LINKS.map((link) => ({ ...link })),
      true,
    );

    expect(toDataURL).toHaveBeenCalledTimes(2);
  });
});
