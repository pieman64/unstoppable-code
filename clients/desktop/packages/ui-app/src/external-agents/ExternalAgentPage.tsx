'use client';

import { useEffect, useState, type ChangeEvent, type JSX } from 'react';
import { useStore } from 'zustand';
import type { ExternalAgentsClient } from '@canopy/app-core';
import { useCanopyClient, useCapabilities } from '@canopy/app-state';
import {
  createExternalAgentStore,
  type ExternalAgentAction,
  type ExternalAgentState,
  type ExternalAgentStore,
} from '@canopy/app-state/external-agents';
import type {
  ExternalAgentConfirmationChange,
  ExternalAgentConfirmationMode,
  ExternalAgentConnectionDetail,
  ExternalAgentExpiryChange,
} from '@canopy/protocol/external-agents';
import {
  AgentAccessEditor,
  Button,
  ConfirmDialog,
  ControlSelect,
  Notice,
  NoticeButton,
  SegmentedControl,
} from '@canopy/ui-shared/components';
import { formatRelativeTime } from '@canopy/ui-shared/lib/format-relative-time';
import {
  accessFormStateFromDetail,
  accessPresets,
  applyAccessPreset,
  buildAccess,
  countAccessTools,
  countEnabledAccessTools,
  isExternalAgentToolGroup,
  setAccessDesktopMode,
  setAccessDesktopSelected,
  setAccessDestructive,
  setAccessGroupLevel,
  setAccessToolEnabled,
  toAccessEditorGroups,
  type AccessFormState,
  type AccessModelSource,
} from './access-model';
import {
  AccessEditorSections,
  ActivityList,
  BackRow,
  type DesktopListState,
  FactRow,
  IdentityBlock,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  ExternalAgentsUnavailable,
  WaitingRows,
} from './external-agents-parts';
import { EXTERNAL_AGENT_CONFIRMATION_CLASS_LABELS } from './display';
import { EXTERNAL_AGENTS_PATH } from './paths';
import { useMountedStore } from './use-mounted-store';

export interface ExternalAgentPageProps {
  readonly connectionId: string;
  readonly onOpenPath: (path: string) => void;
}

type AccessExpiry = 'keep' | 'never' | '7' | '30' | '90' | '365';

export function ExternalAgentPage({
  connectionId,
  onOpenPath,
}: ExternalAgentPageProps): JSX.Element {
  const client = useCanopyClient();
  const capabilities = useCapabilities();
  const externalAgents = client.externalAgents;
  if (capabilities.externalAgents !== true || externalAgents === undefined) {
    return <ExternalAgentsUnavailable />;
  }

  return (
    <ExternalAgentStoreView
      key={connectionId}
      client={externalAgents}
      connectionId={connectionId}
      onOpenPath={onOpenPath}
    />
  );
}

function ExternalAgentStoreView({
  client,
  connectionId,
  onOpenPath,
}: {
  readonly client: ExternalAgentsClient;
  readonly connectionId: string;
  readonly onOpenPath: (path: string) => void;
}): JSX.Element {
  const store = useMountedStore(client, connectionId, createExternalAgentStore);
  if (store === null) return <ExternalAgentLoading />;
  return <ExternalAgentStoreContent store={store} onOpenPath={onOpenPath} />;
}

function ExternalAgentLoading(): JSX.Element {
  return (
    <div
      data-testid="external-agent-loading"
      role="status"
      aria-label="Loading agent"
      className="flex w-full flex-col gap-3 pb-16"
    >
      <div className="h-8 w-48 animate-pulse rounded bg-subtle" />
      <div className="h-24 animate-pulse rounded-lg bg-secondary" />
      <div className="h-40 animate-pulse rounded-lg bg-secondary" />
    </div>
  );
}

