'use client';

import { useState, type JSX, type ReactNode } from 'react';
import type {
  ExternalAgentActivityItem,
  ExternalAgentConnectionDetail,
  ExternalAgentConnectionSummary,
  ExternalAgentDesktop,
  ExternalAgentNotice,
  ExternalAgentOrganization,
  ExternalAgentServerAddress,
  ExternalAgentWaitingAction,
} from '@canopy/protocol/external-agents';
import {
  Button,
  Checkbox,
  CopyButton,
  DetailActionBar,
  McpServerLogo,
  Notice,
  NoticeButton,
  Radio,
  StatusPill,
} from '@canopy/ui-shared/components';
import {
  ChevronLeftMediumIcon,
  ChevronRightIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { formatRelativeTime } from '@canopy/ui-shared/lib/format-relative-time';
import {
  accessSummaryLine,
  activityTargetsLine,
  connectionStatusLabel,
  cursorMcpSnippet,
  EXTERNAL_AGENT_SERVER_COPY,
  waitingTimingLine,
} from './display';
import {
  desktopAccessRows,
  desktopsWriteAccess,
  MAX_ACCESS_DESKTOPS,
  organizationChoiceUnavailable,
  showsAccessDesktops,
  showsAccessOrganizations,
  type AccessFormState,
  type AccessModelSource,
} from './access-model';
import { externalAgentConfirmationPath, externalAgentPath } from './paths';

export function SettingsSection({
  title,
  description,
  children,
  testId,
}: {
  readonly title?: ReactNode;
  readonly description?: ReactNode;
  readonly children?: ReactNode;
  readonly testId?: string;
}): JSX.Element {
  return (
    <section className="flex min-w-0 flex-col gap-3" data-testid={testId}>
      {title || description ? (
        <div className="space-y-1">
          {title ? (
            <h2 className="text-m font-medium fg-primary">{title}</h2>
          ) : null}
          {description ? (
            <div className="text-xs text-pretty fg-secondary">
              {description}
            </div>
          ) : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function SettingsGroup({
  children,
  disabled = false,
}: {
  readonly children?: ReactNode;
  readonly disabled?: boolean;
}): JSX.Element {
  return (
    <div
      aria-disabled={disabled || undefined}
      className={`flex min-w-0 flex-col divide-y rounded-lg bg-secondary px-4 ring-[length:var(--border-hairline)] ring-line-base *:py-3 ${
        disabled ? 'pointer-events-none opacity-50' : ''
      }`}
    >
      {children}
    </div>
  );
}

export function SettingsRow({
  label,
  description,
  control,
  htmlFor,
  children,
  testId,
  pendingActionId,
}: {
  readonly label: ReactNode;
  readonly description?: ReactNode;
  readonly control?: ReactNode;
  readonly htmlFor?: string;
  readonly children?: ReactNode;
  readonly testId?: string;
  readonly pendingActionId?: string;
}): JSX.Element {
  const labelClassName = 'block text-s font-medium fg-primary';
  return (
    <div
      className="flex min-w-0 flex-col gap-3"
      data-testid={testId}
      data-pending-action-id={pendingActionId}
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 sm:gap-6">
        <div className="min-w-0 flex-1 space-y-0.5">
          {htmlFor ? (
            <label htmlFor={htmlFor} className={labelClassName}>
              {label}
            </label>
          ) : (
            <div className={labelClassName}>{label}</div>
          )}
          {description ? (
            <div className="text-xs text-pretty fg-secondary">
              {description}
            </div>
          ) : null}
        </div>
        {control ? (
          <div className="flex shrink-0 items-center gap-2">{control}</div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

/** Requests that need the person's confirmation, ordered oldest first. */
export function WaitingRows({
  waiting,
  onOpenPath,
  showAgent,
}: {
  readonly waiting: readonly ExternalAgentWaitingAction[];
  readonly onOpenPath: (path: string) => void;
  readonly showAgent: boolean;
}): JSX.Element {
  const now = Date.now();
  return (
    <SettingsGroup>
      {waiting.map((request) => {
        const timing = waitingTimingLine(
          request.requestedAt,
          request.decisionExpiresAt,
          now,
        );
        const description = showAgent
          ? `${request.clientName} · ${EXTERNAL_AGENT_SERVER_COPY[request.server].title}. ${timing}`
          : timing;
        return (
          <SettingsRow
            key={request.pendingActionId}
            label={request.action}
            description={description}
            testId="external-agents-waiting-row"
            pendingActionId={request.pendingActionId}
            control={
              <Button
                variant="primary"
                size="control"
                aria-label={`Review: ${request.action}`}
                onClick={(): void =>
                  onOpenPath(
                    externalAgentConfirmationPath(request.pendingActionId),
                  )
                }
              >
                Review
              </Button>
            }
          />
        );
      })}
    </SettingsGroup>
  );
}

export function FactRow({
  label,
  description,
  children,
}: {
  readonly label: string;
  readonly description?: ReactNode;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex min-h-7 min-w-0 flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="min-w-24 flex-1 space-y-0.5">
        <div className="text-s fg-secondary">{label}</div>
        {description ? (
          <div className="text-xs text-pretty fg-secondary">{description}</div>
        ) : null}
      </div>
      <div className="min-w-0 text-s wrap-anywhere fg-primary sm:max-w-3/5 sm:text-right">
        {children}
      </div>
    </div>
  );
}

export function ChoiceRow({
  id,
  label,
  description,
  checked,
  onChange,
  kind,
  name,
  disabled = false,
}: {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly checked: boolean;
  readonly onChange: () => void;
  readonly kind: 'radio' | 'checkbox';
  readonly name?: string;
  readonly disabled?: boolean;
}): JSX.Element {
  const input =
    kind === 'radio' ? (
      <Radio
        id={id}
        name={name}
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        data-testid={id}
      />
    ) : (
      <Checkbox
        id={id}
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        data-testid={id}
      />
    );

  return (
    <div className="flex min-h-7 min-w-0 items-center justify-between gap-3 py-3 sm:gap-6">
      <div className="min-w-0 flex-1 space-y-0.5">
        <label htmlFor={id} className="block text-s font-medium fg-primary">
          {label}
        </label>
        <div className="text-xs text-pretty fg-secondary">{description}</div>
      </div>
      {input}
    </div>
  );
}

const DISMISSED_NOTICES_KEY = 'canopy:external-agents:dismissed-notices:v1';

function noticeKey(notice: ExternalAgentNotice): string {
  return `${notice.connectionId}:${notice.kind}:${notice.at}`;
}

// Best effort: unreadable storage shows every notice.
function readDismissedNotices(): ReadonlySet<string> {
  try {
    const stored: unknown = JSON.parse(
      globalThis.localStorage?.getItem(DISMISSED_NOTICES_KEY) ?? '[]',
    );
    return new Set(
      Array.isArray(stored)
        ? stored.filter((key): key is string => typeof key === 'string')
        : [],
    );
  } catch {
    return new Set();
  }
}

export function NoticeList({
  notices,
  onOpenPath,
}: {
  readonly notices: readonly ExternalAgentNotice[];
  readonly onOpenPath: (path: string) => void;
}): JSX.Element | null {
  const [dismissed, setDismissed] = useState(readDismissedNotices);
  const visible = notices.filter((notice) => !dismissed.has(noticeKey(notice)));
  if (visible.length === 0) return null;

  const dismiss = (notice: ExternalAgentNotice): void => {
    // Keeps only notices still listed, so expired ones leave storage.
    const next = new Set([
      noticeKey(notice),
      ...notices.map(noticeKey).filter((key) => dismissed.has(key)),
    ]);
    setDismissed(next);
    try {
      globalThis.localStorage?.setItem(
        DISMISSED_NOTICES_KEY,
        JSON.stringify([...next]),
      );
    } catch {
      // A failed write hides the notice only until the page reloads.
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {visible.map((notice) => {
        const serverTitle = EXTERNAL_AGENT_SERVER_COPY[notice.server].title;
        const connected = notice.kind === 'connected';
        const message = connected
          ? `${notice.clientName} can now use ${serverTitle}.`
          : `${notice.clientName} can now do more with ${serverTitle}.`;
        return (
          <Notice
            key={noticeKey(notice)}
            intent={connected ? 'positive' : 'attention'}
            title={connected ? 'New agent connected.' : 'Access widened.'}
            onDismiss={(): void => dismiss(notice)}
            dismissLabel={`Dismiss: ${message}`}
            dismissTestId="external-agents-notice-dismiss"
            actions={
              <NoticeButton
                variant="primary"
                onClick={(): void =>
                  onOpenPath(externalAgentPath(notice.connectionId))
                }
              >
                Review
              </NoticeButton>
            }
            data-testid="external-agents-notice"
            data-connection-id={notice.connectionId}
          >
            {message}
          </Notice>
        );
      })}
    </div>
  );
}

export function AgentRow({
  connection,
  onOpen,
}: {
  readonly connection: ExternalAgentConnectionSummary;
  readonly onOpen: () => void;
}): JSX.Element {
  const serverTitle = EXTERNAL_AGENT_SERVER_COPY[connection.server].title;
  const status = connectionStatusLabel(connection.status);
  const lastUsed =
    connection.lastUsedAt === null
      ? 'Not used yet'
      : `Used ${formatRelativeTime(connection.lastUsedAt)}`;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="focus-ring flex w-full min-w-0 items-center gap-3 rounded-md text-left"
      data-testid="external-agent-row"
      data-connection-id={connection.id}
    >
      <McpServerLogo
        name={connection.clientName}
        size={32}
        fallback="monogram"
      />
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="min-w-0 text-s font-medium fg-primary">
            {connection.clientName}
          </span>
          {status ? (
            <StatusPill
              tone="secondary"
              data-testid="external-agent-row-status"
            >
              {status}
            </StatusPill>
          ) : null}
          {!connection.verified ? (
            <StatusPill tone="warning">Unverified</StatusPill>
          ) : null}
        </span>
        <span className="block text-xs text-pretty fg-secondary">
          {`${serverTitle} · ${lastUsed}`}
        </span>
        <span className="block text-xs text-pretty fg-secondary">
          {accessSummaryLine(connection.access)}
        </span>
      </span>
      <ChevronRightIcon
        size={16}
        aria-hidden
        className="shrink-0 fg-tertiary"
      />
    </button>
  );
}

export function ConnectSection({
  servers,
  cursorClientId,
}: {
  readonly servers: readonly ExternalAgentServerAddress[];
  readonly cursorClientId: string;
}): JSX.Element {
  return (
    <SettingsSection
      title="Connect an agent"
      description="Any agent that supports MCP can connect to your account."
      testId="external-agents-connect"
    >
      <SettingsGroup>
        {servers.map((server) => {
          const copy = EXTERNAL_AGENT_SERVER_COPY[server.server];
          return (
            <div
              key={server.server}
              data-testid={`external-agents-server-${server.server}`}
            >
              <SettingsRow
                label={copy.title}
                description={
                  <span className="min-w-0 space-y-0.5">
                    <span className="block">{copy.line}</span>
                    <span className="block wrap-anywhere font-mono fg-secondary">
                      {server.url}
                    </span>
                  </span>
                }
                control={
                  <CopyButton
                    value={server.url}
                    ariaLabel="Copy"
                    label="Copy"
                    copiedLabel="Copied"
                    variant="secondary"
                    size="control"
                  />
                }
              />
            </div>
          );
        })}
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-s fg-secondary">
          <li>
            In your agent, add an MCP server and paste one of these addresses.
          </li>
          <li>
            The agent sends you to this site to sign in and choose what it can
            do.
          </li>
          <li>The agent then appears on this page.</li>
        </ol>
        <SettingsRow
          label="Using Cursor?"
          description="Cursor can’t register itself here. Copy these entries into Cursor’s mcp.json instead."
          control={
            <CopyButton
              value={cursorMcpSnippet(servers, cursorClientId)}
              ariaLabel="Copy entries"
              label="Copy entries"
              copiedLabel="Copied"
              variant="secondary"
              size="control"
              dataTestId="external-agents-cursor-copy"
            />
          }
        >
          <pre
            data-testid="external-agents-cursor-snippet"
            className="max-w-full overflow-x-auto whitespace-pre rounded-md bg-base p-3 font-mono text-xs fg-secondary"
          >
            {cursorMcpSnippet(servers, cursorClientId)}
          </pre>
        </SettingsRow>
      </SettingsGroup>
    </SettingsSection>
  );
}

export function IdentityBlock({
  detail,
}: {
  readonly detail: ExternalAgentConnectionDetail;
}): JSX.Element {
  const status = connectionStatusLabel(detail.status);
  return (
    <div className="flex min-w-0 items-center gap-4">
      <McpServerLogo
        name={detail.clientName}
        size={48}
        fallback="monogram"
        shape="squircle"
      />
      <div className="min-w-0 space-y-0.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h2 className="min-w-0 text-xl font-medium fg-primary">
            {detail.clientName}
          </h2>
          {status ? <StatusPill tone="secondary">{status}</StatusPill> : null}
        </div>
        <div className="text-s text-pretty fg-secondary">
          {`${EXTERNAL_AGENT_SERVER_COPY[detail.server].title} · ${detail.verified ? 'Verified' : 'Unverified'}`}
        </div>
      </div>
    </div>
  );
}

export function ActivityList({
  items,
}: {
  readonly items: readonly ExternalAgentActivityItem[];
}): JSX.Element {
  return (
    <SettingsGroup>
      {items.length === 0 ? (
        <div
          data-testid="external-agent-activity-empty"
          className="text-s fg-secondary"
        >
          Nothing yet.
        </div>
      ) : (
        items.map((item, index) => {
          const targets = activityTargetsLine(item.targets);
          return (
            <div
              key={`${item.at}-${item.tool}-${index}`}
              data-testid="external-agent-activity-row"
              className="flex min-w-0 flex-wrap items-center gap-x-6 gap-y-1"
            >
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="text-s text-pretty fg-primary">
                  {item.toolTitle ?? item.tool}
                </div>
                {targets.length > 0 ? (
                  <div className="text-xs text-pretty fg-secondary">
                    {targets}
                  </div>
                ) : null}
              </div>
              {item.outcome === 'error' ? (
                <span
                  className="shrink-0 text-xs fg-secondary"
                  title={item.outcomeCode ?? undefined}
                >
                  Failed
                </span>
              ) : null}
              <div className="shrink-0 text-right text-xs tabular-nums fg-tertiary">
                {formatRelativeTime(item.at)}
              </div>
            </div>
          );
        })
      )}
    </SettingsGroup>
  );
}

export function BackRow({
  onBack,
  actions,
}: {
  readonly onBack: () => void;
  readonly actions?: ReactNode;
}): JSX.Element {
  return (
    <div className="flex w-full flex-wrap items-center justify-between gap-3 sm:gap-6">
      <Button
        variant="ghost"
        size="control"
        onClick={onBack}
        data-testid="external-agent-back"
      >
        <ChevronLeftMediumIcon size={14} aria-hidden />
        External agents
      </Button>
      <DetailActionBar secondary={actions} />
    </div>
  );
}

/** Where the person's paired desktops are, as the desktop selector shows them. */
export type DesktopListState =
  | { readonly status: 'loading' }
  | {
      readonly status: 'ready';
      readonly desktops: readonly ExternalAgentDesktop[];
    }
  | { readonly status: 'problem' };

/** A quiet connection hint for one desktop row. */
export function desktopConnectionHint(desktop: ExternalAgentDesktop): string {
  if (desktop.connection === 'active') return 'Connected';
  if (desktop.connection === 'reconnecting') return 'Reconnecting';
  return desktop.lastSeenAt === null
    ? 'Not connected'
    : `Last seen ${formatRelativeTime(desktop.lastSeenAt)}`;
}

function desktopDescription(desktop: ExternalAgentDesktop): string {
  const hint = desktopConnectionHint(desktop);
  return desktop.hostname === null || desktop.hostname === ''
    ? hint
    : `${desktop.hostname} · ${hint}`;
}

/**
 * Which desktops a Tasks connection may reach: "All my desktops" or the
 * checked ones. Shared by the consent page and the agent page; each host
 * supplies the list and owns the draft. A checked desktop that is not paired
 * anymore stays checked (and in the policy) until the person removes it.
 */
export function DesktopAccessChoices({
  idPrefix,
  mode,
  remoteIds,
  desktops,
  disabled = false,
  onModeChange,
  onDesktopChange,
  onRetry,
}: {
  /** Prefixes every control id and test id, e.g. `consent` or `external-agent`. */
  readonly idPrefix: string;
  readonly mode: 'all' | 'selected';
  readonly remoteIds: readonly string[];
  readonly desktops: DesktopListState;
  readonly disabled?: boolean;
  readonly onModeChange: (mode: 'all' | 'selected') => void;
  readonly onDesktopChange: (remoteId: string, selected: boolean) => void;
  /** Loads the list again after a failure; without it the row says to reload. */
  readonly onRetry?: () => void;
}): JSX.Element {
  const rows = desktopAccessRows(
    desktops.status === 'ready' ? desktops.desktops : null,
    remoteIds,
  );
  const selectionFull = new Set(remoteIds).size >= MAX_ACCESS_DESKTOPS;
  const radioName = `${idPrefix}-desktop-scope`;

  return (
    <fieldset
      className="min-w-0"
      disabled={disabled}
      data-testid={`${idPrefix}-desktop-choices`}
    >
      <legend className="sr-only">Desktops this agent can reach</legend>
      <SettingsGroup disabled={disabled}>
        <ChoiceRow
          id={`${idPrefix}-desktops-all`}
          label="All my desktops, including ones added later"
          description="New desktops are included when you pair them."
          checked={mode === 'all'}
          onChange={(): void => onModeChange('all')}
          kind="radio"
          name={radioName}
          disabled={disabled}
        />
        <ChoiceRow
          id={`${idPrefix}-desktops-selected`}
          label="Selected desktops"
          description="Choose which desktops this agent can reach."
          checked={mode === 'selected'}
          onChange={(): void => onModeChange('selected')}
          kind="radio"
          name={radioName}
          disabled={disabled}
        />
        {mode === 'selected' && desktops.status === 'loading' ? (
          <div
            role="status"
            data-testid={`${idPrefix}-desktops-loading`}
            className="text-xs fg-secondary"
          >
            Loading your desktops…
          </div>
        ) : null}
        {mode === 'selected' && desktops.status === 'problem' ? (
          <SettingsRow
            label="Couldn’t load your desktops."
            description={
              onRetry === undefined
                ? 'Reload the page to try again. Desktops you already chose stay chosen.'
                : 'Desktops you already chose stay chosen.'
            }
            testId={`${idPrefix}-desktops-error`}
            control={
              onRetry === undefined ? undefined : (
                <Button
                  variant="secondary"
                  size="control"
                  disabled={disabled}
                  data-testid={`${idPrefix}-desktops-retry`}
                  onClick={onRetry}
                >
                  Try again
                </Button>
              )
            }
          />
        ) : null}
        {mode === 'selected' &&
        desktops.status === 'ready' &&
        rows.available.length === 0 &&
        rows.unavailableIds.length === 0 ? (
          <div
            data-testid={`${idPrefix}-desktops-empty`}
            className="text-xs text-pretty fg-secondary"
          >
            You haven’t paired a desktop yet. Pair one from the desktop app,
            then choose it here.
          </div>
        ) : null}
        {mode === 'selected'
          ? rows.available.map(({ desktop, selected }) => (
              <ChoiceRow
                key={desktop.remoteId}
                id={`${idPrefix}-desktop-${desktop.remoteId}`}
                label={desktop.name}
                description={desktopDescription(desktop)}
                checked={selected}
                onChange={(): void =>
                  onDesktopChange(desktop.remoteId, !selected)
                }
                kind="checkbox"
                disabled={disabled || (selectionFull && !selected)}
              />
            ))
          : null}
        {mode === 'selected'
          ? rows.unavailableIds.map((remoteId, index) => (
              <SettingsRow
                key={remoteId}
                label="Unavailable desktop"
                description="This desktop isn’t paired anymore, so the agent can’t reach it."
                testId={`${idPrefix}-desktop-unavailable-${remoteId}`}
                control={
                  <Button
                    variant="secondary"
                    size="control"
                    disabled={disabled}
                    aria-label={
                      rows.unavailableIds.length > 1
                        ? `Remove unavailable desktop ${String(index + 1)}`
                        : 'Remove unavailable desktop'
                    }
                    data-testid={`${idPrefix}-desktop-remove-${remoteId}`}
                    onClick={(): void => onDesktopChange(remoteId, false)}
                  >
                    Remove
                  </Button>
                }
              />
            ))
          : null}
      </SettingsGroup>
    </fieldset>
  );
}

export function AccessEditorSections({
  source,
  draft,
  organizations,
  initialOrganizationIds,
  remoteControlEnabled,
  disabled,
  setOrganizationMode,
  setOrganizationEnabled,
  desktops,
  setDesktopMode,
  setDesktopSelected,
  onRetryDesktops,
  renderEditor,
}: {
  readonly source: AccessModelSource;
  readonly draft: AccessFormState;
  readonly organizations: readonly ExternalAgentOrganization[];
  readonly initialOrganizationIds: readonly string[];
  readonly remoteControlEnabled: boolean;
  readonly disabled: boolean;
  readonly setOrganizationMode: (mode: 'all' | 'selected') => void;
  readonly setOrganizationEnabled: (id: string, enabled: boolean) => void;
  /** The person's paired desktops for the desktop selector. */
  readonly desktops: DesktopListState;
  readonly setDesktopMode: (mode: 'all' | 'selected') => void;
  readonly setDesktopSelected: (remoteId: string, selected: boolean) => void;
  readonly onRetryDesktops?: () => void;
  readonly renderEditor: () => ReactNode;
}): JSX.Element {
  return (
    <>
      <SettingsSection
        title="Access"
        description="Write includes read. Changes apply the next time the agent does something."
        testId="external-agent-access"
      >
        {renderEditor()}
      </SettingsSection>
      {showsAccessOrganizations(source, draft) ? (
        <SettingsSection
          title="Organizations"
          description="The agent can reach organization data only in the ones you choose."
          testId="external-agent-organizations"
        >
          <SettingsGroup disabled={disabled}>
            <ChoiceRow
              id="external-agent-organizations-all"
              label="All my organizations"
              description="Includes organizations you join later."
              checked={draft.organizations.mode === 'all'}
              onChange={(): void => setOrganizationMode('all')}
              kind="radio"
              name="external-agent-organization-scope"
              disabled={disabled}
            />
            <ChoiceRow
              id="external-agent-organizations-selected"
              label="Choose organizations"
              description="Choose which organizations this agent can reach."
              checked={draft.organizations.mode === 'selected'}
              onChange={(): void => setOrganizationMode('selected')}
              kind="radio"
              name="external-agent-organization-scope"
              disabled={disabled}
            />
            {draft.organizations.mode === 'selected'
              ? organizations.map((organization) => {
                  const selected = draft.organizations.organizationIds.includes(
                    organization.id,
                  );
                  const unavailable = organizationChoiceUnavailable(
                    organization,
                    {
                      selected,
                      initiallySelected: initialOrganizationIds.includes(
                        organization.id,
                      ),
                    },
                  );

                  return (
                    <ChoiceRow
                      key={organization.id}
                      id={`external-agent-organization-${organization.id}`}
                      label={organization.name}
                      description={
                        organization.unavailableReason ?? organization.roleLine
                      }
                      checked={selected}
                      onChange={(): void =>
                        setOrganizationEnabled(organization.id, !selected)
                      }
                      kind="checkbox"
                      disabled={disabled || unavailable}
                    />
                  );
                })
              : null}
          </SettingsGroup>
        </SettingsSection>
      ) : null}
      {showsAccessDesktops(source, draft, remoteControlEnabled) ? (
        <SettingsSection
          title="Desktops"
          description="The agent can reach only the desktops you choose."
          testId="external-agent-desktops"
        >
          <div className="flex min-w-0 flex-col gap-3">
            {desktopsWriteAccess(source, draft, remoteControlEnabled) ? (
              <Notice intent="attention" title="This reaches your computer.">
                With write access, this agent can direct agents on the desktops
                you choose. They run commands and edit files under each
                desktop’s approval settings.
              </Notice>
            ) : null}
            <DesktopAccessChoices
              idPrefix="external-agent"
              mode={draft.remotes.mode}
              remoteIds={draft.remotes.remoteIds}
              desktops={desktops}
              disabled={disabled}
              onModeChange={setDesktopMode}
              onDesktopChange={setDesktopSelected}
              onRetry={onRetryDesktops}
            />
          </div>
        </SettingsSection>
      ) : null}
    </>
  );
}

/** Shown where the host does not offer the External agents pages. */
export function ExternalAgentsUnavailable(): JSX.Element {
  return (
    <div data-testid="external-agents-unavailable" className="w-full pt-4">
      <Notice intent="neutral" shape="settings">
        External agents aren’t available here.
      </Notice>
    </div>
  );
}
