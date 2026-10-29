import {
  deleteDesktopMcpTarget,
  moveDesktopMcpTarget,
} from '../mcp/mcpManagementOperations';
import {
  getDefaultConfigId,
  CLOUD_DISPLAY_NAME_MAX,
  CLOUD_HTTPS_REQUIRED,
  CLOUD_SIGN_IN_REQUIRED,
  CLOUD_CONNECT_FAILED,
  CLOUD_SINGLE_CONFIG_REQUIRED,
  CLOUD_REGISTRATION_UNAVAILABLE,
  cloudMcpHeaders,
  cloudHeadersProblem,
  cloudUrlProblem,
  isCloudReadyUrl,
  defaultConfigAuthToken,
  loadSignedInAccountId,
  withoutAuthTokens,
  sameHeaders,
  clearDeviceSignIns,
  promoteCustomMcpServer,
} from '../mcp/mcpManagementOperations';
import {
  McpMoveToCloudDialog,
  McpMoveToDeviceDialog,
  McpPromoteDialog,
} from '../mcp/McpPlacementDialogs';
import type { MarketplaceShareAction } from '@canopy/ui-shared/lib';
import { InstalledEntryStatusSection } from '../plugins/InstalledEntryStatusSection';
import { capitalizeFirstLetter } from '@canopy/ui-shared/lib';
import { flattenMcpServerRows } from '@canopy/desktop-shared/lib/mcp-server-rows';
import {
  ACCOUNT_MCP_ENDPOINT_REQUIRED,
  type AccountMcpClientSetup,
  type AccountMcpOAuthClientCredentials,
} from '@canopy/protocol/mcp-servers';
import { DEFAULT_MCP_HTTP_AUTH_HANDLER } from '@canopy/desktop-shared/types';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  ACCOUNT_MCP_ACTION_EVENT,
  isAccountMcpActionEventDetail,
} from '@/lib/accountMcpEvents';
import {
  AccountMcpCredentialDialog,
  AccountMcpControls,
  AccountMcpDetails,
  McpTierBadge,
  type AccountMcpCredentialKind,
} from '../mcp/AccountMcpControls';
import { useAccountMcpActions } from '../../hooks/useAccountMcpActions';
import {
  curatedMcpAddTarget,
  customAccountMcpPromotable,
  findAccountMcpRow,
} from '@canopy/ui-app/capability';
import { extractIpcErrorMessage } from '@/lib/errors';
import { pointRefsAt } from '@/lib/mcpServerRefs';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { type JSX, type ReactNode, useEffect, useRef, useState } from 'react';
import { useMcpServerList } from '../../hooks/useMcpServerList';
import { McpServerLogo } from '../shared/McpServerLogo';
import { useCuratedMcpServers } from '../../hooks/useCuratedMcpServers';
import { useMcpServerStatuses } from '../../hooks/useMcpServerStatuses';
import { formatDate } from '../../lib/format';
import { EntityEditModalContent } from './EntityEditModalFooter';
import { BackDetailOverlayShell } from './BackDetailOverlayShell';
import {
  createEntityEditModalFooterProps,
  runCancellableModalLoad,
  runEntityEditOperation,
} from './entityEditModalUtils';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { DialogModal } from '../shared/DialogModal';
import { McpBrowseDialog } from '../mcp/McpBrowseDialog';
import {
  ErrorBanner,
  LoadingPlaceholder,
  EmptyState,
} from '../shared/StatusBlocks';
import { brandText } from '@/lib/brand';
import { useEarlyAccessTitle } from '@/lib/earlyAccessTitles';
import {
  curatedMcpDesktopOnly,
  curatedMcpProviderOnly,
  type CuratedMcpRequiredConfigField,
  type CuratedMcpServerEntry,
} from '@canopy/protocol/mcp-catalog';
import type {
  AccountMcpConnectionSummary,
  SaveMcpServerRequest,
  AccountMcpConnection,
  McpHttpAuthHandler,
  McpOAuthConfigData,
  McpServerData,
  McpServerConfigData,
  McpServerCuratedMetadata,
  McpServerHealthCheckResult,
  McpServerIndexEntry,
  McpServerStatusEntry,
  McpServerTestConnectionResult,
  UpdateAccountMcpConnectionRequest,
} from '@canopy/desktop-shared/types/mcp-servers';
import { AccountMcpConnectionError } from '@canopy/desktop-shared/types/mcp-servers';
import { Button, Tooltip } from '@canopy/ui-shared';
import {
  ActionMenuItems,
  ActionMenuRowStyle,
  FloatingMenu,
  McpClientSetupDetails,
  McpConnectionStatusBadge,
  Notice,
  overlayGeneration,
  type ActionMenuItem,
} from '@canopy/ui-shared/components';
import {
  deriveMcpConnectionBadge,
  mcpDeleteImpact,
  mcpPlacementLabel,
  mcpConnectErrorCodeTitle,
  mcpConnectErrorMessage,
} from '@canopy/ui-shared/lib';
import {
  accountMcpCatalogConnectStep,
  accountMcpClientPromptStep,
  accountMcpConnectionLive,
  accountMcpConnectStep,
  accountMcpCredentialTarget,
  accountMcpEndpointEntry,
  accountMcpUnavailableMessage,
  mcpAlreadyConnectedMessage,
  type AccountMcpConnectStep,
  type AccountMcpCredentialTarget,
} from '../mcp/accountMcpConnectSteps';
import { openCloudAccountSettings } from '@/lib/navigation/settings-destinations';
import {
  CloseIcon as AppCatalogCloseIcon,
  ChevronRightMediumIcon as AppCatalogChevronRightMediumIcon,
  GlobeIcon as AppCatalogGlobeIcon,
  ChevronDownMediumIcon as AppCatalogChevronDownMediumIcon,
  DocumentPencilIcon as AppCatalogDocumentPencilIcon,
  TerminalIcon as AppCatalogTerminalIcon,
  PlusIcon as AppCatalogPlusIcon,
  StorefrontIcon as AppCatalogStorefrontIcon,
} from '@canopy/ui-shared/icons/AppIcons';

// ---------------------------------------------------------------------------
// OAuth helpers
// ---------------------------------------------------------------------------

interface OAuthFormState {
  enabled: boolean;
  advancedOpen: boolean;
  usePkce: boolean;
  clientId: string;
  callbackPort?: number;
  /**
   * The pinned port came from a curated catalog entry, so the redirect URI is
   * the vendor's to define. Never set from user input: a hand-authored port
   * keeps Canopy's own redirect shape, which is what its provider has on file.
   */
  vendorRegisteredRedirect?: boolean;
  authorizationUrl: string;
  tokenUrl: string;
  scopes: string;
  audience: string;
}

const EMPTY_OAUTH_FORM: OAuthFormState = {
  enabled: false,
  advancedOpen: false,
  usePkce: true,
  clientId: '',
  authorizationUrl: '',
  tokenUrl: '',
  scopes: '',
  audience: '',
};

export function oauthFromDefinition(
  oauth: McpOAuthConfigData | undefined,
): OAuthFormState {
  if (!oauth) return { ...EMPTY_OAUTH_FORM };
  const advancedOpen = Boolean(
    oauth.clientId ||
    oauth.callbackPort !== undefined ||
    oauth.authorizationUrl ||
    oauth.tokenUrl ||
    (oauth.scopes && oauth.scopes.length > 0) ||
    oauth.audience,
  );
  return {
    enabled: true,
    advancedOpen,
    usePkce: oauth.usePkce ?? true,
    clientId: oauth.clientId ?? '',
    callbackPort: oauth.callbackPort,
    ...(oauth.vendorRegisteredRedirect === true
      ? { vendorRegisteredRedirect: true }
      : {}),
    authorizationUrl: oauth.authorizationUrl ?? '',
    tokenUrl: oauth.tokenUrl ?? '',
    scopes: (oauth.scopes ?? []).join(' '),
    audience: oauth.audience ?? '',
  };
}

/** Build an OAuth form from a curated entry's non-secret hint subset. */
export function oauthFromCuratedHints(
  entry: CuratedMcpServerEntry,
): OAuthFormState {
  const hints = entry.oauthHints;
  const requiresClientId = Boolean(
    entry.requiredConfigFields?.some(
      (field) => field.kind === 'oauth-client-id',
    ),
  );
  if (!hints) {
    return requiresClientId
      ? { ...EMPTY_OAUTH_FORM, enabled: true, advancedOpen: true }
      : { ...EMPTY_OAUTH_FORM };
  }
  const advancedOpen = Boolean(
    hints.clientId ||
    hints.callbackPort !== undefined ||
    hints.authorizationUrl ||
    hints.tokenUrl ||
    (hints.scopes && hints.scopes.length > 0) ||
    hints.audience ||
    requiresClientId,
  );
  return {
    enabled: true,
    advancedOpen,
    usePkce: hints.usePkce ?? true,
    clientId: hints.clientId ?? '',
    callbackPort: hints.callbackPort,
    ...(hints.callbackPort !== undefined
      ? { vendorRegisteredRedirect: true }
      : {}),
    authorizationUrl: hints.authorizationUrl ?? '',
    tokenUrl: hints.tokenUrl ?? '',
    scopes: (hints.scopes ?? []).join(' '),
    audience: hints.audience ?? '',
  };
}

/** Extract the non-secret curated metadata persisted on a server definition. */
export function curatedMetadataFromEntry(
  entry: CuratedMcpServerEntry,
): McpServerCuratedMetadata {
  return {
    key: entry.key,
    ...(entry.logoUrl ? { logoUrl: entry.logoUrl } : {}),
    ...(entry.docsUrl ? { docsUrl: entry.docsUrl } : {}),
    ...(entry.supportUrl ? { supportUrl: entry.supportUrl } : {}),
    ...(entry.privacyPolicyUrl
      ? { privacyPolicyUrl: entry.privacyPolicyUrl }
      : {}),
    ...(entry.authorName ? { authorName: entry.authorName } : {}),
    ...(entry.authorUrl ? { authorUrl: entry.authorUrl } : {}),
    requiresProviderAuth: curatedRequiresProviderAuth(entry),
  };
}

/** Curated catalog metadata is valid only for HTTP server definitions. */
export function curatedMetadataForServerType(
  serverType: McpServerData['definition']['type'],
  curated: McpServerCuratedMetadata | undefined,
): McpServerCuratedMetadata | undefined {
  return serverType === 'http' ? curated : undefined;
}

function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

interface OAuthValidationResult {
  oauth: McpOAuthConfigData | null;
  error: string | null;
}

export function optionalNumberInputValue(
  valueAsNumber: number,
): number | undefined {
  return Number.isFinite(valueAsNumber) ? valueAsNumber : undefined;
}

export function validateOAuthForm(form: OAuthFormState): OAuthValidationResult {
  if (!form.enabled) {
    return { oauth: null, error: null };
  }
  const clientId = form.clientId.trim();
  const authorizationUrl = form.authorizationUrl.trim();
  const tokenUrl = form.tokenUrl.trim();
  if (
    form.callbackPort !== undefined &&
    (!Number.isInteger(form.callbackPort) ||
      form.callbackPort < 1 ||
      form.callbackPort > 65_535)
  ) {
    return {
      oauth: null,
      error: 'OAuth callback port must be an integer from 1 to 65535.',
    };
  }
  if (authorizationUrl && !isValidHttpUrl(authorizationUrl)) {
    return {
      oauth: null,
      error: 'OAuth Authorization URL must be http: or https:.',
    };
  }
  if (tokenUrl && !isValidHttpUrl(tokenUrl)) {
    return { oauth: null, error: 'OAuth Token URL must be http: or https:.' };
  }
  if (
    authorizationUrl &&
    tokenUrl &&
    new URL(authorizationUrl).origin !== new URL(tokenUrl).origin
  ) {
    return {
      oauth: null,
      error: 'OAuth Authorization URL and Token URL must use the same origin.',
    };
  }
  const scopes = form.scopes
    .split(/\s+/)
    .map((s: string) => s.trim())
    .filter((s: string) => s.length > 0);
  const audience = form.audience.trim();
  const oauth: McpOAuthConfigData = {
    usePkce: form.usePkce,
    ...(clientId.length > 0 ? { clientId } : {}),
    ...(form.callbackPort !== undefined
      ? { callbackPort: form.callbackPort }
      : {}),
    // Persisted so the redirect shape survives a reload. Only a curated entry
    // sets it; a port the user typed keeps Canopy's own shape.
    ...(form.vendorRegisteredRedirect === true &&
    form.callbackPort !== undefined
      ? { vendorRegisteredRedirect: true }
      : {}),
    ...(authorizationUrl.length > 0 ? { authorizationUrl } : {}),
    ...(tokenUrl.length > 0 ? { tokenUrl } : {}),
    ...(scopes.length > 0 ? { scopes } : {}),
    ...(audience.length > 0 ? { audience } : {}),
  };
  return { oauth, error: null };
}

export function curatedInitialUrl(entry: CuratedMcpServerEntry): string {
  if (!entry.urlOptions?.length) return entry.url;
  return entry.urlOptions.some((option) => option.url === entry.url)
    ? entry.url
    : entry.urlOptions[0].url;
}

export function curatedRequiresProviderAuth(
  entry: CuratedMcpServerEntry,
): boolean {
  return Boolean(
    entry.requiredConfigFields?.some(
      (field) => field.kind === 'oauth-client-secret',
    ),
  );
}

export function validateCuratedSetup(
  entry: CuratedMcpServerEntry,
  selectedUrl: string,
  form: OAuthFormState,
): string | null {
  if (
    entry.urlOptions?.length &&
    !entry.urlOptions.some((option) => option.url === selectedUrl)
  ) {
    return 'Select one of the available MCP endpoints.';
  }
  if (
    !curatedRequiresProviderAuth(entry) &&
    entry.requiredConfigFields?.some(
      (field) => field.kind === 'oauth-client-id',
    ) &&
    form.clientId.trim().length === 0
  ) {
    return 'OAuth Client ID is required for this catalog entry.';
  }
  return null;
}

function hasAnyAuthTokenConfigured(configs: McpServerConfigData[]): boolean {
  return configs.some(
    (config) =>
      config.authToken !== undefined && config.authToken.trim().length > 0,
  );
}

type McpServerScope = 'device' | 'cloud';

interface McpScopeControlProps {
  value: McpServerScope;
  cloudDisabled: boolean;
  onChange: (scope: McpServerScope) => void;
}

function McpScopeControl({
  value,
  cloudDisabled,
  onChange,
}: McpScopeControlProps): JSX.Element {
  const options: Array<{ scope: McpServerScope; label: string }> = [
    { scope: 'device', label: mcpPlacementLabel('device') },
    { scope: 'cloud', label: mcpPlacementLabel('cloud') },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="Scope"
      className="inline-flex items-center gap-1 rounded-full bg-base p-1 ring-1 ring-inset ring-line-base"
      data-testid="mcp-server-scope"
    >
      {options.map(
        (option): JSX.Element => (
          <button
            key={option.scope}
            type="button"
            role="radio"
            aria-checked={value === option.scope}
            disabled={option.scope === 'cloud' && cloudDisabled}
            onClick={(): void => onChange(option.scope)}
            data-testid={`mcp-server-scope-${option.scope}`}
            className={`focus-ring inline-flex items-center justify-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition disabled:opacity-50 ${
              value === option.scope
                ? 'bg-accent fg-emphasis'
                : 'fg-secondary hover:bg-fg-primary/[0.06]'
            }`}
          >
            {option.label}
          </button>
        ),
      )}
    </div>
  );
}

function ignoreAccountRefresh(): Promise<void> {
  return Promise.resolve();
}

// ---------------------------------------------------------------------------
// KeyValueEditor
// ---------------------------------------------------------------------------

interface KeyValueEditorProps {
  entries: Record<string, string>;
  onChange: (entries: Record<string, string>) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  valueType?: string;
}

