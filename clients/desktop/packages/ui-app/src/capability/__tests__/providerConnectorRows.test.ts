import type { CuratedMcpServerEntry } from '@canopy/protocol/mcp-catalog';
import type { ProviderConnectorListResult } from '@canopy/protocol/mcp-servers';
import { buildProviderConnectorRows } from '../providerConnectorRows';

/** Minimal curated entry; only the fields this module reads matter. */
function entry(
  name: string,
  providerConnector: CuratedMcpServerEntry['providerConnector'],
): CuratedMcpServerEntry {
  return {
    key: name.toLowerCase().replace(/\s+/g, '-'),
    name,
    shortDescription: '',
    url: 'https://example.test/mcp',
    transport: 'http',
    categories: [],
    popular: false,
    sortOrder: 0,
    updatedAt: '2026-08-27T00:00:00.000Z',
    ...(providerConnector ? { providerConnector } : {}),
  };
}

/**
 * What the served catalog advertises. There is no bundled fallback, so every
 * test that expects rows has to supply this — which is the point: the catalog
 * is the only source.
 */
const CATALOG: CuratedMcpServerEntry[] = [
  entry('Gmail', { providers: ['claude', 'codex'] }),
  entry('Google Drive', { providers: ['claude', 'codex'] }),
  entry('Google Calendar', { providers: ['claude', 'codex'] }),
];

const EMPTY_BOTH: ProviderConnectorListResult[] = [
  { provider: 'claude', connectors: [] },
  { provider: 'codex', connectors: [] },
];

describe('buildProviderConnectorRows', () => {
  it('advertises the catalog even when nothing is linked anywhere', () => {
    // The whole question this surface answers is "can I connect Gmail?" — an
    // empty panel answers it wrongly, and Claude Code exposes no catalog of
    // installable connectors to fall back on.
    const rows = buildProviderConnectorRows(EMPTY_BOTH, CATALOG);
    expect(rows.map((r) => r.displayName)).toEqual([
      'Gmail',
      'Google Drive',
      'Google Calendar',
    ]);
    expect(rows.every((r) => r.providers.every((p) => !p.connected))).toBe(
      true,
    );
  });

  it('offers both providers as routes for the same connector', () => {
    const [gmail] = buildProviderConnectorRows(EMPTY_BOTH, CATALOG);
    expect(gmail?.providers.map((p) => p.provider)).toEqual([
      'claude',
      'codex',
    ]);
  });

  it('marks only the provider that actually has it linked', () => {
    const rows = buildProviderConnectorRows(
      [
        { provider: 'claude', connectors: [] },
        {
          provider: 'codex',
          connectors: [
            {
              displayName: 'Gmail',
              connected: true,
              installUrl: 'https://chatgpt.com/apps/gmail/connector_2128aeb',
            },
          ],
        },
      ],
      CATALOG,
    );
    const gmail = rows.find((r) => r.displayName === 'Gmail');
    expect(
      gmail?.providers.find((p) => p.provider === 'codex')?.connected,
    ).toBe(true);
    expect(
      gmail?.providers.find((p) => p.provider === 'claude')?.connected,
    ).toBe(false);
  });

  it('carries the per-app install URL so Connect can deep-link', () => {
    const rows = buildProviderConnectorRows(
      [
        {
          provider: 'codex',
          connectors: [
            {
              displayName: 'Google Drive',
              connected: false,
              installUrl: 'https://chatgpt.com/apps/google-drive/connector_5f3',
            },
          ],
        },
      ],
      CATALOG,
    );
    const drive = rows.find((r) => r.displayName === 'Google Drive');
    const codex = drive?.providers.find((p) => p.provider === 'codex');
    expect(codex?.installUrl).toContain('google-drive');
  });

  it('flags an unreadable provider instead of offering it as a route', () => {
    // Sending the user to link something that still would not appear is worse
    // than telling them the provider could not be read.
    const rows = buildProviderConnectorRows(
      [
        {
          provider: 'claude',
          connectors: [],
          unavailableReason: 'api-key-precedence',
          detail: 'ANTHROPIC_API_KEY takes precedence.',
        },
        { provider: 'codex', connectors: [] },
      ],
      CATALOG,
    );
    const gmail = rows[0];
    expect(
      gmail?.providers.find((p) => p.provider === 'claude')?.unavailable,
    ).toContain('ANTHROPIC_API_KEY');
    expect(
      gmail?.providers.find((p) => p.provider === 'codex')?.unavailable,
    ).toBeUndefined();
  });

  it('keeps a linked connector Canopy does not advertise', () => {
    const rows = buildProviderConnectorRows(
      [
        {
          provider: 'claude',
          connectors: [
            {
              displayName: 'Notion',
              connected: true,
            },
          ],
        },
      ],
      CATALOG,
    );
    expect(rows.map((r) => r.displayName)).toContain('Notion');
    // Derived, so adding or removing an advertised connector does not turn
    // this into a failing magic number.
    expect(rows).toHaveLength(CATALOG.length + 1);
  });

  it('marks a provider that has not answered as pending, not absent', () => {
    // Dropping it made the row shrink and, when no provider had answered, made
    // the row vanish entirely from the first paint — which is what let the
    // provider's own marketplace plugin render in its place and then swap.
    // Rendering it as pending keeps the row stable and claims nothing.
    const rows = buildProviderConnectorRows(
      [{ provider: 'codex', connectors: [] }],
      CATALOG,
    );
    const providers = rows[0]?.providers ?? [];
    expect(providers.map((p) => p.provider)).toEqual(['claude', 'codex']);
    expect(providers.find((p) => p.provider === 'claude')?.pending).toBe(true);
    expect(
      providers.find((p) => p.provider === 'codex')?.pending,
    ).toBeUndefined();
  });
});

