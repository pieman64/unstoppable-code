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
import { DigestPreferencesCard } from '../digest-preferences-card';
import type { DigestOwner } from '../digest-api';
import {
  TestSettingsHost,
  createFakeSettingsClient,
  createTestSettingsHost,
  type FakeSettingsClient,
} from '../../__tests__/helpers/test-settings-host';

let container: HTMLDivElement;
let root: Root;
let client: FakeSettingsClient = createFakeSettingsClient();

/**
 * What the server answered. A 2xx resolves with the body; anything else
 * rejects the way the settings client does, carrying the status.
 */
function reply(status: number, body: unknown, write = false): unknown {
  if (status >= 200 && status < 300) return body;
  throw new SettingsOperationError({
    code: settingsErrorCodeForStatus(status, { write }),
    status,
  });
}

/**
 * Answer every preferences operation with `impl`, which receives the
 * request's method (`GET` for reads, `PATCH` for writes) and its input.
 */
function mockPreferences(
  impl: (method: 'GET' | 'PATCH', input: unknown) => unknown,
): FakeSettingsClient {
  client = createFakeSettingsClient({
    'account.notifications.digestPreferences.read': (input) =>
      impl('GET', input),
    'account.notifications.digestPreferences.update': (input) =>
      impl('PATCH', input),
    'organization.digests.preferences': (input) => impl('GET', input),
    'organization.digests.preferences.update': (input) => impl('PATCH', input),
  });
  return client;
}

async function renderCard(
  owner: DigestOwner = { kind: 'account' },
): Promise<void> {
  const { host } = createTestSettingsHost({ client });
  await act(async () => {
    root.render(
      <TestSettingsHost host={host}>
        <DigestPreferencesCard
          owner={owner}
          title="Work digests"
          description="Summary of what you shipped."
          testIdPrefix="account"
        />
      </TestSettingsHost>,
    );
    await Promise.resolve();
  });
}

function toggle(field: string): HTMLButtonElement {
  const node = container.querySelector(
    `[data-testid="account-digest-toggle-${field}"]`,
  );
  if (!(node instanceof HTMLButtonElement)) {
    throw new Error(`Missing toggle for ${field}`);
  }
  return node;
}

