import type { ProviderRateLimitSnapshot } from '@canopy/desktop-shared/types';
import { patchClaudeRateLimitEvent } from '../claude-rate-limit-event';

function snapshot(
  limitId: string,
  usedPercent: number,
): ProviderRateLimitSnapshot {
  return {
    limitId,
    primary: { usedPercent },
  };
}

describe('patchClaudeRateLimitEvent', () => {
  it('patches existing session and five-hour primary windows immutably', () => {
    const secondary = { usedPercent: 18, windowDurationMins: 60 };
    const credits = { usedUsd: 2.5, totalUsd: 10 };
    const metadata = { source: 'fixture' };
    const session = {
      limitId: 'session',
      primary: { usedPercent: 12, windowDurationMins: 300 },
      secondary,
      credits,
      metadata,
    };
    const fiveHour = snapshot('five_hour', 13);
    const unrelated = snapshot('weekly_all', 60);
    const current: ProviderRateLimitSnapshot[] = [session, fiveHour, unrelated];

    const result = patchClaudeRateLimitEvent(current, {
      status: 'allowed_warning',
      rateLimitType: 'five_hour',
      utilization: 0.42,
    });

    expect(result).toHaveLength(3);
    expect(result?.[0]).not.toBe(session);
    expect(result?.[0]?.primary).not.toBe(session.primary);
    expect(result?.[0]?.primary?.usedPercent).toBe(42);
    expect(result?.[0]?.secondary).toBe(secondary);
    expect(result?.[0]?.credits).toBe(credits);
    const patchedMetadata = result?.[0];
    expect(
      patchedMetadata && 'metadata' in patchedMetadata
        ? patchedMetadata.metadata
        : undefined,
    ).toBe(metadata);
    expect(result?.[1]?.primary?.usedPercent).toBe(42);
    expect(result?.[2]).toBe(unrelated);
    expect(session.primary.usedPercent).toBe(12);
  });

  it('maps seven-day events to existing weekly-all and legacy windows', () => {
    const weeklyAll = snapshot('weekly_all', 10);
    const legacySevenDay = snapshot('seven_day', 20);
    const unrelated = snapshot('session', 30);

    const result = patchClaudeRateLimitEvent(
      [weeklyAll, legacySevenDay, unrelated],
      {
        status: 'allowed',
        rateLimitType: 'seven_day',
        utilization: 0.75,
      },
    );

    expect(result?.[0]?.primary?.usedPercent).toBe(75);
    expect(result?.[1]?.primary?.usedPercent).toBe(75);
    expect(result?.[2]).toBe(unrelated);
  });

  it('maps model-specific weekly events to legacy and case-insensitive scoped windows', () => {
    const legacyOpus = snapshot('seven_day_opus', 11);
    const scopedOpus = snapshot('weekly_scoped:Claude OpUs 4.1', 12);
    const legacySonnet = snapshot('seven_day_sonnet', 21);
    const scopedSonnet = snapshot('weekly_scoped:claude SONNET 4', 22);
    const otherModel = snapshot('weekly_scoped:Claude Haiku', 30);
    const current = [
      legacyOpus,
      scopedOpus,
      legacySonnet,
      scopedSonnet,
      otherModel,
    ];

    const opusResult = patchClaudeRateLimitEvent(current, {
      status: 'allowed',
      rateLimitType: 'seven_day_opus',
      utilization: 0.35,
    });

    expect(opusResult?.[0]?.primary?.usedPercent).toBe(35);
    expect(opusResult?.[1]?.primary?.usedPercent).toBe(35);
    expect(opusResult?.[2]).toBe(legacySonnet);
    expect(opusResult?.[3]).toBe(scopedSonnet);
    expect(opusResult?.[4]).toBe(otherModel);

    const sonnetResult = patchClaudeRateLimitEvent(current, {
      status: 'allowed',
      rateLimitType: 'seven_day_sonnet',
      utilization: 0.65,
    });

    expect(sonnetResult?.[0]).toBe(legacyOpus);
    expect(sonnetResult?.[1]).toBe(scopedOpus);
    expect(sonnetResult?.[2]?.primary?.usedPercent).toBe(65);
    expect(sonnetResult?.[3]?.primary?.usedPercent).toBe(65);
    expect(sonnetResult?.[4]).toBe(otherModel);
  });

  it('sets rejected windows to 100 percent regardless of utilization', () => {
    const current = [snapshot('session', 40)];

    const result = patchClaudeRateLimitEvent(current, {
      status: 'rejected',
      rateLimitType: 'five_hour',
      utilization: 12,
    });

    expect(result?.[0]?.primary?.usedPercent).toBe(100);
  });

  it('uses valid epoch-second resetsAt values as ISO strings', () => {
    const resetsAt = Date.parse('2026-01-01T00:00:00.000Z') / 1000;
    const current = [
      {
        limitId: 'session',
        primary: { usedPercent: 10, resetsAt: '2025-12-31T00:00:00.000Z' },
      },
    ];

    const result = patchClaudeRateLimitEvent(current, {
      status: 'allowed',
      rateLimitType: 'five_hour',
      utilization: 0.2,
      resetsAt,
    });

    expect(result?.[0]?.primary).toEqual({
      usedPercent: 20,
      resetsAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('patches resetsAt without changing usage when utilization is absent', () => {
    const resetsAt = Date.parse('2026-01-01T00:00:00.000Z') / 1000;
    const current = [
      {
        limitId: 'session',
        primary: { usedPercent: 40, resetsAt: '2025-12-31T00:00:00.000Z' },
      },
    ];

    const result = patchClaudeRateLimitEvent(current, {
      status: 'allowed_warning',
      rateLimitType: 'five_hour',
      resetsAt,
    });

    expect(result?.[0]?.primary).toEqual({
      usedPercent: 40,
      resetsAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('ignores invalid utilization while patching a valid reset time', () => {
    const resetsAt = Date.parse('2026-01-01T00:00:00.000Z') / 1000;
    const current = [
      {
        limitId: 'session',
        primary: { usedPercent: 40, resetsAt: '2025-12-31T00:00:00.000Z' },
      },
    ];

    const result = patchClaudeRateLimitEvent(current, {
      status: 'allowed',
      rateLimitType: 'five_hour',
      utilization: 1.5,
      resetsAt,
    });

    expect(result?.[0]?.primary).toEqual({
      usedPercent: 40,
      resetsAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('ignores invalid reset times while applying otherwise valid usage', () => {
    const current = [
      {
        limitId: 'session',
        primary: { usedPercent: 10, resetsAt: '2026-01-01T00:00:00.000Z' },
      },
    ];

    const result = patchClaudeRateLimitEvent(current, {
      status: 'allowed',
      rateLimitType: 'five_hour',
      utilization: 0.2,
      resetsAt: Number.MAX_VALUE,
    });

    expect(result?.[0]?.primary).toEqual({
      usedPercent: 20,
      resetsAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('returns null when the event would not change a matching snapshot', () => {
    const resetsAt = Date.parse('2026-01-01T00:00:00.000Z') / 1000;
    const current = [
      {
        limitId: 'session',
        primary: { usedPercent: 40, resetsAt: '2026-01-01T00:00:00.000Z' },
      },
    ];

    expect(
      patchClaudeRateLimitEvent(current, {
        status: 'allowed',
        rateLimitType: 'five_hour',
        utilization: 0.4,
        resetsAt,
      }),
    ).toBeNull();
  });

  it('returns null for invalid, unsupported, or unmatched events without adding windows', () => {
    const current = [
      snapshot('session', 10),
      snapshot('seven_day_overage_included', 20),
      snapshot('overage', 30),
    ];
    const invalidInfos: unknown[] = [
      null,
      'not an event',
      { status: 'unknown', rateLimitType: 'five_hour', utilization: 0.5 },
      { status: 'allowed', rateLimitType: 'unknown', utilization: 0.5 },
      { status: 'allowed', rateLimitType: 'five_hour', utilization: -0.01 },
      { status: 'allowed', rateLimitType: 'five_hour', utilization: 1.01 },
      { status: 'allowed', rateLimitType: 'five_hour', utilization: NaN },
      { status: 'allowed', rateLimitType: 'five_hour', utilization: Infinity },
      {
        status: 'allowed',
        rateLimitType: 'seven_day_overage_included',
        utilization: 0.5,
      },
      { status: 'allowed', rateLimitType: 'overage', utilization: 0.5 },
    ];

    for (const info of invalidInfos) {
      expect(patchClaudeRateLimitEvent(current, info)).toBeNull();
    }
    expect(
      patchClaudeRateLimitEvent([], {
        status: 'allowed',
        rateLimitType: 'five_hour',
        utilization: 0.5,
      }),
    ).toBeNull();
    expect(
      patchClaudeRateLimitEvent([{ limitId: 'session' }], {
        status: 'allowed',
        rateLimitType: 'five_hour',
        utilization: 0.5,
      }),
    ).toBeNull();
    expect(current).toEqual([
      snapshot('session', 10),
      snapshot('seven_day_overage_included', 20),
      snapshot('overage', 30),
    ]);
  });
});
