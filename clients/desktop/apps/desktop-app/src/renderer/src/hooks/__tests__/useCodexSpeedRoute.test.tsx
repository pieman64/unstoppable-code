/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createDefaultEnvironmentConfig } from '@canopy/desktop-shared/lib/user-environment';
import { useEnvironmentsStore } from '../../stores/environmentsStore';
import { bumpRendererModelFactsVersion } from '../../stores/modelPolicyRuntime';
import type { CodexSpeedRouteFacts } from '@canopy/desktop-shared/lib/codex-speed-availability';
import type { ReadCodexSpeedRouteRequest } from '@canopy/desktop-shared/types/codex-speed-capabilities';
import {
  resetCodexSpeedStoreForTests,
  useCodexSpeedStore,
} from '../../stores/codexSpeedStore';
import {
  useCodexSpeedRoute,
  type CodexSpeedRouteResult,
  type UseCodexSpeedRouteOptions,
} from '../useCodexSpeedRoute';

jest.mock('../../lib/renderer-error-logging', () => ({
  reportRendererConsoleError: jest.fn(),
}));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const REQUEST: ReadCodexSpeedRouteRequest = {
  context: {
    kind: 'chat',
    projectId: 'project',
    worktreeId: 'worktree',
    chatId: 'chat',
  },
  model: 'gpt-5.5',
  modelSelection: 'explicit',
};
const NATIVE: CodexSpeedRouteFacts = {
  modelSelection: 'explicit',
  runtimeModel: 'gpt-5.5',
  modelSource: 'codex-managed',
  harness: 'codex',
  routeProfile: 'codex-native',
};
const FOREIGN: CodexSpeedRouteFacts = { ...NATIVE, routeProfile: 'foreign' };
const readRoute = jest.fn<
  Promise<CodexSpeedRouteFacts>,
  [ReadCodexSpeedRouteRequest]
>();
let result: CodexSpeedRouteResult | undefined;
let root: Root;
let container: HTMLDivElement;
let visibility: DocumentVisibilityState = 'visible';

function Harness(options: UseCodexSpeedRouteOptions): JSX.Element | null {
  result = useCodexSpeedRoute(options);
  return null;
}
async function render(options: UseCodexSpeedRouteOptions): Promise<void> {
  await act(async () => {
    root.render(<Harness {...options} />);
    await Promise.resolve();
  });
}
async function settle(action: () => void): Promise<void> {
  await act(async () => {
    action();
    await Promise.resolve();
  });
}
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

beforeEach(() => {
  resetCodexSpeedStoreForTests();
  useEnvironmentsStore.setState({ data: null });
  readRoute.mockReset().mockResolvedValue(NATIVE);
  result = undefined;
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { codexSpeed: { readRoute } },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetCodexSpeedStoreForTests();
  Reflect.deleteProperty(window, 'api');
});

it('reads the trusted context once and does not repeat on equal requests or keystrokes', async () => {
  await render({ request: REQUEST });
  expect(readRoute).toHaveBeenCalledWith(REQUEST);
  expect(result).toMatchObject({
    status: 'ready',
    route: NATIVE,
    refreshing: false,
  });
  await render({ request: { ...REQUEST, context: { ...REQUEST.context } } });
  expect(readRoute).toHaveBeenCalledTimes(1);
});

it('discards an old native answer when the chat context changes', async () => {
  const old = deferred<CodexSpeedRouteFacts>();
  const next = deferred<CodexSpeedRouteFacts>();
  readRoute.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
  await render({ request: REQUEST });
  await render({
    request: {
      ...REQUEST,
      context: {
        kind: 'chat',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'other-chat',
      },
    },
  });
  expect(result).toMatchObject({ route: null, status: 'loading' });
  await settle(() => old.resolve(NATIVE));
  expect(result?.route).toBeNull();
  await settle(() => next.resolve(FOREIGN));
  expect(result).toMatchObject({ status: 'ready', route: FOREIGN });
});

it('clears old route facts while model or routing dependencies are being rechecked', async () => {
  await render({ request: REQUEST, revalidationKey: 'native-billing' });
  const next = deferred<CodexSpeedRouteFacts>();
  readRoute.mockReturnValueOnce(next.promise);
  await render({
    request: { ...REQUEST, model: 'gpt-other' },
    revalidationKey: 'credits-billing',
  });
  expect(result).toMatchObject({ route: null, status: 'loading' });
  await settle(() => next.resolve(FOREIGN));
  expect(readRoute).toHaveBeenCalledTimes(2);
  expect(result?.route).toEqual(FOREIGN);
});

