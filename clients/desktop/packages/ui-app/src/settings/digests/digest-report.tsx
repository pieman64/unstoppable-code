'use client';

import type { ComponentPropsWithoutRef, JSX } from 'react';
import type { DigestReportData } from '@canopy/protocol/settings';
import { Markdown, markdownOptions } from '@canopy/ui-shared';
import { Fact, FactList } from '@canopy/ui-shared/components';
import type { MarkdownOverrides } from '@canopy/ui-shared';
import {
  formatCountExact,
  formatImpactScore,
  formatUsdExact,
} from '@canopy/ui-shared/lib';
import { GITHUB_PR_URL_PATTERN } from '@canopy/protocol/settings/digest-report';
import { SettingsLink, useSettingsPrivacy } from '../host';
import { joinClassNames } from './digest-class-names';
import { cadenceLabel, formatDigestPeriod } from './digest-format';
import { readContributorMetrics, readHeadlineMetrics } from './digest-metrics';
import { TrendChip } from '../organization/statistics/TrendChip';

/**
 * Whether this surface may render navigable links.
 *
 * `'inert'` is the default so a new surface that forgets to choose fails
 * closed: the public share page must never hand an anonymous viewer a live
 * link into a private repo, nor a member profile URL.
 */
export type DigestLinkPolicy = 'interactive' | 'inert';

// Digest bodies are first-party generated content, but the narrative is written
// by an LLM over user data, so anchors are rendered as inert text rather than
// navigable ones — the same treatment the shared plan view gives plan bodies.
/**
 * Images are neutralized on BOTH link policies, not just the inert one.
 *
 * Unlike an anchor, an `<img>` needs no click to leak: rendering one issues an
 * external request the moment the page paints, which for the anonymous share
 * page means an arbitrary third party learns a viewer opened the digest. The
 * assembly-time strip in `model-text.ts` removes embed syntax, but that is a
 * text transform over untrusted input and a miss there should not become a
 * network request — so the render layer refuses to build an `img` element at
 * all. This override, not the strip, is the actual boundary for embeds.
 *
 * Nothing legitimate is lost: no digest section ever emits an image.
 */
function inertImage({ alt }: ComponentPropsWithoutRef<'img'>): JSX.Element {
  return <span>{alt}</span>;
}

const DIGEST_MARKDOWN_COMPONENTS: MarkdownOverrides = {
  a({ children }): JSX.Element {
    return <span>{children}</span>;
  },
  img: inertImage,
};
const DIGEST_MARKDOWN_OPTIONS = markdownOptions(DIGEST_MARKDOWN_COMPONENTS);

/**
 * Only an exact GitHub pull-request URL is allowed through on an authenticated
 * surface.
 *
 * Shared with `model-text` rather than redeclared so the two layers cannot
 * drift: that module decides what may be WRITTEN into a stored body (it
 * validates `prUrl` before emitting an anchor at all), and this check decides
 * what may become NAVIGABLE at render time. Same shape, enforced twice.
 */
const INTERACTIVE_MARKDOWN_COMPONENTS: MarkdownOverrides = {
  img: inertImage,
  a({ children, href }: ComponentPropsWithoutRef<'a'>): JSX.Element {
    return typeof href === 'string' && GITHUB_PR_URL_PATTERN.test(href) ? (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    );
  },
};
const INTERACTIVE_MARKDOWN_OPTIONS = markdownOptions(
  INTERACTIVE_MARKDOWN_COMPONENTS,
);

const DIGEST_PROSE_CLASS =
  'prose prose-sm [--tw-prose-body:var(--fg-primary)] dark:prose-invert max-w-none break-words prose-pre:overflow-x-auto prose-headings:fg-primary prose-strong:fg-primary';

/** The report fields every digest surface renders (`@canopy/protocol/settings`). */
export type { DigestReportData };

interface DigestReportProps {
  digest: DigestReportData;
  /**
   * Defaults to `'inert'` so a surface that forgets to opt in cannot leak a
   * live link. The public share page relies on this default being safe.
   */
  linkPolicy?: DigestLinkPolicy;
  /**
   * Organization id used to build member profile hrefs in the Team list. Only
   * the protected org digest page supplies it; without it the rows render as
   * plain text.
   */
  orgId?: string | null;
}

/**
 * Full digest report: period header, headline metric strip, and the assembled
 * markdown body. Client component only because the shared `Markdown` renderer
 * is a client component; all data is passed in from the page. The headline,
 * body and contributor names carry the host's replay block class.
 *
 * The executive summary is deliberately NOT rendered separately here. It is
 * already the first section of `bodyMarkdown` (assembled server-side from the
 * model's `sections`), and duplicating it would show the same two paragraphs
 * twice. The email is the surface that carries the summary alone.
 */
