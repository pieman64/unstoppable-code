'use client';

import { Fragment, type JSX, type ReactNode } from 'react';
import { Fact, FactList } from '@canopy/ui-shared/components';
import type { PortalMcpServerDetail } from '@canopy/protocol/portal';
import { Button, StatusLabel } from '@canopy/ui-shared/components';

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

      <FactList rowGap="2" labelTone="secondary">
        <Fact label="Transport">
          {server.type === 'http' ? 'HTTP' : 'Command (stdio)'}
        </Fact>
        {endpoint && (
          <>
            <Fact
              label="Endpoint"
              fit="break-all"
              mono
              dataTestId="mcp-server-read-endpoint"
            >
              {endpoint}
            </Fact>
          </>
        )}
        {server.argCount !== undefined && (
          <>
            <Fact label="Arguments">{server.argCount}</Fact>
          </>
        )}
        {server.headerNames && server.headerNames.length > 0 && (
          <>
            <Fact label="Headers">{server.headerNames.join(', ')}</Fact>
          </>
        )}
        {server.httpAuthHandler !== undefined && (
          <>
            <Fact label="Auth handling">
              {server.httpAuthHandler === 'canopy'
                ? appAuthHandlerLabel
                : 'Provider'}
            </Fact>
          </>
        )}
        {server.oauth && (
          <>
            <Fact
              label={<span className="font-medium fg-primary">OAuth</span>}
              labelTestId="mcp-server-read-oauth"
            />
            <Fact label="Client ID">
              {server.oauth.hasClientId ? 'configured' : 'not configured'}
            </Fact>
            <Fact label="Client secret">
              {server.oauth.hasClientSecret ? 'configured' : 'not configured'}
            </Fact>
            {server.oauth.authorizationUrl !== undefined && (
              <>
                <Fact label="Authorization URL" fit="break-all" mono>
                  {server.oauth.authorizationUrl}
                </Fact>
              </>
            )}
            {server.oauth.tokenUrl !== undefined && (
              <>
                <Fact label="Token URL" fit="break-all" mono>
                  {server.oauth.tokenUrl}
                </Fact>
              </>
            )}
            {server.oauth.scopes !== undefined &&
              server.oauth.scopes.length > 0 && (
                <>
                  <Fact label="Scopes">{server.oauth.scopes.join(', ')}</Fact>
                </>
              )}
            {server.oauth.audience !== undefined && (
              <>
                <Fact label="Audience">{server.oauth.audience}</Fact>
              </>
            )}
          </>
        )}
      </FactList>

      {server.curated !== undefined && (
        <section data-testid="mcp-server-read-curated">
          <h4 className="mb-2 text-xs font-medium fg-primary">
            Curated catalog
          </h4>
          <FactList rowGap="2" labelTone="secondary">
            <Fact label="Catalog key">{server.curated.key}</Fact>
            {server.curated.authorName !== undefined && (
              <>
                <Fact label="Author">
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
                </Fact>
              </>
            )}
            {[
              ['Docs', server.curated.docsUrl],
              ['Support', server.curated.supportUrl],
              ['Privacy policy', server.curated.privacyPolicyUrl],
            ].map(([label, href]) =>
              href === undefined ? null : (
                <Fragment key={label}>
                  <Fact label={label}>
                    <a
                      href={href}
                      target="_blank"
                      rel="noreferrer"
                      className="fg-accent hover:underline"
                    >
                      {href}
                    </a>
                  </Fact>
                </Fragment>
              ),
            )}
            {server.curated.requiresProviderAuth === true && (
              <>
                <Fact label="Provider auth">Required</Fact>
              </>
            )}
          </FactList>
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
                            feedback.tone === 'error' ? '' : 'fg-secondary'
                          }`}
                        >
                          {feedback.tone === 'error' ? (
                            <StatusLabel>{feedback.message}</StatusLabel>
                          ) : (
                            feedback.message
                          )}
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
