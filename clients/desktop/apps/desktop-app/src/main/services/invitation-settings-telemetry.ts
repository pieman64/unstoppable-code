import type { SettingsWriteObserver } from './account-organization-settings';
import { ORGANIZATION_SETTINGS_OPERATIONS } from '@canopy/protocol/settings/operations-organization';
import { isDesktopPostHogOperationCaptureEnabled } from '@canopy/desktop-instrumentation/electron/main';
import {
  recordInviteAcceptTelemetry,
  recordInviteSendTelemetry,
  recordOrganizationCreateTelemetry,
} from '../lib/desktop-telemetry';

interface InvitationSettingsTelemetryDeps {
  accept: typeof recordInviteAcceptTelemetry;
  report: typeof recordInviteSendTelemetry;
  create: typeof recordOrganizationCreateTelemetry;
  enabled: () => boolean;
  now?: () => number;
}

/** The server acknowledges acceptance but exposes no transition flag.
 * Suppression covers 500 account/invite pairs for 24 hours in this process.
 * Restart, expiry or eviction can duplicate an idempotent server success;
 * different accounts are independent. No persistent invitation ledger.
 */
export function createInvitationSettingsWriteObserver(
  deps: InvitationSettingsTelemetryDeps = {
    accept: recordInviteAcceptTelemetry,
    report: recordInviteSendTelemetry,
    create: recordOrganizationCreateTelemetry,
    enabled: isDesktopPostHogOperationCaptureEnabled,
  },
): SettingsWriteObserver {
  const accepted = new Map<string, number>();
  const now = deps.now ?? Date.now;
  return (name, input, result, accountId): void => {
    try {
      if (!deps.enabled()) return;
      if (name === 'organization.create') {
        deps.create({
          creationMethod: 'create',
          inviteIncluded: false,
          projectCount: 0,
        });
      } else if (name === 'organization.members.invite') {
        const parsed =
          ORGANIZATION_SETTINGS_OPERATIONS[name].result.safeParse(result);
        if (!parsed.success) return;
        const invite = parsed.data;
        const delivery =
          invite.delivery ??
          (invite.emailDeferred
            ? 'deferred-for-payment'
            : invite.emailSuppressed
              ? 'email-suppressed'
              : undefined);
        deps.report({
          inviteType: 'organization',
          inviteId: invite.id,
          recipientKind: 'email',
          sendSurface: 'members_tab',
          ...(delivery === undefined ? {} : { delivery }),
        });
      } else if (name === 'organization.invitations.respond') {
        const parsed =
          ORGANIZATION_SETTINGS_OPERATIONS[name].input.safeParse(input);
        if (!parsed.success || parsed.data.action !== 'accept') return;
        const time = now();
        for (const [key, expiresAt] of Array.from(accepted))
          if (expiresAt <= time) accepted.delete(key);
        const key = JSON.stringify([accountId, parsed.data.inviteId]);
        if (accepted.has(key)) return;
        accepted.set(key, time + 86_400_000);
        if (accepted.size > 500) {
          const first = accepted.keys().next();
          if (!first.done) accepted.delete(first.value);
        }
        deps.accept({
          inviteType: 'organization',
          inviteId: parsed.data.inviteId,
          acceptSurface: 'desktop_switcher',
        });
      }
    } catch {
      /* Validated write outcomes survive every observer failure. */
    }
  };
}
