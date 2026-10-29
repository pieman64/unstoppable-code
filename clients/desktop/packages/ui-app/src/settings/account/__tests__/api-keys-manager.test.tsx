/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  TestSettingsHost,
  createFakeSettingsClient,
  createTestSettingsHost,
  type FakeSettingsClient,
} from '../../__tests__/helpers/test-settings-host';
import { ApiKeysManager } from '../api-keys-panel';

const KEY = {
  id: 'key-1',
  name: 'Laptop CLI',
  source: 'MANUAL',
  createdIp: null,
  createdAt: '2026-01-02T10:00:00.000Z',
  lastUsedAt: null,
};

let container: HTMLElement;
let root: Root;
let client: FakeSettingsClient;

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
    await Promise.resolve();
  });
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Button not found: ${label}`);
  return found;
}

async function click(label: string): Promise<void> {
  await act(async () => {
    button(label).click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  client = createFakeSettingsClient({
    'account.apiKeys.list': () => [KEY],
    'account.apiKeys.create': () => ({
      userApiKey: { ...KEY, id: 'key-2', name: 'CI' },
      token: 'csk_secret_value',
    }),
    'account.apiKeys.revoke': () => null,
  });
  const { host } = createTestSettingsHost({
    client,
    privacy: { blockClassName: 'dd-privacy-hidden', maskClassName: '' },
  });
  act(() => {
    root.render(
      <TestSettingsHost host={host}>
        <ApiKeysManager brandDisplayName="Canopy" />
      </TestSettingsHost>,
    );
  });
  await settle();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it('creates a key and shows its token once, blocked from replay', async () => {
  await click('Create manual API key');
  const input = container.querySelector<HTMLInputElement>('input[type="text"]');
  if (!input) throw new Error('missing name input');
  act(() => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set?.call(input, ' CI ');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    input
      .closest('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(
    client.calls.filter((call) => call.operation === 'account.apiKeys.create'),
  ).toEqual([{ operation: 'account.apiKeys.create', input: { name: 'CI' } }]);
  const token = Array.from(container.querySelectorAll('code')).find(
    (code) => code.textContent === 'csk_secret_value',
  );
  expect(token?.classList.contains('dd-privacy-hidden')).toBe(true);

  await click('Done');
  expect(container.textContent).not.toContain('csk_secret_value');
});

it('revokes a key after confirmation', async () => {
  await click('Delete');
  await click('Confirm');

  expect(
    client.calls.filter((call) => call.operation === 'account.apiKeys.revoke'),
  ).toEqual([
    { operation: 'account.apiKeys.revoke', input: { apiKeyId: 'key-1' } },
  ]);
  expect(container.textContent).not.toContain('Laptop CLI');
});
