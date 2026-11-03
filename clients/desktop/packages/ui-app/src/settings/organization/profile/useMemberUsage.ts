'use client';

import { useCallback, useEffect, useState } from 'react';
import type {
  TelemetryTimeGranularity,
  TeamUsageResponse,
} from '@canopy/protocol/telemetry';
import { useSettingsClient } from '../../host';
import { fetchTeamUsage } from '../team-api';
import { USAGE_KNOWN_LOAD_ERRORS } from '../statistics/usage-error-copy';
import { useSettingsLoadFailure } from '../../errors';
import { MEMBER_PROFILE_ERROR_SCOPE } from './use-member-paged-resource';
import type { SettingsFailure } from '../../errors';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface UsageRangeOption {
  ms: number;
  label: string;
  granularity: TelemetryTimeGranularity;
}

export const USAGE_RANGE_OPTIONS: ReadonlyArray<UsageRangeOption> = [
  { ms: 7 * MS_PER_DAY, label: 'Last 7 days', granularity: 'day' },
  { ms: 30 * MS_PER_DAY, label: 'Last 30 days', granularity: 'day' },
  { ms: 90 * MS_PER_DAY, label: 'Last 90 days', granularity: 'week' },
];

export const DEFAULT_USAGE_RANGE_MS = 30 * MS_PER_DAY;

export interface MemberUsageState {
  usage: TeamUsageResponse | null;
  loading: boolean;
  /** Load copy for the last failed fetch; never server text. */
  error: SettingsFailure | null;
  rangeMs: number;
  setRangeMs: (ms: number) => void;
  /** Fetch the usage again after a failure. */
  retry: () => void;
}

/**
 * Shared per-member usage loader for the profile's gated sections (Overview
 * headline stats and the Runs tab). Owns the range-selector state and fetches
 * `fetchTeamUsage` scoped to the subject with `?userId=`. When `enabled` is
 * false (viewer can't clear the org's `usageStatsMinRole`) it never fetches, so
 * no gated data is requested. A superseded fetch is dropped via the `ignore`
 * guard so a stale response can't overwrite a newer one.
 */
export function useMemberUsage(
  orgId: string,
  userId: string,
  enabled: boolean,
): MemberUsageState {
  const client = useSettingsClient();
  const loadErrorCopy = useSettingsLoadFailure(MEMBER_PROFILE_ERROR_SCOPE);
  // Bumped by `retry` to fetch again.
  const [reloadToken, setReloadToken] = useState(0);
  const [rangeMs, setRangeMs] = useState<number>(DEFAULT_USAGE_RANGE_MS);
  const [usage, setUsage] = useState<TeamUsageResponse | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<SettingsFailure | null>(null);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    let ignore = false;
    const option =
      USAGE_RANGE_OPTIONS.find((opt) => opt.ms === rangeMs) ??
      USAGE_RANGE_OPTIONS[1];
    const endIso = new Date().toISOString();
    const startIso = new Date(Date.now() - rangeMs).toISOString();
    void (async (): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const result = await fetchTeamUsage(client, orgId, {
          scope: 'organization',
          granularity: option.granularity,
          startIso,
          endIso,
          userId,
        });
        if (!ignore) {
          setUsage(result);
        }
      } catch (err: unknown) {
        if (!ignore) {
          setError(loadErrorCopy(err, USAGE_KNOWN_LOAD_ERRORS));
          setUsage(null);
        }
      } finally {
        if (!ignore) {
          setLoading(false);
        }
      }
    })();
    return (): void => {
      ignore = true;
    };
  }, [client, orgId, userId, rangeMs, enabled, loadErrorCopy, reloadToken]);

  const retry = useCallback((): void => {
    setReloadToken((token) => token + 1);
  }, []);

  return { usage, loading, error, rangeMs, setRangeMs, retry };
}