function ExternalAgentStoreContent({
  store,
  onOpenPath,
}: {
  readonly store: ExternalAgentStore;
  readonly onOpenPath: (path: string) => void;
}): JSX.Element {
  const state = useStore(store);

  useEffect((): void => {
    if (
      state.detail !== null &&
      state.detail.server === 'tasks' &&
      state.detail.remoteControlEnabled &&
      state.desktops.status === 'idle' &&
      store.getState().desktops.status === 'idle'
    ) {
      void store.getState().loadDesktops();
    }
  }, [state.detail, state.desktops.status, store]);

  const desktops: DesktopListState =
    state.desktops.list !== null
      ? { status: 'ready', desktops: state.desktops.list }
      : state.desktops.status === 'problem'
        ? { status: 'problem' }
        : { status: 'loading' };

  if (state.status === 'not_found') {
    return (
      <div
        data-testid="external-agent-not-found"
        className="flex w-full flex-col gap-4 pb-16"
      >
        <Notice intent="attention">This agent isn’t connected anymore.</Notice>
        <Button
          variant="secondary"
          size="control"
          onClick={(): void => onOpenPath(EXTERNAL_AGENTS_PATH)}
        >
          Back to External agents
        </Button>
      </div>
    );
  }

  if (state.detail === null) {
    if (state.status === 'problem') {
      return (
        <div className="w-full pb-16">
          <Notice
            intent="attention"
            actions={
              <NoticeButton
                variant="primary"
                onClick={(): void => void state.load()}
              >
                Try again
              </NoticeButton>
            }
            data-testid="external-agent-error"
          >
            Couldn’t load this agent.
          </Notice>
        </div>
      );
    }

    return <ExternalAgentLoading />;
  }

  return (
    <ExternalAgentDetailView
      key={state.detailVersion}
      detail={state.detail}
      state={state}
      store={store}
      desktops={desktops}
      onOpenPath={onOpenPath}
    />
  );
}

