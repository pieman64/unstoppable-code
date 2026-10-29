/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  SettingsOperationError,
  settingsErrorCodeForStatus,
} from '@canopy/protocol/settings';
import {
  DigestRequestForm,
  type DigestRequestCredits,
} from '../digest-request-form';
import type { DigestOwner } from '../digest-api';
import {
  TestSettingsHost,
  createFakeSettingsClient,
  createTestSettingsHost,
  type FakeSettingsClient,
} from '../../__tests__/helpers/test-settings-host';

const mockRefresh = jest.fn();

const FUNDED: DigestRequestCredits = {
  spendable: true,
  balanceCredits: 12.5,
  fundingKey: 12.5,
  fundingLabel: null,
};

let container: HTMLDivElement;
let root: Root;
let client: FakeSettingsClient = createFakeSettingsClient();

/**
 * What the server answered. A 2xx resolves with the body; anything else
 * rejects the way the settings client does, with the status and the body's
 * string `error` as the message.
 */
function reply(status: number, body: unknown): unknown {
  if (status >= 200 && status < 300) return body;
  const message =
    typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    typeof body.error === 'string'
      ? body.error
      : undefined;
  throw new SettingsOperationError({
    code: settingsErrorCodeForStatus(status, { write: true }),
    status,
    ...(message !== undefined ? { message } : {}),
  });
}

/** Answer both request operations with `impl`. */
function mockRequest(impl: (input: unknown) => unknown): FakeSettingsClient {
  client = createFakeSettingsClient({
    'account.digests.request': impl,
    'organization.digests.request': impl,
  });
  return client;
}

const { host } = createTestSettingsHost({
  router: { refresh: mockRefresh },
  client: {
    read: (operation, input) => client.read(operation, input),
    write: (operation, input) => client.write(operation, input),
    subscribe: (scope, listener) => client.subscribe(scope, listener),
  },
});

/**
 * Re-rendering with a different `credits` object models a REFRESH: the page
 * re-reads the payer's balance server-side and hands the form a fresh snapshot.
 */
async function renderForm(
  credits: DigestRequestCredits = FUNDED,
  owner: DigestOwner = { kind: 'account' },
): Promise<void> {
  await act(async () => {
    root.render(
      <TestSettingsHost host={host}>
        <DigestRequestForm
          owner={owner}
          testIdPrefix="account"
          credits={credits}
        />
      </TestSettingsHost>,
    );
    await Promise.resolve();
  });
}

function input(name: 'start' | 'end'): HTMLInputElement {
  const node = container.querySelector(
    `[data-testid="account-digest-request-${name}"]`,
  );
  if (!(node instanceof HTMLInputElement)) {
    throw new Error(`missing ${name} input`);
  }
  return node;
}

function submitButton(): HTMLButtonElement {
  const node = container.querySelector(
    '[data-testid="account-digest-request-submit"]',
  );
  if (!(node instanceof HTMLButtonElement)) {
    throw new Error('missing submit button');
  }
  return node;
}

function creditsLine(): HTMLElement {
  const node = container.querySelector(
    '[data-testid="account-digest-request-credits"]',
  );
  if (!(node instanceof HTMLElement)) throw new Error('missing credits line');
  return node;
}

/** Null when funded: the credits line renders only in the blocked state. */
function creditsLineOrNull(): Element | null {
  return container.querySelector(
    '[data-testid="account-digest-request-credits"]',
  );
}

function introLine(): HTMLElement {
  const node = container.querySelector(
    '[data-testid="account-digest-request-intro"]',
  );
  if (!(node instanceof HTMLElement)) throw new Error('missing intro line');
  return node;
}

/**
 * React installs its own `value` setter on controlled inputs to track changes,
 * so assigning `node.value` directly is invisible to it. Go through the native
 * prototype setter, which is what Testing Library does internally.
 */
function setInputValue(node: HTMLInputElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  );
  if (!descriptor?.set) throw new Error('missing native value setter');
  descriptor.set.call(node, value);
  node.dispatchEvent(new Event('input', { bubbles: true }));
}