describe('buildProviderConnectorRows with a served catalog', () => {
  it('advertises what the catalog configures instead of the bundled list', () => {
    // The point of serving it: adding Slack is a hub change, not a release.
    const rows = buildProviderConnectorRows(EMPTY_BOTH, [
      entry('Slack', { providers: ['claude', 'codex'] }),
    ]);
    expect(rows.map((r) => r.displayName)).toEqual(['Slack']);
  });

  it('offers only the providers the catalog names', () => {
    // Catalogs genuinely differ — Codex has no Unstoppable Domains app — so
    // offering Codex there would send the user somewhere with nothing to link.
    const rows = buildProviderConnectorRows(EMPTY_BOTH, [
      entry('Unstoppable Domains', { providers: ['claude'] }),
    ]);
    expect(rows[0]?.providers.map((p) => p.provider)).toEqual(['claude']);
  });

  it('matches a Claude connector under its account-side name', () => {
    // Claude reports by display string and publishes no catalog to look names
    // up in, so a differing name would silently never match.
    const rows = buildProviderConnectorRows(
      [
        {
          provider: 'claude',
          connectors: [
            {
              displayName: 'Unstoppable Domains (Staging)',
              connected: true,
            },
          ],
        },
      ],
      [
        entry('Unstoppable Domains', {
          providers: ['claude'],
          claudeConnectorName: 'Unstoppable Domains (Staging)',
        }),
      ],
    );
    expect(rows[0]?.displayName).toBe('Unstoppable Domains');
    expect(rows[0]?.providers[0]?.connected).toBe(true);
  });

  it('advertises nothing when no entry is configured as a connector', () => {
    // There is deliberately no bundled fallback. A catalog that is cold,
    // unreachable, or simply has no connector ticked hides connectors the same
    // way it already hides every other curated entry — rather than showing a
    // compiled-in list as the only visible capability, which is what the
    // fallback used to do.
    const rows = buildProviderConnectorRows(EMPTY_BOTH, [
      entry('Some Other Server', undefined),
    ]);
    expect(rows).toEqual([]);
  });

  it('honours an explicit empty provider list', () => {
    // "Advertise but offer no route" is a real state — a connector we list but
    // neither provider can supply yet.
    const rows = buildProviderConnectorRows(EMPTY_BOTH, [
      entry('Coming Soon', { providers: [] }),
    ]);
    expect(rows[0]?.displayName).toBe('Coming Soon');
    expect(rows[0]?.providers).toEqual([]);
  });
});

