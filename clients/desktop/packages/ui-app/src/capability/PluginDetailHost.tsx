'use client';

import { pluginDisplayName } from '@canopy/ui-shared';
import { type JSX, type ReactNode, useEffect, useMemo, useState } from 'react';
import type {
  BuiltInProviderInstallStatus,
  MarketplacePluginExternalSource,
  PluginProvider,
} from '@canopy/protocol/plugins';
import {
  ErrorBanner,
  LoadingPlaceholder,
  LoadingSpinner,
  PluginDetailContent,
  PluginDetailSectionHeading,
  RefreshSpinner,
  type PluginDetailContentPlugin,
  type MarkdownProps,
  type PluginDetailReadComponent,
} from '@canopy/ui-shared/components';
import {
  DetailActionBar,
  DetailActionSlotsProvider,
  ExecutionActionButton,
  MarketplaceShareButton,
  useDetailActionSlots,
} from '@canopy/ui-shared/components';
import type { MarketplaceShareAction } from '@canopy/ui-shared/lib';
import { SECONDARY_ACTION_BUTTON_CLASS } from '@canopy/ui-shared/lib/row-chips';

export interface PluginDetailHostPlugin extends PluginDetailContentPlugin {
  builtIn?: boolean;
  curated?: boolean;
  externalSource?: MarketplacePluginExternalSource | string;
  cachedAt?: string;
  globalInstallStatus?: {
    claude?: BuiltInProviderInstallStatus;
    codex?: BuiltInProviderInstallStatus;
    checkedAt: string;
  };
}

export type PluginDetailInstallRequest =
  | { kind: 'external' }
  | { kind: 'providers'; providers: PluginProvider[] };

export interface PluginDetailInstallResult {
  plugin: PluginDetailHostPlugin;
  providerOutcomes?: Partial<
    Record<PluginProvider, { installed: boolean; error?: string }>
  >;
}

export interface PluginDetailRelatedItem {
  id: string;
  label: string;
}

