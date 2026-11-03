/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  BackgroundServiceApi,
  BackgroundServiceStatus,
} from '@canopy/desktop-shared/lib/background-service-status';
import type { RemoteControlContext } from '@canopy/desktop-shared/types';
import { useRemoteControlStore } from '@/stores/remoteControlStore';
import { BackgroundServiceUnavailableNotice } from '../BackgroundServiceUnavailableNotice';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const UNAVAILABLE: BackgroundServiceStatus = {
  state: 'unavailable',
  reason: 'start_failed',
  retry: 'idle',
  sequence: 1,
};

let container: HTMLElement;
let root: Root;
let push: (status: BackgroundServiceStatus) => void;
let api: {
  getStatus: jest.Mock<Promise<BackgroundServiceStatus>, []>;
  retry: jest.Mock<Promise<BackgroundServiceStatus>, []>;
  onStatusChanged: jest.Mock;
  unsubscribe: jest.Mock;
};

function install(initial: BackgroundServiceStatus): void {
  const unsubscribe = jest.fn();
  api = {
    getStatus: jest.fn(() => Promise.resolve(initial)),
    retry: jest.fn(() => new Promise<BackgroundServiceStatus>(() => {})),
    onStatusChanged: jest.fn(
      (callback: (status: BackgroundServiceStatus) => void) => {
        push = callback;
        return unsubscribe;
      },
    ),
    unsubscribe,
  };
  const backgroundService: BackgroundServiceApi = api;
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: { backgroundService },
  });
}

async function mount(
  context: RemoteControlContext = { mode: 'local' },
): Promise<void> {
  useRemoteControlStore.setState({ context });
  await act(async () => {
    root.render(<BackgroundServiceUnavailableNotice />);
    await Promise.resolve();
  });
}

function notice(): HTMLElement | null {
  return container.querySelector('[data-testid="background-service-notice"]');
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useRemoteControlStore.setState({ context: { mode: 'local' } });
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: undefined,
  });
});

it('shows while unavailable and hides once a push says the service is back', async () => {
  install(UNAVAILABLE);
  await mount();
  expect(notice()).not.toBeNull();
  act(() => push({ state: 'ok', retry: 'idle', sequence: 2 }));
  expect(notice()).toBeNull();
});

it('stays hidden while ok or merely reconnecting', async () => {
  install({ state: 'reconnecting', retry: 'idle', sequence: 3 });
  await mount();
  expect(notice()).toBeNull();
  act(() => push({ ...UNAVAILABLE, sequence: 4 }));
  expect(notice()).not.toBeNull();
});

it('ignores a stale read that lands after a newer push', async () => {
  install(UNAVAILABLE);
  let resolve: (status: BackgroundServiceStatus) => void = () => {};
  api.getStatus.mockImplementation(
    () => new Promise((done) => (resolve = done)),
  );
  await mount();
  act(() => push({ state: 'ok', retry: 'idle', sequence: 2 }));
  await act(async () => {
    resolve(UNAVAILABLE);
    await Promise.resolve();
  });
  expect(notice()).toBeNull();
});

it('Try again asks main once and follows its pushes', async () => {
  install(UNAVAILABLE);
  await mount();
  const button = container.querySelector<HTMLButtonElement>(
    '[data-testid="background-service-notice-retry"]',
  );
  act(() => button?.click());
  expect(api.retry).toHaveBeenCalledTimes(1);
  act(() => push({ ...UNAVAILABLE, retry: 'running', sequence: 2 }));
  expect(notice()?.textContent).toContain('Trying again…');
  act(() => push({ ...UNAVAILABLE, retry: 'failed', sequence: 3 }));
  expect(notice()?.textContent).toContain(
    "Still couldn't reach the background service",
  );
});

it('never calls the blocked channels in a window that shows another computer', async () => {
  install(UNAVAILABLE);
  await mount({
    mode: 'remote',
    deviceId: 'dev-studio',
    name: 'Studio desktop',
    platform: 'linux',
  });
  expect(notice()).toBeNull();
  expect(api.getStatus).not.toHaveBeenCalled();
  expect(api.onStatusChanged).not.toHaveBeenCalled();
});

it('unsubscribes on unmount', async () => {
  install(UNAVAILABLE);
  await mount();
  act(() => root.unmount());
  expect(api.unsubscribe).toHaveBeenCalledTimes(1);
  root = createRoot(container);
});
