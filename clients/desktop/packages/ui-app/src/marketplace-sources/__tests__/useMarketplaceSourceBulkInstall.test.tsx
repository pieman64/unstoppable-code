/**
 * @jest-environment jsdom
 */
/* eslint-disable @typescript-eslint/require-await -- act() callbacks stay async so React flushes the settled promises they trigger. */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  useMarketplaceSourceBulkInstall,
  type UseMarketplaceSourceBulkInstallOptions,
  type UseMarketplaceSourceBulkInstallResult,
} from '../useMarketplaceSourceBulkInstall';

let root: Root;
let latest: UseMarketplaceSourceBulkInstallResult;

function Harness(props: UseMarketplaceSourceBulkInstallOptions): null {
  latest = useMarketplaceSourceBulkInstall(props);
  return null;
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  root = createRoot(document.createElement('div'));
});

afterEach(() => {
  act(() => root.unmount());
});

describe('useMarketplaceSourceBulkInstall', () => {
  it('installs sequentially, skips satisfied plugins and counts failures', async () => {
    const order: string[] = [];
    const installPlugin = jest.fn(async (_source: string, key: string) => {
      order.push(key);
      return key !== 'b';
    });
    await act(async () => {
      root.render(
        <Harness
          sourceId="s"
          installPlugin={installPlugin}
          stillNeedsInstall={(key) => key !== 'skip'}
        />,
      );
    });
    act(() => latest.start(['a', 'skip', 'b', 'c']));
    await flush();
    expect(order).toEqual(['a', 'b', 'c']);
    expect(latest.running).toBe(false);
    expect(latest.summary).toBe('Installed 2, 1 already installed, 1 failed.');
  });

  it('cancels after the current plugin settles', async () => {
    let release: (value: boolean) => void = () => undefined;
    const installPlugin = jest.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    await act(async () => {
      root.render(
        <Harness
          sourceId="s"
          installPlugin={installPlugin}
          stillNeedsInstall={() => true}
        />,
      );
    });
    act(() => latest.start(['a', 'b', 'c']));
    expect(latest.running).toBe(true);
    act(() => latest.cancel());
    expect(latest.cancelling).toBe(true);
    // A second start while running is ignored.
    act(() => latest.start(['z']));
    await act(async () => {
      release(true);
    });
    await flush();
    expect(installPlugin).toHaveBeenCalledTimes(1);
    expect(latest.summary).toBe('Installed 1, 2 cancelled.');
  });

  it('stops scheduling when the source changes', async () => {
    let release: (value: boolean) => void = () => undefined;
    const installPlugin = jest.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const props = {
      installPlugin,
      stillNeedsInstall: (): boolean => true,
    };
    await act(async () => {
      root.render(<Harness sourceId="s" {...props} />);
    });
    act(() => latest.start(['a', 'b']));
    await act(async () => {
      root.render(<Harness sourceId="other" {...props} />);
    });
    await act(async () => {
      release(true);
    });
    await flush();
    expect(installPlugin).toHaveBeenCalledTimes(1);
    expect(latest.running).toBe(false);
    expect(latest.summary).toBeUndefined();
  });
  it('stops on an unknown install outcome without counting it as a failure', async () => {
    const installPlugin = jest.fn(async () => null);
    await act(async () => {
      root.render(
        <Harness
          sourceId="s"
          installPlugin={installPlugin}
          stillNeedsInstall={() => true}
        />,
      );
    });
    act(() => latest.start(['a', 'b']));
    await flush();
    expect(installPlugin).toHaveBeenCalledTimes(1);
    expect(latest.summary).toBe(
      'Installed 0, 1 need a status check, 1 cancelled.',
    );
    expect(latest.summary).not.toContain('failed');
  });
});