function ExternalAgentDetailView({
  detail,
  state,
  store,
  desktops,
  onOpenPath,
}: {
  readonly detail: ExternalAgentConnectionDetail;
  readonly state: ExternalAgentState;
  readonly store: ExternalAgentStore;
  readonly desktops: DesktopListState;
  readonly onOpenPath: (path: string) => void;
}): JSX.Element {
  const [draft, setDraft] = useState<AccessFormState>(() =>
    accessFormStateFromDetail(detail),
  );
  const [confirmationDraft, setConfirmationDraft] = useState<
    ExternalAgentConnectionDetail['confirmation']
  >(() => ({ ...detail.confirmation }));
  const [expiry, setExpiry] = useState<AccessExpiry>('keep');
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  const source: AccessModelSource = {
    server: detail.server,
    groups: detail.groups,
  };
  const presets = accessPresets(detail.groups);
  const editorGroups = toAccessEditorGroups(source, draft, {
    verified: detail.verified,
  });
  const enabledTools = countEnabledAccessTools(source, draft);
  const overToolLimit = enabledTools > detail.maxTools;
  // Compare with the loaded state's own projection, so a stored grant the
  // form cannot show (Remote Control while off) never reads as an edit.
  const hasAccessChanges =
    JSON.stringify(buildAccess(source, draft, { keepUnusedScope: true })) !==
    JSON.stringify(
      buildAccess(source, accessFormStateFromDetail(detail), {
        keepUnusedScope: true,
      }),
    );
  const confirmationChange: ExternalAgentConfirmationChange = {};
  for (const confirmationClass of detail.confirmationClasses) {
    const mode = confirmationDraft[confirmationClass];
    if (mode !== detail.confirmation[confirmationClass]) {
      confirmationChange[confirmationClass] = mode;
    }
  }
  const hasConfirmationChanges = Object.keys(confirmationChange).length > 0;
  const canSave =
    (hasAccessChanges || hasConfirmationChanges || expiry !== 'keep') &&
    !overToolLimit &&
    state.pending === null;
  const disabled = state.pending !== null;
  const editorDisabled = disabled || detail.status === 'expired';
  // Pausing or resuming reloads the agent, so it waits until edits are saved
  // or discarded rather than dropping them silently.
  const hasUnsavedEdits =
    hasAccessChanges || hasConfirmationChanges || expiry !== 'keep';

  const setOrganizationMode = (mode: 'all' | 'selected'): void => {
    setDraft((current) => ({
      ...current,
      organizations: { ...current.organizations, mode },
    }));
  };

  const setOrganizationEnabled = (id: string, enabled: boolean): void => {
    setDraft((current) => {
      const organizationIds = current.organizations.organizationIds.filter(
        (candidate) => candidate !== id,
      );
      return {
        ...current,
        organizations: {
          ...current.organizations,
          organizationIds: enabled ? [...organizationIds, id] : organizationIds,
        },
      };
    });
  };

  const changeExpiry = (event: ChangeEvent<HTMLSelectElement>): void => {
    setExpiry(expiryValue(event.currentTarget.value));
  };

  const save = (): void => {
    void store.getState().save({
      access: buildAccess(source, draft, { keepUnusedScope: true }),
      expiry: expiryChange(expiry),
      ...(hasConfirmationChanges ? { confirmation: confirmationChange } : {}),
    });
  };

  const pause = (): void => {
    void store.getState().pause();
  };

  const resume = (): void => {
    void store.getState().resume();
  };

  const confirmRemove = async (): Promise<void> => {
    await store.getState().remove();
    if (store.getState().status === 'removed') {
      onOpenPath(EXTERNAL_AGENTS_PATH);
      return;
    }
    setConfirmingRemoval(false);
  };

  const discard = (): void => {
    setDraft(accessFormStateFromDetail(detail));
    setConfirmationDraft({ ...detail.confirmation });
    setExpiry('keep');
  };

  const handleToolChange = (
    groupId: string,
    toolName: string,
    enabled: boolean,
  ): void => {
    const group = source.groups.find((candidate) => candidate.id === groupId);
    const tool = group?.tools.find((candidate) => candidate.name === toolName);
    if (tool !== undefined) {
      setDraft((current) => setAccessToolEnabled(current, tool, enabled));
    }
  };

  const unavailableRemove =
    state.outcome?.kind === 'unavailable' && state.outcome.action === 'remove';

  return (
    <div
      data-testid="external-agent-page"
      data-status={detail.status}
      className="flex min-w-0 flex-col"
    >
      <BackRow
        onBack={(): void => onOpenPath(EXTERNAL_AGENTS_PATH)}
        actions={
          detail.status === 'expired' ? null : (
            <>
              <Button
                variant="destructive"
                size="control"
                disabled={disabled}
                data-testid="external-agent-remove"
                onClick={(): void => setConfirmingRemoval(true)}
              >
                Remove
              </Button>
              {detail.status === 'paused' ? (
                <Button
                  variant="secondary"
                  size="control"
                  disabled={disabled || hasUnsavedEdits}
                  data-testid="external-agent-resume"
                  onClick={resume}
                >
                  Resume
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  size="control"
                  disabled={disabled || hasUnsavedEdits}
                  data-testid="external-agent-pause"
                  onClick={pause}
                >
                  Pause
                </Button>
              )}
            </>
          )
        }
      />
      {state.status !== 'loading' && state.problem !== null ? (
        <div className="w-full pt-4">
          <Notice
            intent="attention"
            actions={
              <NoticeButton
                variant="primary"
                onClick={(): void => void state.load()}
              >
                Try again
              </NoticeButton>
            }
            data-testid="external-agent-error"
            shape="settings"
          >
            Couldn’t load this agent.
          </Notice>
        </div>
      ) : null}
      <div className="flex w-full flex-col gap-10 pb-16 pt-6">
        <div
          data-testid="external-agent-identity"
          className="flex min-w-0 flex-col gap-6"
        >
          <IdentityBlock detail={detail} />
          {detail.status === 'active' && detail.waiting.length > 0 ? (
            <SettingsSection
              title="Waiting for you"
              description="This agent asked to do something that needs your confirmation."
              testId="external-agent-waiting"
            >
              <WaitingRows
                waiting={detail.waiting}
                onOpenPath={onOpenPath}
                showAgent={false}
              />
            </SettingsSection>
          ) : null}
          {detail.status === 'paused' ? (
            <Notice
              intent="neutral"
              title="Paused."
              actions={
                <NoticeButton
                  variant="primary"
                  disabled={disabled || hasUnsavedEdits}
                  onClick={resume}
                >
                  Resume
                </NoticeButton>
              }
              data-testid="external-agent-paused-notice"
              shape="settings"
            >
              This agent can’t read or change anything until you resume it. Its
              access stays as it is.
            </Notice>
          ) : null}
          {detail.status === 'expired' ? (
            <Notice
              intent="attention"
              title="This connection has ended."
              data-testid="external-agent-expired-notice"
              shape="settings"
            >
              To use this agent again, connect it again from the agent.
            </Notice>
          ) : null}
          <SettingsSection title="Connection">
            <SettingsGroup>
              <FactRow label="Agent">
                {detail.clientName},{' '}
                {detail.verified ? 'verified' : 'unverified'}
              </FactRow>
              {detail.from === null ? null : (
                <FactRow label="From">
                  <span className="font-mono">{detail.from}</span>
                </FactRow>
              )}
              <FactRow
                label="Returns to"
                description={
                  detail.loopback ? (
                    <span data-testid="external-agent-loopback-note">
                      An address on this computer. Any app running on it could
                      receive the result.
                    </span>
                  ) : undefined
                }
              >
                <span className="font-mono">{detail.returnsTo}</span>
              </FactRow>
              <FactRow label="Connected">
                {formatDate(detail.createdAt)}
              </FactRow>
              <FactRow label="Last used">
                {detail.lastUsedAt === null
                  ? 'Not used yet'
                  : formatRelativeTime(detail.lastUsedAt)}
              </FactRow>
              {detail.status === 'expired' ? (
                <FactRow label="Access ends">
                  {detail.expiresAt === null
                    ? 'When I remove it'
                    : `Ended ${formatDate(detail.expiresAt)}`}
                </FactRow>
              ) : (
                <SettingsRow
                  label="Access ends"
                  htmlFor="external-agent-access-ends"
                  control={
                    <ControlSelect
                      id="external-agent-access-ends"
                      data-testid="external-agent-access-ends"
                      value={expiry}
                      onChange={changeExpiry}
                      disabled={disabled}
                    >
                      <option value="keep">
                        {detail.expiresAt === null
                          ? 'Keep current: when I remove it'
                          : `Keep current: ${formatDate(detail.expiresAt)}`}
                      </option>
                      <option value="never">When I remove it</option>
                      <option value="7">7 days from now</option>
                      <option value="30">30 days from now</option>
                      <option value="90">90 days from now</option>
                      <option value="365">365 days from now</option>
                    </ControlSelect>
                  }
                />
              )}
            </SettingsGroup>
          </SettingsSection>
        </div>

        <AccessEditorSections
          source={source}
          draft={draft}
          organizations={detail.organizations}
          initialOrganizationIds={detail.current.organizations.organizationIds}
          remoteControlEnabled={detail.remoteControlEnabled}
          disabled={editorDisabled}
          setOrganizationMode={setOrganizationMode}
          setOrganizationEnabled={setOrganizationEnabled}
          desktops={desktops}
          setDesktopMode={(mode): void =>
            setDraft((current) => setAccessDesktopMode(current, mode))
          }
          setDesktopSelected={(remoteId, selected): void =>
            setDraft((current) =>
              setAccessDesktopSelected(current, remoteId, selected),
            )
          }
          onRetryDesktops={(): void => void store.getState().loadDesktops()}
          renderEditor={(): JSX.Element => (
            <AgentAccessEditor
              preset={draft.preset}
              onPresetChange={(preset): void =>
                setDraft((current) =>
                  applyAccessPreset(current, source, presets, preset),
                )
              }
              groups={editorGroups}
              onLevelChange={(groupId, level): void => {
                if (!isExternalAgentToolGroup(groupId)) return;
                setDraft((current) =>
                  setAccessGroupLevel(current, source, groupId, level),
                );
              }}
              onDestructiveChange={(groupId, enabled): void =>
                setDraft((current) =>
                  setAccessDestructive(current, source, groupId, enabled),
                )
              }
              onToolChange={handleToolChange}
              toolCount={{
                enabled: enabledTools,
                total: countAccessTools(source),
                max: detail.maxTools,
              }}
              disabled={editorDisabled}
            />
          )}
        />
        {detail.confirmationClasses.length > 0 ? (
          <SettingsSection
            title="Changes"
            description="Ask first sends each change to you to confirm before it happens. Deleting or removing always asks."
            testId="external-agent-confirmation-settings"
          >
            <SettingsGroup disabled={editorDisabled}>
              {detail.confirmationClasses.map((confirmationClass) => {
                const label =
                  EXTERNAL_AGENT_CONFIRMATION_CLASS_LABELS[confirmationClass];
                const testId = `external-agent-confirmation-${confirmationClass}`;
                return (
                  <SettingsRow
                    key={confirmationClass}
                    label={label}
                    control={
                      <SegmentedControl
                        label={label}
                        value={confirmationDraft[confirmationClass]}
                        options={[
                          {
                            value: 'act',
                            label: 'Act',
                            dataTestId: `${testId}-act`,
                          },
                          {
                            value: 'ask_first',
                            label: 'Ask first',
                            dataTestId: `${testId}-ask_first`,
                          },
                        ]}
                        onChange={(mode: ExternalAgentConfirmationMode): void =>
                          setConfirmationDraft((current) => ({
                            ...current,
                            [confirmationClass]: mode,
                          }))
                        }
                        semantics="toggle"
                        width="control"
                        disabled={editorDisabled}
                        dataTestId={`${testId}-control`}
                      />
                    }
                  />
                );
              })}
            </SettingsGroup>
          </SettingsSection>
        ) : null}
        {detail.status !== 'expired' ? (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              variant="secondary"
              size="control"
              disabled={disabled}
              data-testid="external-agent-discard"
              onClick={discard}
            >
              Discard
            </Button>
            <Button
              variant="primary"
              size="control"
              disabled={!canSave}
              data-testid="external-agent-save"
              onClick={save}
            >
              Save
            </Button>
          </div>
        ) : null}

        <OutcomeNotice state={state} maxTools={detail.maxTools} />

        <SettingsSection
          title="Recent activity"
          description="What the agent did, not what it read or wrote."
          testId="external-agent-activity"
        >
          <ActivityList items={detail.activity} />
        </SettingsSection>
      </div>
      {confirmingRemoval ? (
        <ConfirmDialog
          title={`Remove ${detail.clientName}?`}
          message={`${detail.clientName} stops working with your account at once. Every sign-in it holds stops working. This cannot be undone.`}
          confirmLabel="Remove"
          destructive
          onConfirm={(): void => void confirmRemove()}
          onCancel={(): void => setConfirmingRemoval(false)}
          confirmTestId="external-agent-remove-confirm"
          dataTestId="external-agent-remove-dialog"
          errorMessage={
            unavailableRemove ? 'Couldn’t remove the agent. Try again.' : null
          }
        />
      ) : null}
    </div>
  );
}

