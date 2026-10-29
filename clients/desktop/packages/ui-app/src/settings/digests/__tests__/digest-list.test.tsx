/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DigestList, type DigestListItem } from '../digest-list';
import {
  TestSettingsHost,
  createTestSettingsHost,
} from '../../__tests__/helpers/test-settings-host';

let container: HTMLDivElement;
let root: Root;

function item(overrides: Partial<DigestListItem> = {}): DigestListItem {
  return {
    externalId: 'digest-1',
    cadence: 'WEEKLY',
    periodStart: '2026-06-08T00:00:00.000Z',
    periodEnd: '2026-06-15T00:00:00.000Z',
    headline: 'Shipped the thing',
    variant: 'STANDARD',
    status: 'READY',
    createdAt: new Date().toISOString(),
    billedCredits: null,
    ...overrides,
  };
}

async function renderList(
  digests: DigestListItem[],
  privacy = { blockClassName: '', maskClassName: '' },
): Promise<void> {
  const { host } = createTestSettingsHost({ privacy });
  await act(async () => {
    root.render(
      <TestSettingsHost host={host}>
        <DigestList
          digests={digests}
          basePath="/account/digests"
          emptyMessage="No digests yet."
        />
      </TestSettingsHost>,
    );
    await Promise.resolve();
  });
}

function row(externalId: string): HTMLElement {
  const node = container.querySelector(
    `[data-testid="digest-list-item-${externalId}"]`,
  );
  if (!(node instanceof HTMLElement))
    throw new Error(`missing row ${externalId}`);
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

describe('DigestList', () => {
  it('links a READY row into its detail page', async () => {
    await renderList([item()]);

    const node = row('digest-1');
    expect(node.tagName).toBe('A');
    expect(node.getAttribute('href')).toBe('/account/digests/digest-1');
  });

  it('does not link a pending on-demand row', async () => {
    // `getUserDigest`/`getOrgDigest` stay READY-only, so a link here would
    // navigate the user straight into a 404 on their own digest.
    await renderList([
      item({
        externalId: 'digest-2',
        cadence: 'ON_DEMAND',
        status: 'PENDING',
        headline: null,
      }),
    ]);

    const node = row('digest-2');
    expect(node.tagName).not.toBe('A');
    expect(container.querySelector('a')).toBeNull();
    expect(node.textContent).toContain('On demand');
    expect(node.textContent).toContain('Queued');
  });

  it('renders the stored headline as the row label', async () => {
    // Same stored `Digest.headline` the email subject uses. The list is a
    // passive consumer of that field: no truncation, prefixing, or
    // re-derivation happens here.
    await renderList([
      item({ headline: 'Authentication hardening and faster releases' }),
    ]);

    expect(row('digest-1').textContent).toContain(
      'Authentication hardening and faster releases',
    );
  });

  it('falls back to a neutral label when no headline was stored', async () => {
    await renderList([item({ externalId: 'digest-3', headline: null })]);

    expect(row('digest-3').textContent).toContain('Work digest');
  });

  it('shows what a report cost where the report is', async () => {
    await renderList([item({ billedCredits: 0.42 })]);

    expect(row('digest-1').textContent).toContain('0.42 credits');
  });

  it('renders nothing for an unbilled row rather than claiming it was free', async () => {
    // Null means no debit has landed (not generated yet, a deterministic
    // narrative, or a gateway response with no cost). "0 credits" would read as
    // a positive claim that the report cost nothing.
    await renderList([item({ billedCredits: null })]);

    expect(
      container.querySelector('[data-testid="digest-list-item-cost-digest-1"]'),
    ).toBeNull();
    expect(row('digest-1').textContent).not.toContain('credits');
  });

  it('explains each non-READY status rather than showing a bare row', async () => {
    await renderList([
      item({ externalId: 'a', cadence: 'ON_DEMAND', status: 'GENERATING' }),
      item({ externalId: 'b', cadence: 'ON_DEMAND', status: 'SKIPPED_EMPTY' }),
      item({ externalId: 'c', cadence: 'ON_DEMAND', status: 'FAILED' }),
    ]);

    expect(row('a').textContent).toContain('Generating your digest…');
    expect(row('b').textContent).toContain('No activity found in this range.');
    // A failed row must say so; its only other signal would be disappearing.
    expect(row('c').textContent).toContain('We couldn’t generate this digest');
  });

  it('reassures a user when generation is taking longer than usual', async () => {
    await renderList([
      item({
        status: 'GENERATING',
        createdAt: new Date(Date.now() - 2 * 60 * 1_000 - 1).toISOString(),
      }),
    ]);

    expect(row('digest-1').textContent).toContain('Still generating');
    expect(row('digest-1').textContent).toContain('you don’t need to retry');
  });

  it('blocks the headline from session replay when the host asks', async () => {
    await renderList([item()], {
      blockClassName: 'replay-block',
      maskClassName: 'replay-mask',
    });

    const headline = row('digest-1').querySelector('p.replay-block');
    expect(headline?.textContent).toBe('Shipped the thing');
  });

  it('adds no stray class token on a host without replay privacy', async () => {
    await renderList([item()]);

    const headline = Array.from(row('digest-1').querySelectorAll('p')).find(
      (node) => node.textContent === 'Shipped the thing',
    );
    expect(headline?.getAttribute('class')).toBe(
      'mt-1 text-s font-medium fg-primary',
    );
  });
});
