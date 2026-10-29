/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { McpOAuthBrowser } from '../McpOAuthBrowser';
import { useTryItSetupPaneStore } from '@/stores/tryItSetupPaneStore';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
const mockCreate = jest.fn<
  Promise<{ id: string }>,
  [string, string, { url: string }]
>();
const mockDestroy = jest.fn<void, [string, string, string]>();
jest.mock('@/lib/panels/browser-panel-sync', () => ({
  requestBrowserSessionDestruction: (
    ...args: [string, string, string]
  ): void => {
    mockDestroy(...args);
  },
}));
jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: (): void => undefined,
}));
jest.mock('@/stores/browserEventSubscription', () => ({
  ensureBrowserEventSubscription: (): void => undefined,
}));
jest.mock('@/stores/browserStore', () => ({
  useBrowserStore: {
    getState: (): { createBrowser: typeof mockCreate } => ({
      createBrowser: mockCreate,
    }),
  },
}));
jest.mock('@/components/browser/BrowserPane', () => ({
  BrowserPane: ({ visible }: { visible: boolean }): JSX.Element => (
    <div data-testid="native-pane" data-visible={visible} />
  ),
}));
jest.mock('@/components/shared/loading', () => ({
  LoadingPlaceholder: (): null => null,
}));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  useTryItSetupPaneStore.setState({ pane: null, reservation: null });
  mockCreate.mockReset().mockResolvedValue({ id: 'browser-1' });
  mockDestroy.mockClear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
it('preserves Marketplace defaults and releases only its own session', async () => {
  await act(async () => {
    root.render(
      <McpOAuthBrowser url="https://fixture.test" onClose={() => undefined} />,
    );
    await Promise.resolve();
  });
  expect(container.textContent).toContain('Sign in to connect');
  expect(container.textContent).toContain('Open in browser');
  expect(container.querySelector('[data-visible="true"]')).not.toBeNull();
  act(() => root.unmount());
  expect(mockDestroy).toHaveBeenCalledTimes(1);
  expect(mockDestroy.mock.calls[0]?.[2]).toBe('browser-1');
  expect(useTryItSetupPaneStore.getState().reservation).toBeNull();
  root = createRoot(container);
});
it('refuses a competing chat or Marketplace native view', async () => {
  const error = jest.fn();
  await act(async () => {
    root.render(
      <>
        <McpOAuthBrowser
          url="https://fixture.test/first"
          onClose={() => undefined}
        />
        <McpOAuthBrowser
          url="https://fixture.test/second"
          onClose={() => undefined}
          onError={error}
        />
      </>,
    );
    await Promise.resolve();
  });
  expect(mockCreate).toHaveBeenCalledTimes(1);
  expect(error).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain('Another connection');
});
it('uses a chat reservation without offering the single-use URL externally', async () => {
  const owner = {};
  useTryItSetupPaneStore.getState().reserve(owner);
  await act(async () => {
    root.render(
      <McpOAuthBrowser
        owner={owner}
        url="https://fixture.test/once"
        visible={false}
        allowExternalOpen={false}
        title="Authorize Linear"
        onClose={() => undefined}
      />,
    );
    await Promise.resolve();
  });
  expect(container.textContent).toContain('Authorize Linear');
  expect(container.textContent).not.toContain('Open in browser');
  expect(container.querySelector('[data-visible="false"]')).not.toBeNull();
});
