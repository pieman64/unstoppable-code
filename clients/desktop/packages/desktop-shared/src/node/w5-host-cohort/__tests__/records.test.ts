import type { PlatformProcessInspection } from '@canopy/core-runtime';
import {
  decodeMaintenanceRecord,
  decodeMemberRecord,
  encodeMaintenanceRecord,
  encodeMemberRecord,
  maintenanceOwnerLiveness,
  memberLiveness,
  W5_START_MATCH_WINDOW_MS,
} from '../records';

const TOKEN = '12345678-1234-4234-8234-123456789abc';
const PS_SECONDS = 1_790_000_000;
const member = (
  startEstimateMs: number,
  pid = 4242,
): { pid: number; startEstimateMs: number; hostKind: string } => ({
  pid,
  startEstimateMs,
  hostKind: 'cli',
});
const darwin = (seconds: number, pid = 4242): PlatformProcessInspection => ({
  state: 'running',
  startIdentity: `darwin:v1:${pid}:${seconds}`,
});

describe('member records', () => {
  it('round-trips and keeps unknown fields readable', () => {
    const record = member(PS_SECONDS * 1000 + 500);
    expect(decodeMemberRecord(encodeMemberRecord(record))).toEqual(record);
    expect(
      decodeMemberRecord(
        JSON.stringify({ ...record, version: 1, future: { kept: true } }),
      ),
    ).toEqual(record);
  });

  it.each([
    ['partial JSON', '{"version":1,"pid":12'],
    ['empty', ''],
    ['array', '[]'],
    ['null', 'null'],
    ['newer version', JSON.stringify({ ...member(1), version: 2 })],
    ['missing version', JSON.stringify(member(1))],
    ['zero pid', JSON.stringify({ ...member(1, 0), version: 1 })],
    ['fractional pid', JSON.stringify({ ...member(1, 1.5), version: 1 })],
    ['oversized pid', JSON.stringify({ ...member(1, 2 ** 31), version: 1 })],
    [
      'string pid',
      JSON.stringify({
        version: 1,
        pid: '7',
        startEstimateMs: 1,
        hostKind: 'cli',
      }),
    ],
    ['zero start', JSON.stringify({ ...member(0), version: 1 })],
    ['fractional start', JSON.stringify({ ...member(1.5), version: 1 })],
    ['empty kind', JSON.stringify({ ...member(1), hostKind: '', version: 1 })],
    [
      'long kind',
      JSON.stringify({ ...member(1), hostKind: 'k'.repeat(65), version: 1 }),
    ],
  ])('rejects %s', (_, text) => {
    expect(decodeMemberRecord(text)).toBeNull();
  });
});

describe('maintenance records', () => {
  const record = { pid: 99, startIdentity: 'darwin:v1:99:1', token: TOKEN };

  it('round-trips', () => {
    expect(decodeMaintenanceRecord(encodeMaintenanceRecord(record))).toEqual(
      record,
    );
  });

  it.each([
    ['partial JSON', '{"version":1,"pid":99,"startId'],
    ['newer version', JSON.stringify({ ...record, version: 2 })],
    ['non-UUID token', JSON.stringify({ ...record, version: 1, token: 'abc' })],
    [
      'upper-case token',
      JSON.stringify({ ...record, version: 1, token: TOKEN.toUpperCase() }),
    ],
    [
      'empty identity',
      JSON.stringify({ ...record, version: 1, startIdentity: '' }),
    ],
    ['negative pid', JSON.stringify({ ...record, version: 1, pid: -1 })],
  ])('rejects %s', (_, text) => {
    expect(decodeMaintenanceRecord(text)).toBeNull();
  });
});

describe('member liveness', () => {
  const { before, after } = W5_START_MATCH_WINDOW_MS;
  const psMs = PS_SECONDS * 1000;

  it.each([
    ['observed minimum', 163, 'live'],
    ['observed maximum', 1121, 'live'],
    ['upper edge', after, 'live'],
    ['past the upper edge', after + 1, 'departed'],
    ['lower edge', -before, 'live'],
    ['before the lower edge', -before - 1, 'departed'],
    ['a reused PID started hours later', 3_600_000, 'departed'],
  ] as const)('%s (%i ms) is %s', (_, offset, expected) => {
    expect(memberLiveness(member(psMs + offset), darwin(PS_SECONDS))).toBe(
      expected,
    );
  });

  it('proves departure only from absence or a mismatched macOS start', () => {
    const record = member(psMs);
    expect(memberLiveness(record, { state: 'absent' })).toBe('departed');
    expect(
      memberLiveness(record, { state: 'unverifiable', reason: 'fixture' }),
    ).toBe('unknown');
    // Linux start ticks are boot-relative: a running PID is never pruned.
    expect(
      memberLiveness(record, {
        state: 'running',
        startIdentity: 'linux:v1:4242:boot:123',
      }),
    ).toBe('unknown');
    expect(memberLiveness(record, darwin(PS_SECONDS, 4343))).toBe('unknown');
  });
});

describe('maintenance owner liveness', () => {
  const record = { pid: 99, startIdentity: 'darwin:v1:99:5', token: TOKEN };

  it.each([
    [{ state: 'absent' }, 'departed'],
    [{ state: 'unverifiable', reason: 'fixture' }, 'unknown'],
    [{ state: 'running', startIdentity: 'darwin:v1:99:5' }, 'live'],
    [{ state: 'running', startIdentity: 'darwin:v1:99:6' }, 'departed'],
  ] satisfies [PlatformProcessInspection, string][])(
    '%j is %s',
    (inspection, expected) => {
      expect(maintenanceOwnerLiveness(record, inspection)).toBe(expected);
    },
  );
});