beforeEach(() => {
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

describe('DigestPreferencesCard', () => {
  it('renders the stored cadences returned by the API', async () => {
    mockPreferences(() =>
      reply(200, { daily: true, weekly: false, monthly: false }),
    );

    await renderCard();

    expect(toggle('daily').getAttribute('aria-checked')).toBe('true');
    expect(toggle('weekly').getAttribute('aria-checked')).toBe('false');
    expect(toggle('monthly').getAttribute('aria-checked')).toBe('false');
  });

  it('renders nothing when the digests flag is off (route answers 404)', async () => {
    // The flag has one source of truth -- `requireDigestsEnabled` server-side.
    // The card must treat that 404 as "surface does not exist", NOT as an
    // error banner and NOT as three off toggles the user could click.
    mockPreferences(() => reply(404, { error: 'Not found' }));

    await renderCard();

    expect(
      container.querySelector('[data-testid="account-digest-preferences"]'),
    ).toBeNull();
  });

  it('PATCHes the complete preference object, not just the changed cadence', async () => {
    // The route rejects a partial body (all three booleans are required), so a
    // diff-style payload would 400 on every toggle. The anchors ride along for
    // the same reason: the card's old parse dropped unknown keys, which would
    // have reset the user's anchor to the default on the next toggle.
    const patchBodies: unknown[] = [];
    mockPreferences((method, input) => {
      if (method === 'PATCH') {
        patchBodies.push(input);
        return reply(200, {
          daily: false,
          weekly: true,
          monthly: true,
          weeklyAnchorDay: 4,
          monthlyAnchorDay: 12,
        });
      }
      return reply(200, {
        daily: false,
        weekly: true,
        monthly: false,
        weeklyAnchorDay: 4,
        monthlyAnchorDay: 12,
      });
    });

    await renderCard();
    await act(async () => {
      toggle('monthly').click();
      await Promise.resolve();
    });

    expect(patchBodies).toStrictEqual([
      {
        daily: false,
        weekly: true,
        monthly: true,
        weeklyAnchorDay: 4,
        monthlyAnchorDay: 12,
      },
    ]);
    expect(toggle('monthly').getAttribute('aria-checked')).toBe('true');
  });

  it('renders the server anchors and PATCHes a changed one', async () => {
    const patchBodies: unknown[] = [];
    mockPreferences((method, input) => {
      if (method === 'PATCH') {
        patchBodies.push(input);
        return reply(200, input);
      }
      return reply(200, {
        daily: false,
        weekly: true,
        monthly: false,
        weeklyAnchorDay: 3,
        monthlyAnchorDay: 1,
      });
    });

    await renderCard();

    const weeklyAnchor = container.querySelector<HTMLSelectElement>(
      '[data-testid="account-digest-anchor-weekly"]',
    );
    if (!weeklyAnchor) throw new Error('weekly anchor select missing');
    expect(weeklyAnchor.value).toBe('3');
    // The description is derived from the anchor, not hardcoded to Monday.
    expect(container.textContent).toContain(
      'Every Wednesday, covering the previous week.',
    );

    await act(async () => {
      weeklyAnchor.value = '5';
      weeklyAnchor.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    expect(patchBodies).toStrictEqual([
      {
        daily: false,
        weekly: true,
        monthly: false,
        weeklyAnchorDay: 5,
        monthlyAnchorDay: 1,
      },
    ]);
    expect(container.textContent).toContain(
      'Every Friday, covering the previous week.',
    );
  });

  it('adopts the server response rather than the optimistic value', async () => {
    // The routes return the full projected object; if the server clamped or
    // normalized the write, the card must show what was actually persisted.
    mockPreferences((method) =>
      method === 'PATCH'
        ? reply(200, { daily: false, weekly: false, monthly: false })
        : reply(200, { daily: false, weekly: true, monthly: false }),
    );

    await renderCard();
    await act(async () => {
      toggle('daily').click();
      await Promise.resolve();
    });

    expect(toggle('daily').getAttribute('aria-checked')).toBe('false');
    expect(toggle('weekly').getAttribute('aria-checked')).toBe('false');
  });

  it('hides the card when a save reports the surface is gone', async () => {
    // 404/403 mean the same thing on PATCH as on GET: the flag was flipped off,
    // or org edit rights were revoked in another tab. Folding them into the
    // generic error banner leaves toggles that fail on every future click.
    mockPreferences((method) =>
      method === 'PATCH'
        ? reply(404, { error: 'Not found' }, true)
        : reply(200, { daily: false, weekly: true, monthly: false }),
    );

    await renderCard();
    await act(async () => {
      toggle('daily').click();
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-testid="account-digest-preferences"]'),
    ).toBeNull();
  });

  it('never writes placeholder defaults back when the initial load failed', async () => {
    // A 5xx leaves `preferences` holding DEFAULT_DIGEST_PREFERENCES, which is
    // weekly-on. Toggling from those would PATCH a value the user never chose
    // over whatever they actually had stored.
    const methods: string[] = [];
    mockPreferences((method) => {
      methods.push(method);
      return reply(500, { error: 'boom' });
    });

    await renderCard();

    expect(container.textContent).toContain("Couldn't load this. Try again.");
    expect(toggle('daily').disabled).toBe(true);
    await act(async () => {
      toggle('daily').click();
      await Promise.resolve();
    });

    expect(methods).toStrictEqual(['GET']);
  });

  it('rolls the toggle back and surfaces an error when the save fails', async () => {
    mockPreferences((method) =>
      method === 'PATCH'
        ? reply(500, { error: 'boom' }, true)
        : reply(200, { daily: false, weekly: true, monthly: false }),
    );

    await renderCard();
    await act(async () => {
      toggle('daily').click();
      await Promise.resolve();
    });

    expect(toggle('daily').getAttribute('aria-checked')).toBe('false');
    expect(container.textContent).toContain(
      "Couldn't save digest settings. Try again.",
    );
    // A failed save is retried by saving again, not by a Retry action.
    expect(container.textContent).not.toContain('Retry');
  });

  it('reads the preferences again from Retry after a failed load', async () => {
    let reads = 0;
    mockPreferences((method) => {
      if (method === 'PATCH') throw new Error('unexpected write');
      reads += 1;
      return reads === 1
        ? reply(500, { error: 'SENTINEL boom' })
        : reply(200, { daily: true, weekly: false, monthly: false });
    });

    await renderCard();
    expect(container.textContent).not.toContain('SENTINEL');
    const retry = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Retry',
    );
    if (retry === undefined) throw new Error('No Retry button');
    await act(async () => {
      retry.click();
      await Promise.resolve();
    });

    expect(reads).toBe(2);
    expect(container.textContent).not.toContain("Couldn't load this.");
    expect(toggle('daily').disabled).toBe(false);
    expect(toggle('daily').getAttribute('aria-checked')).toBe('true');
  });

  it('reads and writes an organization through the organization operations', async () => {
    mockPreferences((method, input) =>
      method === 'PATCH'
        ? reply(200, input)
        : reply(200, {
            daily: false,
            weekly: true,
            monthly: false,
            weeklyAnchorDay: 1,
            monthlyAnchorDay: 1,
          }),
    );

    await renderCard({ kind: 'organization', organizationId: 'org-1' });
    await act(async () => {
      toggle('daily').click();
      await Promise.resolve();
    });

    expect(client.calls).toStrictEqual([
      {
        operation: 'organization.digests.preferences',
        input: { organizationId: 'org-1' },
      },
      {
        operation: 'organization.digests.preferences.update',
        input: {
          organizationId: 'org-1',
          daily: true,
          weekly: true,
          monthly: false,
          weeklyAnchorDay: 1,
          monthlyAnchorDay: 1,
        },
      },
    ]);
  });

  it('reads and writes the viewer through the account operations', async () => {
    mockPreferences((method, input) =>
      method === 'PATCH'
        ? reply(200, input)
        : reply(200, {
            daily: false,
            weekly: true,
            monthly: false,
            weeklyAnchorDay: 1,
            monthlyAnchorDay: 1,
          }),
    );

    await renderCard();
    await act(async () => {
      toggle('daily').click();
      await Promise.resolve();
    });

    expect(client.calls.map((call) => call.operation)).toStrictEqual([
      'account.notifications.digestPreferences.read',
      'account.notifications.digestPreferences.update',
    ]);
    expect(client.calls[0]?.input).toStrictEqual({});
  });

  it('hides the card when the organization denies access (403)', async () => {
    mockPreferences(() => reply(403, { error: 'Forbidden' }));

    await renderCard({ kind: 'organization', organizationId: 'org-1' });

    expect(
      container.querySelector('[data-testid="account-digest-preferences"]'),
    ).toBeNull();
  });
});
