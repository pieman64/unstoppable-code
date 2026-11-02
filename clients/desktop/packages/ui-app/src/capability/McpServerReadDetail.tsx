'use client';

import { Fragment, type JSX, type ReactNode } from 'react';
import type { PortalMcpServerDetail } from '@canopy/protocol/portal';
import { Button } from '@canopy/ui-shared/components';

export interface McpServerReadDetailProps {
  statusSection?: ReactNode;
  /** Credential-free portal projection. Raw MCP definitions are forbidden. */
  server: PortalMcpServerDetail;
  /** Host-owned label for app-managed HTTP auth. */
  appAuthHandlerLabel?: string;
  onConfigure?: () => void;
  onToggleConfig?: (configId: string, enabled: boolean) => void;
  configToggleFeedback?: Readonly<
    Record<
      string,
      { pending?: boolean; message?: string; tone?: 'error' | 'muted' }
    >
  >;
}

/**
 * The extra-headers part of a config's summary line, with its leading
 * separator. Account servers report presence only (names stay in the
 * cloud); with no presence reported, it makes no claim at all.
 */
function extraHeadersSummary(
  server: PortalMcpServerDetail,
  config: PortalMcpServerDetail['configs'][number],
): string {
  if (config.hasExtraHeaders === true) return ' · Extra headers configured';
  if (server.scope === 'account' && config.hasExtraHeaders === undefined)
    return '';
  return ` · Extra headers: ${
    config.extraHeaderNames.length > 0
      ? config.extraHeaderNames.join(', ')
      : 'none'
  }`;
}