describe('buildProviderConnectorRows — alternate routes', () => {
  it('marks a capability the provider already serves another way', () => {
    const rows = buildProviderConnectorRows(
      [
        {
          provider: 'claude',
          connectors: [],
          alternateRoutes: [
            { normalizedName: 'gmail', serverName: 'plugin:gmail:gmail' },
          ],
        },
      ],
      CATALOG,
    );
    const gmail = rows.find((row) => row.displayName === 'Gmail');
    expect(gmail?.providers[0]?.alternateRoute).toBe('plugin:gmail:gmail');
    expect(gmail?.providers[0]?.connected).toBe(false);
  });

  it('leaves an unrelated connector alone', () => {
    const rows = buildProviderConnectorRows(
      [
        {
          provider: 'claude',
          connectors: [],
          alternateRoutes: [
            { normalizedName: 'gmail', serverName: 'plugin:gmail:gmail' },
          ],
        },
      ],
      CATALOG,
    );
    const drive = rows.find((row) => row.displayName === 'Google Drive');
    expect(drive?.providers[0]?.alternateRoute).toBeUndefined();
  });

  it('prefers a real connector over an alternate route', () => {
    // The connector is the route this surface manages; reporting "available
    // some other way" over a live connection misstates which one is in play.
    const rows = buildProviderConnectorRows(
      [
        {
          provider: 'claude',
          connectors: [
            {
              displayName: 'Gmail',
              connected: true,
            },
          ],
          alternateRoutes: [
            { normalizedName: 'gmail', serverName: 'plugin:gmail:gmail' },
          ],
        },
      ],
      CATALOG,
    );
    const gmail = rows.find((row) => row.displayName === 'Gmail');
    expect(gmail?.providers[0]?.connected).toBe(true);
    expect(gmail?.providers[0]?.alternateRoute).toBeUndefined();
  });
});

describe('buildProviderConnectorRows — snapshot staleness', () => {
  it('qualifies a not-connected answer that came from a snapshot', () => {
    // Codex reads a cache only Codex writes; neither apps/list (unimplemented
    // by the bundled app-server) nor thread/start refreshes it. A not-linked
    // answer may simply predate the user linking.
    const rows = buildProviderConnectorRows(
      [
        {
          provider: 'codex',
          connectors: [
            {
              displayName: 'Slack',
              connected: false,
            },
          ],
          snapshotAt: '2026-08-24T09:51:37.000Z',
        },
      ],
      CATALOG,
    );
    const slack = rows.find((row) => row.displayName === 'Slack');
    expect(slack?.providers[0]?.staleSince).toBe('2026-08-24T09:51:37.000Z');
  });

  it('does not qualify a positive', () => {
    // A recorded link is trustworthy; only the negative is ambiguous.
    const rows = buildProviderConnectorRows(
      [
        {
          provider: 'codex',
          connectors: [
            {
              displayName: 'Slack',
              connected: true,
            },
          ],
          snapshotAt: '2026-08-24T09:51:37.000Z',
        },
      ],
      CATALOG,
    );
    const slack = rows.find((row) => row.displayName === 'Slack');
    expect(slack?.providers[0]?.connected).toBe(true);
    expect(slack?.providers[0]?.staleSince).toBeUndefined();
  });

  it('leaves a live-read provider unqualified', () => {
    // Claude is read from the CLI on demand, so its answer is current.
    const rows = buildProviderConnectorRows(
      [{ provider: 'claude', connectors: [] }],
      CATALOG,
    );
    expect(rows[0]?.providers[0]?.staleSince).toBeUndefined();
  });
});

describe('claudeConnectorName aliasing', () => {
  it('does not append the same connector twice under its account-side name', () => {
    // The "append connectors the catalog did not describe" pass compares
    // against catalog display names, but a Claude connector is matched by
    // `claudeConnectorName`. When they differ the connector fails to recognise
    // itself and is appended again — a duplicate tile in the Plugins list and a
    // duplicate row in the detail panel, in exactly the case the alias exists
    // to support.
    const rows = buildProviderConnectorRows(
      [
        {
          provider: 'claude',
          connectors: [
            {
              displayName: 'Gmail (Work)',
              connected: true,
            },
          ],
        },
      ],
      [
        entry('Gmail', {
          providers: ['claude'],
          claudeConnectorName: 'Gmail (Work)',
        }),
      ],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.displayName).toBe('Gmail');
    expect(rows[0]?.providers[0]?.connected).toBe(true);
  });
});
