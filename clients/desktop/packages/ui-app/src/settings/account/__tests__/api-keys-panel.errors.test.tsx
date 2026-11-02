/**
 * @jest-environment jsdom
 */
/* eslint-disable @typescript-eslint/require-await -- act() callbacks stay async so React flushes the settled promises they trigger. */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SettingsOperationError } from '@canopy/protocol/settings';
import {
  TestSettingsHost,
  createFakeSettingsClient,
  createTestSettingsHost,
  type FakeSettingsClient,
} from '../../__tests__/helpers/test-settings-host';
import { ApiKeysManager } from '../api-keys-panel';

const SERVER_SENTINEL = 'api-keys-server-sentinel';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  jest.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  jest.useRealTimers();
});

function serverFailure(): SettingsOperationError {
  return new SettingsOperationError({
    code: 'failed',
    status: 500,
    message: SERVER_SENTINEL,
  });
}

async function render(client: FakeSettingsClient): Promise<void> {
  const { host } = createTestSettingsHost({ client });
  await act(async () => {
    root.render(
      <TestSettingsHost host={host}>
        <ApiKeysManager brandDisplayName="Canopy" />
      </TestSettingsHost>,
    );
  });
  // The first read is deferred out of the effect body.
  await act(async () => {
    jest.runOnlyPendingTimers();
  });
}

function buttonNamed(name: string): HTMLButtonElement {
  const button = Array.from(
    container.querySelectorAll<HTMLButtonElement>('button'),
  ).find((candidate) => candidate.textContent?.trim() === name);
  if (button === undefined) throw new Error(`Missing ${name} button`);
  return button;
}

describe('ApiKeysManager errors', () => {
  it('shows load copy, never the server text, and Retry reads again', async () => {
    let reads = 0;
    const client = createFakeSettingsClient({
      'account.apiKeys.list': () => {
        reads += 1;
        if (reads === 1) throw serverFailure();
        return [];
      },
    });
    await render(client);

    expect(container.textContent).toContain("Couldn't load this.");
    expect(container.textContent).not.toContain(SERVER_SENTINEL);

    await act(async () => buttonNamed('Try again').click());

    expect(reads).toBe(2);
    expect(container.textContent).not.toContain("Couldn't load this.");
  });

  it('shows action copy when creating a key fails', async () => {
    const client = createFakeSettingsClient({
      'account.apiKeys.list': () => [],
      'account.apiKeys.create': () => {
        throw serverFailure();
      },
    });
    await render(client);

    await act(async () => buttonNamed('Create manual API key').click());
    const input = container.querySelector('input');
    if (!(input instanceof HTMLInputElement)) throw new Error('Missing input');
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(input, 'Laptop CLI');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const form = input.closest('form');
    if (form === null) throw new Error('Missing form');
    await act(async () => {
      form.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });

    expect(container.textContent).toContain(
      "Couldn't create the API key. Try again.",
    );
    expect(container.textContent).not.toContain(SERVER_SENTINEL);
  });
});
