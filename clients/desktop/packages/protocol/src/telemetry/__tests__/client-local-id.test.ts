import { createHash } from 'node:crypto';
import {
  clampTelemetryClientId,
  MAX_TELEMETRY_CLIENT_ID_LENGTH,
  TELEMETRY_PRIVATE_OWNER_CONFLICT_ID_SUFFIX,
  telemetryNamespacedClientLocalId,
  telemetryOrganizationTargetKey,
  telemetryPrivateOwnerConflictClientLocalId,
} from '../index';

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

describe('telemetry client-local-id namespacing (CAN-3517)', () => {
  it('passes short ids through and clamps long ones deterministically', () => {
    expect(clampTelemetryClientId('payments')).toBe('payments');
    const long = 'a'.repeat(200);
    const clamped = clampTelemetryClientId(long);
    expect(clamped).toHaveLength(MAX_TELEMETRY_CLIENT_ID_LENGTH);
    expect(clamped).toBe(`${'a'.repeat(119)}~${clamped.slice(120)}`);
    expect(clampTelemetryClientId(long)).toBe(clamped);
    expect(clampTelemetryClientId('b'.repeat(200))).not.toBe(clamped);
    expect(clampTelemetryClientId('abcdefghijk', 5)).toBe('abcde');
  });

  it('derives the organization-scoped id the desktop uploads under', () => {
    const org = '0f8e3c1a-1111-4222-8333-944445555666';
    expect(telemetryOrganizationTargetKey(org)).toBe(`org:${org}`);
    const digest = sha256(`org:${org}`);
    // Pinned so a change on either side fails loudly: the server finds
    // misfiled rows by recomputing exactly this id.
    expect(telemetryNamespacedClientLocalId('payments-1a2b', digest)).toBe(
      `payments-1a2b-${digest.slice(0, 16)}`,
    );
    const long = 'w'.repeat(128);
    expect(telemetryNamespacedClientLocalId(long, digest)).toBe(
      clampTelemetryClientId(`${long}-${digest.slice(0, 16)}`),
    );
  });

  it('derives the private id the desktop falls back to when a legacy organization row holds the bare id (CAN-3601)', () => {
    // Frozen: already persisted. The server finds a checkout's Personal rows
    // by recomputing exactly this id.
    expect(TELEMETRY_PRIVATE_OWNER_CONFLICT_ID_SUFFIX).toBe(
      sha256('private-owner-conflict-v1').slice(0, 16),
    );
    expect(telemetryPrivateOwnerConflictClientLocalId('payments-1a2b')).toBe(
      `payments-1a2b-${TELEMETRY_PRIVATE_OWNER_CONFLICT_ID_SUFFIX}`,
    );
    const long = 'w'.repeat(128);
    expect(telemetryPrivateOwnerConflictClientLocalId(long)).toBe(
      clampTelemetryClientId(
        `${long}-${TELEMETRY_PRIVATE_OWNER_CONFLICT_ID_SUFFIX}`,
      ),
    );
  });
});