async function fillRange(start: string, end: string): Promise<void> {
  await act(async () => {
    setInputValue(input('start'), start);
    await Promise.resolve();
  });
  await act(async () => {
    setInputValue(input('end'), end);
    await Promise.resolve();
  });
}

async function submit(): Promise<void> {
  await act(async () => {
    const form = container.querySelector('form');
    if (!form) throw new Error('missing form');
    form.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await Promise.resolve();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
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
});

describe('DigestRequestForm', () => {
  it('posts the raw calendar dates the inputs emit, never a constructed Date', async () => {
    // This is the whole reason the route takes `z.iso.date()`. Synthesizing an
    // instant client-side shifts the range a day for every viewer west of UTC.
    mockRequest(() =>
      reply(202, { status: 'enqueued', digestExternalId: 'd-1' }),
    );

    await renderForm();
    await fillRange('2026-06-13', '2026-06-17');
    await submit();

    expect(client.calls).toStrictEqual([
      {
        operation: 'account.digests.request',
        input: { startDate: '2026-06-13', endDate: '2026-06-17' },
      },
    ]);
  });

  it('requests an organization digest through the organization operation', async () => {
    mockRequest(() =>
      reply(202, { status: 'enqueued', digestExternalId: 'd-1' }),
    );

    await renderForm(FUNDED, { kind: 'organization', organizationId: 'org-1' });
    await fillRange('2026-06-13', '2026-06-17');
    await submit();

    expect(client.calls).toStrictEqual([
      {
        operation: 'organization.digests.request',
        input: {
          organizationId: 'org-1',
          startDate: '2026-06-13',
          endDate: '2026-06-17',
        },
      },
    ]);
  });

  it('reports an accepted request whose body could not be read as queued', async () => {
    mockRequest(() => {
      throw new SettingsOperationError({
        code: 'invalid_response',
        status: 202,
      });
    });

    await renderForm();
    await fillRange('2026-06-13', '2026-06-17');
    await submit();

    expect(container.textContent).toContain('Digest requested.');
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('says the outcome is unknown when the request may have gone through', async () => {
    mockRequest(() => {
      throw new SettingsOperationError({ code: 'uncertain' });
    });

    await renderForm();
    await fillRange('2026-06-13', '2026-06-17');
    await submit();

    expect(container.textContent).toContain(
      "Couldn't confirm that finished. Refresh to check before trying again.",
    );
  });

  it('shows generic action copy, never the server text, for an unknown failure', async () => {
    mockRequest(() =>
      reply(500, { error: 'SENTINEL Digest request failed: db timeout' }),
    );

    await renderForm();
    await fillRange('2026-06-13', '2026-06-17');
    await submit();

    expect(container.textContent).toContain(
      "Couldn't request that digest. Try again.",
    );
    expect(container.textContent).not.toContain('SENTINEL');
  });

  it('explains a throttled request without the server text', async () => {
    mockRequest(() =>
      reply(429, {
        error:
          'SENTINEL Too many recent digest requests failed or produced no activity; try again later',
      }),
    );

    await renderForm();
    await fillRange('2026-06-13', '2026-06-17');
    await submit();

    expect(container.textContent).toContain(
      'Too many recent digests failed or had no activity to report. Try again later.',
    );
    expect(container.textContent).not.toContain('SENTINEL');
  });

  it('states the billing model once, in the intro', async () => {
    mockRequest(() => reply(202, { status: 'enqueued' }));

    await renderForm({
      spendable: true,
      balanceCredits: 12.5,
      fundingKey: 12.5,
      fundingLabel: null,
    });

    expect(introLine().textContent).toBe(
      'Generate a one-off report covering any range of up to 90 days. ' +
        'A report ending today covers everything so far today (dates are ' +
        'UTC). Reports are billed to your AI credits based on usage.',
    );
    // The credits line below the form is the BLOCKED state only, so a funded
    // requester is not told the same thing twice.
    expect(creditsLineOrNull()).toBeNull();
  });

  // Same intro on the org form. Neither the wallet figure nor the pool it
  // spills into is restated: the viewer already knows what credits are.
  it('keeps the org form to the same intro when a pool backs the wallet', async () => {
    mockRequest(() => reply(202, { status: 'enqueued' }));

    await renderForm({
      spendable: true,
      balanceCredits: 3,
      fundingKey: 3,
      fundingLabel: 'Acme',
    });

    expect(introLine().textContent).toContain(
      'billed to your AI credits based on usage.',
    );
    expect(introLine().textContent).not.toContain('Acme');
    expect(creditsLineOrNull()).toBeNull();
  });

  it('lets a funded requester submit repeatedly, with no ration to spend down', async () => {
    // The point of the change: there is no per-period allowance any more, so
    // two back-to-back requests both go through and nothing counts down.
    mockRequest(() =>
      reply(202, { status: 'enqueued', digestExternalId: 'd-1' }),
    );

    await renderForm();
    await fillRange('2026-06-13', '2026-06-17');
    await submit();
    await fillRange('2026-06-01', '2026-06-07');
    await submit();

    expect(client.calls).toHaveLength(2);
    expect(submitButton().disabled).toBe(false);
  });

  it('reports success and refreshes the archive', async () => {
    mockRequest(() =>
      reply(202, { status: 'enqueued', digestExternalId: 'd-1' }),
    );

    await renderForm();
    await fillRange('2026-06-13', '2026-06-17');
    await submit();

    expect(container.textContent).toContain(
      'We’ll update this page automatically and email you when it’s ready',
    );
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('reports a duplicate range without claiming a new digest was queued', async () => {
    mockRequest(() =>
      reply(200, { status: 'already_exists', digestExternalId: 'd-1' }),
    );

    await renderForm();
    await fillRange('2026-06-13', '2026-06-17');
    await submit();

    expect(container.textContent).toContain(
      'You already have a digest for that range',
    );
  });

  it('blocks submission and links to billing when the wallet is empty', async () => {
    mockRequest(() => reply(202, { status: 'enqueued' }));

    await renderForm({
      spendable: false,
      balanceCredits: 0,
      fundingKey: 0,
      fundingLabel: null,
    });
    await fillRange('2026-06-13', '2026-06-17');

    expect(creditsLine().textContent).toContain('out of AI credits');
    expect(submitButton().disabled).toBe(true);
    expect(input('start').disabled).toBe(true);
    expect(creditsLine().querySelector('a')?.getAttribute('href')).toBe(
      '/account/billing',
    );
  });

  it('adopts a 402 from submit as a state rather than an error banner', async () => {
    // The page's server read can predate the wallet draining in another tab.
    // The credits line already carries the top-up link, so a banner on top of
    // it would say the same thing twice — being broke is a state, not an error.
    mockRequest(() =>
      reply(402, {
        error: {
          code: 'insufficient_credits',
          message: 'Not enough AI credits to generate this digest',
        },
      }),
    );

    await renderForm({
      spendable: true,
      balanceCredits: 0.2,
      fundingKey: 0.2,
      fundingLabel: null,
    });
    await fillRange('2026-06-13', '2026-06-17');
    await submit();

    expect(creditsLine().textContent).toContain('out of AI credits');
    expect(submitButton().disabled).toBe(true);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    // ...and it asks the server to catch up rather than trusting itself.
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('keeps the 402 state while the refreshed balance is unchanged', async () => {
    // A rejected request bills nothing, so a refresh that reports the same
    // balance means the wallet is still empty. Retiring the rejection on any
    // re-render would re-enable a button whose every press 402s.
    mockRequest(() =>
      reply(402, {
        error: { code: 'insufficient_credits', message: 'no credits' },
      }),
    );

    await renderForm({
      spendable: true,
      balanceCredits: 0.2,
      fundingKey: 0.2,
      fundingLabel: null,
    });
    await fillRange('2026-06-13', '2026-06-17');
    await submit();

    await renderForm({
      spendable: true,
      balanceCredits: 0.2,
      fundingKey: 0.2,
      fundingLabel: null,
    });

    expect(submitButton().disabled).toBe(true);
  });

  it('retires the 402 state once a top-up changes the balance', async () => {
    mockRequest(() =>
      reply(402, {
        error: { code: 'insufficient_credits', message: 'no credits' },
      }),
    );

    await renderForm({
      spendable: true,
      balanceCredits: 0.2,
      fundingKey: 0.2,
      fundingLabel: null,
    });
    await fillRange('2026-06-13', '2026-06-17');
    await submit();
    expect(submitButton().disabled).toBe(true);

    // The user tops up in another tab; the refresh brings back a new balance.
    await renderForm({
      spendable: true,
      balanceCredits: 50,
      fundingKey: 50,
      fundingLabel: null,
    });

    expect(submitButton().disabled).toBe(false);
  });

  it('retires the 402 state for an org-pool-funded requester whose wallet stays at 0', async () => {
    // Regression: the rejection used to key on `balanceCredits`, which is
    // permanently 0 for a requester funded entirely by an org pool — exactly the
    // case `fundingLabel` describes. `0 === 0` held forever, so ONE 402 disabled
    // the form for good, still claiming "You're out of AI credits" after the
    // pool was refunded, until a full page reload.
    mockRequest(() =>
      reply(402, {
        error: { code: 'insufficient_credits', message: 'no credits' },
      }),
    );

    await renderForm({
      spendable: true,
      balanceCredits: 0,
      fundingKey: 4,
      fundingLabel: 'Acme',
    });
    await fillRange('2026-06-13', '2026-06-17');
    await submit();
    expect(submitButton().disabled).toBe(true);

    // The pool drained, so the refresh honestly reports nothing spendable.
    await renderForm({
      spendable: false,
      balanceCredits: 0,
      fundingKey: 0,
      fundingLabel: 'Acme',
    });
    expect(submitButton().disabled).toBe(true);

    // An admin tops the POOL up. The personal wallet is still 0, but the
    // funding key moved, so the form must become usable again.
    await renderForm({
      spendable: true,
      balanceCredits: 0,
      fundingKey: 250,
      fundingLabel: 'Acme',
    });

    expect(submitButton().disabled).toBe(false);
  });

  it('surfaces a disabled generator as a retryable message', async () => {
    mockRequest(() =>
      reply(503, { error: 'Work Digest generation is disabled' }),
    );

    await renderForm();
    await fillRange('2026-06-13', '2026-06-17');
    await submit();

    expect(container.textContent).toContain(
      'Digest generation is temporarily unavailable',
    );
  });

  it('self-gates to nothing when the surface does not exist for this viewer', async () => {
    // 404 = flag off; 403 = org edit rights revoked in another tab. Both mean
    // the form must disappear rather than strand a control that always fails.
    mockRequest(() => reply(404, { error: 'Not found' }));

    await renderForm();
    await fillRange('2026-06-13', '2026-06-17');
    await submit();

    expect(
      container.querySelector('[data-testid="account-digest-request"]'),
    ).toBeNull();
  });

  it('explains a rejected range with local copy, never the route text', async () => {
    mockRequest(() =>
      reply(400, { error: 'SENTINEL Digest range cannot exceed 90 days' }),
    );

    await renderForm();
    await fillRange('2026-01-01', '2026-06-17');
    await submit();

    expect(container.textContent).toContain(
      'Choose a range of 90 days or less that ends today or earlier.',
    );
    expect(container.textContent).not.toContain('SENTINEL');
  });

  it('bounds the pickers to today so the browser enforces the rule too', async () => {
    mockRequest(() => reply(202, { status: 'enqueued' }));

    await renderForm();
    await fillRange('2026-06-13', '');

    // Today is selectable now that a range may still be in progress; the
    // browser still blocks tomorrow, matching the route's inclusive-end check.
    const today = new Date().toISOString().slice(0, 10);
    expect(input('start').getAttribute('max')).toBe(today);
    expect(input('end').getAttribute('max')).toBe(today);
    expect(input('end').getAttribute('min')).toBe('2026-06-13');
  });
});
