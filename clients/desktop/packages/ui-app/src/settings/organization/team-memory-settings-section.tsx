'use client';

import { useEffect, useState, type JSX } from 'react';
import { CognitionIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  DelayedLoadingPlaceholder,
  ErrorBanner,
  SettingsFormSkeleton,
  Tooltip,
} from '@canopy/ui-shared/components';
import type { OrganizationRole } from '@canopy/protocol/settings/organization';
import { canEditMemorySettings } from '@canopy/protocol/settings/organization-permissions';
import { useSettingsClient, useSettingsPrivacy } from '../host';
import { useSettingsErrorCopy, useSettingsLoadErrorCopy } from '../errors';
import { joinClassNames } from './settings/join-class-names';
import {
  fetchMemoryParticipation,
  updateMemberMemoryParticipation,
  type MemoryParticipationMember,
} from './team-api';

const MEMORY_SETTINGS_ERROR_SCOPE = 'settings.organization.memory';

interface TeamMemorySettingsSectionProps {
  orgId: string;
  /** Org display name, named in the quiet-participation tooltip. */
  orgName: string;
  viewerRole: OrganizationRole;
  memoryEnabled: boolean;
}

export function TeamMemorySettingsSection(
  props: TeamMemorySettingsSectionProps,
): JSX.Element | null {
  if (!props.memoryEnabled || !canEditMemorySettings(props.viewerRole)) {
    return null;
  }
  return <MemorySettingsCard orgId={props.orgId} orgName={props.orgName} />;
}

function MemorySettingsCard({
  orgId,
  orgName,
}: {
  orgId: string;
  orgName: string;
}): JSX.Element {
  const client = useSettingsClient();
  const { blockClassName } = useSettingsPrivacy();
  const [members, setMembers] = useState<MemoryParticipationMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingMemberId, setSavingMemberId] = useState<string | null>(null);
  const errorCopy = useSettingsErrorCopy(MEMORY_SETTINGS_ERROR_SCOPE);
  const loadErrorCopy = useSettingsLoadErrorCopy(MEMORY_SETTINGS_ERROR_SCOPE);
  // A failed load offers Retry; a failed toggle does not.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped by Retry to run the load again.
  const [loadAttempt, setLoadAttempt] = useState(0);

  const retryLoad = (): void => {
    setLoadError(null);
    setLoading(true);
    setLoadAttempt((attempt) => attempt + 1);
  };

  useEffect(() => {
    let active = true;
    const load = async (): Promise<void> => {
      try {
        const result = await fetchMemoryParticipation(client, orgId);
        if (active) {
          setMembers(result.members);
          setLoadError(null);
        }
      } catch (err) {
        if (active) setLoadError(loadErrorCopy(err));
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };
    void load();
    return (): void => {
      active = false;
    };
  }, [client, orgId, loadErrorCopy, loadAttempt]);

  const handleToggle = async (
    memberId: string,
    enabled: boolean,
  ): Promise<void> => {
    const previousEnabled = members.find(
      (member) => member.userId === memberId,
    )?.memoryEnabled;
    if (previousEnabled === undefined) {
      return;
    }
    setMembers((current) =>
      current.map((member) =>
        member.userId === memberId
          ? { ...member, memoryEnabled: enabled }
          : member,
      ),
    );
    setSavingMemberId(memberId);
    setError(null);
    try {
      const result = await updateMemberMemoryParticipation(
        client,
        orgId,
        memberId,
        enabled,
      );
      setMembers((current) =>
        current.map((member) =>
          member.userId === memberId
            ? { ...member, memoryEnabled: result.memoryEnabled }
            : member,
        ),
      );
    } catch (err) {
      setMembers((current) =>
        current.map((member) =>
          member.userId === memberId
            ? { ...member, memoryEnabled: previousEnabled }
            : member,
        ),
      );
      setError(
        errorCopy.actionCopy(err, {
          action: 'update memory participation',
        }),
      );
    } finally {
      setSavingMemberId(null);
    }
  };

  return (
    <section
      className="rounded-xl bg-card p-5 shadow-sm"
      data-testid="team-memory-settings-section"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-subtle fg-accent">
          <CognitionIcon size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-m font-semibold fg-primary">
            Memory participation
          </h2>
          <p className="mt-1 text-s fg-secondary">
            Choose whose organization conversations can be used to build shared
            memory.
          </p>
          <p className="mt-2 text-xs fg-secondary">
            Disabling a member expires facts sourced solely from that member.
            Re-enabling them does not restore expired facts.
          </p>

          <ErrorBanner className="mt-3" error={loadError} onRetry={retryLoad} />
          <ErrorBanner className="mt-3" error={error} />

          {loading ? (
            <div className="mt-4">
              <DelayedLoadingPlaceholder>
                <SettingsFormSkeleton />
              </DelayedLoadingPlaceholder>
            </div>
          ) : (
            <ul className="mt-4 divide-y overflow-hidden rounded-lg border">
              {members.map((member) => {
                const busy = savingMemberId !== null;
                return (
                  <li
                    key={member.userId}
                    className="flex items-center justify-between gap-4 px-4 py-3"
                    data-testid={`memory-participation-row-${member.userId}`}
                  >
                    <div className={joinClassNames('min-w-0', blockClassName)}>
                      <p className="truncate text-s font-medium fg-primary">
                        {member.name ?? member.email}
                      </p>
                      <p className="truncate text-xs fg-secondary">
                        {member.email} · {roleLabel(member.role)}
                      </p>
                      {!member.contributingRecently && (
                        <QuietParticipationLabel
                          userId={member.userId}
                          orgName={orgName}
                        />
                      )}
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={member.memoryEnabled}
                      aria-label={`Include ${member.name ?? member.email} in organization memory`}
                      disabled={busy}
                      data-testid={`memory-participation-toggle-${member.userId}`}
                      onClick={() =>
                        void handleToggle(member.userId, !member.memoryEnabled)
                      }
                      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                        member.memoryEnabled
                          ? 'bg-accent hover:bg-accent/90'
                          : 'bg-fg-secondary/30 hover:bg-fg-secondary/45'
                      }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-card shadow-sm transition-transform ${
                          member.memoryEnabled
                            ? 'translate-x-6'
                            : 'translate-x-1'
                        }`}
                      />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * Neutral, admin-only note that a member's chats have not reached organization
 * memory recently (CAN-3383). It reports this one metric and nothing else: no
 * cause, and no claim about the member's other work.
 */
function QuietParticipationLabel({
  userId,
  orgName,
}: {
  userId: string;
  orgName: string;
}): JSX.Element {
  return (
    <Tooltip
      label={
        <span className="block max-w-60 whitespace-normal">
          {`No chats contributed to ${orgName} memory in 30 days.`}
        </span>
      }
      className="mt-1"
    >
      <button
        type="button"
        data-testid={`memory-participation-quiet-${userId}`}
        className="cursor-default text-left text-xs fg-secondary"
      >
        No recent chat contributions
      </button>
    </Tooltip>
  );
}

function roleLabel(role: OrganizationRole): string {
  switch (role) {
    case 'OWNER':
      return 'Owner';
    case 'ADMIN':
      return 'Admin';
    case 'MEMBER':
      return 'Member';
  }
}