it('rechecks on window focus and returning to visibility without polling', async () => {
  const timeout = jest.spyOn(window, 'setTimeout');
  const interval = jest.spyOn(window, 'setInterval');
  await render({ request: REQUEST });
  await settle(() => window.dispatchEvent(new Event('focus')));
  expect(readRoute).toHaveBeenCalledTimes(2);
  await settle(() => {
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await settle(() => window.dispatchEvent(new Event('focus')));
  expect(readRoute).toHaveBeenCalledTimes(2);
  await settle(() => {
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(readRoute).toHaveBeenCalledTimes(3);
  expect(timeout).not.toHaveBeenCalled();
  expect(interval).not.toHaveBeenCalled();
  timeout.mockRestore();
  interval.mockRestore();
});

it('rechecks after catalog generation or fetch changes, preserving semantic identity', async () => {
  await render({ request: REQUEST });
  const catalog = {
    generation: 1,
    status: 'ready' as const,
    fetchedAt: 100,
    expiresAt: 1000,
    truncated: false,
    models: [],
    denials: [],
  };
  await settle(() => useCodexSpeedStore.getState().applyCatalog(catalog));
  expect(readRoute).toHaveBeenCalledTimes(2);
  await settle(() =>
    useCodexSpeedStore.getState().applyCatalog({ ...catalog }),
  );
  expect(readRoute).toHaveBeenCalledTimes(2);
  await settle(() =>
    useCodexSpeedStore.getState().applyCatalog({ ...catalog, fetchedAt: 200 }),
  );
  expect(readRoute).toHaveBeenCalledTimes(3);
  await settle(() =>
    useCodexSpeedStore.getState().applyCatalog({ ...catalog, generation: 2 }),
  );
  expect(readRoute).toHaveBeenCalledTimes(4);
});

it('does not read when disabled or hidden and discards pending answers after disable', async () => {
  await render({ request: REQUEST, enabled: false });
  expect(readRoute).not.toHaveBeenCalled();
  visibility = 'hidden';
  await render({ request: REQUEST, enabled: true });
  expect(readRoute).not.toHaveBeenCalled();
  const pending = deferred<CodexSpeedRouteFacts>();
  readRoute.mockReturnValueOnce(pending.promise);
  await settle(() => {
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await render({ request: REQUEST, enabled: false });
  await settle(() => pending.resolve(NATIVE));
  expect(result).toMatchObject({
    route: null,
    status: 'unknown',
    refreshing: false,
  });
});

it('fails closed on bridge errors and offers an explicit retry', async () => {
  readRoute.mockRejectedValueOnce(new Error('private account or path detail'));
  await render({ request: REQUEST });
  expect(result).toMatchObject({
    route: null,
    status: 'unknown',
    refreshing: false,
  });
  expect(JSON.stringify(result)).not.toContain('private');
  await act(async () => {
    await result?.refresh();
  });
  expect(result).toMatchObject({ route: NATIVE, status: 'ready' });
});

it('renders unknown without a context or preload API', async () => {
  await render({ request: null });
  expect(result?.status).toBe('unknown');
  expect(readRoute).not.toHaveBeenCalled();
  Reflect.deleteProperty(window, 'api');
  await render({ request: REQUEST });
  expect(result).toMatchObject({ route: null, status: 'unknown' });
});

it('rechecks workspace environment changes without sending environment data to the bridge', async () => {
  await render({ request: REQUEST });
  const config = createDefaultEnvironmentConfig('2026-09-30T12:00:00.000Z');
  await settle(() => useEnvironmentsStore.setState({ data: config }));
  expect(readRoute).toHaveBeenCalledTimes(2);
  expect(readRoute).toHaveBeenLastCalledWith(REQUEST);
  expect(JSON.stringify(readRoute.mock.calls)).not.toContain('globalRuntimes');
});

it('rechecks when model registry or organization routing facts change', async () => {
  await render({ request: REQUEST });
  await settle(() => bumpRendererModelFactsVersion());
  expect(readRoute).toHaveBeenCalledTimes(2);
});