function OutcomeNotice({
  state,
  maxTools,
}: {
  readonly state: ExternalAgentState;
  readonly maxTools: number;
}): JSX.Element | null {
  const outcome = state.outcome;
  if (outcome === null) return null;

  if (outcome.kind === 'saved') {
    return (
      <Notice
        intent="positive"
        title="Saved."
        data-testid="external-agent-outcome"
        data-outcome="saved"
        shape="settings"
      >
        The agent uses the new access on its next call.
      </Notice>
    );
  }
  if (outcome.kind === 'paused' || outcome.kind === 'resumed') {
    const title = outcome.kind === 'paused' ? 'Paused.' : 'Resumed.';
    return (
      <Notice
        intent="positive"
        data-testid="external-agent-outcome"
        data-outcome={outcome.kind}
        shape="settings"
      >
        {title}
      </Notice>
    );
  }
  if (outcome.kind === 'conflict') {
    return (
      <Notice
        intent="attention"
        title="This agent changed somewhere else."
        data-testid="external-agent-outcome"
        data-outcome="conflict"
        shape="settings"
      >
        The page now shows its latest access. Make your changes again.
      </Notice>
    );
  }
  if (outcome.kind === 'expired') {
    return (
      <Notice
        intent="attention"
        data-testid="external-agent-outcome"
        data-outcome="expired"
        shape="settings"
      >
        This connection ended before your change was saved.
      </Notice>
    );
  }
  if (outcome.kind === 'invalid_policy') {
    return (
      <Notice
        intent="attention"
        title="This access can’t be granted."
        data-testid="external-agent-outcome"
        data-outcome="invalid_policy"
        shape="settings"
      >
        {`Check the groups you chose and keep it to ${maxTools} tools or fewer, then save again.`}
      </Notice>
    );
  }

  const action = unavailableAction(outcome.action);
  return (
    <Notice
      intent="attention"
      title={`Couldn’t ${action}.`}
      data-testid="external-agent-outcome"
      data-outcome="unavailable"
      shape="settings"
    >
      Try again.
    </Notice>
  );
}

function unavailableAction(action: ExternalAgentAction): string {
  if (action === 'save') return 'save your changes';
  if (action === 'pause') return 'pause the agent';
  if (action === 'resume') return 'resume the agent';
  return 'remove the agent';
}

function expiryValue(value: string): AccessExpiry {
  if (
    value === 'never' ||
    value === '7' ||
    value === '30' ||
    value === '90' ||
    value === '365'
  ) {
    return value;
  }
  return 'keep';
}

function expiryChange(value: AccessExpiry): ExternalAgentExpiryChange {
  if (value === 'keep') return { kind: 'keep' };
  if (value === 'never') return { kind: 'never' };
  return { kind: 'days', days: Number(value) };
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }).format(
    new Date(value),
  );
}
