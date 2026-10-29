/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DigestAutoRefresh } from '../digest-auto-refresh';
import {
  TestSettingsHost,
  createTestSettingsHost,
} from '../../__tests__/helpers/test-settings-host';

const mockRefresh = jest.fn();
// One host for the whole file, so its router is stable across re-renders
// exactly as a real host's is.
const { host } = createTestSettingsHost({ router: { refresh: mockRefresh } });

function Refresh({ active }: { active: boolean }): JSX.Element {
  return (
    <TestSettingsHost host={host}>
      <DigestAutoRefresh active={active} />
    </TestSettingsHost>
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    value: false,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
    await Promise.resolve();
  });
  container.remove();
  jest.useRealTimers();
});

it('refreshes recursively while work is active and stops when it is terminal', async () => {
  await act(async () => {
    root.render(<Refresh active />);
    await Promise.resolve();
  });
  await act(async () => jest.advanceTimersByTimeAsync(20_000));
  expect(mockRefresh).toHaveBeenCalledTimes(2);

  await act(async () => {
    root.render(<Refresh active={false} />);
    await Promise.resolve();
  });
  await act(async () => jest.advanceTimersByTimeAsync(20_000));
  expect(mockRefresh).toHaveBeenCalledTimes(2);
  expect(
    container.querySelector('[data-testid="digest-refresh-now"]'),
  ).toBeNull();
});

it('pauses while hidden and refreshes immediately when visible again', async () => {
  await act(async () => {
    root.render(<Refresh active />);
    await Promise.resolve();
  });
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    value: true,
  });
  document.dispatchEvent(new Event('visibilitychange'));
  await act(async () => jest.advanceTimersByTimeAsync(20_000));
  expect(mockRefresh).not.toHaveBeenCalled();

  Object.defineProperty(document, 'hidden', {
    configurable: true,
    value: false,
  });
  document.dispatchEvent(new Event('visibilitychange'));
  expect(mockRefresh).toHaveBeenCalledTimes(1);
});

it('offers a manual refresh fallback', async () => {
  await act(async () => {
    root.render(<Refresh active />);
    await Promise.resolve();
  });
  const button = container.querySelector('[data-testid="digest-refresh-now"]');
  if (!(button instanceof HTMLButtonElement)) throw new Error('missing button');

  await act(async () => {
    button.click();
    await Promise.resolve();
  });

  expect(mockRefresh).toHaveBeenCalledTimes(1);
});
