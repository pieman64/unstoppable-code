/**
 * Structural checks for the organization digest archive and report, over the
 * shared digest contracts in `account-digests.ts`.
 */

import { z } from 'zod';
import type { DigestArchiveItem } from './account-digests';

export const digestArchiveItemShape = z.looseObject({
  externalId: z.string(),
  cadence: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'ON_DEMAND']),
  periodStart: z.string(),
  periodEnd: z.string(),
  headline: z.string().nullable(),
  variant: z.enum(['FULL', 'NUDGE']),
  status: z.enum([
    'PENDING',
    'GENERATING',
    'READY',
    'SKIPPED_EMPTY',
    'SKIPPED_INELIGIBLE',
    'FAILED',
  ]),
  billedCredits: z.number().nullable(),
  createdAt: z.string(),
});

const digestArchiveListShape = z.array(digestArchiveItemShape);

export function isDigestArchiveItemList(
  value: unknown,
): value is DigestArchiveItem[] {
  return digestArchiveListShape.safeParse(value).success;
}

/** The report fields every protected digest detail carries. */
export const digestReportShape = z.looseObject({
  externalId: z.string(),
  subjectType: z.string(),
  cadence: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  headline: z.string().nullable(),
  executiveSummaryMarkdown: z.string().nullable(),
  bodyMarkdown: z.string().nullable(),
  variant: z.string(),
});

/**
 * An organization digest as `getOrgDigest` serializes it: the report plus the
 * org's sharing posture. `sharePath`/`shareSlug` are present only for viewers
 * who can manage sharing.
 */
export const organizationDigestDetailShape = digestReportShape.extend({
  sharingEnabled: z.boolean().optional(),
  shareSlug: z.string().optional(),
  sharePath: z.string().optional(),
});

/** Funding the on-demand request form shows (`readDigestBillingForPage`). */
export const digestRequestCreditsShape = z.looseObject({
  spendable: z.boolean(),
  balanceCredits: z.number(),
  fundingKey: z.number(),
  fundingLabel: z.string().nullable(),
});