export interface PluginDetailHostProps {
  plugin: PluginDetailHostPlugin;
  /** Omit where Back would only repeat the breadcrumb's parent. */
  onBack?: () => void;
  loadDetail: () => Promise<PluginDetailHostPlugin>;
  readComponent: PluginDetailReadComponent;
  /** Omitted by read-only hosts, which must not show install controls. */
  onInstall?: (
    request: PluginDetailInstallRequest,
  ) => Promise<PluginDetailInstallResult | PluginDetailHostPlugin>;
  onPluginUpdated?: (plugin: PluginDetailHostPlugin) => void;
  /**
   * Share, rendered once in the detail's action bar at the top right of the
   * chrome row, immediately before the primary action, on the overview and
   * on member views alike. Omitted on hosts that cannot share.
   */
  shareAction?: MarketplaceShareAction;
  /** Host secondary actions, placed before the built-in ones and Share. */
  headerActions?: ReactNode;
  /**
   * The host's primary, such as the shared Try it CTA, shown while the detail
   * has no Install action of its own, so the bar keeps exactly one primary.
   * A host whose `installContent` declares its own primary passes this only
   * once that content has none.
   */
  idlePrimaryAction?: ReactNode;
  /** Replaces the header primary while reusing this host's installation flow. */
  renderPrimaryAction?: (action: {
    onInstall: () => void;
    busy: boolean;
  }) => ReactNode;
  headerIcon?: ReactNode;
  /** Page hosts own an h1; nested desktop panels retain the default h2. */
  titleAs?: 'h1' | 'h2';
  authorDisplay?: string | null;
  connectionContent?: ReactNode;
  /**
   * Host transport's install panel, replacing the built-in one. It declares
   * its page-level buttons with `DetailPageActions`, so they join the
   * standard action bar in this detail's chrome.
   */
  installContent?: ReactNode;
  onToggleCodexCompat?: (disabled: boolean) => Promise<PluginDetailHostPlugin>;
  onOpenRelated?: (id: string) => void;
  relatedItems?: readonly PluginDetailRelatedItem[];
  relatedContent?: ReactNode;
  loading?: boolean;
  error?: string;
  truncated?: boolean;
  readme?: { body: string; truncated?: boolean };
  markdownOptions?: MarkdownProps['options'];
  needsInstall?: boolean;
  brandName?: string;
  compatibilityError?: string;
  formatDate?: (value: string) => string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function providerLabel(provider: PluginProvider): string {
  return provider === 'claude' ? 'Claude' : 'Codex';
}

function installedPlugin(
  result: PluginDetailInstallResult | PluginDetailHostPlugin,
): PluginDetailHostPlugin {
  return 'plugin' in result ? result.plugin : result;
}

function providerOutcomes(
  result: PluginDetailInstallResult | PluginDetailHostPlugin,
): PluginDetailInstallResult['providerOutcomes'] {
  return 'plugin' in result ? result.providerOutcomes : undefined;
}

interface ProviderRow {
  provider: PluginProvider;
  applicable: boolean;
  available: boolean;
  installed: boolean;
  statusText: string;
}

const PROVIDERS: readonly PluginProvider[] = ['claude', 'codex'];

function providerRow(
  provider: PluginProvider,
  status: BuiltInProviderInstallStatus | undefined,
  hasFacet: boolean,
): ProviderRow {
  const applicable = hasFacet || status !== undefined;
  const available = status?.available ?? hasFacet;
  if (!available) {
    return {
      provider,
      applicable,
      available,
      installed: false,
      statusText: 'Not available for this plugin',
    };
  }
  if (!status) {
    return {
      provider,
      applicable,
      available,
      installed: false,
      statusText: 'Status unavailable',
    };
  }
  return {
    provider,
    applicable,
    available,
    installed: status.installed,
    statusText: status.installed
      ? status.enabled === false
        ? 'Installed, disabled'
        : 'Installed'
      : 'Not installed',
  };
}

interface BuiltInInstall {
  visibleRows: ProviderRow[];
  /** Available providers that do not have the plugin yet. */
  installable: PluginProvider[];
  installing: PluginProvider[] | null;
  message: { tone: 'success' | 'error'; text: string } | null;
  install: (providers: PluginProvider[]) => Promise<void>;
}

function useBuiltInInstall(
  plugin: PluginDetailHostPlugin,
  onInstall: PluginDetailHostProps['onInstall'],
  onPluginUpdated: PluginDetailHostProps['onPluginUpdated'],
): BuiltInInstall {
  const [installing, setInstalling] = useState<PluginProvider[] | null>(null);
  const [message, setMessage] = useState<BuiltInInstall['message']>(null);
  const rows = useMemo(
    () =>
      PROVIDERS.map((provider) =>
        providerRow(
          provider,
          plugin.globalInstallStatus?.[provider],
          provider === 'claude'
            ? plugin.facets?.claude !== undefined
            : plugin.facets?.codex !== undefined ||
                plugin.facets?.codexCompatibility !== undefined,
        ),
      ),
    [plugin],
  );
  const visibleRows = rows.some((row) => row.applicable)
    ? rows.filter((row) => row.applicable)
    : rows;
  const installable = visibleRows
    .filter((row) => row.available && !row.installed)
    .map((row) => row.provider);

  useEffect(() => {
    setInstalling(null);
    setMessage(null);
  }, [plugin.marketplaceId, plugin.name]);

  const install = async (providers: PluginProvider[]): Promise<void> => {
    if (!onInstall) return;
    setInstalling(providers);
    setMessage(null);
    try {
      const result = await onInstall({ kind: 'providers', providers });
      onPluginUpdated?.(installedPlugin(result));
      const outcomes = providerOutcomes(result);
      const failures = providers.filter(
        (provider) => outcomes?.[provider]?.installed === false,
      );
      if (failures.length > 0) {
        const failure = failures[0];
        setMessage({
          tone: 'error',
          text:
            failures.length === providers.length && providers.length > 1
              ? `Could not install plugin: ${outcomes?.[failure]?.error ?? 'Unknown error.'}`
              : `Could not install to ${providerLabel(failure)}: ${outcomes?.[failure]?.error ?? 'Unknown error.'}`,
        });
      } else {
        setMessage({
          tone: 'success',
          text: `Installed to ${providers.map(providerLabel).join(' and ')}.`,
        });
      }
    } catch (error) {
      setMessage({
        tone: 'error',
        text: `Could not install plugin: ${errorMessage(error)}`,
      });
    } finally {
      setInstalling(null);
    }
  };

  return { visibleRows, installable, installing, message, install };
}

function BuiltInInstallPanel({
  state,
  brandName,
}: {
  state: BuiltInInstall;
  brandName: string;
}): JSX.Element {
  const { visibleRows, installing, message, install } = state;
  const installingOnly = (provider: PluginProvider): boolean =>
    installing?.length === 1 && installing[0] === provider;
  return (
    <section
      className="rounded-lg border p-4"
      data-testid="built-in-install-panel"
    >
      <h3 className="text-s font-medium fg-primary">
        Install in provider apps
      </h3>
      <p className="text-xs fg-secondary mt-1">
        This plugin is available inside {brandName}. Install it to Claude or
        Codex to use it directly outside {brandName}.
      </p>
      <div className="mt-3 divide-y rounded-md border">
        {visibleRows.map((row) => (
          <div
            key={row.provider}
            className="flex flex-wrap items-center justify-between gap-3 px-3 py-2"
            data-testid={`built-in-install-row-${row.provider}`}
          >
            <div className="min-w-0">
              <p className="text-s fg-primary">{providerLabel(row.provider)}</p>
              <p
                className="text-xs fg-secondary"
                data-testid={`built-in-install-status-${row.provider}`}
              >
                {row.statusText}
              </p>
            </div>
            {row.available && (
              <button
                type="button"
                onClick={() => void install([row.provider])}
                disabled={installing !== null}
                className={`${SECONDARY_ACTION_BUTTON_CLASS} disabled:opacity-50`}
                data-testid={`built-in-install-button-${row.provider}`}
              >
                {installingOnly(row.provider)
                  ? `Installing to ${providerLabel(row.provider)}…`
                  : row.installed
                    ? `Reinstall in ${providerLabel(row.provider)}`
                    : `Install to ${providerLabel(row.provider)}`}
              </button>
            )}
          </div>
        ))}
      </div>
      {message && (
        <p
          className={`mt-3 text-xs ${message.tone === 'success' ? 'fg-secondary' : 'fg-destructive'}`}
          data-testid="built-in-install-message"
          role="status"
        >
          {message.text}
        </p>
      )}
    </section>
  );
}

export function PluginDetailHost({
  plugin,
  onBack,
  loadDetail,
  readComponent,
  onInstall,
  onPluginUpdated,
  shareAction,
  headerActions,
  idlePrimaryAction,
  renderPrimaryAction,
  headerIcon,
  titleAs = 'h2',
  authorDisplay,
  connectionContent,
  installContent,
  onToggleCodexCompat,
  onOpenRelated,
  relatedItems = [],
  relatedContent,
  loading = false,
  error,
  truncated = false,
  readme,
  markdownOptions,
  needsInstall = false,
  brandName = 'the app',
  compatibilityError = '',
  formatDate = (value): string => new Date(value).toLocaleDateString(),
}: PluginDetailHostProps): JSX.Element {
  const Title = titleAs;
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState('');
  const [compatError, setCompatError] = useState('');
  const [compatBusy, setCompatBusy] = useState(false);
  const builtIn = useBuiltInInstall(plugin, onInstall, onPluginUpdated);
  const actionSlots = useDetailActionSlots();

  // Host-local action state is scoped to one plugin; a failed toggle or
  // install message from a previous plugin must not survive an identity
  // change in a reused host instance.
  useEffect(() => {
    setInstalling(false);
    setInstallError('');
    setCompatError('');
    setCompatBusy(false);
  }, [plugin.marketplaceId, plugin.name]);

  if (loading) {
    return (
      <div data-testid="plugin-detail-loading">
        <Title id="plugin-detail-title" className="sr-only">
          {pluginDisplayName(plugin)}
        </Title>
        <LoadingPlaceholder label="Loading plugin…" showSpinner />
      </div>
    );
  }
  if (error) {
    return (
      <div data-testid="plugin-detail-error">
        <Title id="plugin-detail-title" className="sr-only">
          {pluginDisplayName(plugin)}
        </Title>
        <ErrorBanner error={error} />
        <button
          type="button"
          onClick={() => void loadDetail()}
          data-testid="plugin-detail-retry"
          className="focus-ring mt-3 rounded-md border px-4 py-2 text-s font-medium fg-primary"
        >
          Retry
        </button>
      </div>
    );
  }

  const installExternal = async (): Promise<void> => {
    if (!onInstall) return;
    setInstalling(true);
    setInstallError('');
    try {
      const result = await onInstall({ kind: 'external' });
      onPluginUpdated?.(installedPlugin(result));
    } catch (installFailure) {
      setInstallError(errorMessage(installFailure));
    } finally {
      setInstalling(false);
    }
  };

  const metadataFooter = (
    <>
      {(compatError || compatibilityError) && (
        <p className="text-xs fg-destructive mt-2">
          {compatError || compatibilityError}
        </p>
      )}
      {plugin.providerSupport.codex === 'compat' && onToggleCodexCompat && (
        <div className="mt-4 flex items-center justify-between gap-4 rounded-lg ring-[length:var(--border-hairline)] ring-line-base bg-secondary/30 px-4 py-3">
          <div className="pr-3">
            <p className="text-xs font-medium fg-primary">
              Codex compatibility mode
            </p>
            <p className="text-xs fg-secondary">
              When off, this Claude plugin is not used under Codex.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-label="Codex compatibility mode"
            aria-checked={plugin.codexCompatDisabled !== true}
            disabled={compatBusy}
            onClick={() => {
              setCompatBusy(true);
              setCompatError('');
              void onToggleCodexCompat(plugin.codexCompatDisabled !== true)
                .then((updated) => onPluginUpdated?.(updated))
                .catch((toggleFailure: unknown) =>
                  setCompatError(errorMessage(toggleFailure)),
                )
                .finally(() => setCompatBusy(false));
            }}
            className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${plugin.codexCompatDisabled === true ? 'bg-muted' : 'bg-accent'}`}
            data-testid="plugin-detail-codex-compat-disable-toggle"
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-base transition-transform ${plugin.codexCompatDisabled === true ? 'translate-x-0.5' : 'translate-x-4'}`}
            />
          </button>
        </div>
      )}
    </>
  );