function KeyValueEditor({
  entries,
  onChange,
  keyPlaceholder = 'Key',
  valuePlaceholder = 'Value',
  valueType = 'text',
}: KeyValueEditorProps): JSX.Element {
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');

  function handleAdd(): void {
    if (!newKey.trim() || !newValue.trim()) return;
    onChange({ ...entries, [newKey.trim()]: newValue.trim() });
    setNewKey('');
    setNewValue('');
  }

  function handleRemove(key: string): void {
    const next = { ...entries };
    delete next[key];
    onChange(next);
  }

  return (
    <div className="space-y-2">
      {Object.entries(entries).map(([key, value]) => (
        <div key={key} className="flex items-center gap-2">
          <input
            type="text"
            value={key}
            readOnly
            className="flex-1 rounded-md border bg-secondary/50 px-2 py-1 text-xs fg-primary"
          />
          <input
            type={valueType}
            value={value}
            readOnly
            className="flex-1 rounded-md border bg-secondary/50 px-2 py-1 text-xs fg-primary"
          />
          <button
            type="button"
            onClick={() => handleRemove(key)}
            className="focus-ring rounded p-1 fg-secondary hover:fg-destructive transition-colors"
            aria-label={`Remove ${key}`}
          >
            <AppCatalogCloseIcon width="12" height="12" />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={newKey}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            setNewKey(e.target.value)
          }
          placeholder={keyPlaceholder}
          className="focus-ring flex-1 rounded-md border bg-base px-2 py-1 text-xs"
        />
        <input
          type={valueType}
          value={newValue}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            setNewValue(e.target.value)
          }
          placeholder={valuePlaceholder}
          className="focus-ring flex-1 rounded-md border bg-base px-2 py-1 text-xs"
        />
        <button
          type="button"
          onClick={handleAdd}
          disabled={!newKey.trim() || !newValue.trim()}
          className="focus-ring rounded-md px-2 py-1 text-xs font-medium bg-secondary fg-primary hover:bg-accent-subtle transition-colors disabled:opacity-50"
        >
          Add
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ConfigEditor
// ---------------------------------------------------------------------------

interface ConfigEditorProps {
  config: McpServerConfigData;
  onChange: (config: McpServerConfigData) => void;
  onDelete: () => void;
  initialExpanded?: boolean;
}

function ConfigEditor({
  config,
  onChange,
  onDelete,
  initialExpanded = false,
}: ConfigEditorProps): JSX.Element {
  const [expanded, setExpanded] = useState(initialExpanded);
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div className="rounded-lg border bg-secondary/20">
      {/* Header row */}
      <div className="flex items-center gap-3 px-3 py-2">
        <input
          type="checkbox"
          checked={config.enabled}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            onChange({ ...config, enabled: e.target.checked })
          }
          className="rounded"
          aria-label={`Enable ${config.name || 'config'}`}
        />
        <span className="flex-1 text-sm fg-primary truncate">
          {config.name || 'Untitled config'}
        </span>
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="focus-ring rounded p-1 fg-secondary hover:fg-primary transition-colors"
          aria-label={expanded ? 'Collapse config' : 'Expand config'}
        >
          <AppCatalogChevronRightMediumIcon
            width="14"
            height="14"
            className={`transition-transform ${expanded ? 'rotate-90' : ''}`}
          />
        </button>
      </div>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t px-3 py-3 space-y-3">
          {/* Name */}
          <label className="block text-xs">
            <span className="mb-1 block fg-secondary">Name</span>
            <input
              type="text"
              value={config.name}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                onChange({ ...config, name: e.target.value })
              }
              placeholder="Config name"
              className="focus-ring w-full rounded-md border bg-base px-2 py-1 text-xs"
            />
          </label>

          {/* Description */}
          <label className="block text-xs">
            <span className="mb-1 block fg-secondary">Description</span>
            <input
              type="text"
              value={config.description}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                onChange({ ...config, description: e.target.value })
              }
              placeholder="Optional description"
              className="focus-ring w-full rounded-md border bg-base px-2 py-1 text-xs"
            />
          </label>

          {/* Env vars */}
          <div className="text-xs">
            <span className="mb-1 block fg-secondary">
              Environment variables
            </span>
            <KeyValueEditor
              entries={config.envVars}
              onChange={(envVars: Record<string, string>) =>
                onChange({ ...config, envVars })
              }
              keyPlaceholder="VAR_NAME"
              valuePlaceholder="value"
            />
          </div>

          {/* Extra args */}
          <label className="block text-xs">
            <span className="mb-1 block fg-secondary">Extra arguments</span>
            <input
              type="text"
              value={config.extraArgs.join(' ')}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                onChange({
                  ...config,
                  extraArgs: e.target.value
                    .split(' ')
                    .filter((a: string) => a.length > 0),
                })
              }
              placeholder="Space-separated extra args"
              className="focus-ring w-full rounded-md border bg-base px-2 py-1 text-xs"
            />
          </label>

          {/* Extra headers */}
          <div className="text-xs">
            <span className="mb-1 block fg-secondary">Extra headers</span>
            <KeyValueEditor
              entries={config.extraHeaders}
              onChange={(extraHeaders: Record<string, string>) =>
                onChange({ ...config, extraHeaders })
              }
              keyPlaceholder="Header-Name"
              valuePlaceholder="header-value"
            />
          </div>

          {/* Auth token */}
          <label className="block text-xs">
            <span className="mb-1 block fg-secondary">Auth token</span>
            <input
              type="password"
              value={config.authToken ?? ''}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                onChange({ ...config, authToken: e.target.value || undefined })
              }
              placeholder="Bearer token"
              className="focus-ring w-full rounded-md border bg-base px-2 py-1 text-xs"
            />
          </label>

          {/* Delete config */}
          <div className="pt-1">
            {!confirmDelete ? (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="focus-ring rounded-md px-2 py-1 text-xs font-medium fg-destructive hover:bg-destructive-subtle transition-colors"
              >
                Delete config
              </button>
            ) : (
              <span className="inline-flex items-center gap-2">
                <span className="text-xs fg-secondary">Are you sure?</span>
                <button
                  type="button"
                  onClick={onDelete}
                  className="focus-ring rounded-md px-2 py-1 text-xs font-medium fg-emphasis bg-destructive hover:bg-destructive/90 transition-colors"
                >
                  Confirm
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="focus-ring rounded-md px-2 py-1 text-xs font-medium fg-secondary hover:fg-primary hover:bg-secondary transition-colors"
                >
                  Cancel
                </button>
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// McpServerDialog
// ---------------------------------------------------------------------------

interface McpServerDialogProps {
  serverId: string | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
  /** Skip the modal enter animation, e.g. when swapping in for another modal. */
  noEnterAnimation?: boolean;
  /**
   * Curated catalog entry used to pre-fill a create-mode dialog (name,
   * description, url, HTTP transport, OAuth hints). Curated adds attach the
   * catalog metadata and default to the Canopy proxy (`httpAuthHandler`).
   * Ignored in edit mode.
   */
  initialCurated?: CuratedMcpServerEntry;
  /** Current catalog used to rehydrate constraints for installed entries. */
  curatedEntries?: CuratedMcpServerEntry[];
  mode?: 'device' | 'account';
  entryAction?: 'move-to-device';
  onAccountConnect?: (options: {
    bearerToken?: string;
    oauthClient?: AccountMcpOAuthClientCredentials;
    endpointUrl?: string;
  }) => void;
  /**
   * A cloud connection with no copy on this device. With `serverId` null the
   * dialog edits it in place, or moves it to this device.
   */
  accountConnection?: AccountMcpConnection;
  /**
   * Account setup for a catalog server that registers no OAuth clients
   * itself: the dialog collects the user's own app, and shows the redirect
   * URI to register when the cloud sent `clientSetup`.
   */
  requiresOAuthClient?: boolean;
  clientSetup?: AccountMcpClientSetup;
  /**
   * The catalog endpoint account setup starts on, when it reopens for the one
   * `clientSetup` describes. Ignored unless it is one of the entry's options.
   */
  initialEndpointUrl?: string;
}

/** Auth Handling selector value; `''` means "use the global default". */
type AuthHandlerChoice = '' | McpHttpAuthHandler;

function isAuthHandlerChoice(value: string): value is AuthHandlerChoice {
  return (
    value === '' ||
    value === 'canopy' ||
    value === 'provider' ||
    value === 'account'
  );
}

/** Why the cloud account is never offered for a desktop-only catalog server. */
const CURATED_DESKTOP_ONLY_REASON =
  'Desktop only. This server signs in on this device.';

export function McpServerDialog({
  serverId,
  onClose,
  onSaved,
  noEnterAnimation = false,
  initialCurated,
  curatedEntries = [],
  mode = 'device',
  entryAction,
  onAccountConnect,
  accountConnection,
  requiresOAuthClient = false,
  clientSetup,
  initialEndpointUrl,
}: McpServerDialogProps): JSX.Element {
  const cloudOnly = serverId === null && accountConnection !== undefined;
  const isCreate = serverId === null && !cloudOnly;
  const [accountFields, setAccountFields] = useState<Record<string, string>>(
    {},
  );
  const accountConnectionsEnabled = useFeatureFlagsStore((state): boolean =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopySharedMcpAccountConnections.key),
  );

  // Form state
  const [serverType, setServerType] = useState<'command' | 'http'>('http');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [url, setUrl] = useState('');
  const [headers, setHeaders] = useState<Record<string, string>>({});
  const [configs, setConfigs] = useState<McpServerConfigData[]>([]);
  const [oauthForm, setOauthForm] = useState<OAuthFormState>({
    ...EMPTY_OAUTH_FORM,
  });
  // HTTP-only Auth Handling preference ('' = global default).
  const [authHandler, setAuthHandler] = useState<AuthHandlerChoice>('');
  const [globalAuthHandler, setGlobalAuthHandler] =
    useState<McpHttpAuthHandler>();
  const [accountConnectionId, setAccountConnectionId] = useState('');
  const [accountConnections, setAccountConnections] = useState<
    AccountMcpConnectionSummary[]
  >([]);
  const [accountConnectionsLoading, setAccountConnectionsLoading] =
    useState(false);
  const [accountConnectionsError, setAccountConnectionsError] = useState('');
  const [accountConnectionsRetry, setAccountConnectionsRetry] = useState(0);
  // Non-secret curated metadata carried through save (create-from-catalog or
  // an already-curated server being edited).
  const [curatedMeta, setCuratedMeta] = useState<
    McpServerCuratedMetadata | undefined
  >(undefined);
  const curatedEntry =
    initialCurated ??
    curatedEntries.find((entry) => entry.key === curatedMeta?.key);
  const curatedRequiresProvider = Boolean(
    curatedMeta?.requiresProviderAuth ||
    (curatedEntry && curatedRequiresProviderAuth(curatedEntry)),
  );

  // undefined while loading; null when signed out.
  const [cloudAccountId, setCloudAccountId] = useState<string | null>();
  const accountActions = useAccountMcpActions(ignoreAccountRefresh);
  // Where the server lives when the dialog opened, and the user's choice.
  const [initialScope, setInitialScope] = useState<McpServerScope>('device');
  const [scope, setScope] = useState<McpServerScope>('device');
  const [scopeTouched, setScopeTouched] = useState(false);
  // The cloud connection an existing server lives in, when it has one.
  const [boundConnection, setBoundConnection] = useState<
    AccountMcpConnectionSummary | undefined
  >(accountConnection);
  // Write-only in the cloud; blank keeps what the cloud stores.
  const [cloudToken, setCloudToken] = useState('');
  const [clearStoredHeaders, setClearStoredHeaders] = useState(false);
  const [confirmMoveToDevice, setConfirmMoveToDevice] = useState(false);
  const [confirmMoveToCloud, setConfirmMoveToCloud] = useState(false);
  const [moveWithoutStoredHeaders, setMoveWithoutStoredHeaders] =
    useState(false);
  // A server moved off the cloud keeps one id across retries.
  const movedDeviceId = useRef<string | null>(null);
  const pendingMoveData = useRef<
    ((deviceId: string) => SaveMcpServerRequest) | null
  >(null);
  const pendingMoveToCloud = useRef<(() => Promise<void>) | null>(null);
  const isCustomHttp = serverType === 'http' && !curatedMeta?.key;
  const accountHeaders = cloudMcpHeaders(headers, configs);
  const hasAccountHeaders = Object.keys(accountHeaders).length > 0;
  const headersCloudProblem = cloudHeadersProblem(accountHeaders);
  const urlCloudProblem = cloudUrlProblem(url);
  const moveConfigProblem =
    !isCreate && initialScope === 'device' && configs.length > 1
      ? CLOUD_SINGLE_CONFIG_REQUIRED
      : undefined;
  const cloudEligible =
    isCustomHttp &&
    accountConnectionsEnabled &&
    typeof cloudAccountId === 'string' &&
    urlCloudProblem === undefined &&
    headersCloudProblem === undefined &&
    moveConfigProblem === undefined;
  const scopeAvailable = accountConnectionsEnabled && serverType === 'http';
  // New custom HTTP servers go to the cloud account until the user picks a
  // scope; ineligible input keeps them on this device as it is typed.
  const effectiveScope: McpServerScope = !scopeAvailable
    ? 'device'
    : isCreate && isCustomHttp && !scopeTouched
      ? cloudEligible
        ? 'cloud'
        : 'device'
      : scope;
  const movingToCloud =
    !isCreate && initialScope === 'device' && effectiveScope === 'cloud';
  const movingToDevice =
    initialScope === 'cloud' && effectiveScope === 'device';
  // A device server can't inherit an account default: there is no connection
  // behind it, so "Use default" resolves to the local proxy instead.
  const deviceHandler: AuthHandlerChoice = curatedRequiresProvider
    ? 'provider'
    : authHandler === 'account' ||
        (authHandler === '' && globalAuthHandler === 'account')
      ? 'canopy'
      : authHandler;
  const handlerToPersist: AuthHandlerChoice =
    effectiveScope === 'cloud' ? 'account' : deviceHandler;
  const effectiveAuthHandler = handlerToPersist || globalAuthHandler;
  const usesAccountAuth =
    accountConnectionsEnabled && effectiveAuthHandler === 'account';

  // UI state
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Track IDs of newly added configs so they start expanded
  const [expandedNewIds, setExpandedNewIds] = useState<Set<string>>(new Set());

  // Health/test state
  const [healthResult, setHealthResult] =
    useState<McpServerHealthCheckResult | null>(null);
  const [healthChecking, setHealthChecking] = useState(false);
  const [testResult, setTestResult] =
    useState<McpServerTestConnectionResult | null>(null);
  const [testRunning, setTestRunning] = useState(false);
  const [selectedConfigId, setSelectedConfigId] = useState('');
  // OAuth "Connect" state (HTTP + OAuth servers). Curated adds do NOT
  // auto-launch OAuth on save; the user connects here after saving.
  const [connecting, setConnecting] = useState(false);
  const [connectMessage, setConnectMessage] = useState('');

  // Loaded server data for edit mode
  const [loadedServer, setLoadedServer] = useState<McpServerData | null>(null);

  const accessTokenRef = useRef<HTMLInputElement>(null);

  // Stable refs for callbacks
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const accountConnectionRef = useRef(accountConnection);
  accountConnectionRef.current = accountConnection;
  const accountConnectionKey = accountConnection?.id;

  useEffect((): (() => void) | undefined => {
    if (!accountConnectionsEnabled) return;
    let cancelled = false;
    void loadSignedInAccountId().then((id): void => {
      if (!cancelled) setCloudAccountId(id ?? null);
    });
    return (): void => {
      cancelled = true;
    };
  }, [accountConnectionsEnabled]);

  useEffect((): (() => void) => {
    let cancelled = false;
    void window.api
      .loadPreferences()
      .then((preferences): void => {
        if (!cancelled)
          setGlobalAuthHandler(
            preferences.mcpHttpAuthDefaultHandler ??
              DEFAULT_MCP_HTTP_AUTH_HANDLER,
          );
      })
      .catch((error: unknown): void => {
        if (!cancelled)
          setError(error instanceof Error ? error.message : String(error));
      });
    return (): void => {
      cancelled = true;
    };
  }, []);

  // Load server data when editing
  useEffect(() => {
    setScopeTouched(false);
    setCloudToken('');
    setClearStoredHeaders(false);
    setConfirmMoveToDevice(false);
    setConfirmMoveToCloud(false);
    pendingMoveToCloud.current = null;
    setMoveWithoutStoredHeaders(false);
    movedDeviceId.current = null;
    if (!serverId) {
      const curated = initialCurated;
      const cloud = accountConnectionRef.current;
      setInitialScope(cloud ? 'cloud' : 'device');
      setScope(cloud ? 'cloud' : 'device');
      setBoundConnection(cloud);
      setServerType('http');
      setName(curated?.name ?? cloud?.displayName ?? '');
      setDescription(curated?.shortDescription ?? '');
      setCommand('');
      setArgs('');
      const reopenedUrl = curated?.urlOptions?.find(
        (option): boolean => option.url === initialEndpointUrl,
      )?.url;
      setUrl(curated ? (reopenedUrl ?? curatedInitialUrl(curated)) : '');
      setHeaders({});
      setAccountFields({});
      const now = new Date().toISOString();
      const defaultConfigId = crypto.randomUUID();
      setConfigs([
        {
          id: defaultConfigId,
          name: 'Default',
          description: '',
          enabled: true,
          envVars: {},
          extraArgs: [],
          extraHeaders: {},
          createdAt: now,
          updatedAt: now,
        },
      ]);
      setSelectedConfigId(defaultConfigId);
      setExpandedNewIds(new Set());
      setLoadedServer(null);
      setAccountConnectionId(cloud?.id ?? '');
      setError('');
      setConfirmDelete(false);
      setHealthResult(null);
      setTestResult(null);
      setConnectMessage('');
      setOauthForm(
        curated && !curatedRequiresProvider
          ? oauthFromCuratedHints(curated)
          : { ...EMPTY_OAUTH_FORM },
      );
      // Curated adds default to the Canopy proxy; hand-entered adds inherit the
      // global default.
      setAuthHandler(
        curated ? (curatedRequiresProvider ? 'provider' : 'canopy') : '',
      );
      setCuratedMeta(curated ? curatedMetadataFromEntry(curated) : undefined);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError('');

    void runCancellableModalLoad(
      async (): Promise<void> => {
        const [result, index] = await Promise.all([
          window.mcpServers.loadServer(serverId),
          window.mcpServers.loadIndex(),
        ]);
        if (cancelled) return;
        const server = result.server;
        const entry = flattenMcpServerRows(index.servers).find(
          (candidate): boolean => candidate.id === serverId,
        );
        const handler =
          server.definition.httpAuthHandler ??
          entry?.authHandler ??
          (entry?.scope === 'account' ? 'account' : undefined);
        const inCloud =
          server.definition.type === 'http' && handler === 'account';
        // The bound connection comes from the merged list, which lists a
        // device copy under its account row.
        const bound = index.servers.find(
          (row): boolean =>
            row.accountConnection !== undefined &&
            (row.accountConnection.id === entry?.accountConnectionId ||
              row.deviceCopies?.some(
                (copy): boolean => copy.id === serverId,
              ) === true),
        )?.accountConnection;
        setLoadedServer(server);
        setAccountConnectionId(entry?.accountConnectionId ?? '');
        setBoundConnection(bound);
        setInitialScope(inCloud ? 'cloud' : 'device');
        setScope(inCloud ? 'cloud' : 'device');
        setServerType(server.definition.type);
        setName(server.definition.name);
        setDescription(server.definition.description);
        setCommand(server.definition.command ?? '');
        setArgs((server.definition.args ?? []).join(' '));
        setUrl(server.definition.url ?? '');
        setHeaders(server.definition.headers ?? {});
        setConfigs(server.configs);
        setSelectedConfigId(getDefaultConfigId(server.configs));
        setOauthForm(oauthFromDefinition(server.definition.oauth));
        setAuthHandler(handler === 'account' ? '' : (handler ?? ''));
        setCuratedMeta(server.definition.curated);
      },
      {
        isCancelled: () => cancelled,
        setError,
        setLoading,
      },
    );

    return (): void => {
      cancelled = true;
    };
  }, [
    serverId,
    initialCurated,
    curatedRequiresProvider,
    accountConnectionKey,
    initialEndpointUrl,
  ]);

  useEffect(() => {
    if (configs.length === 0) {
      setSelectedConfigId('');
      return;
    }

    const selectedStillExists = configs.some(
      (config) => config.id === selectedConfigId,
    );
    if (!selectedStillExists) {
      setSelectedConfigId(getDefaultConfigId(configs));
    }
  }, [configs, selectedConfigId]);

  useEffect((): (() => void) | undefined => {
    if (
      !accountConnectionsEnabled ||
      mode === 'account' ||
      (effectiveAuthHandler !== 'account' && !curatedMeta?.key) ||
      serverType !== 'http' ||
      (!curatedMeta?.key && !accountConnectionId)
    )
      return;
    let cancelled = false;
    setAccountConnectionsLoading(true);
    setAccountConnectionsError('');
    setAccountConnections([]);
    void window.mcpServers
      .listAccountConnections()
      .then((connections): void => {
        if (!cancelled) setAccountConnections(connections);
      })
      .catch((): void => {
        if (!cancelled)
          setAccountConnectionsError(
            'Could not load account connections. Check your cloud sign-in and try again.',
          );
      })
      .finally((): void => {
        if (!cancelled) setAccountConnectionsLoading(false);
      });
    return (): void => {
      cancelled = true;
    };
  }, [
    accountConnectionsEnabled,
    effectiveAuthHandler,
    serverType,
    accountConnectionsRetry,
    curatedMeta?.key,
    accountConnectionId,
    mode,
  ]);

  const curatedConnections = accountConnections.filter(
    (connection): boolean =>
      connection.kind === 'CURATED' &&
      connection.serverKey === curatedMeta?.key,
  );
  const matchedAccountConnection = curatedMeta?.key
    ? (curatedConnections.find(
        (connection): boolean => connection.configId === selectedConfigId,
      ) ??
      (curatedConnections.length === 1 ? curatedConnections[0] : undefined))
    : accountConnections.find(
        (connection): boolean => connection.id === accountConnectionId,
      );

  // ---- Handlers ----

  // The account list stands in when the merged index could not be read.
  const cloudConnection: AccountMcpConnectionSummary | undefined =
    boundConnection ??
    (isCustomHttp && accountConnectionId
      ? matchedAccountConnection
      : undefined);
  const cloudOwned = cloudConnection?.kind === 'CUSTOM';
  const storedHeadersNote = cloudOnly && cloudConnection?.hasExtraHeaders;
  // The cloud never returns its stored headers, so a move carries only the
  // ones on this device's copy or typed here. A connection that doesn't say
  // whether it stores any is treated as if it does.
  const storedHeadersKnown = cloudConnection?.hasExtraHeaders === true;
  const headersLeftInCloud =
    movingToDevice &&
    cloudOwned &&
    cloudConnection?.hasExtraHeaders !== false &&
    Object.keys(
      cloudMcpHeaders(
        loadedServer?.definition.headers,
        loadedServer?.configs ?? [],
      ),
    ).length === 0;
  const moveDropsStoredHeaders = headersLeftInCloud && !hasAccountHeaders;
  const urlChanged = cloudOnly
    ? url.trim().length > 0
    : url.trim() !== (loadedServer?.definition.url ?? '').trim();
  // The cloud answers a new address by asking for sign-in again unless the
  // same save brings a token.
  const cloudUrlWarning =
    effectiveScope === 'cloud' &&
    cloudOwned &&
    !movingToCloud &&
    urlChanged &&
    !cloudToken.trim();
  // A new cloud server needs a signed-in account; an existing one only
  // needs one when the save reaches the cloud, which reports it then.
  const cloudBlockedReason =
    effectiveScope === 'cloud' && isCustomHttp
      ? (urlCloudProblem ??
        headersCloudProblem ??
        moveConfigProblem ??
        (cloudAccountId === null && !cloudConnection
          ? CLOUD_SIGN_IN_REQUIRED
          : undefined))
      : undefined;

  const handleSave = async (): Promise<void> => {
    if (!name.trim() || (serverType === 'http' && !effectiveAuthHandler))
      return;
    if (initialCurated && isCreate) {
      const setupError = validateCuratedSetup(initialCurated, url, oauthForm);
      if (setupError) {
        setError(setupError);
        return;
      }
    }
    let oauthToPersist: McpOAuthConfigData | undefined;
    if (serverType === 'http' && oauthForm.enabled) {
      const validation = validateOAuthForm(oauthForm);
      if (validation.error) {
        setError(validation.error);
        return;
      }
      oauthToPersist = validation.oauth ?? undefined;
    }
    const curatedToPersist = curatedMetadataForServerType(
      serverType,
      curatedMeta,
    );
    const inCloud = effectiveScope === 'cloud';
    if (
      inCloud &&
      curatedToPersist?.key &&
      (accountConnectionsLoading || !matchedAccountConnection)
    ) {
      setError(
        'Connect this catalog server in your cloud account before saving.',
      );
      return;
    }
    if (
      inCloud &&
      !curatedToPersist?.key &&
      accountConnectionId &&
      !cloudOnly &&
      (accountConnectionsLoading || accountConnectionsError)
    ) {
      setError(
        accountConnectionsError || 'Account connections are still loading.',
      );
      return;
    }
    const buildServerData = (
      boundConnectionId: string | undefined,
      deviceId = loadedServer?.definition.id ?? '',
    ): SaveMcpServerRequest => {
      const now = new Date().toISOString();
      const moveConfigs =
        entryAction === 'move-to-device' && loadedServer
          ? loadedServer.configs
          : configs;
      const defaultId = getDefaultConfigId(moveConfigs);
      return {
        definition: {
          id: deviceId,
          name:
            entryAction === 'move-to-device'
              ? (loadedServer?.definition.name ??
                accountConnection?.displayName ??
                name.trim())
              : name.trim(),
          description:
            entryAction === 'move-to-device'
              ? (loadedServer?.definition.description ?? '')
              : description.trim(),
          type: serverType,
          command: serverType === 'command' ? command.trim() : undefined,
          args:
            serverType === 'command'
              ? args.split(' ').filter((a: string) => a.length > 0)
              : undefined,
          url: serverType === 'http' ? url.trim() : undefined,
          headers:
            serverType === 'http' && Object.keys(headers).length > 0
              ? headers
              : undefined,
          ...(oauthToPersist ? { oauth: oauthToPersist } : {}),
          ...(serverType === 'http' && handlerToPersist
            ? { httpAuthHandler: handlerToPersist }
            : {}),
          ...(curatedToPersist ? { curated: curatedToPersist } : {}),
          createdAt: loadedServer?.definition.createdAt ?? now,
          updatedAt: now,
        },
        // A cloud server's token lives in the cloud account, never here.
        configs:
          inCloud && !curatedToPersist?.key
            ? withoutAuthTokens(configs)
            : movingToDevice && cloudToken.trim()
              ? moveConfigs.map(
                  (config): McpServerConfigData =>
                    config.id === defaultId
                      ? { ...config, authToken: cloudToken }
                      : config,
                )
              : moveConfigs,
        ...(serverType !== 'http' || movingToDevice
          ? { accountRouting: 'clear' as const }
          : {}),
        ...(boundConnectionId
          ? { accountConnectionId: boundConnectionId }
          : {}),
      };
    };
    if (inCloud && cloudBlockedReason) {
      setError(cloudBlockedReason);
      return;
    }
    if (inCloud && curatedToPersist?.key) {
      await runEntityEditOperation(
        async (): Promise<void> => {
          await window.mcpServers.saveServer(buildServerData(undefined));
        },
        {
          setSaving,
          setError,
          onSaved: onSavedRef.current,
          onClose: onCloseRef.current,
        },
      );
      return;
    }
    if (inCloud && cloudConnection) {
      await saveCloudEdit(cloudConnection, buildServerData);
      return;
    }
    if (inCloud) {
      const problem = !cloudAccountId
        ? CLOUD_SIGN_IN_REQUIRED
        : (headersCloudProblem ??
          (isCloudReadyUrl(url)
            ? undefined
            : (urlCloudProblem ?? CLOUD_HTTPS_REQUIRED)));
      if (problem) {
        setError(problem);
        return;
      }
      const expectedAccountId = cloudAccountId ?? undefined;
      if (movingToCloud) {
        pendingMoveToCloud.current = (): Promise<void> =>
          createAccountServer(buildServerData, expectedAccountId);
        setConfirmMoveToCloud(true);
        return;
      }
      await createAccountServer(buildServerData, expectedAccountId);
      return;
    }
    if (movingToDevice && cloudOwned && cloudConnection) {
      pendingMoveData.current = (deviceId): SaveMcpServerRequest =>
        buildServerData(undefined, deviceId);
      setMoveWithoutStoredHeaders(false);
      setConfirmMoveToDevice(true);
      return;
    }
    await runEntityEditOperation(
      async (): Promise<void> => {
        await window.mcpServers.saveServer(buildServerData(undefined));
      },
      {
        setSaving,
        setError,
        onSaved: onSavedRef.current,
        onClose: onCloseRef.current,
      },
    );
  };

  // Edits the cloud connection in place and keeps the device copy, when there
  // is one, in step with it.
  const saveCloudEdit = async (
    connection: AccountMcpConnectionSummary,
    buildServerData: (boundConnectionId: string) => SaveMcpServerRequest,
  ): Promise<void> => {
    const request: UpdateAccountMcpConnectionRequest = {};
    const displayName = name.trim().slice(0, CLOUD_DISPLAY_NAME_MAX);
    if (connection.kind === 'CUSTOM') {
      // Only what changed here reaches the cloud; a device copy may carry
      // its own name.
      if (
        displayName !==
        (loadedServer?.definition.name ?? connection.displayName)
      )
        request.displayName = displayName;
      if (urlChanged && url.trim()) request.customUrl = url.trim();
      if (cloudOnly) {
        if (hasAccountHeaders) request.headers = accountHeaders;
        else if (clearStoredHeaders) request.headers = {};
      } else if (
        loadedServer &&
        // A new address drops the cloud's stored headers unless the same
        // save sends them again.
        ((urlChanged && hasAccountHeaders) ||
          !sameHeaders(
            accountHeaders,
            cloudMcpHeaders(
              loadedServer.definition.headers,
              loadedServer.configs,
            ),
          ))
      )
        request.headers = accountHeaders;
    }
    // Only a token typed here replaces the cloud's sign-in; an older device
    // copy may still hold a stale one, which the save below drops.
    if (cloudToken.trim()) request.bearerToken = cloudToken.trim();
    await runEntityEditOperation(
      async (): Promise<void> => {
        if (Object.keys(request).length > 0) {
          const result = await window.mcpServers.updateAccountConnection(
            connection.id,
            {
              ...request,
              ...(cloudAccountId ? { expectedAccountId: cloudAccountId } : {}),
            },
          );
          if ('error' in result)
            throw new AccountMcpConnectionError(
              result.error.code,
              result.error.header,
            );
        }
        if (!cloudOnly)
          await window.mcpServers.saveServer(buildServerData(connection.id));
      },
      {
        setSaving,
        setError,
        onSaved: onSavedRef.current,
        onClose: onCloseRef.current,
      },
    );
  };

  // Moves a cloud server here: the device server is saved first, desktop
  // references follow it, and only then does the cloud connection go.
  const moveToDevice = async (): Promise<void> => {
    const connection = cloudConnection;
    const build = pendingMoveData.current;
    if (!connection || !build) return;
    if (moveDropsStoredHeaders && !moveWithoutStoredHeaders) return;
    setConfirmMoveToDevice(false);
    setSaving(true);
    setError('');
    const deviceId =
      loadedServer?.definition.id ??
      (movedDeviceId.current ??= crypto.randomUUID());
    try {
      await moveDesktopMcpTarget({
        data: build(deviceId),
        connection,
        ...(cloudAccountId ? { expectedAccountId: cloudAccountId } : {}),
      });
    } catch (err) {
      setSaving(false);
      setError(extractIpcErrorMessage(err));
      return;
    }
    try {
      await onSavedRef.current();
    } catch {
      // The server moved; only the list behind the dialog is stale.
    }
    onCloseRef.current();
  };

  // Creates the cloud connection first and binds the device row to it. A
  // browser sign-in keeps settling after the dialog closes; the table follows
  // the connection's status from there. Moving an existing device server
  // also points its references at the connection and drops its own sign-ins.
  const createAccountServer = async (
    buildServerData: (boundConnectionId: string) => SaveMcpServerRequest,
    expectedAccountId: string | undefined,
  ): Promise<void> => {
    setSaving(true);
    setError('');
    let bound = false;
    let saveError: string | undefined;
    let failure: string | undefined;
    // A move sends only the token its confirmation showed; the field starts
    // with the device's own, and a token the user cleared stays behind.
    const bearerToken =
      cloudToken.trim() ||
      (movingToCloud ? undefined : defaultConfigAuthToken(configs));
    const oauthClientId =
      oauthForm.enabled && oauthForm.clientId.trim()
        ? oauthForm.clientId.trim()
        : undefined;
    const moving = movingToCloud ? loadedServer : null;
    const code = await accountActions.connect(undefined, 'default', {
      customUrl: url.trim(),
      displayName: name.trim().slice(0, CLOUD_DISPLAY_NAME_MAX),
      ...(hasAccountHeaders ? { headers: accountHeaders } : {}),
      ...(expectedAccountId ? { expectedAccountId } : {}),
      ...(moving ? { pendingKey: moving.definition.id } : {}),
      onFailure: (message): void => {
        failure = message;
      },
      ...(bearerToken
        ? { bearerToken }
        : oauthClientId
          ? { oauthClient: { clientId: oauthClientId } }
          : {}),
      onStarted: async (connection): Promise<void> => {
        try {
          await window.mcpServers.saveServer(buildServerData(connection.id));
        } catch (err) {
          saveError = err instanceof Error ? err.message : String(err);
          throw err;
        }
        bound = true;
        if (moving) {
          await clearDeviceSignIns(moving);
          // The bound device copy still routes through the cloud, so a
          // reference left behind keeps working on this device.
          await pointRefsAt(
            [
              {
                serverId: moving.definition.id,
                configId: getDefaultConfigId(configs),
              },
            ],
            { serverId: connection.serverKey, configId: connection.configId },
          ).catch((): void => undefined);
        }
        // The row now points at the connection; a failed list refresh must
        // not throw, or the connection would be rolled back under it.
        try {
          await onSavedRef.current();
        } catch {
          // The row is saved; only the list shown behind the dialog is stale.
        }
        onCloseRef.current();
      },
    });
    if (bound) return;
    setSaving(false);
    if (!saveError && code === 'oauth-client-required') {
      setError(CLOUD_REGISTRATION_UNAVAILABLE);
      accessTokenRef.current?.focus();
      return;
    }
    setError(
      saveError ??
        failure ??
        (code
          ? new AccountMcpConnectionError(code).message
          : CLOUD_CONNECT_FAILED),
    );
  };

  // The device copy goes first, so a failure there leaves the cloud server in
  // place; once it is gone, a cloud failure closes the editor with a toast.
  const handleDelete = async (): Promise<void> => {
    const connection =
      cloudOwned && initialScope === 'cloud' ? cloudConnection : undefined;
    if (!serverId && !connection) return;
    await runEntityEditOperation(
      async (): Promise<void> => {
        try {
          await deleteDesktopMcpTarget({
            ...(serverId ? { serverId } : {}),
            ...(connection ? { connection } : {}),
            ...(cloudAccountId ? { expectedAccountId: cloudAccountId } : {}),
          });
        } catch (error) {
          if (!serverId && connection)
            await onSavedRef.current().catch((): void => undefined);
          throw error;
        }
      },
      {
        setSaving,
        setError,
        onSaved: onSavedRef.current,
        onClose: onCloseRef.current,
      },
    );
  };

  const handleHealthCheck = async (): Promise<void> => {
    if (!serverId) return;
    setHealthChecking(true);
    setHealthResult(null);
    try {
      const result = await window.mcpServers.checkHealth(
        serverId,
        selectedConfigId || undefined,
      );
      setHealthResult(result);
    } catch (err) {
      setHealthResult({
        serverId,
        configId: selectedConfigId || undefined,
        status: 'unhealthy',
        message: err instanceof Error ? err.message : String(err),
        checkedAt: new Date().toISOString(),
      });
    } finally {
      setHealthChecking(false);
    }
  };

  const handleTestConnection = async (): Promise<void> => {
    if (!serverId) return;
    setTestRunning(true);
    setTestResult(null);
    try {
      const result = await window.mcpServers.testConnection(
        serverId,
        selectedConfigId || undefined,
      );
      setTestResult(result);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setTestResult({
        serverId,
        configId: selectedConfigId || undefined,
        success: false,
        message: 'Connection test failed',
        error: errorMessage,
      });
    } finally {
      setTestRunning(false);
    }
  };

  const handleConnect = async (): Promise<void> => {
    if (!serverId) return;
    setConnecting(true);
    setConnectMessage('');
    try {
      const result = await window.mcpServers.startOAuthLogin({
        serverId,
        configId: selectedConfigId || undefined,
      });
      setConnectMessage(
        result.status === 'completed'
          ? // A valid token already existed, so no browser opened.
            mcpAlreadyConnectedMessage(name.trim() || 'This server')
          : 'Switch to your browser to finish signing in, then re-check the status.',
      );
    } catch (err) {
      setConnectMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setConnecting(false);
    }
  };

  function handleAddConfig(): void {
    const now = new Date().toISOString();
    const newId = crypto.randomUUID();
    const newConfig: McpServerConfigData = {
      id: newId,
      name: `Config ${configs.length + 1}`,
      description: '',
      enabled: true,
      envVars: {},
      extraArgs: [],
      extraHeaders: {},
      createdAt: now,
      updatedAt: now,
    };
    setConfigs([...configs, newConfig]);
    setExpandedNewIds((prev) => new Set([...Array.from(prev), newId]));
  }

  function handleUpdateConfig(
    index: number,
    updated: McpServerConfigData,
  ): void {
    setConfigs(configs.map((c, i) => (i === index ? updated : c)));
  }

  function handleDeleteConfig(index: number): void {
    setConfigs(configs.filter((_, i) => i !== index));
  }

  const willCreateAccountConnection =
    usesAccountAuth &&
    isCustomHttp &&
    !cloudConnection &&
    !(
      accountConnectionId &&
      (accountConnectionsLoading || accountConnectionsError)
    );
  const editsCloudConnection =
    effectiveScope === 'cloud' && cloudConnection !== undefined;
  const cloudOnlyInCloud = cloudOnly && effectiveScope === 'cloud';
  // Why "Cloud account" can't be chosen for a custom HTTP server.
  const cloudLocalReason =
    accountConnectionsEnabled && isCustomHttp && !cloudEligible
      ? (urlCloudProblem ??
        headersCloudProblem ??
        moveConfigProblem ??
        (cloudAccountId === null
          ? `${CLOUD_SIGN_IN_REQUIRED} It stays on this device for now.`
          : undefined))
      : undefined;
  // A catalog server joins the cloud only through its existing connection,
  // and a desktop-only one never does (REG-3035).
  const curatedDesktopOnly =
    curatedEntry !== undefined && curatedMcpDesktopOnly(curatedEntry);
  const curatedCloudReason =
    scopeAvailable && curatedMeta?.key && curatedDesktopOnly
      ? effectiveScope === 'cloud'
        ? undefined
        : CURATED_DESKTOP_ONLY_REASON
      : scopeAvailable &&
          curatedMeta?.key &&
          effectiveScope !== 'cloud' &&
          !accountConnectionsLoading &&
          !matchedAccountConnection
        ? accountConnectionsError ||
          (cloudAccountId === null
            ? `${CLOUD_SIGN_IN_REQUIRED} It stays on this device for now.`
            : 'Connect this catalog server in your cloud account first.')
        : undefined;
  const curatedCloudRetry =
    effectiveScope === 'device' &&
    cloudLocalReason === undefined &&
    curatedCloudReason !== undefined &&
    !curatedDesktopOnly;
  const cloudChoiceDisabled =
    cloudLocalReason !== undefined && effectiveScope !== 'cloud';
  const changeScope = (next: McpServerScope): void => {
    setScopeTouched(true);
    setScope(next);
    setError('');
    // A device server's token travels with it; a cloud one is write-only.
    if (next === 'cloud' && initialScope === 'device')
      setCloudToken(defaultConfigAuthToken(configs) ?? '');
    else if (next !== initialScope) setCloudToken('');
  };
  const canSave =
    name.trim().length > 0 &&
    !saving &&
    (serverType !== 'http' ||
      effectiveScope === 'cloud' ||
      Boolean(deviceHandler) ||
      globalAuthHandler !== undefined) &&
    (serverType === 'command'
      ? command.trim().length > 0
      : url.trim().length > 0 || (cloudOnly && effectiveScope === 'cloud')) &&
    !(effectiveScope === 'cloud' && cloudBlockedReason);
  const entryMoveOpened = useRef(false);
  useEffect(() => {
    if (
      entryAction !== 'move-to-device' ||
      entryMoveOpened.current ||
      loading ||
      !cloudConnection ||
      !cloudAccountId ||
      globalAuthHandler === undefined
    )
      return;
    if (scope !== 'device') {
      setScope('device');
      setScopeTouched(true);
      return;
    }
    // Reuse validation and the captured move request; never save unrelated edits.
    entryMoveOpened.current = true;
    void handleSave();
  });
  const deleteNote =
    cloudOwned && initialScope === 'cloud'
      ? serverId
        ? mcpDeleteImpact('device-and-cloud')
        : mcpDeleteImpact('cloud')
      : cloudConnection && serverId
        ? mcpDeleteImpact('device-retaining-cloud')
        : undefined;
  const footerProps = createEntityEditModalFooterProps(
    isCreate,
    saving,
    canSave,
    confirmDelete,
    setConfirmDelete,
    () => void handleDelete(),
    onClose,
    () => void handleSave(),
  );
  const accountSetup = mode === 'account' && initialCurated !== undefined;
  useCurrentUiStateReporter(
    'mcp.serverEditor',
    accountSetup
      ? null
      : {
          mode: isCreate ? 'create' : 'edit',
          ...(serverId ? { serverId } : {}),
          cloudOnly,
          scopeAvailable,
          scope: effectiveScope,
          initialScope,
          moveToDeviceDialogOpen: confirmMoveToDevice,
          moveToCloudDialogOpen: confirmMoveToCloud,
          moveDropsStoredHeaders,
          moveWithoutStoredHeaders,
          deleteConfirmOpen: confirmDelete,
          saving,
          errorVisible: error.length > 0,
        },
  );

  if (accountSetup) {
    const declaredFields = initialCurated.requiredConfigFields ?? [];
    // A server without client registration needs the user's own app: its
    // client ID, and its secret when the server takes only confidential
    // clients and the account can store one for this server.
    const clientFields: CuratedMcpRequiredConfigField[] =
      requiresOAuthClient || clientSetup
        ? [
            { kind: 'oauth-client-id' },
            ...(clientSetup?.clientSecretAccepted &&
            clientSetup.clientSecretRequired
              ? [{ kind: 'oauth-client-secret' as const }]
              : []),
          ]
        : [];
    const setupFields = [
      ...declaredFields,
      ...clientFields.filter(
        (field): boolean =>
          !declaredFields.some(
            (declared): boolean => declared.kind === field.kind,
          ),
      ),
    ];
    // A client secret always needs an accompanying client ID, even when the
    // catalog only marks the secret as a required input.
    const requiredFields =
      setupFields.some(
        (field): boolean => field.kind === 'oauth-client-secret',
      ) &&
      !setupFields.some((field): boolean => field.kind === 'oauth-client-id')
        ? [{ kind: 'oauth-client-id' as const }, ...setupFields]
        : setupFields;
    // An optional secret the account can store rides along when typed.
    const optionalSecret =
      clientSetup?.clientSecretAccepted === true &&
      !requiredFields.some(
        (field): boolean => field.kind === 'oauth-client-secret',
      );
    const supportedFields = requiredFields.every(
      (field): boolean =>
        field.kind === 'oauth-client-id' ||
        field.kind === 'oauth-client-secret',
    );
    const collectsOauthClient = requiredFields.some(
      (field): boolean => field.kind === 'oauth-client-id',
    );
    const formFields = optionalSecret
      ? [...requiredFields, { kind: 'oauth-client-secret' as const }]
      : requiredFields;
    const unsupportedMessage =
      'This server needs setup fields that account connections do not support yet.';
    const connectAccount = (): void => {
      if (!supportedFields) return;
      if (
        requiredFields.some(
          (field): boolean => !accountFields[field.kind]?.trim(),
        )
      ) {
        setError('Fill in each required field to connect.');
        return;
      }
      if (
        initialCurated.urlOptions?.length &&
        !initialCurated.urlOptions.some((option): boolean => option.url === url)
      ) {
        setError('Select one of the available MCP endpoints.');
        return;
      }
      onAccountConnect?.({
        ...(collectsOauthClient && accountFields['oauth-client-id']?.trim()
          ? {
              oauthClient: {
                clientId: accountFields['oauth-client-id'].trim(),
                ...(accountFields['oauth-client-secret']
                  ? { clientSecret: accountFields['oauth-client-secret'] }
                  : {}),
              },
            }
          : {}),
        ...(initialCurated.urlOptions?.length ? { endpointUrl: url } : {}),
      });
    };
    return (
      <DialogModal
        onClose={onClose}
        title={`Connect ${initialCurated.name}`}
        titleId="mcp-server-dialog-title"
        maxWidth="xl"
        closeOnBackdrop
      >
        <div
          className="flex flex-col gap-4 p-5"
          data-testid="mcp-account-setup"
        >
          {initialCurated.setupInstructions && (
            <p className="text-sm fg-secondary">
              {initialCurated.setupInstructions}
            </p>
          )}
          {requiresOAuthClient && !clientSetup && (
            <p className="text-sm fg-secondary">
              {mcpConnectErrorMessage('client_credentials_required')}
            </p>
          )}
          {clientSetup && (
            <McpClientSetupDetails
              serverName={initialCurated.name}
              redirectUri={clientSetup.redirectUri}
              {...(clientSetup.docsUrl ? { docsUrl: clientSetup.docsUrl } : {})}
              clientSecretRequired={clientSetup.clientSecretRequired}
              clientSecretAccepted={clientSetup.clientSecretAccepted}
              registrationRefused={clientSetup.registrationRefused === true}
            />
          )}
          {initialCurated.urlOptions?.length ? (
            <label className="block text-sm">
              <span className="mb-1.5 block fg-secondary">Endpoint</span>
              <select
                value={url}
                onChange={(event): void => setUrl(event.target.value)}
                data-testid="mcp-curated-url-option"
                className="focus-ring w-full rounded-lg border bg-base px-3 py-2 text-sm"
              >
                {initialCurated.urlOptions.map(
                  (option): JSX.Element => (
                    <option key={option.url} value={option.url}>
                      {option.label}
                    </option>
                  ),
                )}
              </select>
            </label>
          ) : null}
          {supportedFields ? (
            formFields.map(
              (field): JSX.Element => (
                <label key={field.kind} className="block text-sm">
                  <span className="mb-1.5 block fg-secondary">
                    {field.kind === 'oauth-client-id'
                      ? 'OAuth client ID'
                      : 'OAuth client secret'}
                  </span>
                  <input
                    type={
                      field.kind === 'oauth-client-secret' ? 'password' : 'text'
                    }
                    autoComplete="off"
                    value={accountFields[field.kind] ?? ''}
                    onChange={(event): void =>
                      setAccountFields({
                        ...accountFields,
                        [field.kind]: event.target.value,
                      })
                    }
                    data-testid={`mcp-account-${field.kind}`}
                    className="focus-ring w-full rounded-lg border bg-base px-3 py-2 text-sm"
                  />
                  {optionalSecret && field.kind === 'oauth-client-secret' && (
                    <span className="mt-1 block text-xs fg-secondary">
                      Optional.
                    </span>
                  )}
                </label>
              ),
            )
          ) : (
            <p className="text-sm fg-secondary">{unsupportedMessage}</p>
          )}
          <ErrorBanner error={error} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={connectAccount}
              disabled={!supportedFields}
            >
              Connect
            </Button>
          </div>
        </div>
      </DialogModal>
    );
  }

  return (
    <>
      <DialogModal
        onClose={onClose}
        title={isCreate ? 'New MCP server' : 'Edit MCP server'}
        titleId="mcp-server-dialog-title"
        maxWidth="3xl"
        headerBorder={false}
        closeOnBackdrop
        noEnterAnimation={noEnterAnimation}
      >
        <EntityEditModalContent
          loading={loading}
          error={error}
          bodyClassName="flex flex-1 min-h-0 flex-col gap-4 px-5 pb-5 overflow-y-auto"
          footerProps={footerProps}
        >
          {isCreate &&
            initialCurated &&
            curatedMcpProviderOnly(initialCurated) && (
              // A provider connector never signs in from this editor; say
              // where it does here, where the modal keeps the user's focus.
              // A server the catalog marks desktop only does sign in here.
              <Notice
                intent="neutral"
                role="status"
                data-testid="mcp-server-provider-connector-notice"
              >
                {accountMcpUnavailableMessage(initialCurated)}
              </Notice>
            )}
          {confirmDelete && deleteNote && (
            <Notice
              role="none"
              intent="attention"
              data-testid="mcp-server-delete-scope"
            >
              {deleteNote}
            </Notice>
          )}

          {/* Health / Test buttons for existing servers */}
          {serverId && (
            <div className="flex flex-wrap items-end gap-3">
              <label className="min-w-55 text-xs">
                <span className="mb-1 block fg-secondary">
                  Config to validate
                </span>
                <select
                  value={selectedConfigId}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                    setSelectedConfigId(e.target.value)
                  }
                  disabled={configs.length === 0}
                  className="focus-ring w-full rounded-md border bg-base px-3 py-1.5 text-xs fg-primary disabled:opacity-50"
                >
                  {configs.length === 0 ? (
                    <option value="">No configs available</option>
                  ) : (
                    configs.map((config) => (
                      <option key={config.id} value={config.id}>
                        {config.name}
                        {config.enabled ? '' : ' (disabled)'}
                      </option>
                    ))
                  )}
                </select>
              </label>
              <button
                type="button"
                onClick={() => void handleHealthCheck()}
                disabled={healthChecking || configs.length === 0}
                className="focus-ring rounded-md px-3 py-1.5 text-xs font-medium bg-secondary fg-primary hover:bg-accent-subtle transition-colors disabled:opacity-50"
              >
                {healthChecking ? 'Checking\u2026' : 'Health check'}
              </button>
              <button
                type="button"
                onClick={() => void handleTestConnection()}
                disabled={testRunning || configs.length === 0}
                className="focus-ring rounded-md px-3 py-1.5 text-xs font-medium bg-secondary fg-primary hover:bg-accent-subtle transition-colors disabled:opacity-50"
              >
                {testRunning ? 'Testing\u2026' : 'Test connection'}
              </button>
              {serverType === 'http' &&
                effectiveAuthHandler !== 'account' &&
                oauthForm.enabled && (
                  <button
                    type="button"
                    onClick={() => void handleConnect()}
                    disabled={connecting || configs.length === 0}
                    data-testid="mcp-server-connect"
                    className="focus-ring rounded-md px-3 py-1.5 text-xs font-medium bg-accent fg-emphasis hover:bg-accent/90 transition-colors disabled:opacity-50"
                  >
                    {connecting ? 'Connecting\u2026' : 'Connect'}
                  </button>
                )}
            </div>
          )}

          {/* Connect (OAuth) result */}
          {connectMessage && (
            <div className="rounded-lg border bg-secondary/30 px-3 py-2 text-xs fg-secondary">
              {connectMessage}
            </div>
          )}

          {/* Health check result */}
          {healthResult && (
            <div
              className={`rounded-lg border px-3 py-2 text-xs ${
                healthResult.status === 'healthy'
                  ? 'border-line-positive bg-success-subtle fg-success'
                  : healthResult.status === 'needs_auth'
                    ? 'border-line-attention bg-warning-subtle fg-warning'
                    : 'border-line-destructive/30 bg-destructive-subtle fg-destructive'
              }`}
            >
              <span className="font-medium">
                {capitalizeFirstLetter(healthResult.status.replace(/_/g, ' '))}
              </span>
              {' \u2014 '}
              {healthResult.message}
              {healthResult.responseTime != null && (
                <span className="ml-2 fg-secondary">
                  ({healthResult.responseTime}ms)
                </span>
              )}
            </div>
          )}

          {/* Test connection result */}
          {testResult && (
            <div
              className={`rounded-lg border px-3 py-2 text-xs ${
                testResult.success
                  ? 'border-line-positive bg-success-subtle fg-success'
                  : 'border-line-destructive/30 bg-destructive-subtle fg-destructive'
              }`}
            >
              <p className="font-medium">
                {testResult.success ? 'Connected' : 'Failed'}
                {' \u2014 '}
                {testResult.message}
              </p>
              {testResult.error && (
                <p
                  className={`${POSTHOG_REPLAY_BLOCK_CLASS} mt-1 fg-destructive`}
                >
                  {testResult.error}
                </p>
              )}
              {testResult.responseTime != null && (
                <p className="mt-1 fg-secondary">
                  Response time: {testResult.responseTime}ms
                </p>
              )}
              {testResult.tools && testResult.tools.length > 0 && (
                <div className="mt-2">
                  <p className="fg-secondary mb-1">
                    Available tools ({testResult.tools.length}):
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {testResult.tools.map((tool: string) => (
                      <span
                        key={tool}
                        className="inline-block rounded bg-secondary px-1.5 py-0.5 text-3xs fg-primary"
                      >
                        {tool}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Server type selector */}
          {!cloudOnly && (
            <div className="text-sm">
              <span className="mb-1.5 block fg-secondary">Server type</span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setServerType('command')}
                  className={`focus-ring flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                    serverType === 'command'
                      ? 'bg-accent fg-emphasis'
                      : 'bg-secondary fg-primary hover:bg-accent-subtle'
                  }`}
                >
                  <AppCatalogTerminalIcon width="14" height="14" />
                  Command
                </button>
                <button
                  type="button"
                  onClick={() => setServerType('http')}
                  className={`focus-ring flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                    serverType === 'http'
                      ? 'bg-accent fg-emphasis'
                      : 'bg-secondary fg-primary hover:bg-accent-subtle'
                  }`}
                >
                  <AppCatalogGlobeIcon width="14" height="14" />
                  HTTP
                </button>
              </div>
            </div>
          )}

          {/* Name */}
          <label className="block text-sm">
            <span className="mb-1.5 block fg-secondary">
              Name <span className="fg-destructive">*</span>
            </span>
            <input
              type="text"
              value={name}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setName(e.target.value)
              }
              placeholder="My MCP server"
              maxLength={CLOUD_DISPLAY_NAME_MAX}
              className="focus-ring w-full rounded-lg border bg-base px-3 py-2 text-sm"
              autoFocus
            />
          </label>

          {/* Description */}
          {!cloudOnlyInCloud && (
            <label className="block text-sm">
              <span className="mb-1.5 block fg-secondary">Description</span>
              <input
                type="text"
                value={description}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setDescription(e.target.value)
                }
                placeholder="Optional description"
                className="focus-ring w-full rounded-lg border bg-base px-3 py-2 text-sm"
              />
            </label>
          )}

          {/* Command fields */}
          {serverType === 'command' && (
            <>
              <label className="block text-sm">
                <span className="mb-1.5 block fg-secondary">
                  Command <span className="fg-destructive">*</span>
                </span>
                <input
                  type="text"
                  value={command}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setCommand(e.target.value)
                  }
                  placeholder="npx"
                  className="focus-ring w-full rounded-lg border bg-base px-3 py-2 text-sm"
                />
              </label>
              <label className="block text-sm">
                <span className="mb-1.5 block fg-secondary">Arguments</span>
                <input
                  type="text"
                  value={args}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setArgs(e.target.value)
                  }
                  placeholder="-y @modelcontextprotocol/server-postgres"
                  className="focus-ring w-full rounded-lg border bg-base px-3 py-2 text-sm"
                />
                <span className="mt-1 block text-xs fg-secondary">
                  Space-separated arguments
                </span>
              </label>
              {accountConnectionsEnabled && (
                <div className="flex flex-col gap-1.5 text-sm">
                  <span className="fg-secondary">Scope</span>
                  <McpScopeControl
                    value="device"
                    cloudDisabled
                    onChange={changeScope}
                  />
                  <p
                    className="text-xs fg-secondary"
                    data-testid="mcp-cloud-local-reason"
                  >
                    Desktop only. Command servers run on this device.
                  </p>
                </div>
              )}
            </>
          )}

          {/* HTTP fields */}
          {serverType === 'http' && (
            <>
              {initialCurated?.setupInstructions && isCreate && (
                <div
                  className="rounded-lg border bg-secondary/30 px-3 py-2 text-sm fg-secondary"
                  data-testid="mcp-curated-setup-instructions"
                >
                  {initialCurated.setupInstructions}
                </div>
              )}

              {initialCurated?.urlOptions?.length && isCreate ? (
                <label className="block text-sm">
                  <span className="mb-1.5 block fg-secondary">
                    Endpoint <span className="fg-destructive">*</span>
                  </span>
                  <select
                    value={url}
                    onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                      setUrl(e.target.value)
                    }
                    data-testid="mcp-curated-url-option"
                    className="focus-ring w-full rounded-lg border bg-base px-3 py-2 text-sm"
                  >
                    {initialCurated.urlOptions.map((option) => (
                      <option key={option.url} value={option.url}>
                        {option.label}
                        {option.description ? ` — ${option.description}` : ''}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <label className="block text-sm">
                  <span className="mb-1.5 block fg-secondary">
                    URL{' '}
                    {!(cloudOnly && effectiveScope === 'cloud') && (
                      <span className="fg-destructive">*</span>
                    )}
                  </span>
                  <input
                    type="text"
                    value={url}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      setUrl(e.target.value)
                    }
                    placeholder={
                      cloudOnly && cloudConnection?.upstreamHost
                        ? `https://${cloudConnection.upstreamHost}/…`
                        : 'https://mcp.example.com/sse'
                    }
                    data-testid="mcp-server-url"
                    className="focus-ring w-full rounded-lg border bg-base px-3 py-2 text-sm"
                  />
                  {cloudOnly && (
                    <span
                      className="mt-1 block text-xs fg-secondary"
                      data-testid="mcp-server-url-hint"
                    >
                      {effectiveScope === 'device'
                        ? 'Enter the full URL to run it on this device.'
                        : cloudConnection?.upstreamHost
                          ? `Leave it empty to keep ${cloudConnection.upstreamHost}.`
                          : 'Leave it empty to keep the current address.'}
                    </span>
                  )}
                </label>
              )}

              {scopeAvailable && (
                <div className="flex flex-col gap-1.5 text-sm">
                  <span className="fg-secondary">Scope</span>
                  <McpScopeControl
                    value={effectiveScope}
                    cloudDisabled={
                      cloudChoiceDisabled || curatedCloudReason !== undefined
                    }
                    onChange={changeScope}
                  />
                  <span className="text-xs fg-secondary">
                    {effectiveScope === 'cloud'
                      ? 'Stored in your cloud account. Cloud chats and every signed-in desktop can use it.'
                      : 'Runs on this device. Its credentials stay here.'}
                  </span>
                </div>
              )}

              {effectiveScope === 'device' && (
                <label className="block text-sm">
                  <span className="mb-1.5 block fg-secondary">
                    Auth handling
                  </span>
                  <select
                    value={deviceHandler}
                    onChange={(
                      e: React.ChangeEvent<HTMLSelectElement>,
                    ): void => {
                      const value = e.currentTarget.value;
                      if (isAuthHandlerChoice(value)) setAuthHandler(value);
                    }}
                    data-testid="mcp-server-auth-handler"
                    disabled={curatedRequiresProvider}
                    className="focus-ring w-full rounded-lg border bg-base px-3 py-2 text-sm fg-primary"
                  >
                    {globalAuthHandler !== 'account' && (
                      <option value="" disabled={curatedRequiresProvider}>
                        Use default
                      </option>
                    )}
                    <option value="canopy" disabled={curatedRequiresProvider}>
                      {brandText.appName} proxy
                    </option>
                    <option value="provider">Agent provider</option>
                  </select>
                  <span className="mt-1 block text-xs fg-secondary">
                    {deviceHandler === 'provider'
                      ? 'The agent provider receives this server directly and handles auth.'
                      : deviceHandler === 'canopy'
                        ? `${brandText.appName} routes this server through its local proxy and owns auth.`
                        : `Inherit the global default for how this server's auth is handled.`}
                  </span>
                </label>
              )}

              {effectiveScope === 'cloud' && curatedMeta?.key && (
                <div className="text-sm" data-testid="mcp-account-binding">
                  {accountConnectionsLoading ? (
                    <LoadingPlaceholder label="Loading account connections…" />
                  ) : accountConnectionsError ? (
                    <ErrorBanner error={accountConnectionsError} />
                  ) : (
                    <p className="fg-secondary" data-testid="mcp-account-match">
                      {matchedAccountConnection
                        ? `Account connection: ${matchedAccountConnection.displayName}`
                        : 'Connect this catalog server in your cloud account before saving.'}
                    </p>
                  )}
                  {!accountConnectionsLoading && !matchedAccountConnection && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(): void =>
                        setAccountConnectionsRetry((retry): number => retry + 1)
                      }
                    >
                      Try again
                    </Button>
                  )}
                </div>
              )}

              {effectiveScope === 'cloud' && isCustomHttp && (
                <div
                  className="flex flex-col gap-3 text-sm"
                  data-testid="mcp-cloud-placement"
                >
                  {(willCreateAccountConnection || movingToCloud) && (
                    <div className="flex flex-col gap-1">
                      <p className="fg-primary">
                        {movingToCloud
                          ? 'Will move to your cloud account'
                          : 'Will be added to your cloud account'}
                      </p>
                      {movingToCloud && (
                        <p
                          className="text-xs fg-secondary"
                          data-testid="mcp-cloud-move-carries"
                        >
                          Its URL, headers, and access token move to your cloud
                          account. OAuth sign-ins don't move, so sign in again
                          after you save if it uses OAuth.
                        </p>
                      )}
                      {hasAccountHeaders && (
                        <p
                          className="text-xs fg-secondary"
                          data-testid="mcp-cloud-headers-consent"
                        >
                          Its headers are stored in your cloud account too.
                        </p>
                      )}
                    </div>
                  )}
                  <label className="block">
                    <span className="mb-1.5 block fg-secondary">
                      Access token
                    </span>
                    <input
                      ref={accessTokenRef}
                      type="password"
                      autoComplete="off"
                      value={cloudToken}
                      onChange={(
                        e: React.ChangeEvent<HTMLInputElement>,
                      ): void => setCloudToken(e.target.value)}
                      placeholder={
                        editsCloudConnection &&
                        cloudConnection?.authMode === 'BEARER'
                          ? 'Stored'
                          : 'Optional'
                      }
                      data-testid="mcp-cloud-access-token"
                      className="focus-ring w-full rounded-lg border bg-base px-3 py-2 text-sm"
                    />
                    <span className="mt-1 block text-xs fg-secondary">
                      {!editsCloudConnection
                        ? 'Optional. The token is stored in your cloud account.'
                        : cloudConnection?.authMode === 'BEARER'
                          ? 'Leave it empty to keep the stored token.'
                          : 'Optional. Connects with this token instead of signing in.'}
                    </span>
                  </label>
                  {cloudUrlWarning && (
                    <Notice
                      role="none"
                      intent="attention"
                      data-testid="mcp-cloud-url-warning"
                    >
                      Changing the URL signs you out. Sign in again after you
                      save.
                    </Notice>
                  )}
                </div>
              )}

              {movingToDevice && cloudOwned && (
                <div
                  className="flex flex-col gap-3 text-sm"
                  data-testid="mcp-device-placement"
                >
                  <p className="fg-primary">Will move to this device</p>
                  <label className="block">
                    <span className="mb-1.5 block fg-secondary">
                      Access token
                    </span>
                    <input
                      type="password"
                      autoComplete="off"
                      value={cloudToken}
                      onChange={(
                        e: React.ChangeEvent<HTMLInputElement>,
                      ): void => setCloudToken(e.target.value)}
                      placeholder="Optional"
                      data-testid="mcp-device-access-token"
                      className="focus-ring w-full rounded-lg border bg-base px-3 py-2 text-sm"
                    />
                    <span className="mt-1 block text-xs fg-secondary">
                      Optional. Stored on this device. Or turn on OAuth below
                      and connect after you save.
                    </span>
                  </label>
                </div>
              )}

              {(effectiveScope === 'device'
                ? (cloudLocalReason ?? curatedCloudReason)
                : cloudBlockedReason) && (
                <div className="flex items-center justify-between gap-2">
                  <p
                    className="text-xs fg-secondary"
                    data-testid="mcp-cloud-local-reason"
                  >
                    {effectiveScope === 'device'
                      ? (cloudLocalReason ?? curatedCloudReason)
                      : cloudBlockedReason}
                  </p>
                  {curatedCloudRetry && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(): void =>
                        setAccountConnectionsRetry((retry): number => retry + 1)
                      }
                    >
                      Try again
                    </Button>
                  )}
                </div>
              )}

              <div className="text-sm">
                <span className="mb-1.5 block fg-secondary">Headers</span>
                {storedHeadersNote && effectiveScope === 'cloud' && (
                  <div
                    className="mb-2 flex items-center justify-between gap-2 text-xs fg-secondary"
                    data-testid="mcp-cloud-stored-headers"
                  >
                    <span>
                      {clearStoredHeaders
                        ? 'Stored headers are removed when you save.'
                        : 'Custom headers are stored in your cloud account. Add headers here to replace them.'}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={(): void =>
                        setClearStoredHeaders((current): boolean => !current)
                      }
                    >
                      {clearStoredHeaders
                        ? 'Keep stored headers'
                        : 'Remove stored headers'}
                    </Button>
                  </div>
                )}
                {headersLeftInCloud && (
                  <Notice
                    role="none"
                    intent="attention"
                    className="mb-2"
                    data-testid="mcp-cloud-stored-headers"
                  >
                    {storedHeadersKnown
                      ? "Its stored headers can't be copied to this device. Enter them again here to keep them."
                      : "It may have stored headers, which can't be copied to this device. Enter them again here to keep them."}
                  </Notice>
                )}
                <KeyValueEditor
                  entries={headers}
                  onChange={setHeaders}
                  keyPlaceholder="Header-Name"
                  valuePlaceholder="header-value"
                />
              </div>

              {curatedRequiresProvider && (
                <div
                  className="rounded-lg border bg-secondary/30 px-3 py-2 text-sm fg-secondary"
                  data-testid="mcp-curated-provider-auth"
                >
                  This catalog entry requires a confidential OAuth client. The
                  agent provider will handle authentication so the client secret
                  is never stored in the local server definition.
                </div>
              )}

              {/* OAuth section (HTTP only, for locally managed public clients) */}
              {!curatedRequiresProvider && !cloudOnlyInCloud && (
                <div className="space-y-3 rounded-lg border bg-secondary/20 p-3">
                  <label className="flex items-start gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      checked={oauthForm.enabled}
                      onChange={(
                        e: React.ChangeEvent<HTMLInputElement>,
                      ): void =>
                        setOauthForm({
                          ...oauthForm,
                          enabled: e.target.checked,
                        })
                      }
                      className="mt-0.5 rounded"
                      data-testid="mcp-server-use-oauth"
                    />
                    <span>
                      <span className="block font-medium fg-primary">
                        Use OAuth
                      </span>
                      <span className="mt-0.5 block text-xs fg-secondary">
                        {brandText.appName} discovers OAuth settings from the
                        HTTP MCP server, uses a local loopback callback, and
                        stores tokens in secure local storage.
                      </span>
                    </span>
                  </label>

                  {oauthForm.enabled && (
                    <div className="space-y-3 border-t pt-3">
                      {oauthForm.enabled &&
                        hasAnyAuthTokenConfigured(configs) && (
                          <Notice
                            role="none"
                            intent="attention"
                            title="OAuth covers proxied sessions"
                            data-testid="mcp-server-oauth-token-warning"
                          >
                            The static token is kept only for non-OAuth use.
                          </Notice>
                        )}

                      <div className="rounded-md border bg-base/50 px-3 py-2 text-xs fg-secondary">
                        PKCE and the loopback redirect are managed by{' '}
                        {brandText.appName}.
                      </div>

                      <button
                        type="button"
                        onClick={(): void =>
                          setOauthForm({
                            ...oauthForm,
                            advancedOpen: !oauthForm.advancedOpen,
                          })
                        }
                        className="focus-ring rounded-md border px-2 py-1 text-xs fg-secondary transition hover:bg-fg-primary/[0.08] hover:fg-primary"
                      >
                        {oauthForm.advancedOpen
                          ? 'Hide advanced OAuth overrides'
                          : 'Show advanced OAuth overrides'}
                      </button>

                      {oauthForm.advancedOpen && (
                        <div className="space-y-3 rounded-md border bg-base/40 p-3">
                          <p className="text-xs fg-secondary">
                            Fill these only when OAuth discovery or dynamic
                            registration is unavailable for this MCP server.
                          </p>

                          <label className="block text-xs">
                            <span className="mb-1 block fg-secondary">
                              Client ID
                              {curatedEntry?.requiredConfigFields?.some(
                                (field) => field.kind === 'oauth-client-id',
                              ) && <span className="fg-destructive"> *</span>}
                            </span>
                            <input
                              type="text"
                              value={oauthForm.clientId}
                              onChange={(
                                e: React.ChangeEvent<HTMLInputElement>,
                              ): void =>
                                setOauthForm({
                                  ...oauthForm,
                                  clientId: e.target.value,
                                })
                              }
                              placeholder="optional client id"
                              className="focus-ring w-full rounded-md border bg-base px-2 py-1 text-xs"
                            />
                          </label>

                          <label className="block text-xs">
                            <span className="mb-1 block fg-secondary">
                              Standalone saved client secrets are not supported.
                            </span>
                            <span className="mt-1 block text-2xs fg-secondary">
                              {brandText.appName} stores standalone MCP server
                              definitions on disk, so this editor only supports
                              public-client OAuth metadata plus PKCE.
                            </span>
                          </label>

                          <label className="block text-xs">
                            <span className="mb-1 block fg-secondary">
                              Callback port
                            </span>
                            <input
                              type="number"
                              min={1}
                              max={65_535}
                              step={1}
                              inputMode="numeric"
                              value={oauthForm.callbackPort ?? ''}
                              onChange={(
                                e: React.ChangeEvent<HTMLInputElement>,
                              ): void => {
                                setOauthForm({
                                  ...oauthForm,
                                  callbackPort: optionalNumberInputValue(
                                    e.currentTarget.valueAsNumber,
                                  ),
                                });
                              }}
                              placeholder="e.g. 3118"
                              data-testid="mcp-server-oauth-callback-port"
                              className="focus-ring w-full rounded-md border bg-base px-2 py-1 text-xs"
                            />
                            <span className="mt-1 block text-2xs fg-secondary">
                              Optional. Uses a dedicated loopback listener
                              instead of the shared MCP proxy port. Register{' '}
                              {/* The shape depends on who owns the OAuth client.
                                A catalog entry pins a port because the vendor
                                registered the redirect; anything typed here is
                                the user's own client, and Canopy keeps its own
                                shape for it. Stating one unconditionally sent
                                half the users to register a URI Canopy would
                                never send. */}
                              <code>
                                {oauthForm.vendorRegisteredRedirect === true
                                  ? 'http://localhost:<port>/callback'
                                  : 'http://127.0.0.1:<port>/oauth/callback'}
                              </code>{' '}
                              with the OAuth provider.
                            </span>
                          </label>

                          <label className="block text-xs">
                            <span className="mb-1 block fg-secondary">
                              Authorization URL
                            </span>
                            <input
                              type="text"
                              value={oauthForm.authorizationUrl}
                              onChange={(
                                e: React.ChangeEvent<HTMLInputElement>,
                              ): void =>
                                setOauthForm({
                                  ...oauthForm,
                                  authorizationUrl: e.target.value,
                                })
                              }
                              placeholder="optional authorization endpoint"
                              className="focus-ring w-full rounded-md border bg-base px-2 py-1 text-xs"
                            />
                          </label>

                          <label className="block text-xs">
                            <span className="mb-1 block fg-secondary">
                              Token URL
                            </span>
                            <input
                              type="text"
                              value={oauthForm.tokenUrl}
                              onChange={(
                                e: React.ChangeEvent<HTMLInputElement>,
                              ): void =>
                                setOauthForm({
                                  ...oauthForm,
                                  tokenUrl: e.target.value,
                                })
                              }
                              placeholder="optional token endpoint"
                              className="focus-ring w-full rounded-md border bg-base px-2 py-1 text-xs"
                            />
                          </label>

                          <label className="block text-xs">
                            <span className="mb-1 block fg-secondary">
                              Scopes
                            </span>
                            <input
                              type="text"
                              value={oauthForm.scopes}
                              onChange={(
                                e: React.ChangeEvent<HTMLInputElement>,
                              ): void =>
                                setOauthForm({
                                  ...oauthForm,
                                  scopes: e.target.value,
                                })
                              }
                              placeholder="optional scopes"
                              className="focus-ring w-full rounded-md border bg-base px-2 py-1 text-xs"
                            />
                          </label>

                          <label className="block text-xs">
                            <span className="mb-1 block fg-secondary">
                              Audience
                            </span>
                            <input
                              type="text"
                              value={oauthForm.audience}
                              onChange={(
                                e: React.ChangeEvent<HTMLInputElement>,
                              ): void =>
                                setOauthForm({
                                  ...oauthForm,
                                  audience: e.target.value,
                                })
                              }
                              placeholder="optional audience"
                              className="focus-ring w-full rounded-md border bg-base px-2 py-1 text-xs"
                            />
                          </label>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* Configurations section */}
          {!cloudOnlyInCloud && (
            <div className="border-t pt-4">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-medium fg-primary">
                  Configurations
                </span>
                <button
                  type="button"
                  onClick={handleAddConfig}
                  data-testid="mcp-server-add-config"
                  className="focus-ring rounded-md px-2 py-1 text-xs font-medium bg-secondary fg-primary hover:bg-accent-subtle transition-colors"
                >
                  Add
                </button>
              </div>

              {configs.length === 0 && (
                <p className="text-xs fg-secondary py-3 text-center">
                  No configurations. Add one to define environment-specific
                  settings.
                </p>
              )}

              <div className="space-y-2">
                {configs.map((config, index) => (
                  <ConfigEditor
                    key={config.id || `new-${index}`}
                    config={config}
                    initialExpanded={expandedNewIds.has(config.id)}
                    onChange={(updated: McpServerConfigData) =>
                      handleUpdateConfig(index, updated)
                    }
                    onDelete={() => handleDeleteConfig(index)}
                  />
                ))}
              </div>
            </div>
          )}
        </EntityEditModalContent>
      </DialogModal>
      {confirmMoveToDevice && (
        <McpMoveToDeviceDialog
          serverName={name.trim() || (cloudConnection?.displayName ?? '')}
          signInAgain={
            !cloudToken.trim() &&
            !oauthForm.enabled &&
            !hasAnyAuthTokenConfigured(configs)
          }
          {...(moveDropsStoredHeaders
            ? {
                storedHeadersChoice: {
                  known: storedHeadersKnown,
                  confirmed: moveWithoutStoredHeaders,
                  onChange: setMoveWithoutStoredHeaders,
                },
              }
            : {})}
          onConfirm={(): void => void moveToDevice()}
          onClose={(): void => setConfirmMoveToDevice(false)}
        />
      )}
      {confirmMoveToCloud && (
        <McpMoveToCloudDialog
          serverName={name.trim()}
          tokenMoves={cloudToken.trim().length > 0}
          dataTestId="mcp-move-to-cloud-dialog"
          confirmTestId="mcp-move-to-cloud-confirm"
          onConfirm={(): void => {
            const move = pendingMoveToCloud.current;
            pendingMoveToCloud.current = null;
            setConfirmMoveToCloud(false);
            if (move) void move();
          }}
          onClose={(): void => {
            pendingMoveToCloud.current = null;
            setConfirmMoveToCloud(false);
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// McpServerDetailOverlay (read-only detail view for UnifiedTable "View" action)
// ---------------------------------------------------------------------------

export function McpServerDetailOverlay({
  shareAction,
  serverId,
  configId,
  onBack,
}: {
  shareAction?: MarketplaceShareAction;
  serverId: string;
  /**
   * Which configuration of an account server to open. Account rows for one
   * key share the server id, so without it the default connection opens.
   */
  configId?: string;
  onBack: () => void;
}): JSX.Element {
  const accountEnabled = useFeatureFlagsStore((state): boolean =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopySharedMcpAccountConnections.key),
  );
  const [accountConnection, setAccountConnection] =
    useState<AccountMcpConnection | null>(null);
  const [server, setServer] = useState<McpServerData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    setAccountConnection(null);
    setServer(null);

    void runCancellableModalLoad(
      async (): Promise<void> => {
        // Account rows are keyed by server key, so only the merged index
        // tells an account row from a device server.
        const accountConnectionId = accountEnabled
          ? findAccountMcpRow(
              (await window.mcpServers.loadIndex()).servers,
              serverId,
              configId,
            )?.accountConnectionId
          : undefined;
        if (cancelled) return;
        if (accountConnectionId) {
          const result =
            await window.mcpServers.getAccountConnection(accountConnectionId);
          if (!cancelled) setAccountConnection(result);
          return;
        }
        const result = await window.mcpServers.loadServer(serverId);
        if (cancelled) return;
        setServer(result.server);
      },
      {
        isCancelled: () => cancelled,
        setError,
        setLoading,
      },
    );

    return (): void => {
      cancelled = true;
    };
  }, [serverId, configId, accountEnabled]);

  if (accountConnection)
    return (
      <AccountMcpDetails
        shareAction={shareAction}
        connection={accountConnection}
        onClose={onBack}
        onSaved={(): Promise<void> => Promise.resolve()}
      />
    );

  const def = server?.definition;

  return (
    <BackDetailOverlayShell
      title={def?.name ?? 'MCP server'}
      titleId="mcp-detail-overlay-title"
      onBack={onBack}
      badge={
        def ? (
          <span className="ml-2 px-2 py-0.5 text-3xs font-medium rounded bg-secondary fg-secondary">
            {def.type === 'http' ? 'HTTP' : 'Command'}
          </span>
        ) : null
      }
    >
      {loading && (
        <div className="flex items-center justify-center py-12">
          <p className="text-sm fg-secondary">Loading&hellip;</p>
        </div>
      )}

      {error && <Notice intent="destructive">{error}</Notice>}

      {def && !loading && (
        <>
          <InstalledEntryStatusSection
            entry={{
              state: 'installed',
              name: def.name,
              ref: { type: 'local-mcp', serverId },
            }}
            onUninstalled={onBack}
          />
          {/* Description */}
          {def.description && (
            <p className="text-sm fg-secondary mb-4">{def.description}</p>
          )}

          {/* Connection details */}
          <div className="rounded-lg border bg-secondary/30 px-4 py-3 mb-4">
            <dl className="space-y-1.5 text-sm">
              <div className="flex gap-2">
                <dt className="font-medium fg-primary whitespace-nowrap">
                  Type:
                </dt>
                <dd className="fg-secondary">
                  {def.type === 'command' ? 'Command (stdio)' : 'HTTP'}
                </dd>
              </div>
              {def.type === 'command' && def.command && (
                <div className="flex gap-2">
                  <dt className="font-medium fg-primary whitespace-nowrap">
                    Command:
                  </dt>
                  {/* Args often carry API keys inline. */}
                  <dd
                    className={`${POSTHOG_REPLAY_BLOCK_CLASS} fg-secondary font-mono text-xs break-all`}
                  >
                    {def.command}
                    {def.args && def.args.length > 0
                      ? ` ${def.args.join(' ')}`
                      : ''}
                  </dd>
                </div>
              )}
              {def.type === 'http' && def.url && (
                <div className="flex gap-2">
                  <dt className="font-medium fg-primary whitespace-nowrap">
                    URL:
                  </dt>
                  <dd className="fg-secondary font-mono text-xs break-all">
                    {def.url}
                  </dd>
                </div>
              )}
              {def.type === 'http' && (
                <div className="flex gap-2">
                  <dt className="font-medium fg-primary whitespace-nowrap">
                    OAuth:
                  </dt>
                  <dd className="fg-secondary">
                    {def.oauth ? 'configured' : 'not configured'}
                  </dd>
                </div>
              )}
            </dl>
          </div>

          {/* Configurations */}
          <h3 className="text-sm font-medium fg-primary mb-2">
            Configurations ({server?.configs.length ?? 0})
          </h3>
          {server?.configs.length === 0 && (
            <p className="text-xs fg-secondary italic">No configurations.</p>
          )}
          <div className="space-y-2">
            {server?.configs.map((c) => (
              <div
                key={c.id}
                className="rounded-lg border bg-secondary/20 px-4 py-3"
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-medium fg-primary">
                    {c.name}
                  </span>
                  <span
                    className={`px-1.5 py-0.5 text-3xs font-medium rounded ${
                      c.enabled
                        ? 'bg-success-subtle fg-success'
                        : 'bg-secondary fg-secondary'
                    }`}
                  >
                    {c.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                </div>
                {c.description && (
                  <p className="text-xs fg-secondary mb-2">{c.description}</p>
                )}
                <dl className="space-y-1 text-xs">
                  {Object.keys(c.envVars).length > 0 && (
                    <div className="flex gap-2">
                      <dt className="font-medium fg-primary whitespace-nowrap">
                        Env vars:
                      </dt>
                      <dd className="fg-secondary">
                        {Object.keys(c.envVars).join(', ')}
                      </dd>
                    </div>
                  )}
                  {c.extraArgs.length > 0 && (
                    <div className="flex gap-2">
                      <dt className="font-medium fg-primary whitespace-nowrap">
                        Extra args:
                      </dt>
                      <dd
                        className={`${POSTHOG_REPLAY_BLOCK_CLASS} fg-secondary font-mono`}
                      >
                        {c.extraArgs.join(' ')}
                      </dd>
                    </div>
                  )}
                  {Object.keys(c.extraHeaders).length > 0 && (
                    <div className="flex gap-2">
                      <dt className="font-medium fg-primary whitespace-nowrap">
                        Extra headers:
                      </dt>
                      <dd className="fg-secondary">
                        {Object.keys(c.extraHeaders).join(', ')}
                      </dd>
                    </div>
                  )}
                  {c.authToken && (
                    <div className="flex gap-2">
                      <dt className="font-medium fg-primary whitespace-nowrap">
                        Auth token:
                      </dt>
                      <dd className="fg-secondary">configured</dd>
                    </div>
                  )}
                </dl>
              </div>
            ))}
          </div>
        </>
      )}
    </BackDetailOverlayShell>
  );
}

// ---------------------------------------------------------------------------
// McpServersTab helpers (logo, status badge, Add menu)
// ---------------------------------------------------------------------------

/**
 * Row logo for the table Name cell: the shared circular {@link McpServerLogo}
 * with the monogram fallback (rows are identified by server name).
 */
function McpRowLogo({
  curatedKey,
  logoUrl,
  name,
}: {
  curatedKey?: string;
  logoUrl?: string;
  name?: string;
}): JSX.Element {
  return (
    <McpServerLogo
      curatedKey={curatedKey}
      logoUrl={logoUrl}
      size={20}
      fallback="monogram"
      name={name}
      imgTestId="mcp-server-row-logo"
      fallbackTestId="mcp-server-row-logo-fallback"
    />
  );
}

type McpTableOverflow = 'none' | 'start' | 'end' | 'both';

function readMcpTableOverflow(region: HTMLElement): McpTableOverflow {
  const hidden = region.scrollWidth - region.clientWidth;
  if (hidden <= 1) return 'none';
  const before = region.scrollLeft > 1;
  const after = region.scrollLeft < hidden - 1;
  if (before && after) return 'both';
  return before ? 'start' : 'end';
}

/**
 * The table's border and scroll region (CAN-4258). A table wider than its
 * mount scrolls here instead of being clipped: the hidden side fades, since
 * overlay scrollbars hide at rest, and the region becomes a named keyboard
 * stop that arrow keys scroll. A table that fits adds neither.
 */
function McpTableScrollRegion({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  const regionRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState<McpTableOverflow>('none');
  useEffect((): (() => void) | undefined => {
    const region = regionRef.current;
    if (!region) return undefined;
    // Only an edge change re-renders, so scrolling stays off React.
    const update = (): void => setOverflow(readMcpTableOverflow(region));
    update();
    const observer =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(update);
    observer?.observe(region);
    if (region.firstElementChild) observer?.observe(region.firstElementChild);
    region.addEventListener('scroll', update, { passive: true });
    return (): void => {
      observer?.disconnect();
      region.removeEventListener('scroll', update);
    };
  }, []);
  const scrollable = overflow !== 'none';
  return (
    <div
      ref={regionRef}
      data-testid="mcp-servers-table"
      data-overflow={scrollable ? overflow : undefined}
      {...(scrollable
        ? { role: 'region', 'aria-label': 'MCP servers', tabIndex: 0 }
        : {})}
      className="mcp-table-scroll focus-ring focus-ring-inset overflow-x-auto rounded-lg border"
    >
      {children}
    </div>
  );
}

// Re-exported from the shared derivation so existing callers keep one import.
export { deriveMcpConnectionBadge };

/** Choose an enabled configuration that still needs a supported OAuth flow. */
export function getMcpConnectConfigId(
  server: McpServerIndexEntry,
  entry: McpServerStatusEntry | undefined,
): string | undefined {
  const enabledConfigIds = new Set(
    server.configs
      .filter((config) => config.enabled)
      .map((config) => config.id),
  );
  return (
    entry?.configs.find(
      (config) =>
        enabledConfigIds.has(config.configId) &&
        config.authStatus !== 'connected' &&
        config.authStatus !== 'unsupported',
    )?.configId ?? server.configs.find((config) => config.enabled)?.id
  );
}

function McpStatusBadge({
  entry,
}: {
  entry: McpServerStatusEntry | undefined;
}): JSX.Element {
  return <McpConnectionStatusBadge badge={deriveMcpConnectionBadge(entry)} />;
}

/**
 * Status-column cell: servers awaiting authentication get an inline Connect
 * button (launching the OAuth login flow) instead of an "Auth required" badge.
 */
function McpStatusCell({
  entry,
  connecting,
  onConnect,
}: {
  entry: McpServerStatusEntry | undefined;
  connecting: boolean;
  onConnect: () => void;
}): JSX.Element {
  const { status } = deriveMcpConnectionBadge(entry);
  // Cached health and account recovery eligibility are separate: an
  // unchecked/disconnected account still keeps its legacy Connect shortcut.
  if (
    status === 'auth_required' ||
    (entry?.handler === 'account' && entry.connectionStatus === 'auth_required')
  ) {
    const accountAction =
      entry?.handler === 'account'
        ? entry.configs.some(
            (config): boolean =>
              config.authStatus === 'error' || config.authStatus === 'expired',
          )
          ? 'Reconnect in cloud'
          : 'Connect in cloud'
        : undefined;
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onConnect();
        }}
        disabled={connecting}
        data-testid="mcp-server-connect-button"
        className="px-2.5 py-1 text-2xs font-medium rounded-md bg-accent fg-emphasis hover:bg-accent/90 transition-colors focus-ring disabled:opacity-50"
      >
        {connecting ? 'Connecting…' : (accountAction ?? 'Connect')}
      </button>
    );
  }
  return <McpStatusBadge entry={entry} />;
}

/**
 * Toolbar "Add" affordance. With a non-empty curated catalog it is a dropdown
 * (Browse / Add Custom); with an empty/unavailable catalog it degrades to a
 * plain "Add custom" button (the pre-catalog behavior, renamed).
 */
function AddServerMenu({
  hasCatalog,
  onBrowse,
  onAddCustom,
}: {
  hasCatalog: boolean;
  onBrowse: () => void;
  onAddCustom: () => void;
}): JSX.Element {
  const browseLabel = useEarlyAccessTitle('Browse MCP Servers');
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuItems: readonly ActionMenuItem[] = [
    {
      key: 'browse',
      label: browseLabel,
      icon: <AppCatalogStorefrontIcon />,
      testId: 'mcp-add-browse',
      onSelect: onBrowse,
    },
    {
      key: 'custom',
      label: 'Add custom',
      icon: <AppCatalogPlusIcon />,
      testId: 'mcp-add-custom',
      onSelect: onAddCustom,
    },
  ];

  if (!hasCatalog) {
    return (
      <button
        type="button"
        onClick={onAddCustom}
        data-testid="mcp-add-custom"
        className="px-3 py-1.5 text-xs font-medium rounded-md bg-accent fg-emphasis hover:bg-accent/90 transition-colors focus-ring"
      >
        Add custom
      </button>
    );
  }

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-testid="mcp-add-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-md bg-accent fg-emphasis hover:bg-accent/90 transition-colors focus-ring"
      >
        Add
        <AppCatalogChevronDownMediumIcon width="10" height="10" />
      </button>
      <FloatingMenu
        open={open}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        placement="bottom-right"
        aria-label="Add"
        data-testid="mcp-add-menu"
        className="min-w-50"
      >
        <ActionMenuRowStyle>
          <ActionMenuItems
            items={menuItems}
            onSelect={(item): void => {
              if (item.disabled || !item.onSelect) return;
              setOpen(false);
              triggerRef.current?.focus({ preventScroll: true });
              item.onSelect();
            }}
          />
        </ActionMenuRowStyle>
      </FloatingMenu>
    </div>
  );
}

/** Table Name-cell subtitle: description for 0\u20131 configs, else a config summary. */
export function mcpRowSubtitle(server: McpServerIndexEntry): string {
  const enabledConfigs = server.configs.filter((config) => config.enabled);
  if (enabledConfigs.length <= 1) return server.description;
  const names = enabledConfigs.map((config) => config.name).join(', ');
  return `${enabledConfigs.length} configs \u00b7 ${names}`;
}

// ---------------------------------------------------------------------------
// McpServersTab (main export)
// ---------------------------------------------------------------------------

interface McpServersTabProps {
  accountPanel?: boolean;
}

export function McpServersTab({
  accountPanel = false,
}: McpServersTabProps): JSX.Element {
  const accountEnabled = useFeatureFlagsStore((state): boolean =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopySharedMcpAccountConnections.key),
  );
  const {
    servers,
    loading,
    error,
    refresh,
    accountConnectionsAvailable,
    accountConnectionsUnavailableReason,
  } = useMcpServerList();
  const accountActions = useAccountMcpActions(refresh);
  // Keyed by connection id: two connections to one provider share a server
  // key but are two rows (REG-3033).
  const [accountDetails, setAccountDetails] = useState<string | null>(null);
  const detailsConnection = servers.find(
    (row): boolean => (row.accountConnectionId ?? row.id) === accountDetails,
  )?.accountConnection;
  const { entries: curatedEntries, refresh: refreshCurated } =
    useCuratedMcpServers();
  const { statuses, refresh: refreshStatuses } = useMcpServerStatuses(servers);
  const [promoteRow, setPromoteRow] = useState<McpServerIndexEntry | null>(
    null,
  );
  // A cloud connection with no device copy, opened for editing.
  const [dialogAccountConnection, setDialogAccountConnection] = useState<
    AccountMcpConnection | undefined
  >(undefined);

  // null = dialog closed, '' = create mode, string = edit by id
  const [dialogServerId, setDialogServerId] = useState<string | null>(null);
  // Curated entry to pre-fill the create dialog (undefined = blank custom add).
  const [dialogCurated, setDialogCurated] = useState<
    CuratedMcpServerEntry | undefined
  >(undefined);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState<'device' | 'account'>('device');
  const [dialogAccountConfigId, setDialogAccountConfigId] = useState('default');
  // Account setup for a catalog server that registers no OAuth clients: the
  // dialog asks for the user's own app, with the cloud's setup when it sent one.
  const [dialogOAuthClient, setDialogOAuthClient] = useState<{
    clientSetup?: AccountMcpClientSetup;
    endpointUrl?: string;
  } | null>(null);
  // The cloud account the account setup dialog was opened under. Credentials
  // typed into that dialog are bound to it: a sign-in change closes the dialog
  // (below) and the connect path refuses a mismatch, so a secret entered for one
  // account is never submitted under another.
  const dialogAccountId = useRef<string | undefined>(undefined);
  const [setupError, setSetupError] = useState<string | null>(null);
  // Guidance that is not an error: what to do when Connect can't start here,
  // or that a sign-in needed no browser because it was already signed in.
  const [connectNotice, setConnectNotice] = useState<string | null>(null);
  const setupRequest = useRef(0);
  // A connection awaiting a credential (a custom connection's replacement, or
  // a catalog server's access token when its own app needs a secret the cloud
  // can't store); bound to the captured account exactly like the curated
  // setup dialog.
  const [credentialPrompt, setCredentialPrompt] = useState<{
    target: AccountMcpCredentialTarget;
    kind: AccountMcpCredentialKind;
    clientSetup?: AccountMcpClientSetup;
    intro?: string;
  } | null>(null);
  // A custom row whose promotion needs an access token to go ahead.
  const [promotionTokenPrompt, setPromotionTokenPrompt] = useState<{
    row: McpServerIndexEntry;
  } | null>(null);
  const accountSetupOpenRef = useRef(false);
  accountSetupOpenRef.current =
    dialogMode === 'account' ||
    credentialPrompt !== null ||
    promotionTokenPrompt !== null ||
    promoteRow !== null;
  const dialogOpenRef = useRef(false);
  dialogOpenRef.current =
    accountSetupOpenRef.current ||
    dialogServerId !== null ||
    accountDetails !== null ||
    browseOpen;
  const closeAccountSetup = (): void => {
    dialogAccountId.current = undefined;
    setCredentialPrompt(null);
    setPromotionTokenPrompt(null);
    setPromoteRow(null);
    setDialogServerId(null);
    setDialogCurated(undefined);
    setDialogAccountConnection(undefined);
    setDialogOAuthClient(null);
    setDialogMode('device');
  };
  // Setup only opens once the signed-in account is known, so every
  // submission carries the account its credentials were typed under.
  const withCapturedAccount = (open: () => void): void => {
    const request = ++setupRequest.current;
    setSetupError(null);
    void (async (): Promise<void> => {
      let accountId: string | undefined;
      try {
        accountId = (await window.api?.loadCanopyCloudAccount?.())?.account?.id;
      } catch {
        accountId = undefined;
      }
      if (request !== setupRequest.current) return;
      if (!accountId) {
        setSetupError('Sign in to connect account servers.');
        return;
      }
      dialogAccountId.current = accountId;
      open();
    })();
  };
  const openAccountSetup = (
    entry: CuratedMcpServerEntry,
    configId: string,
    oauthClient: {
      clientSetup?: AccountMcpClientSetup;
      endpointUrl?: string;
    } | null = null,
  ): void =>
    withCapturedAccount((): void => {
      setDialogMode('account');
      setDialogCurated(entry);
      setDialogAccountConfigId(configId);
      setDialogOAuthClient(oauthClient);
      setDialogServerId('');
    });
  const openCredentialPrompt = (
    connection: AccountMcpConnection,
    kind: AccountMcpCredentialKind,
    clientSetup?: AccountMcpClientSetup,
  ): void =>
    withCapturedAccount((): void =>
      setCredentialPrompt({
        target: accountMcpCredentialTarget(connection),
        kind,
        ...(clientSetup ? { clientSetup } : {}),
      }),
    );
  const promptForOAuthClient = (
    entry: CuratedMcpServerEntry | undefined,
    connection: AccountMcpConnection | undefined,
    configId: string,
    clientSetup?: AccountMcpClientSetup,
    endpointUrl?: string,
  ): void => {
    const step = accountMcpClientPromptStep({
      ...(entry ? { entry } : {}),
      ...(connection ? { connection } : {}),
      configId,
      ...(clientSetup ? { clientSetup } : {}),
      ...(endpointUrl ? { endpointUrl } : {}),
    });
    if (step.kind === 'error') setSetupError(step.message);
    else if (step.kind === 'token')
      withCapturedAccount((): void =>
        setCredentialPrompt({
          target: step.target,
          kind: 'bearer',
          intro: step.intro,
        }),
      );
    else if (step.kind === 'setup')
      openAccountSetup(step.entry, step.configId, {
        ...(step.clientSetup ? { clientSetup: step.clientSetup } : {}),
        ...(step.endpointUrl ? { endpointUrl: step.endpointUrl } : {}),
      });
    else
      openCredentialPrompt(step.connection, 'oauth-client', step.clientSetup);
  };
  useEffect((): (() => void) | undefined => {
    // The bridge fires this for every account operation (a connect settling,
    // a disconnect, a tools save), not only for sign-in changes, so the dialog
    // only closes when the signed-in account really differs from the one its
    // credentials were captured under.
    return window.mcpServers?.onAuthChanged?.((): void => {
      if (!accountSetupOpenRef.current) return;
      const captured = dialogAccountId.current;
      if (captured === undefined) {
        closeAccountSetup();
        return;
      }
      void window.api
        ?.loadCanopyCloudAccount?.()
        .then((state): void => {
          if (!accountSetupOpenRef.current) return;
          if (state.account?.id === captured) return;
          // Credentials in the open dialog belong to the previous sign-in.
          closeAccountSetup();
        })
        .catch((): void => {
          // The account can no longer be confirmed as the captured one.
          closeAccountSetup();
        });
    });
  }, []);

  // The catalog read can outlast the user: a setup started, or any dialog
  // open, opened or closed meanwhile wins over this delayed one.
  const promptForEndpoint = (serverKey: string, configId: string): void => {
    const request = ++setupRequest.current;
    const overlays = overlayGeneration(document);
    void accountMcpEndpointEntry(
      serverKey,
      curatedEntries,
      refreshCurated,
    ).then((entry): void => {
      if (
        request !== setupRequest.current ||
        overlays !== overlayGeneration(document) ||
        dialogOpenRef.current
      )
        return;
      if (entry) openAccountSetup(entry, configId);
      else setSetupError(mcpConnectErrorMessage(ACCOUNT_MCP_ENDPOINT_REQUIRED));
    });
  };

  const startAccountStep = (
    step: AccountMcpConnectStep<AccountMcpConnection>,
    entry: CuratedMcpServerEntry | undefined,
    connection?: AccountMcpConnection,
  ): void => {
    setConnectNotice(null);
    if (step.kind === 'unavailable')
      setConnectNotice(accountMcpUnavailableMessage(entry));
    else if (step.kind === 'setup') openAccountSetup(step.entry, step.configId);
    else if (step.kind === 'credential')
      openCredentialPrompt(step.connection, 'bearer');
    else if (step.kind === 'connect')
      void accountActions.connect(step.serverKey, step.configId, {
        // A server without dynamic registration needs the user's own OAuth
        // app (a custom one, the client it was created with); collect it
        // and retry.
        onOAuthClientRequired: (clientSetup): void =>
          promptForOAuthClient(entry, connection, step.configId, clientSetup),
        onEndpointRequired: (): void =>
          promptForEndpoint(step.serverKey, step.configId),
      });
  };

  const hasCatalog = curatedEntries.length > 0;

  const openAddCustom = (): void => {
    setDialogMode('device');
    setDialogCurated(undefined);
    setDialogAccountConnection(undefined);
    setDialogServerId('');
  };

  // The same Add rule as the Plugins page detail (REG-3033): one helper
  // decides between an account connection and a device file for both.
  const handleBrowseAdd = (entry: CuratedMcpServerEntry): void => {
    setBrowseOpen(false);
    setDialogAccountConfigId('default');
    const target = curatedMcpAddTarget(entry, {
      accountConnectionsEnabled: accountEnabled,
      accountConnectionsAvailable,
    });
    if (target.kind === 'account') {
      startAccountStep(
        accountMcpCatalogConnectStep(entry, target.configId),
        entry,
      );
      return;
    }
    // A provider connector's guidance renders inside the editor opened below.
    setConnectNotice(null);
    setDialogMode('device');
    setDialogCurated(entry);
    setDialogServerId('');
  };

  // Promotion moves the row to the cloud account with its own URL, name,
  // headers, and the access token the user confirmed; non-HTTPS or local URLs
  // have no cloud equivalent, so those rows stay on the device. The device
  // copy stays bound to the new connection, loses its plaintext token, and
  // hands its references to the cloud ref.
  const promoteCustomRow = async (
    row: McpServerIndexEntry,
    credential: { bearerToken?: string; expectedAccountId: string },
  ): Promise<void> => {
    setSetupError(null);
    try {
      await promoteCustomMcpServer(row, credential, accountActions, () =>
        withCapturedAccount((): void => setPromotionTokenPrompt({ row })),
      );
    } catch (error) {
      setSetupError(extractIpcErrorMessage(error));
    }
  };

  const customRowPromotable = (row: McpServerIndexEntry): boolean =>
    customAccountMcpPromotable(row) &&
    statuses.get(row.id)?.handler !== 'provider';

  // Moving a row to the cloud account carries its token, so it always asks,
  // App Advisor included; the confirmation is bound to the account it opened
  // under, like the setup dialogs.
  const openPromoteDialog = (server: McpServerIndexEntry): void =>
    withCapturedAccount((): void => setPromoteRow(server));
  const promoteRefusal = (server: McpServerIndexEntry): string | undefined =>
    customRowPromotable(server) && server.configs.length > 1
      ? CLOUD_SINGLE_CONFIG_REQUIRED
      : undefined;
  // Whether the catalog keeps this row's server off the cloud account.
  const rowDesktopOnly = (server: McpServerIndexEntry): boolean =>
    curatedEntries.some(
      (entry): boolean =>
        entry.key === server.curatedKey && curatedMcpDesktopOnly(entry),
    );
  const connectAccountRow = (server: McpServerIndexEntry): void => {
    if (customRowPromotable(server)) {
      const refusal = promoteRefusal(server);
      if (refusal) setSetupError(refusal);
      else openPromoteDialog(server);
      return;
    }
    const entry = curatedEntries.find(
      (catalog): boolean =>
        catalog.key ===
        (server.curatedKey ?? server.accountConnection?.serverKey),
    );
    const connection = server.accountConnection;
    startAccountStep(
      accountMcpConnectStep({
        ...(entry ? { entry } : {}),
        ...(connection ? { connection } : {}),
        ...(server.curatedKey ? { curatedKey: server.curatedKey } : {}),
      }),
      entry,
      connection,
    );
  };
  // Custom cloud rows open the editor: on their device copy when this device
  // has one, otherwise on the connection itself.
  const editableAccountCopy = (
    server: McpServerIndexEntry,
  ): McpServerIndexEntry | undefined =>
    server.deviceCopies?.find(
      (copy): boolean =>
        copy.accountConnectionId !== undefined &&
        copy.accountConnectionId === server.accountConnection?.id,
    );
  const openAccountEditor = (server: McpServerIndexEntry): void => {
    const connection = server.accountConnection;
    if (!connection) return;
    const copy = editableAccountCopy(server);
    setDialogMode('device');
    setDialogCurated(undefined);
    if (copy) {
      setDialogAccountConnection(undefined);
      setDialogServerId(copy.id);
    } else {
      setDialogAccountConnection(connection);
      setDialogServerId('');
    }
  };
  useCurrentUiStateReporter(
    `mcp.accountConnections.${accountPanel ? 'settings' : 'plugins'}`,
    accountEnabled
      ? {
          available: accountConnectionsAvailable === true,
          loading,
          setupOpen:
            (dialogMode === 'account' && dialogServerId !== null) ||
            credentialPrompt !== null ||
            promotionTokenPrompt !== null,
          detailsOpen: accountDetails !== null,
          promoteDialogOpen: promoteRow !== null,
          detailsRowId: accountDetails,
          pendingCount: accountActions.pending.size,
          rows: servers.slice(0, 50).map((row) => ({
            id: row.id,
            serverKey:
              row.accountConnection?.serverKey ?? row.curatedKey ?? null,
            status: row.accountConnection?.status ?? null,
          })),
        }
      : null,
  );
  useEffect((): (() => void) => {
    const listener = (event: Event): void => {
      if (
        !(event instanceof CustomEvent) ||
        !accountEnabled ||
        !accountConnectionsAvailable ||
        loading
      )
        return;
      const nav = useNavigationStore.getState();
      if (nav.settingsOpen !== accountPanel) return;
      const detail: unknown = event.detail;
      if (!isAccountMcpActionEventDetail(detail)) return;
      const row = servers.find(
        (server): boolean => server.id === detail.serverId,
      );
      const entry = curatedEntries.find(
        (catalog): boolean =>
          catalog.key ===
          (row?.curatedKey ??
            row?.accountConnection?.serverKey ??
            detail.serverId),
      );
      // Desktop only blocks every cloud connect, never revoking a connection
      // made before the server was marked (REG-3035).
      if (
        entry &&
        curatedMcpDesktopOnly(entry) &&
        detail.operation !== 'disconnect'
      )
        return;
      const customPromotable = row !== undefined && customRowPromotable(row);
      if (
        !row?.accountConnection &&
        !row?.curatedKey &&
        !entry &&
        !customPromotable
      )
        return;
      const connection = row?.accountConnection;
      if (detail.operation === 'edit') {
        // Same rows as the Edit button: custom servers in the cloud account.
        if (!row || connection?.kind !== 'CUSTOM') return;
        openAccountEditor(row);
      } else if (detail.operation === 'disconnect') {
        if (!connection || connection.status === 'DISCONNECTED') return;
        void accountActions.disconnect(connection.id);
      } else {
        if (
          detail.operation === 'promote' &&
          (!row || connection || (!row.curatedKey && !customPromotable))
        )
          return;
        if (
          detail.operation === 'reconnect' &&
          connection?.status !== 'REAUTH_REQUIRED'
        )
          return;
        if (
          connection?.status === 'CONNECTED' ||
          connection?.status === 'PENDING'
        )
          return;
        const refusal = row ? promoteRefusal(row) : undefined;
        if (refusal) {
          setSetupError(refusal);
          detail.refuse?.(refusal);
          return;
        }
        if (row) connectAccountRow(row);
        else if (detail.operation === 'connect' && entry)
          handleBrowseAdd(entry);
        else return;
      }
      detail.acknowledge();
    };
    window.addEventListener(ACCOUNT_MCP_ACTION_EVENT, listener);
    return (): void =>
      window.removeEventListener(ACCOUNT_MCP_ACTION_EVENT, listener);
  });

  const closeDialog = (): void => {
    setupRequest.current += 1;
    closeAccountSetup();
  };

  const handleSaved = async (): Promise<void> => {
    await refresh();
    refreshStatuses();
  };

  const [connectingServerId, setConnectingServerId] = useState<string | null>(
    null,
  );

  const [connectError, setConnectError] = useState('');
  const accountError = accountEnabled
    ? setupError || accountActions.error
    : null;
  const bannerError = error || connectError || accountError;
  // A cloud refusal's code stays out of the sentence but at hand.
  const bannerErrorCode =
    bannerError && bannerError === accountActions.error
      ? accountActions.errorCode
      : null;

  const handleConnect = async (server: McpServerIndexEntry): Promise<void> => {
    const entry = statuses.get(server.id);
    setConnectError('');
    setConnectNotice(null);
    if (entry?.handler === 'account') {
      openCloudAccountSettings();
      return;
    }
    const configId = getMcpConnectConfigId(server, entry);
    setConnectingServerId(server.id);
    try {
      const result = await window.mcpServers.startOAuthLogin({
        serverId: server.id,
        ...(configId ? { configId } : {}),
      });
      if (result.status === 'started') {
        // Browser flow pending: re-check when the user returns to the app.
        const handleFocus = (): void => {
          window.removeEventListener('focus', handleFocus);
          refreshStatuses();
        };
        window.addEventListener('focus', handleFocus);
      } else {
        // A valid token already existed, so no browser opened.
        setConnectNotice(mcpAlreadyConnectedMessage(server.name));
      }
    } catch (error: unknown) {
      setConnectError(error instanceof Error ? error.message : String(error));
    } finally {
      setConnectingServerId(null);
      refreshStatuses();
    }
  };

  return (
    <>
      {/* Toolbar */}
      <div className="flex items-center justify-between mb-4">
        <p className="text-xs fg-secondary">
          {servers.length > 0
            ? `${servers.length} server${servers.length !== 1 ? 's' : ''}`
            : ''}
        </p>
        <AddServerMenu
          hasCatalog={hasCatalog}
          onBrowse={() => setBrowseOpen(true)}
          onAddCustom={openAddCustom}
        />
      </div>

      {accountEnabled && accountConnectionsAvailable === false && (
        <Notice
          intent="neutral"
          icon={null}
          className="mb-4"
          data-testid="mcp-account-sign-in-hint"
        >
          {accountConnectionsUnavailableReason === 'unavailable'
            ? 'Account MCP connections are unavailable.'
            : 'Sign in to see account connections'}
        </Notice>
      )}
      {/* Error */}
      <div
        title={mcpConnectErrorCodeTitle(bannerErrorCode)}
        data-mcp-error-code={bannerErrorCode ?? undefined}
      >
        <ErrorBanner error={bannerError} />
      </div>
      {connectNotice && (
        <Notice
          intent="neutral"
          className="mb-4"
          role="status"
          data-testid="mcp-connect-notice"
          onDismiss={(): void => setConnectNotice(null)}
          dismissTestId="mcp-connect-notice-dismiss"
        >
          {connectNotice}
        </Notice>
      )}

      {/* Loading */}
      {loading && servers.length === 0 && (
        <LoadingPlaceholder label="Loading MCP servers…" space="page" />
      )}

      {/* Table */}
      {servers.length > 0 && (
        <McpTableScrollRegion>
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-secondary/50 border-b">
                <th className="text-left px-4 py-3 font-medium fg-secondary">
                  Name
                </th>
                <th className="text-left px-4 py-3 font-medium fg-secondary">
                  Type
                </th>
                <th className="text-left px-4 py-3 font-medium fg-secondary">
                  Status
                </th>
                <th className="text-left px-4 py-3 font-medium fg-secondary">
                  Last updated
                </th>
                <th className="text-right px-4 py-3 font-medium fg-secondary">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {servers
                .slice()
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((server) => {
                  const subtitle = mcpRowSubtitle(server);
                  return (
                    <tr
                      key={server.accountConnectionId ?? server.id}
                      data-testid={`mcp-server-row-${server.id}`}
                      data-mcp-connection-id={server.accountConnectionId}
                      onClick={(): void =>
                        server.accountConnection && accountEnabled
                          ? setAccountDetails(
                              server.accountConnectionId ?? server.id,
                            )
                          : setDialogServerId(server.id)
                      }
                      className="border-b last:border-b-0 hover:bg-secondary/30 transition-colors cursor-pointer"
                    >
                      {/* The Name column yields width to the others and
                          truncates; the details open from the row keep the
                          full name (CAN-4258). */}
                      <td className="w-full min-w-40 max-w-0 px-4 py-3">
                        <div className="flex items-start gap-2.5">
                          <McpRowLogo
                            curatedKey={server.curatedKey}
                            logoUrl={server.logoUrl}
                            name={server.name}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 items-baseline gap-1.5">
                              <span className="truncate fg-primary font-medium">
                                {server.name}
                              </span>
                              {server.accountConnection &&
                                server.accountConnection.configId !==
                                  'default' && (
                                  // One row per connection (REG-3033): a second
                                  // configuration of the same provider names
                                  // itself beside the shared display name.
                                  <span
                                    className="shrink-0 text-xs fg-secondary"
                                    data-testid="mcp-account-config"
                                  >
                                    {server.configs[0]?.name ??
                                      server.accountConnection.configId}
                                  </span>
                                )}
                            </div>
                            {accountEnabled && (
                              <div className="mt-1">
                                <McpTierBadge
                                  row={server}
                                  desktopOnly={rowDesktopOnly(server)}
                                  providers={
                                    statuses.get(server.id)?.handler ===
                                    'provider'
                                      ? curatedEntries.find(
                                          (entry): boolean =>
                                            entry.key === server.curatedKey,
                                        )?.providerConnector?.providers
                                      : undefined
                                  }
                                />
                              </div>
                            )}
                            {subtitle && (
                              <p className="text-xs fg-secondary mt-0.5 line-clamp-1">
                                {subtitle}
                              </p>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className="rounded bg-secondary px-1.5 py-0.5 text-3xs font-medium fg-secondary">
                          {server.type}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {accountEnabled && server.accountConnection ? (
                          <span data-testid="mcp-account-status">
                            {server.accountConnection.status === 'CONNECTED'
                              ? 'Connected'
                              : server.accountConnection.status ===
                                  'REAUTH_REQUIRED'
                                ? 'Reconnect'
                                : server.accountConnection.status === 'PENDING'
                                  ? 'Waiting for browser'
                                  : 'Not connected'}
                          </span>
                        ) : (
                          <McpStatusCell
                            entry={statuses.get(server.id)}
                            connecting={connectingServerId === server.id}
                            onConnect={(): void => void handleConnect(server)}
                          />
                        )}
                      </td>
                      <td className="px-4 py-3 fg-secondary">
                        {server.updatedAt
                          ? formatDate(server.updatedAt)
                          : '\u2014'}
                      </td>
                      <td
                        className="px-4 py-3"
                        onClick={(event): void => event.stopPropagation()}
                      >
                        {/* Actions wrap onto further lines instead of
                            widening the table (CAN-4258). */}
                        <div className="flex flex-wrap items-center justify-end gap-1.5">
                          {accountEnabled &&
                            accountConnectionsAvailable &&
                            (!customAccountMcpPromotable(server) ||
                              customRowPromotable(server)) &&
                            (!rowDesktopOnly(server) ||
                              accountMcpConnectionLive(server)) && (
                              // A desktop-only server never connects through
                              // the cloud account, but a connection made before
                              // it was marked keeps its Disconnect (REG-3035).
                              <AccountMcpControls
                                row={server}
                                actions={accountActions}
                                connectable={!rowDesktopOnly(server)}
                                onConnect={(): void =>
                                  connectAccountRow(server)
                                }
                              />
                            )}
                          {accountEnabled &&
                            server.deviceCopies
                              ?.filter(
                                (device): boolean =>
                                  server.accountConnection?.kind !== 'CUSTOM' ||
                                  device !== editableAccountCopy(server),
                              )
                              .map(
                                (device): JSX.Element => (
                                  <Button
                                    key={device.id}
                                    size="sm"
                                    variant="ghost"
                                    className="whitespace-nowrap"
                                    data-testid="mcp-device-copy"
                                    onClick={(): void =>
                                      setDialogServerId(device.id)
                                    }
                                  >
                                    Device copy
                                  </Button>
                                ),
                              )}
                          {accountEnabled && server.accountConnection ? (
                            <>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="whitespace-nowrap"
                                data-testid="mcp-account-details-button"
                                onClick={(): void =>
                                  setAccountDetails(
                                    server.accountConnectionId ?? server.id,
                                  )
                                }
                              >
                                Details
                              </Button>
                              {server.accountConnection.kind === 'CUSTOM' && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="whitespace-nowrap"
                                  data-testid="mcp-account-edit-button"
                                  onClick={(): void =>
                                    openAccountEditor(server)
                                  }
                                >
                                  Edit
                                </Button>
                              )}
                            </>
                          ) : (
                            <Tooltip label="Edit server">
                              <button
                                type="button"
                                onClick={(e): void => {
                                  e.stopPropagation();
                                  setDialogServerId(server.id);
                                }}
                                aria-label="Edit server"
                                data-testid="mcp-server-edit-button"
                                className="focus-ring rounded p-1 fg-secondary hover:fg-primary hover:bg-secondary transition-colors"
                              >
                                <AppCatalogDocumentPencilIcon
                                  width="14"
                                  height="14"
                                />
                              </button>
                            </Tooltip>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </McpTableScrollRegion>
      )}

      {/* Empty state */}
      {!loading && servers.length === 0 && !error && (
        <EmptyState
          title="No MCP servers registered"
          subtitle="Register an MCP server to extend agent capabilities"
        />
      )}

      {/* Browse dialog */}
      {browseOpen && (
        <McpBrowseDialog
          entries={curatedEntries}
          installedServers={servers}
          onClose={() => setBrowseOpen(false)}
          onAdd={handleBrowseAdd}
        />
      )}

      {accountEnabled && detailsConnection && (
        <AccountMcpDetails
          key={detailsConnection.id}
          connection={detailsConnection}
          onClose={(): void => setAccountDetails(null)}
          onSaved={handleSaved}
        />
      )}
      {credentialPrompt && (
        <AccountMcpCredentialDialog
          key={`${credentialPrompt.kind}:${credentialPrompt.target.id}`}
          kind={credentialPrompt.kind}
          displayName={credentialPrompt.target.displayName}
          {...(credentialPrompt.intro ? { intro: credentialPrompt.intro } : {})}
          {...(credentialPrompt.clientSetup
            ? { clientSetup: credentialPrompt.clientSetup }
            : {})}
          onSubmit={(credential): void => {
            const { id, serverKey, configId } = credentialPrompt.target;
            const expectedAccountId = dialogAccountId.current;
            closeDialog();
            if (!expectedAccountId) {
              setSetupError(
                new AccountMcpConnectionError('account-changed').message,
              );
              return;
            }
            void accountActions.connect(serverKey, configId, {
              ...credential,
              expectedAccountId,
              // The server may still want more than this prompt collected,
              // such as a secret, or an access token instead.
              onOAuthClientRequired: (clientSetup): void =>
                promptForOAuthClient(
                  curatedEntries.find(
                    (entry): boolean => entry.key === serverKey,
                  ),
                  servers.find(
                    (row): boolean => row.accountConnection?.id === id,
                  )?.accountConnection,
                  configId,
                  clientSetup,
                ),
            });
          }}
          onClose={closeDialog}
        />
      )}
      {promoteRow && (
        <McpPromoteDialog
          key={promoteRow.id}
          serverId={promoteRow.id}
          serverName={promoteRow.name}
          onClose={closeDialog}
          onConfirm={(bearerToken): void => {
            const row = promoteRow;
            const expectedAccountId = dialogAccountId.current;
            closeDialog();
            if (!expectedAccountId) {
              setSetupError(
                new AccountMcpConnectionError('account-changed').message,
              );
              return;
            }
            void promoteCustomRow(row, { bearerToken, expectedAccountId });
          }}
        />
      )}
      {promotionTokenPrompt && (
        <AccountMcpCredentialDialog
          key={`promote:${promotionTokenPrompt.row.id}`}
          kind="bearer"
          intro={CLOUD_REGISTRATION_UNAVAILABLE}
          displayName={promotionTokenPrompt.row.name}
          onSubmit={(credential): void => {
            const { row } = promotionTokenPrompt;
            const expectedAccountId = dialogAccountId.current;
            closeDialog();
            if (!expectedAccountId) {
              setSetupError(
                new AccountMcpConnectionError('account-changed').message,
              );
              return;
            }
            if ('bearerToken' in credential)
              void promoteCustomRow(row, {
                bearerToken: credential.bearerToken,
                expectedAccountId,
              });
          }}
          onClose={closeDialog}
        />
      )}
      {/* Add / edit dialog */}
      {dialogServerId !== null && (
        <McpServerDialog
          key={`${dialogMode}:${dialogServerId}:${dialogCurated?.key ?? ''}:${dialogAccountConnection?.id ?? ''}`}
          serverId={dialogServerId || null}
          accountConnection={dialogAccountConnection}
          initialCurated={dialogCurated}
          {...(dialogOAuthClient
            ? {
                requiresOAuthClient: true,
                ...(dialogOAuthClient.clientSetup
                  ? { clientSetup: dialogOAuthClient.clientSetup }
                  : {}),
                ...(dialogOAuthClient.endpointUrl
                  ? { initialEndpointUrl: dialogOAuthClient.endpointUrl }
                  : {}),
              }
            : {})}
          mode={dialogMode}
          onAccountConnect={(options): void => {
            if (!dialogCurated) return;
            const entry = dialogCurated;
            const configId = dialogAccountConfigId;
            const expectedAccountId = dialogAccountId.current;
            closeDialog();
            if (!expectedAccountId) {
              setSetupError(
                new AccountMcpConnectionError('account-changed').message,
              );
              return;
            }
            void accountActions.connect(entry.key, configId, {
              ...options,
              expectedAccountId,
              // Setup reopens for the user's own app, or the secret it lacked,
              // on the endpoint this attempt chose.
              onOAuthClientRequired: (clientSetup): void =>
                promptForOAuthClient(
                  entry,
                  undefined,
                  configId,
                  clientSetup,
                  options.endpointUrl,
                ),
            });
          }}
          curatedEntries={curatedEntries}
          onClose={closeDialog}
          onSaved={handleSaved}
        />
      )}
    </>
  );
}
