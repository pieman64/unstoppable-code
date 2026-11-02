import type { ProviderRateLimitSnapshot } from '@canopy/desktop-shared/types';
import { buildSubCards } from '../usage-sub-cards';

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;

describe('buildSubCards', () => {
  it('maps modern Claude limits to one titled card each', () => {
    const rateLimits: ProviderRateLimitSnapshot[] = [
      {
        limitId: 'session',
        limitName: '5-hour window',
        planType: 'default_claude_max_20x',
        primary: {
          usedPercent: 42,
          resetsAt: '2026-10-04T20:00:00.000Z',
          windowDurationMins: 300,
        },
      },
      {
        limitId: 'weekly_all',
        limitName: '7-day window',
        primary: {
          usedPercent: 0,
          resetsAt: '2026-10-09T00:00:00.000Z',
          windowDurationMins: 10_080,
        },
      },
      {
        limitId: 'weekly_scoped:Opus',
        limitName: '7-day Opus',
        primary: { usedPercent: 12.5, resetsAt: '2026-10-09T00:00:00.000Z' },
      },
    ];

    expect(buildSubCards('claude', rateLimits)).toEqual([
      {
        key: 'session-primary',
        title: '5-hour window',
        usedPercent: 42,
        resetsAt: '2026-10-04T20:00:00.000Z',
        windowDurationMs: FIVE_HOUR_MS,
        credits: undefined,
      },
      {
        key: 'weekly_all-primary',
        title: '7-day window',
        usedPercent: 0,
        resetsAt: '2026-10-09T00:00:00.000Z',
        windowDurationMs: SEVEN_DAY_MS,
        credits: undefined,
      },
      {
        key: 'weekly_scoped:Opus-primary',
        title: '7-day Opus',
        usedPercent: 12.5,
        resetsAt: '2026-10-09T00:00:00.000Z',
        windowDurationMs: SEVEN_DAY_MS,
        credits: undefined,
      },
    ]);
  });

  it('infers legacy Claude window durations from their keys', () => {
    expect(
      buildSubCards('claude', [
        {
          limitId: 'five_hour',
          limitName: 'Five Hour',
          primary: { usedPercent: 10, resetsAt: '2026-10-04T20:00:00.000Z' },
        },
        {
          limitId: 'seven_day_opus',
          limitName: 'Seven Day Opus',
          primary: { usedPercent: 30 },
        },
        { limitId: 'unrecognized_window', primary: { usedPercent: 5 } },
        { primary: { usedPercent: 1 } },
      ]),
    ).toEqual([
      {
        key: 'five_hour-primary',
        title: 'Five Hour',
        usedPercent: 10,
        resetsAt: '2026-10-04T20:00:00.000Z',
        windowDurationMs: FIVE_HOUR_MS,
        credits: undefined,
      },
      {
        key: 'seven_day_opus-primary',
        title: 'Seven Day Opus',
        usedPercent: 30,
        resetsAt: undefined,
        windowDurationMs: SEVEN_DAY_MS,
        credits: undefined,
      },
      {
        key: 'unrecognized_window-primary',
        title: 'unrecognized_window',
        usedPercent: 5,
        resetsAt: undefined,
        windowDurationMs: undefined,
        credits: undefined,
      },
      {
        key: 'default-primary',
        title: 'Current window',
        usedPercent: 1,
        resetsAt: undefined,
        windowDurationMs: undefined,
        credits: undefined,
      },
    ]);
  });

  it('keeps the Claude Extra usage card and its dollar credits as rendered today', () => {
    expect(
      buildSubCards('claude', [
        {
          limitId: 'extra_usage',
          limitName: 'Extra usage',
          primary: { usedPercent: 25 },
          credits: { totalUsd: 100, remainingUsd: 75 },
        },
      ]),
    ).toEqual([
      {
        key: 'extra_usage-primary',
        title: 'Extra usage',
        usedPercent: 25,
        resetsAt: undefined,
        windowDurationMs: undefined,
        credits: { totalUsd: 100, remainingUsd: 75 },
      },
    ]);
  });

  it('keeps Claude Extra usage spend on the desktop card', () => {
    expect(
      buildSubCards('claude', [
        {
          limitId: 'extra_usage',
          limitName: 'Extra usage',
          primary: { usedPercent: 25 },
          spend: { currency: 'USD', used: 12.5, limit: 50, isEnabled: true },
        },
      ])[0]?.spend,
    ).toStrictEqual({
      currency: 'USD',
      used: 12.5,
      limit: 50,
      isEnabled: true,
    });
  });

  it('expands Codex buckets into duration-titled primary and secondary cards', () => {
    expect(
      buildSubCards('codex', [
        {
          limitId: 'codex_other',
          limitName: 'GPT-5 Codex Mini',
          primary: { usedPercent: 3, windowDurationMins: 90 },
        },
        {
          limitId: 'codex',
          limitName: 'Codex',
          planType: 'pro',
          primary: {
            usedPercent: 23,
            resetsAt: '2026-10-04T20:00:00.000Z',
            windowDurationMins: 300,
          },
          secondary: {
            usedPercent: 61,
            resetsAt: '2026-10-09T00:00:00.000Z',
            windowDurationMins: 10_080,
          },
          credits: { remainingUsd: 120 },
        },
      ]),
    ).toEqual([
      {
        key: 'codex-primary',
        title: '5-hour window',
        usedPercent: 23,
        resetsAt: '2026-10-04T20:00:00.000Z',
        windowDurationMs: FIVE_HOUR_MS,
        credits: { remainingUsd: 120 },
        creditsAreCount: true,
      },
      {
        key: 'codex-secondary',
        title: '7-day window',
        usedPercent: 61,
        resetsAt: '2026-10-09T00:00:00.000Z',
        windowDurationMs: SEVEN_DAY_MS,
        credits: { remainingUsd: 120 },
        creditsAreCount: true,
      },
      {
        key: 'codex_other-primary',
        title: '90-minute GPT-5 Codex Mini',
        usedPercent: 3,
        resetsAt: undefined,
        windowDurationMs: 90 * 60 * 1000,
        credits: undefined,
        creditsAreCount: true,
      },
    ]);
  });

  it('falls back to ordinal Codex titles when a window has no duration', () => {
    expect(
      buildSubCards('codex', [
        {
          primary: { usedPercent: 5, windowDurationMins: 0 },
          secondary: { usedPercent: 6 },
        },
      ]),
    ).toEqual([
      {
        key: 'default-primary',
        title: 'Primary window',
        usedPercent: 5,
        resetsAt: undefined,
        windowDurationMs: undefined,
        credits: undefined,
        creditsAreCount: true,
      },
      {
        key: 'default-secondary',
        title: 'Secondary window',
        usedPercent: 6,
        resetsAt: undefined,
        windowDurationMs: undefined,
        credits: undefined,
        creditsAreCount: true,
      },
    ]);
  });

  it('keeps Cursor spend credits on the card', () => {
    expect(
      buildSubCards('cursor', [
        {
          limitId: 'on_demand',
          limitName: 'On-demand usage',
          credits: { usedUsd: 12.5, totalUsd: 50, remainingUsd: 37.5 },
        },
      ]),
    ).toEqual([
      {
        key: 'on_demand-primary',
        title: 'On-demand usage',
        usedPercent: undefined,
        resetsAt: undefined,
        windowDurationMs: undefined,
        credits: { usedUsd: 12.5, totalUsd: 50, remainingUsd: 37.5 },
      },
    ]);
  });

  it('returns no cards when the provider reports no limits', () => {
    expect(buildSubCards('claude', undefined)).toEqual([]);
    expect(buildSubCards('codex', [])).toEqual([]);
  });
});