  // The standard action bar: [secondary…] [Share] [Primary], at the top
  // right of the chrome row on the overview and member views alike.
  const canInstall = onInstall !== undefined;
  const showInstallPrompt = canInstall && needsInstall;
  const builtInPanel = plugin.builtIn === true || plugin.curated === true;
  const installAction =
    !canInstall || installContent ? undefined : showInstallPrompt ||
      installing ? (
      <ExecutionActionButton
        placement="detail"
        label={installing ? 'Installing…' : 'Install'}
        ariaLabel="Install plugin"
        variant="primary"
        onClick={() => void installExternal()}
        disabled={installing}
        dataTestId="plugin-detail-install"
        stopKeyDownPropagation={false}
      />
    ) : builtInPanel &&
      (builtIn.installable.length > 0 || builtIn.installing !== null) ? (
      <ExecutionActionButton
        placement="detail"
        label={builtIn.installing !== null ? 'Installing…' : 'Install'}
        ariaLabel={`Install to ${builtIn.installable.map(providerLabel).join(' and ')}`}
        variant="primary"
        onClick={() => void builtIn.install(builtIn.installable)}
        disabled={builtIn.installing !== null}
        dataTestId="plugin-detail-install"
        stopKeyDownPropagation={false}
      />
    ) : undefined;
  const primaryAction = renderPrimaryAction
    ? renderPrimaryAction({
        onInstall: (): void => {
          if (builtInPanel && !showInstallPrompt)
            void builtIn.install(builtIn.installable);
          else void installExternal();
        },
        busy: installing || builtIn.installing !== null,
      })
    : (installAction ?? idlePrimaryAction);
  const updateAction =
    canInstall && !installContent && plugin.externalSource && !needsInstall ? (
      <button
        type="button"
        onClick={() => void installExternal()}
        disabled={installing}
        className={`${SECONDARY_ACTION_BUTTON_CLASS} gap-1.5 disabled:opacity-50`}
        data-testid="plugin-detail-update"
      >
        <RefreshSpinner spinning={installing} />
        {installing ? 'Updating…' : 'Update'}
      </button>
    ) : undefined;
  const chromeActions = (
    <DetailActionBar
      secondary={
        headerActions || updateAction ? (
          <>
            {headerActions}
            {updateAction}
          </>
        ) : undefined
      }
      share={
        shareAction ? (
          <MarketplaceShareButton
            action={shareAction}
            name={pluginDisplayName(plugin)}
            placement="detail"
            dataTestId="plugin-detail-share"
          />
        ) : undefined
      }
      primary={primaryAction}
      slots={actionSlots}
    />
  );