export function DigestReport({
  digest,
  linkPolicy = 'inert',
  orgId = null,
}: DigestReportProps): JSX.Element {
  const { blockClassName } = useSettingsPrivacy();
  const interactive = linkPolicy === 'interactive';
  const metrics = readHeadlineMetrics(digest.metrics, digest.subjectType);
  const contributors = readContributorMetrics(digest.metrics, {
    orgId: interactive ? orgId : null,
  });
  const markdownOpts = interactive
    ? INTERACTIVE_MARKDOWN_OPTIONS
    : DIGEST_MARKDOWN_OPTIONS;

  return (
    <article className="flex flex-col gap-6" data-testid="digest-report">
      <header>
        <p className="text-xs fg-secondary">
          {cadenceLabel(digest.cadence)} ·{' '}
          {formatDigestPeriod(digest.periodStart, digest.periodEnd)}
        </p>
        <h1
          className={joinClassNames(
            'mt-1 text-xl font-semibold fg-primary',
            blockClassName,
          )}
          data-testid="digest-report-headline"
        >
          {digest.headline ?? 'Work digest'}
        </h1>
      </header>

      <FactList
        layout="stacked"
        columns={4}
        valueSize="large"
        labelTone="secondary"
        columnGap="3"
        rowGap="3"
        dataTestId="digest-report-metrics"
      >
        {metrics.map((metric) => (
          <Fact
            key={metric.key}
            label={metric.label}
            testId={`digest-metric-${metric.key}`}
          >
            {/*
              Both branches format through pinned-locale helpers. A bare
              `toLocaleString()` resolves from the server's locale during SSR
              and the viewer's in the browser, which is both a hydration
              mismatch and a reason two viewers can see one digest differently.
            */}
            <div>
              {metric.value === null
                ? '—'
                : metric.key === 'cost'
                  ? formatUsdExact(metric.value)
                  : formatCountExact(metric.value)}
            </div>
            {/*
              More-is-better on every card, spend included: this report frames
              the period as output, so `flex` (up = green) rather than the
              usage dashboard's cost scheme. `requireComputablePercent` keeps a
              card with no baseline chip-free instead of inventing a `New` or
              `0%` signal.
            */}
            {metric.value !== null && (
              <TrendChip
                current={metric.value}
                previous={metric.previousValue}
                scheme="flex"
                requireComputablePercent
                data-testid={`digest-metric-${metric.key}-trend`}
              />
            )}
          </Fact>
        ))}
      </FactList>

      {digest.variant === 'NUDGE' ? (
        <div
          className="rounded-xl bg-card p-5 shadow-sm"
          data-testid="digest-quiet-period"
        >
          <h2 className="text-base font-semibold fg-primary">Quiet period</h2>
          <div
            className={joinClassNames(
              `mt-2 ${DIGEST_PROSE_CLASS}`,
              blockClassName,
            )}
          >
            <Markdown options={markdownOpts}>
              {digest.executiveSummaryMarkdown ??
                'There was not enough activity for a full report.'}
            </Markdown>
          </div>
        </div>
      ) : (
        <div className="rounded-xl bg-card p-5 shadow-sm">
          <div className={joinClassNames(DIGEST_PROSE_CLASS, blockClassName)}>
            <Markdown options={markdownOpts}>
              {digest.bodyMarkdown ?? ''}
            </Markdown>
          </div>
        </div>
      )}

      {digest.subjectType === 'ORGANIZATION' &&
        (contributors.rows.length > 0 || contributors.remainderCount > 0) && (
          <section
            className="rounded-xl bg-card p-5 shadow-sm"
            aria-labelledby="digest-contributors-heading"
            data-testid="digest-contributors"
          >
            <h2
              id="digest-contributors-heading"
              className="text-base font-semibold fg-primary"
            >
              Team
            </h2>
            {/*
            Ranked by Impact score, the same ordering and the same numbers the
            Statistics People tab shows — both read `computeUserLeaderboard`
            over the same window. Usage stays as the secondary line because
            this section only ever renders for viewers who already passed the
            usage-stats gate.
          */}
            <ol className="mt-3 divide-y">
              {contributors.rows.map((contributor) => (
                <li
                  key={contributor.key}
                  className="flex items-center justify-between gap-4 py-2 text-sm"
                  data-testid="digest-contributor-row"
                >
                  <span
                    className={joinClassNames(
                      'min-w-0 truncate font-medium fg-primary',
                      blockClassName,
                    )}
                  >
                    {contributor.href === null ? (
                      contributor.name
                    ) : (
                      <SettingsLink
                        href={contributor.href}
                        className="hover:underline"
                      >
                        {contributor.name}
                      </SettingsLink>
                    )}
                  </span>
                  <span className="flex shrink-0 items-baseline gap-2">
                    {contributor.impactScore !== null && (
                      <span
                        className="font-semibold fg-primary"
                        data-testid="digest-contributor-impact"
                      >
                        {formatImpactScore(contributor.impactScore)} impact
                      </span>
                    )}
                    <span className="fg-secondary">
                      {formatCountExact(contributor.turns)} turns ·{' '}
                      {formatUsdExact(contributor.costUsd)}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
            {contributors.remainderCount > 0 && (
              <p
                className="mt-3 text-xs fg-secondary"
                data-testid="digest-contributors-remainder"
              >
                and {formatCountExact(contributors.remainderCount)} more
                contributor
                {contributors.remainderCount === 1 ? '' : 's'}
              </p>
            )}
          </section>
        )}
    </article>
  );
}
