/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  UNKNOWN_USER_KEY,
  UNKNOWN_USER_LABEL,
} from '@canopy/protocol/settings/digest-report';
import {
  DigestReport,
  type DigestLinkPolicy,
  type DigestReportData,
} from '../digest-report';
import {
  TestSettingsHost,
  createTestSettingsHost,
} from '../../__tests__/helpers/test-settings-host';

const NO_PRIVACY = { blockClassName: '', maskClassName: '' };

let container: HTMLDivElement;
let root: Root;

const PR_URL = 'https://github.com/unstoppabledomains/canopy/pull/2388';

function contributor(
  index: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    userExternalId: `user-${String(index)}`,
    userName: `Member ${String(index)}`,
    turnCount: 1000 + index,
    totalCostUsd: 1234.5,
    impactScore: 100 - index,
    ...overrides,
  };
}

function digest(overrides: Partial<DigestReportData> = {}): DigestReportData {
  return {
    externalId: 'digest-1',
    subjectType: 'ORGANIZATION',
    cadence: 'WEEKLY',
    periodStart: '2026-08-14T00:00:00.000Z',
    periodEnd: '2026-08-21T00:00:00.000Z',
    headline: 'Onboarding UX hardening',
    executiveSummaryMarkdown: 'Summary.',
    bodyMarkdown: `See [canopy#2388](${PR_URL}) and [elsewhere](https://example.com/x).`,
    metrics: {
      turnTotals: { turnCount: 12345, totalCostUsd: 6658.47 },
      worktreeCount: 4,
      planCount: 2,
      mergedPullRequests: [{}, {}],
      contributors: [contributor(1), contributor(2)],
    },
    variant: 'STANDARD',
    ...overrides,
  };
}

async function render(
  data: DigestReportData,
  props: { linkPolicy?: DigestLinkPolicy; orgId?: string | null } = {},
  privacy = NO_PRIVACY,
): Promise<void> {
  const { host } = createTestSettingsHost({ privacy });
  await act(async () => {
    root.render(
      <TestSettingsHost host={host}>
        <DigestReport digest={data} {...props} />
      </TestSettingsHost>,
    );
    await Promise.resolve();
  });
}

function anchors(): HTMLAnchorElement[] {
  return Array.from(container.querySelectorAll('a'));
}

