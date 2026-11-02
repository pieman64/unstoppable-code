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
  act(() => root.render(<OpenCodeAccountCard snapshot={snapshot} />));
  const rows = container.querySelectorAll(
    '[data-testid="opencode-account-row"]',
  );
  expect(rows).toHaveLength(3);
  expect(rows[0]?.textContent).not.toContain('Selected');
  expect(rows[1]?.textContent).toContain('Selected in OpenCode');
  expect(rows[1]?.textContent).toContain('Sign in again');
  expect(rows[2]?.textContent).toContain('Environment variable');
  expect(container.querySelector('h2')?.textContent).toBe(
    'OpenCode · Provider accounts',
  );
  expect(container.textContent).toContain(
    'Plan and usage limits are unavailable from OpenCode.',
  );
  expect(container.textContent).not.toMatch(/authenticated|Unlimited|0%/);
  // Each account's label and its provider's name are blocked from replay.
  expect(container.querySelectorAll(`.${REPLAY_BLOCK_CLASS}`)).toHaveLength(6);
});
it('has no refresh of its own; the host refreshes every usage group', () => {
  act(() => root.render(<OpenCodeAccountCard snapshot={snapshot} />));
  expect(container.querySelector('button')).toBeNull();
});
it('names a provider that reports no accounts and an unavailable read', () => {
  act(() =>
    root.render(
      <OpenCodeAccountCard
        snapshot={{
          ...snapshot,
          providers: [{ id: 'empty', name: 'Empty', accounts: [] }],
        }}
      />,
    ),
  );
  expect(container.textContent).toContain('No account information reported.');
  act(() =>
    root.render(
      <OpenCodeAccountCard
        snapshot={{ ...snapshot, status: 'unavailable', providers: [] }}
      />,
    ),
  );
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    'Account information is unavailable. Try refreshing.',
  );
});
