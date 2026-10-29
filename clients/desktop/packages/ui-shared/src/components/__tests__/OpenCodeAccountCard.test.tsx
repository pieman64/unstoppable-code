/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { OpenCodeAccountCard } from '../OpenCodeAccountCard';
import type { OpenCodeAccountSnapshot } from '@canopy/protocol/portal';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const snapshot: OpenCodeAccountSnapshot = {
  status: 'ready',
  updatedAt: '2026-10-21T23:00:00Z',
  providers: [
    {
      id: 'provider',
      name: 'Provider',
      accounts: [
        {
          label: 'Personal',
          method: 'key',
          selected: false,
          needsSignIn: false,
        },
        { label: 'Work', method: 'oauth', selected: true, needsSignIn: true },
        {
          label: 'PROVIDER_KEY',
          method: 'env',
          selected: false,
          needsSignIn: false,
        },
      ],
    },
  ],
};
it('shows all reported accounts without treating configured credentials as authenticated or quota data', () => {
  act(() =>
    root.render(
      <OpenCodeAccountCard
        snapshot={snapshot}
        onRefresh={() => Promise.resolve()}
      />,
    ),
  );
  const rows = container.querySelectorAll('li');
  expect(rows).toHaveLength(3);
  expect(rows[0]?.textContent).not.toContain('Selected');
  expect(rows[1]?.textContent).toContain('Selected in OpenCode');
  expect(rows[1]?.textContent).toContain('Sign in again');
  expect(rows[2]?.textContent).toContain('Environment variable');
  expect(container.textContent).toContain(
    'Plan and usage limits are unavailable from OpenCode.',
  );
  expect(container.textContent).not.toMatch(/authenticated|Unlimited|0%/);
  expect(container.querySelectorAll(`.${REPLAY_BLOCK_CLASS}`)).toHaveLength(4);
});
it('keeps refresh disabled when the paired desktop is unavailable', () => {
  const refresh = jest.fn(() => Promise.resolve());
  act(() =>
    root.render(
      <OpenCodeAccountCard snapshot={snapshot} onRefresh={refresh} disabled />,
    ),
  );
  const button = container.querySelector('button');
  expect(button?.disabled).toBe(true);
  act(() => button?.click());
  expect(refresh).not.toHaveBeenCalled();
});
it('reports refresh failures with curated copy', async () => {
  act(() =>
    root.render(
      <OpenCodeAccountCard
        snapshot={snapshot}
        onRefresh={() => Promise.reject(new Error('secret-token'))}
      />,
    ),
  );
  await act(() => {
    container.querySelector('button')?.click();
    return Promise.resolve();
  });
  expect(container.textContent).toContain(
    'Could not refresh accounts. Try again.',
  );
  expect(container.textContent).not.toContain('secret-token');
});
