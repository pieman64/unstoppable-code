/**
 * @jest-environment jsdom
 */
import type { ReleaseNotesEntry } from '@canopy/protocol/release-notes';
import type { CanopyApi, PreferencesData } from '@canopy/desktop-shared/types';
import { makeTestPreferences } from '@/test-utils/preferences';
import { subscribePreferencesUpdated } from '@/lib/preferences-events';
import {
  recordReleaseHighlightsVersion,
  resetReleaseHighlightsWritesForTests,
  resolveManualReleaseNotesEntry,
  resolveReleaseNotesUrl,
} from '../release-highlights';

function entry(version: string, releasedOn?: string): ReleaseNotesEntry {
  return {
    version,
    ...(releasedOn ? { releasedOn } : {}),
    highlights: [{ title: 'A' }, { title: 'B' }, { title: 'C' }],
  };
}

const RELEASED_ON = '2026-09-01';
const CATALOG = [
  entry('1.10.0', RELEASED_ON),
  entry('1.9.2', RELEASED_ON),
  entry('1.9.0', RELEASED_ON),
];

function installApi(api: Partial<CanopyApi>): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: api,
  });
}

afterEach(() => {
  Reflect.deleteProperty(window, 'api');
  resetReleaseHighlightsWritesForTests();
});

describe('resolveManualReleaseNotesEntry', () => {
  it('resolves only exact stable releases', () => {
    expect(resolveManualReleaseNotesEntry('1.9.0', CATALOG)?.version).toBe(
      '1.9.0',
    );
    expect(resolveManualReleaseNotesEntry('1.9.1', CATALOG)).toBeNull();
    expect(resolveManualReleaseNotesEntry('1.9.3-rc.1', CATALOG)).toBeNull();
  });

  it('never shows a future or unrelated release for an unmatched stable build', () => {
    expect(resolveManualReleaseNotesEntry('1.8.4', CATALOG)).toBeNull();
    expect(resolveManualReleaseNotesEntry('2.0.0', CATALOG)).toBeNull();
  });

  it('hides drafts from stable builds and RCs', () => {
    const withDraft = [entry('1.11.0'), ...CATALOG];
    expect(resolveManualReleaseNotesEntry('1.11.0', withDraft)).toBeNull();
    expect(resolveManualReleaseNotesEntry('1.11.2', withDraft)).toBeNull();
    expect(resolveManualReleaseNotesEntry('1.11.0-rc.1', withDraft)).toBeNull();
  });

  it.each(['1.9.0-beta.1', '1.9', 'broken', '9007199254740992.0.0'])(
    'does not treat unsupported %s as an internal build',
    (version) => {
      expect(resolveManualReleaseNotesEntry(version, CATALOG)).toBeNull();
    },
  );

  it('does not offer unrelated notes on internal or dev builds', () => {
    expect(resolveManualReleaseNotesEntry('internal-123', CATALOG)).toBeNull();
    expect(resolveManualReleaseNotesEntry('internal-123', [])).toBeNull();
    expect(resolveManualReleaseNotesEntry(null, CATALOG)).toBeNull();
    expect(resolveManualReleaseNotesEntry('', CATALOG)).toBeNull();
  });
});

describe('resolveReleaseNotesUrl', () => {
  it('builds the changelog URL on the configured origin', async () => {
    installApi({
      getCanopyCloudBaseUrl: jest
        .fn()
        .mockResolvedValue('https://app.example.test/'),
    });
    await expect(resolveReleaseNotesUrl(entry('1.9.0'))).resolves.toBe(
      'https://app.example.test/changelog',
    );
    await expect(
      resolveReleaseNotesUrl(entry('1.9.0', '2026-10-01')),
    ).resolves.toBe('https://app.example.test/changelog?version=1.9.0#v1-9-0');
  });

  it('returns null without an origin, API, or on failure', async () => {
    installApi({ getCanopyCloudBaseUrl: jest.fn().mockResolvedValue(null) });
    await expect(resolveReleaseNotesUrl(entry('1.9.0'))).resolves.toBeNull();
    installApi({
      getCanopyCloudBaseUrl: jest.fn().mockRejectedValue(new Error('x')),
    });
    await expect(resolveReleaseNotesUrl(entry('1.9.0'))).resolves.toBeNull();
    installApi({});
    await expect(resolveReleaseNotesUrl(entry('1.9.0'))).resolves.toBeNull();
  });
});

describe('recordReleaseHighlightsVersion', () => {
  it('saves the normalized version and broadcasts saved preferences', async () => {
    const saved = makeTestPreferences({
      releaseHighlightsLastSeenVersion: '1.9.0',
    });
    const savePreferences = jest.fn().mockResolvedValue(saved);
    installApi({ savePreferences });
    const events: PreferencesData[] = [];
    const unsubscribe = subscribePreferencesUpdated((preferences) => {
      events.push(preferences);
    });
    try {
      await recordReleaseHighlightsVersion('1.9.0-rc.2');
    } finally {
      unsubscribe();
    }
    expect(savePreferences).toHaveBeenCalledWith({
      releaseHighlightsLastSeenVersion: '1.9.0',
    });
    expect(events).toEqual([saved]);
  });

  it('serializes writes and never lowers a watermark it wrote', async () => {
    const savePreferences = jest
      .fn()
      .mockResolvedValue(
        makeTestPreferences({ releaseHighlightsLastSeenVersion: '1.10.0' }),
      );
    installApi({ savePreferences });
    await Promise.all([
      recordReleaseHighlightsVersion('1.10.0'),
      recordReleaseHighlightsVersion('1.9.0'),
      recordReleaseHighlightsVersion('1.10.0'),
    ]);
    expect(savePreferences).toHaveBeenCalledTimes(1);
    expect(savePreferences).toHaveBeenCalledWith({
      releaseHighlightsLastSeenVersion: '1.10.0',
    });
  });

  it('uses a newer watermark returned by main to suppress stale retries', async () => {
    const savePreferences = jest
      .fn()
      .mockResolvedValue(
        makeTestPreferences({ releaseHighlightsLastSeenVersion: '1.10.0' }),
      );
    installApi({ savePreferences });
    await recordReleaseHighlightsVersion('1.9.0');
    await recordReleaseHighlightsVersion('1.9.1');
    expect(savePreferences).toHaveBeenCalledTimes(1);
  });

  it('swallows save failures and retries a later write', async () => {
    const savePreferences = jest
      .fn()
      .mockRejectedValueOnce(new Error('disk'))
      .mockResolvedValue(makeTestPreferences());
    installApi({ savePreferences });
    await expect(recordReleaseHighlightsVersion('1.9.0')).resolves.toBe(
      undefined,
    );
    await recordReleaseHighlightsVersion('1.9.0');
    expect(savePreferences).toHaveBeenCalledTimes(2);
  });

  it('ignores invalid versions', async () => {
    const savePreferences = jest.fn();
    installApi({ savePreferences });
    await recordReleaseHighlightsVersion('internal-42');
    expect(savePreferences).not.toHaveBeenCalled();
  });
});