  const hasInstallActions =
    !!connectionContent ||
    (canInstall && builtInPanel) ||
    !!plugin.externalSource ||
    showInstallPrompt ||
    installing;
  const installActions = hasInstallActions ? (
    <>
      {connectionContent}
      {canInstall && builtInPanel && (
        <BuiltInInstallPanel state={builtIn} brandName={brandName} />
      )}
      {plugin.externalSource && (
        <div className="min-w-0 rounded-lg ring-[length:var(--border-hairline)] ring-line-base bg-secondary/30 px-4 py-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <dl className="min-w-0 flex-1 space-y-1 text-xs">
              <div className="flex gap-2">
                <dt className="fg-secondary whitespace-nowrap">Source:</dt>
                <dd className="fg-secondary min-w-0 truncate">
                  <a
                    href={
                      typeof plugin.externalSource === 'string'
                        ? plugin.externalSource
                        : plugin.externalSource.url
                    }
                    target="_blank"
                    rel="noopener noreferrer"
                    className="focus-ring rounded fg-secondary hover:fg-primary hover:underline"
                  >
                    {typeof plugin.externalSource === 'string'
                      ? plugin.externalSource
                      : plugin.externalSource.url}
                  </a>
                </dd>
              </div>
              {plugin.cachedAt && (
                <div className="flex gap-2">
                  <dt className="fg-secondary whitespace-nowrap">
                    Last fetched:
                  </dt>
                  <dd className="fg-secondary">
                    {formatDate(plugin.cachedAt)}
                  </dd>
                </div>
              )}
            </dl>
          </div>
        </div>
      )}
      {showInstallPrompt && !installing && (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <p className="text-s fg-secondary">
            This plugin&rsquo;s content is hosted externally and needs to be
            installed.
          </p>
          {installError && (
            <p className="mt-4 text-s fg-destructive">{installError}</p>
          )}
        </div>
      )}
      {installing && (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <LoadingSpinner tone="accent" className="mb-3" />
          <p className="text-s fg-secondary">Installing plugin&hellip;</p>
        </div>
      )}
    </>
  ) : undefined;