export function McpServerReadDetail({
  server,
  appAuthHandlerLabel = 'App',
  onConfigure,
  onToggleConfig,
  configToggleFeedback,
  statusSection,
}: McpServerReadDetailProps): JSX.Element {
  const endpoint = server.type === 'http' ? server.url : server.command;
  return (
    <div
      className="flex flex-1 min-h-0 flex-col gap-4 overflow-y-auto px-5 pb-5"
      data-testid="mcp-server-read-detail"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold fg-primary">{server.name}</h3>
          {server.description && (
            <p className="mt-1 text-sm fg-secondary">{server.description}</p>
          )}
          <p className="mt-1 text-xs fg-secondary">
            {server.type === 'http' ? 'HTTP' : 'Command (stdio)'}
            {server.updatedAt ? ` · Updated ${server.updatedAt}` : null}
          </p>
        </div>
        {onConfigure && (
          <Button
            type="button"
            size="compact"
            onClick={onConfigure}
            data-testid="mcp-server-read-configure"
          >
            Configure
          </Button>
        )}
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
        <dt className="fg-secondary">Transport</dt>
        <dd className="fg-primary">
          {server.type === 'http' ? 'HTTP' : 'Command (stdio)'}
        </dd>
        {endpoint && (
          <>
            <dt className="fg-secondary">Endpoint</dt>
            <dd
              className="break-all font-mono fg-primary"
              data-testid="mcp-server-read-endpoint"
            >
              {endpoint}
            </dd>
          </>
        )}
        {server.argCount !== undefined && (
          <>
            <dt className="fg-secondary">Arguments</dt>
            <dd className="fg-primary">{server.argCount}</dd>
          </>
        )}
        {server.headerNames && server.headerNames.length > 0 && (
          <>
            <dt className="fg-secondary">Headers</dt>
            <dd className="fg-primary">{server.headerNames.join(', ')}</dd>
          </>
        )}
        {server.httpAuthHandler !== undefined && (
          <>
            <dt className="fg-secondary">Auth handling</dt>
            <dd className="fg-primary">
              {server.httpAuthHandler === 'canopy'
                ? appAuthHandlerLabel
                : 'Provider'}
            </dd>
          </>
        )}
        {server.oauth && (
          <>
            <dt
              className="font-medium fg-primary"
              data-testid="mcp-server-read-oauth"
            >
              OAuth
            </dt>
            <dd />
            <dt className="fg-secondary">Client ID</dt>
            <dd className="fg-primary">
              {server.oauth.hasClientId ? 'configured' : 'not configured'}
            </dd>
            <dt className="fg-secondary">Client secret</dt>
            <dd className="fg-primary">
              {server.oauth.hasClientSecret ? 'configured' : 'not configured'}
            </dd>
            {server.oauth.authorizationUrl !== undefined && (
              <>
                <dt className="fg-secondary">Authorization URL</dt>
                <dd className="break-all font-mono fg-primary">
                  {server.oauth.authorizationUrl}
                </dd>
              </>
            )}
            {server.oauth.tokenUrl !== undefined && (
              <>
                <dt className="fg-secondary">Token URL</dt>
                <dd className="break-all font-mono fg-primary">
                  {server.oauth.tokenUrl}
                </dd>
              </>
            )}
            {server.oauth.scopes !== undefined &&
              server.oauth.scopes.length > 0 && (
                <>
                  <dt className="fg-secondary">Scopes</dt>
                  <dd className="fg-primary">
                    {server.oauth.scopes.join(', ')}
                  </dd>
                </>
              )}
            {server.oauth.audience !== undefined && (
              <>
                <dt className="fg-secondary">Audience</dt>
                <dd className="fg-primary">{server.oauth.audience}</dd>
              </>
            )}
          </>
        )}
      </dl>

      {server.curated !== undefined && (
        <section data-testid="mcp-server-read-curated">
          <h4 className="mb-2 text-xs font-medium fg-primary">
            Curated catalog
          </h4>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
            <dt className="fg-secondary">Catalog key</dt>
            <dd className="fg-primary">{server.curated.key}</dd>
            {server.curated.authorName !== undefined && (
              <>
                <dt className="fg-secondary">Author</dt>
                <dd className="fg-primary">
                  {server.curated.authorUrl !== undefined ? (
                    <a
                      href={server.curated.authorUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="fg-accent hover:underline"
                    >
                      {server.curated.authorName}
                    </a>
                  ) : (
                    server.curated.authorName
                  )}
                </dd>
              </>
            )}
            {[
              ['Docs', server.curated.docsUrl],
              ['Support', server.curated.supportUrl],
              ['Privacy policy', server.curated.privacyPolicyUrl],
            ].map(([label, href]) =>
              href === undefined ? null : (
                <Fragment key={label}>
                  <dt className="fg-secondary">{label}</dt>
                  <dd className="fg-primary">
                    <a
                      href={href}
                      target="_blank"
                      rel="noreferrer"
                      className="fg-accent hover:underline"
                    >
                      {href}
                    </a>
                  </dd>
                </Fragment>
              ),
            )}
            {server.curated.requiresProviderAuth === true && (
              <>
                <dt className="fg-secondary">Provider auth</dt>
                <dd className="fg-primary">Required</dd>
              </>
            )}
          </dl>
        </section>
      )}

      {statusSection}
      <section aria-labelledby="mcp-server-configs-heading">
        <h4
          id="mcp-server-configs-heading"
          className="mb-2 text-xs font-medium fg-primary"
        >
          Configurations
        </h4>
        {server.configs.length === 0 ? (
          <p className="text-xs fg-secondary">No configurations.</p>
        ) : (
          <div className="space-y-2">
            {server.configs.map((config) => {
              const feedback = configToggleFeedback?.[config.id];
              return (
                <div
                  key={config.id}
                  className="flex items-start justify-between gap-3 rounded-lg border bg-secondary/20 p-3"
                  data-testid="mcp-server-read-config"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium fg-primary">
                      {config.name}
                    </p>
                    {config.description && (
                      <p className="mt-0.5 text-xs fg-secondary">
                        {config.description}
                      </p>
                    )}
                    <p className="mt-1 text-2xs fg-secondary">
                      Environment variables:{' '}
                      {config.envVarNames.length > 0
                        ? config.envVarNames.join(', ')
                        : 'none'}{' '}
                      · {config.extraArgCount} extra arguments
                      {extraHeadersSummary(server, config)}
                      {' · '}token{' '}
                      {config.hasAuthToken ? 'configured' : 'not configured'}
                    </p>
                  </div>
                  {statusSection ? null : onToggleConfig ? (
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={config.enabled}
                        aria-label={`${config.enabled ? 'Disable' : 'Enable'} ${config.name}`}
                        onClick={() =>
                          onToggleConfig(config.id, !config.enabled)
                        }
                        disabled={feedback?.pending === true}
                        data-testid="mcp-server-read-config-toggle"
                        className="focus-ring rounded-md border px-2 py-1 text-xs fg-primary disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {feedback?.pending === true
                          ? 'Saving…'
                          : config.enabled
                            ? 'Enabled'
                            : 'Disabled'}
                      </button>
                      {feedback?.message && (
                        <span
                          role="status"
                          data-testid="mcp-server-read-config-feedback"
                          className={`max-w-52 text-right text-3xs ${
                            feedback.tone === 'error'
                              ? 'fg-destructive'
                              : 'fg-secondary'
                          }`}
                        >
                          {feedback.message}
                        </span>
                      )}
                    </div>
                  ) : (
                    <span className="shrink-0 text-xs fg-secondary">
                      {config.enabled ? 'Enabled' : 'Disabled'}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