function testId(id: string): HTMLElement | null {
  const node = container.querySelector(`[data-testid="${id}"]`);
  return node instanceof HTMLElement ? node : null;
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

describe('DigestReport link policy', () => {
  it('renders a GitHub PR href as a real link when interactive', async () => {
    await render(digest(), { linkPolicy: 'interactive' });

    const hrefs = anchors().map((a) => a.getAttribute('href'));
    expect(hrefs).toContain(PR_URL);
  });

  it('keeps a non-GitHub href inert even when interactive', async () => {
    await render(digest(), { linkPolicy: 'interactive' });

    const hrefs = anchors().map((a) => a.getAttribute('href'));
    expect(hrefs).not.toContain('https://example.com/x');
    expect(container.textContent).toContain('elsewhere');
  });

  it('renders no anchors at all when inert', async () => {
    await render(digest(), { linkPolicy: 'inert', orgId: 'org-1' });

    expect(anchors()).toHaveLength(0);
    // The text still reads normally; only navigability is withheld.
    expect(container.textContent).toContain('canopy#2388');
  });

  it('fails closed when no policy is passed', async () => {
    await render(digest(), { orgId: 'org-1' });

    expect(anchors()).toHaveLength(0);
  });

  it('withholds member links on an inert surface even when an orgId leaks in', async () => {
    await render(digest(), { linkPolicy: 'inert', orgId: 'org-1' });

    expect(anchors()).toHaveLength(0);
  });
});

describe('DigestReport headline', () => {
  it('renders the stored headline verbatim', async () => {
    // `Digest.headline` is the single source of truth shared by the email
    // subject, this report heading, the list rows, and shared reports. The
    // selection/validation work happens once at generation time, so this
    // surface must render it as-is rather than re-deriving anything.
    await render(
      digest({ headline: 'Authentication hardening and faster releases' }),
    );

    expect(testId('digest-report-headline')?.textContent).toBe(
      'Authentication hardening and faster releases',
    );
  });

  it('does not prefix the heading with cadence, period, or brand', async () => {
    // Those anchors belong to the email Subject wrapper only. On a rendered
    // report the cadence and period already have their own chrome, so
    // repeating them in the h1 would be the same redundancy the email
    // subject change removed.
    await render(
      digest({ headline: 'Plugin discovery lands across desktop and web' }),
    );

    const heading = testId('digest-report-headline')?.textContent ?? '';
    expect(heading).not.toMatch(/weekly|digest|report/i);
    expect(heading).not.toContain('Aug');
    expect(heading).not.toContain('2026');
  });

  it('falls back to a neutral label when no headline was stored', async () => {
    // Nudge and insufficient-credit rows persist a null headline; the report
    // still has to render a heading rather than an empty h1.
    await render(digest({ headline: null }));

    expect(testId('digest-report-headline')?.textContent).toBe('Work digest');
  });
});

describe('DigestReport headline metrics', () => {
  it('groups the Spend tile with thousands separators', async () => {
    await render(digest());

    expect(testId('digest-metric-cost')?.textContent).toContain('$6,658.47');
  });

  it('groups the neighbouring count tiles the same way', async () => {
    // Turns is fallback-only, so reaching it means withholding Spend — the
    // share page and any viewer below `usageStatsMinRole`.
    await render(
      digest({
        subjectType: 'USER',
        metrics: {
          turnTotals: { turnCount: 12345 },
          worktreeCount: 4,
          planCount: 2,
          mergedPullRequests: [{}, {}],
        },
      }),
    );

    expect(testId('digest-metric-turns')?.textContent).toContain('12,345');
  });
});

describe('DigestReport trend chips', () => {
  function withPrevious(
    previousPeriod: Record<string, unknown> | null,
  ): DigestReportData {
    return digest({
      metrics: {
        turnTotals: { turnCount: 12345, totalCostUsd: 6658.47 },
        worktreeCount: 4,
        planCount: 2,
        mergedPullRequests: [{}, {}],
        contributors: [contributor(1)],
        previousPeriod,
      },
    });
  }

  it('renders a signed percentage against the prior period', async () => {
    // 4 worktrees vs. a prior 3.556 is +12.5%.
    await render(withPrevious({ worktreeCount: 3.5556 }));

    expect(testId('digest-metric-worktrees-trend')?.textContent).toContain(
      '+12.5%',
    );
  });

  it('colors a spend increase as positive, not as a cost warning', async () => {
    // Every card on this report is framed as output, so the `flex` scheme
    // applies to Spend too: up is green. `fg-warning` here would mean the
    // usage dashboard's cost scheme leaked in.
    await render(withPrevious({ totalCostUsd: 3000 }));

    const chip = testId('digest-metric-cost-trend');
    expect(chip?.className).toContain('fg-success');
    expect(chip?.className).not.toContain('fg-warning');
  });

  it('marks a decline with a downward direction', async () => {
    // Plans is slot 3 on a user digest; the org set spends that slot on
    // Contributors, so this chip only exists on the user view.
    await render({ ...withPrevious({ planCount: 8 }), subjectType: 'USER' });

    const chip = testId('digest-metric-plans-trend');
    expect(chip?.textContent).toContain('-75.0%');
    expect(chip?.className).toContain('fg-destructive');
  });

  it('compares merged PRs against the stored prior count', async () => {
    await render(withPrevious({ mergedPullRequestCount: 1 }));

    expect(testId('digest-metric-merged-trend')?.textContent).toContain(
      '+100.0%',
    );
  });

  it('uses the exact merged-PR count instead of the capped detail-row length', async () => {
    await render(
      digest({
        metrics: {
          turnTotals: { turnCount: 12345, totalCostUsd: 6658.47 },
          worktreeCount: 4,
          planCount: 2,
          mergedPullRequestCount: 12_000,
          mergedPullRequests: [{}, {}],
          contributors: [contributor(1)],
          previousPeriod: { mergedPullRequestCount: 12_000 },
        },
      }),
    );

    expect(testId('digest-metric-merged')?.textContent).toContain('12,000');
    expect(testId('digest-metric-merged-trend')?.textContent).toContain('0%');
  });

  it('compares contributors against the stored prior count', async () => {
    await render(withPrevious({ contributorCount: 2 }));

    expect(testId('digest-metric-contributors-trend')?.textContent).toContain(
      '-50.0%',
    );
  });

  it('renders no chip on a digest written before prior-period rollups', async () => {
    // The intended fallback for existing rows: cards, no chips, no backfill.
    await render(withPrevious(null));

    expect(testId('digest-metric-worktrees')).not.toBeNull();
    expect(testId('digest-metric-worktrees-trend')).toBeNull();
    expect(testId('digest-metric-cost-trend')).toBeNull();
  });

  it('renders no chip when the prior value was zero', async () => {
    // A `New` or `0%` chip would imply a comparison that does not exist.
    await render({
      ...withPrevious({ worktreeCount: 0, planCount: 0 }),
      subjectType: 'USER',
    });

    expect(testId('digest-metric-worktrees-trend')).toBeNull();
    expect(testId('digest-metric-plans-trend')).toBeNull();
  });

  it('renders no spend chip when prior-period cost was withheld', async () => {
    // `projectMetrics` omits `previousPeriod.totalCostUsd` for viewers who are
    // not cleared for spend, while keeping the counts. The Spend card must
    // then show no chip rather than treating the absence as a zero baseline.
    await render(withPrevious({ worktreeCount: 2, planCount: 1 }));

    // A present-but-baseline-less Spend is still a real card, so it keeps its
    // slot rather than being substituted away by the fallback chain.
    expect(testId('digest-metric-cost')?.textContent).toContain('$6,658.47');
    expect(testId('digest-metric-cost-trend')).toBeNull();
    expect(testId('digest-metric-worktrees-trend')?.textContent).toContain(
      '+100.0%',
    );
  });
});

describe('DigestReport team list', () => {
  it('orders by Impact score, not by spend', async () => {
    // The red case: the top spender is the *lowest* Impact member.
    await render(
      digest({
        metrics: {
          contributors: [
            contributor(1, {
              userName: 'Big Spender',
              totalCostUsd: 90000,
              impactScore: 3,
            }),
            contributor(2, { userName: 'Top Impact', impactScore: 88 }),
          ],
        },
      }),
      { linkPolicy: 'interactive', orgId: 'org-1' },
    );

    const names = Array.from(
      container.querySelectorAll('[data-testid="digest-contributor-row"]'),
    ).map((node) => node.textContent ?? '');
    expect(names[0]).toContain('Top Impact');
    expect(names[1]).toContain('Big Spender');
  });

  it('renders the Impact score and grouped usage on each row', async () => {
    await render(digest(), { linkPolicy: 'interactive', orgId: 'org-1' });

    const row = container.querySelector(
      '[data-testid="digest-contributor-row"]',
    );
    expect(row?.textContent).toContain('99 impact');
    expect(row?.textContent).toContain('1,001 turns');
    expect(row?.textContent).toContain('$1,234.50');
  });

  it('caps the list at ten rows and counts the remainder', async () => {
    const contributors = Array.from({ length: 22 }, (_, index) =>
      contributor(index + 1),
    );
    await render(digest({ metrics: { contributors } }), {
      linkPolicy: 'interactive',
      orgId: 'org-1',
    });

    expect(
      container.querySelectorAll('[data-testid="digest-contributor-row"]'),
    ).toHaveLength(10);
    expect(testId('digest-contributors-remainder')?.textContent).toContain(
      'and 12 more contributors',
    );
  });

  it('still accounts for the unresolved bucket when it is the only contributor', async () => {
    await render(
      digest({
        metrics: {
          contributors: [
            contributor(1, {
              userExternalId: UNKNOWN_USER_KEY,
              userName: UNKNOWN_USER_LABEL,
              impactScore: 999,
            }),
          ],
        },
      }),
      { linkPolicy: 'interactive', orgId: 'org-1' },
    );

    expect(
      container.querySelectorAll('[data-testid="digest-contributor-row"]'),
    ).toHaveLength(0);
    expect(testId('digest-contributors-remainder')?.textContent).toContain(
      'and 1 more contributor',
    );
  });

  it.each([
    {
      name: 'never ranks the unresolved-actor bucket and folds it into the remainder',
      externalId: UNKNOWN_USER_KEY,
    },
    {
      name: 'never ranks a legacy unresolved contributor with a null external id',
      externalId: null,
    },
  ])('$name', async ({ externalId }) => {
    await render(
      digest({
        metrics: {
          contributors: [
            contributor(1, {
              userExternalId: externalId,
              userName: UNKNOWN_USER_LABEL,
              impactScore: 999,
            }),
            contributor(2),
          ],
        },
      }),
      { linkPolicy: 'interactive', orgId: 'org-1' },
    );

    const rows = container.querySelectorAll(
      '[data-testid="digest-contributor-row"]',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('Member 2');
    expect(testId('digest-contributors-remainder')?.textContent).toContain(
      'and 1 more contributor',
    );
  });

  it('links each row to the member profile route', async () => {
    await render(digest(), { linkPolicy: 'interactive', orgId: 'org-1' });

    const hrefs = anchors().map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/organization/org-1/members/user-1');
  });

  it('renders unlinked rather than a broken href when no orgId is supplied', async () => {
    // The account digest page is interactive but has no org context.
    await render(digest(), { linkPolicy: 'interactive' });

    const hrefs = anchors().map((a) => a.getAttribute('href') ?? '');
    expect(hrefs.some((href) => href.includes('/members/'))).toBe(false);
    expect(
      container.querySelectorAll('[data-testid="digest-contributor-row"]'),
    ).toHaveLength(2);
  });

  it('keeps a contributor with no external id visible but unlinked', async () => {
    await render(
      digest({
        metrics: {
          contributors: [
            contributor(1, {
              userExternalId: null,
              userName: 'Unlinked member',
            }),
          ],
        },
      }),
      { linkPolicy: 'interactive', orgId: 'org-1' },
    );

    const rows = container.querySelectorAll(
      '[data-testid="digest-contributor-row"]',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('Unlinked member');
    expect(anchors().some((anchor) => anchor.href.includes('/members/'))).toBe(
      false,
    );
  });

  it('omits the section entirely for a user digest', async () => {
    await render(digest({ subjectType: 'USER' }), {
      linkPolicy: 'interactive',
    });

    expect(testId('digest-contributors')).toBeNull();
  });

  it('omits the section when the viewer was gated out of contributor rows', async () => {
    // `projectMetrics` replaces every contributor with `{}` below the
    // usage-stats threshold and for anonymous share viewers.
    await render(digest({ metrics: { contributors: [{}, {}] } }), {
      linkPolicy: 'interactive',
      orgId: 'org-1',
    });

    expect(testId('digest-contributors')).toBeNull();
  });

  // An <img> needs no click to leak: rendering one issues an external request
  // the moment the page paints, so for the anonymous share page an arbitrary
  // third party learns a viewer opened the digest. The assembly-time strip is
  // a text transform over untrusted input; a miss there must not become a
  // network request, so the render layer refuses to build an img at all.
  describe.each(['inert', 'interactive'] as const)(
    'image neutralization (%s policy)',
    (linkPolicy) => {
      it('never renders an img element, on either policy', async () => {
        await render(
          digest({
            bodyMarkdown:
              '# H\n\nProgress ![tracker](https://attacker.test/pixel.png) shipped.',
          }),
          { linkPolicy, orgId: 'org-1' },
        );

        expect(container.querySelectorAll('img')).toHaveLength(0);
        expect(container.innerHTML).not.toContain('attacker.test');
        // The alt text survives as inert text rather than silently vanishing.
        expect(container.textContent).toContain('tracker');
      });
    },
  );

  it('keeps a non-GitHub link inert even on the interactive policy', async () => {
    await render(
      digest({
        bodyMarkdown: '# H\n\nSee [payout](https://evil.example.com/phish).',
      }),
      { linkPolicy: 'interactive', orgId: 'org-1' },
    );

    const anchors = Array.from(container.querySelectorAll('a')).map((a) =>
      a.getAttribute('href'),
    );
    expect(anchors).not.toContain('https://evil.example.com/phish');
    expect(container.textContent).toContain('payout');
  });

  it('blocks the headline, body and member names from session replay', async () => {
    await render(
      digest(),
      { linkPolicy: 'interactive', orgId: 'org-1' },
      { blockClassName: 'replay-block', maskClassName: 'replay-mask' },
    );

    expect(
      testId('digest-report-headline')?.querySelector('.replay-block')
        ?.textContent,
    ).toBe('Onboarding UX hardening');
    const blocked = Array.from(container.querySelectorAll('.replay-block'));
    expect(
      blocked.some((node) => node.textContent?.includes('canopy#2388')),
    ).toBe(true);
    const rows = Array.from(
      container.querySelectorAll('[data-testid="digest-contributor-row"]'),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.querySelector('.replay-block')?.textContent).toContain(
        'Member',
      );
    }
  });

  it('leaves no stray class token when the host has no replay privacy', async () => {
    await render(digest());

    const headline = testId('digest-report-headline');
    expect(headline?.getAttribute('class')).not.toMatch(/^\s|\s$|\s\s/);
    expect(headline?.querySelector('[class=""]')).toBeNull();
  });
});