  const sharedRelatedContent =
    relatedContent ??
    (relatedItems.length > 0 && onOpenRelated ? (
      <section data-testid="plugin-detail-related">
        <PluginDetailSectionHeading>Related</PluginDetailSectionHeading>
        {relatedItems.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onOpenRelated(item.id)}
            className="block text-s fg-accent"
          >
            {item.label}
          </button>
        ))}
      </section>
    ) : undefined);

  return (
    <div data-testid="plugin-detail-host">
      {truncated && (
        <p
          role="note"
          data-testid="plugin-detail-truncated"
          className="mb-4 rounded-lg border bg-secondary/50 px-4 py-3 text-s fg-secondary"
        >
          Some content was truncated. Open this plugin in {brandName} for the
          full detail.
        </p>
      )}
      <PluginDetailContent
        plugin={plugin}
        titleAs={titleAs}
        authorDisplay={authorDisplay}
        headerIcon={headerIcon}
        onBack={onBack}
        onReadComponent={readComponent}
        readme={readme}
        markdownOptions={markdownOptions}
        metadataFooter={metadataFooter}
        installActions={
          installContent || installActions ? (
            <DetailActionSlotsProvider slots={actionSlots}>
              {installContent ?? installActions}
            </DetailActionSlotsProvider>
          ) : undefined
        }
        hideComponents={showInstallPrompt || installing}
        relatedContent={sharedRelatedContent}
        headerActions={chromeActions}
      />
    </div>
  );
}
