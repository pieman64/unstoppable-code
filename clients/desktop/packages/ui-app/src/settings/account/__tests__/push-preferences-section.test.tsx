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
  TestSettingsHost,
  createFakeSettingsClient,
  createTestSettingsHost,
  type FakeSettingsClient,
} from '../../__tests__/helpers/test-settings-host';
import { SettingsOperationError } from '@canopy/protocol/settings';
import { PushPreferencesSection } from '../push-preferences-section';

const SERVER_SENTINEL = 'push-preferences-server-sentinel';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

let client: FakeSettingsClient;

function stubClient(pushEnabled: boolean, bodies: unknown[] = []): void {
  client = createFakeSettingsClient({
    'account.notifications.push.read': () => ({ pushEnabled }),
    'account.notifications.push.update': (input) => {
      bodies.push(input);
      return { pushEnabled };
    },
  });
}

async function render(): Promise<void> {
  const { host } = createTestSettingsHost({ client });
  await act(async () => {
    root.render(
      <TestSettingsHost host={host}>
        <PushPreferencesSection />
      </TestSettingsHost>,
    );
  });
}

function card(): HTMLElement {
  const value = container.querySelector(
    '[data-testid="account-push-preferences"]',
  );
  if (!(value instanceof HTMLElement)) throw new Error('Missing card');
  return value;
}

describe('PushPreferencesSection', () => {
  // This section goes through `SettingsCard`, like the sibling Work digests
  // section on the same page; these assertions keep the two from diverging.
  it('renders as a settings section with a text-only title and subtitle', async () => {
    stubClient(true);
    await render();

    expect(card()).not.toBeNull();
    expect(card().querySelector('h2')?.textContent).toBe('Push notifications');
    expect(card().querySelector('.bg-accent-subtle')).toBeNull();
    expect(card().textContent).toContain('Push notifications');
    expect(card().textContent).toContain(
      'Send alerts to devices where you are signed in',
    );
  });

  it('holds the setting row with a form skeleton until the read settles', async () => {
    client = createFakeSettingsClient({
      'account.notifications.push.read': () =>
        new Promise<never>(() => undefined),
    });
    await render();

    expect(
      card()
        .querySelector('[data-testid="settings-skeleton-form"]')
        ?.getAttribute('role'),
    ).toBe('status');
    expect(card().textContent).not.toContain('Loading notification settings');
    expect(
      container.querySelector('[data-testid="account-push-toggle"]'),
    ).toBeNull();
  });

  it('shows load copy, never the server text, and Retry reads again', async () => {
    let reads = 0;
    client = createFakeSettingsClient({
      'account.notifications.push.read': () => {
        reads += 1;
        if (reads === 1) {
          throw new SettingsOperationError({
            code: 'failed',
            status: 500,
            message: SERVER_SENTINEL,
          });
        }
        return { pushEnabled: true };
      },
    });
    await render();

    expect(card().textContent).toContain("Couldn't load this.");
    expect(card().textContent).not.toContain(SERVER_SENTINEL);
    expect(
      container.querySelector('[data-testid="account-push-toggle"]'),
    ).toBeNull();

    const retry = Array.from(
      card().querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === 'Try again');
    if (retry === undefined) throw new Error('Missing Retry');
    await act(async () => retry.click());

    expect(reads).toBe(2);
    expect(card().textContent).not.toContain("Couldn't load this.");
    expect(
      container
        .querySelector('[data-testid="account-push-toggle"]')
        ?.getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('shows action copy when a save fails and restores the toggle', async () => {
    client = createFakeSettingsClient({
      'account.notifications.push.read': () => ({ pushEnabled: true }),
      'account.notifications.push.update': () => {
        throw new SettingsOperationError({
          code: 'failed',
          status: 500,
          message: SERVER_SENTINEL,
        });
      },
    });
    await render();

    const toggle = container.querySelector(
      '[data-testid="account-push-toggle"]',
    );
    if (!(toggle instanceof HTMLButtonElement))
      throw new Error('Missing toggle');
    await act(async () => toggle.click());

    expect(card().textContent).toContain(
      "Couldn't save notification settings. Try again.",
    );
    expect(card().textContent).not.toContain(SERVER_SENTINEL);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  it('keeps the toggle wired through the refactor', async () => {
    const bodies: unknown[] = [];
    stubClient(true, bodies);
    await render();

    const toggle = container.querySelector(
      '[data-testid="account-push-toggle"]',
    );
    if (!(toggle instanceof HTMLButtonElement))
      throw new Error('Missing toggle');
    expect(toggle.getAttribute('aria-checked')).toBe('true');

    await act(async () => toggle.click());

    expect(bodies).toEqual([{ pushEnabled: false }]);
  });
});
