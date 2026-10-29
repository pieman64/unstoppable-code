import type { AdvertisedConnector } from '../mcp/provider-connectors';
import { PROVIDER_CONNECTOR_MANAGE_URLS } from '../mcp/provider-connectors';
import { normalizeCapabilityName } from '@canopy/desktop-shared/lib/normalize-capability-name';
import {
  parseClaudeAlternateRoutes,
  parseClaudeConnectorList,
  parseCodexDirectory,
  parseCodexLinkedApps,
} from '../mcp/provider-connectors';

/**
 * Captured from `claude mcp list` on a real machine. Account connectors and
 * locally-added servers share one list and are only distinguishable by the
 * `claude.ai ` prefix, which is the whole reason this parser exists.
 */
const REAL_OUTPUT = `Checking MCP server health…

plugin:slack:slack: https://mcp.slack.com/mcp (HTTP) - ✔ Connected
unstoppable-domains: https://api.unstoppabledomains.com/mcp/v1/ (HTTP) - ! Needs authentication
claude.ai Gmail: https://mcp.anthropic.com/gmail (HTTP) - ✔ Connected
claude.ai Google Drive: https://mcp.anthropic.com/gdrive (HTTP) - ✔ Connected
claude.ai Google Calendar: https://mcp.anthropic.com/gcal (HTTP) - ! Needs authentication
slack: https://slack-mcp.anthropic.com/mcp (HTTP) - ✘ Failed to connect — ENOTFOUND
linear: https://mcp.linear.app/mcp (HTTP) - ✔ Connected
`;

describe('parseClaudeConnectorList', () => {
  it('returns only the account connectors', () => {
    const connectors = parseClaudeConnectorList(REAL_OUTPUT);
    expect(connectors.map((c) => c.displayName)).toEqual([
      'Gmail',
      'Google Drive',
      'Google Calendar',
    ]);
  });

  it('keeps the provider-qualified name for CLI round-trips', () => {
    const [gmail] = parseClaudeConnectorList(REAL_OUTPUT);
    expect(gmail?.name).toBe('claude.ai Gmail');
  });

  it('does not read "Not connected" as connected', () => {
    // `\bconnected\b` matched it. Of the two directions this can be wrong,
    // reporting an unlinked connector as linked is the one that silently
    // leaves the user with no working tools and no prompt to fix it.
    const parsed = parseClaudeConnectorList(
      'claude.ai Gmail: https://example.test/mcp - ✘ Not connected\n',
    );
    expect(parsed[0]?.connected).toBe(false);
  });

  it('treats only an explicit success as connected', () => {
    // A needs-authentication connector reading as ready is exactly the
    // ambiguity this surface exists to remove.
    const byName = new Map(
      parseClaudeConnectorList(REAL_OUTPUT).map((c) => [c.displayName, c]),
    );
    expect(byName.get('Gmail')?.connected).toBe(true);
    expect(byName.get('Google Calendar')?.connected).toBe(false);
    expect(byName.get('Google Calendar')?.status).toContain(
      'Needs authentication',
    );
  });

  it('ignores locally configured servers', () => {
    // Canopy manages those elsewhere; double-reporting them here would offer
    // two different Connect paths for one server.
    const names = parseClaudeConnectorList(REAL_OUTPUT).map((c) => c.name);
    expect(names).not.toContain('linear');
    expect(names).not.toContain('plugin:slack:slack');
  });

  it('returns nothing when no connectors are linked', () => {
    expect(
      parseClaudeConnectorList(
        'Checking MCP server health…\n\nlinear: x - ✔ Connected\n',
      ),
    ).toEqual([]);
  });

  it('survives output with no server lines at all', () => {
    expect(parseClaudeConnectorList('')).toEqual([]);
  });
});

/**
 * Shape captured from a real `~/.codex/cache/codex_app_directory` entry. The
 * live file carries ~3,000 apps; only the Google Workspace three are surfaced,
 * because they are the ones that would otherwise need Canopy to hold Google
 * restricted scopes.
 */
const CODEX_DIRECTORY = {
  schema_version: 1,
  connectors: [
    {
      id: 'connector_2128aebfecb84f64a069897515042a44',
      name: 'Gmail',
      installUrl:
        'https://chatgpt.com/apps/gmail/connector_2128aebfecb84f64a069897515042a44',
      isAccessible: false,
      isEnabled: true,
    },
    {
      id: 'connector_5f3c8c41a1e54ad7a76272c89e2554fa',
      name: 'Google Drive',
      installUrl:
        'https://chatgpt.com/apps/google-drive/connector_5f3c8c41a1e54ad7a76272c89e2554fa',
      isAccessible: true,
      isEnabled: true,
    },
    { id: 'connector_x', name: 'Notion', isAccessible: true, isEnabled: true },
    {
      id: 'asdk_app_69a1d78e929881919bba0dbda1f6436d',
      name: 'Slack',
      installUrl:
        'https://chatgpt.com/apps/slack/asdk_app_69a1d78e929881919bba0dbda1f6436d',
      isAccessible: false,
      isEnabled: true,
    },
    {
      id: 'connector_y',
      name: 'Google Calendar',
      isAccessible: false,
      isEnabled: false,
    },
  ],
};

/**
 * `codex_apps_tools` — the cache Codex writes with the tools it actually
 * loaded, which is the only on-disk evidence of which apps are linked.
 */
const CODEX_APPS_TOOLS = {
  schema_version: 4,
  tools: [
    {
      tool_namespace: 'codex_apps__gmail',
      connector_id: 'connector_2128aebfecb84f64a069897515042a44',
      connector_name: 'Gmail',
    },
    {
      tool_namespace: 'codex_apps__slack',
      connector_id: 'asdk_app_69a1d78e929881919bba0dbda1f6436d',
      connector_name: 'Slack',
    },
    {
      tool_namespace: 'codex_apps__sites',
      connector_id: 'connector_20205bf7d4e99a89d7154bb849718324',
      connector_name: 'Sites',
    },
  ],
};

const EMPTY_LINKED: ReadonlySet<string> = new Set();

/** What the served catalog advertises, in the tests that do not vary it. */
const ADVERTISED: readonly AdvertisedConnector[] = [
  { displayName: 'Gmail' },
  { displayName: 'Google Drive' },
  { displayName: 'Google Calendar' },
];

describe('parseCodexDirectory', () => {
  it('surfaces only the advertised connectors', () => {
    // Notion is in the directory but not advertised; Google Calendar is
    // advertised but provider-disabled in this fixture.
    expect(
      parseCodexDirectory(CODEX_DIRECTORY, EMPTY_LINKED, ADVERTISED).map(
        (c) => c.name,
      ),
    ).toEqual(['Gmail', 'Google Drive']);
  });

  it('reads linked state from the linked-app set, not the directory', () => {
    // Regression: `isAccessible` is false for every entry in a real directory
    // cache — all 3,092 of them — because that file is an anonymous catalog
    // snapshot, not account state. Keying on it reported every Codex connector
    // as unlinked no matter what the user had connected.
    const byName = new Map(
      parseCodexDirectory(
        CODEX_DIRECTORY,
        parseCodexLinkedApps(CODEX_APPS_TOOLS),
        ADVERTISED,
      ).map((c) => [c.name, c]),
    );
    expect(byName.get('Gmail')?.connected).toBe(true);
    // Directory says `isAccessible: true` for Drive and the tools cache has no
    // Drive tools; the tools cache is what counts.
    expect(byName.get('Google Drive')?.connected).toBe(false);
  });

  it('matches a linked app by id even when the display name drifts', () => {
    // The tools cache carries its own `connector_name`; only the id is a
    // stable join key across a provider-side rename.
    const linked = parseCodexLinkedApps({
      schema_version: 4,
      tools: [
        {
          tool_namespace: 'codex_apps__gmail',
          connector_id: 'connector_2128aebfecb84f64a069897515042a44',
          connector_name: 'Gmail (Project)',
        },
      ],
    });
    const byName = new Map(
      parseCodexDirectory(CODEX_DIRECTORY, linked, ADVERTISED).map((c) => [
        c.name,
        c,
      ]),
    );
    expect(byName.get('Gmail')?.connected).toBe(true);
  });

  it('treats an unreadable tools cache as nothing linked', () => {
    expect(parseCodexLinkedApps(null).size).toBe(0);
    expect(parseCodexLinkedApps({ tools: 'nope' }).size).toBe(0);
  });

  it('carries the per-app install URL so Connect can deep-link', () => {
    const [gmail] = parseCodexDirectory(
      CODEX_DIRECTORY,
      EMPTY_LINKED,
      ADVERTISED,
    );
    expect(gmail?.installUrl).toContain('chatgpt.com/apps/gmail/');
  });

  it('skips apps the provider has disabled', () => {
    // Offering Connect for a disabled app dead-ends the user.
    expect(
      parseCodexDirectory(CODEX_DIRECTORY, EMPTY_LINKED, ADVERTISED).map(
        (c) => c.name,
      ),
    ).not.toContain('Google Calendar');
  });

  it('tolerates a missing or malformed directory', () => {
    expect(parseCodexDirectory(null, EMPTY_LINKED, ADVERTISED)).toEqual([]);
    expect(parseCodexDirectory({}, EMPTY_LINKED, ADVERTISED)).toEqual([]);
    expect(
      parseCodexDirectory({ connectors: 'nope' }, EMPTY_LINKED, ADVERTISED),
    ).toEqual([]);
  });
});

describe('parseClaudeAlternateRoutes', () => {
  it('reports a capability served by a plugin rather than a connector', () => {
    // Claude serves Slack as `plugin:slack:slack`, not `claude.ai Slack`.
    // Without this a user whose Slack works is told to connect Slack.
    const routes = parseClaudeAlternateRoutes(REAL_OUTPUT);
    expect(routes.map((route) => route.serverName)).toContain(
      'plugin:slack:slack',
    );
  });

  it('normalizes a namespaced plugin server to its capability', () => {
    const routes = parseClaudeAlternateRoutes(REAL_OUTPUT);
    const slack = routes.find(
      (route) => route.serverName === 'plugin:slack:slack',
    );
    expect(slack?.normalizedName).toBe('slack');
  });

  it('never reports an account connector as an alternate route', () => {
    // Those are the primary route; double-reporting would make a connected
    // connector read as "available some other way".
    const routes = parseClaudeAlternateRoutes(REAL_OUTPUT);
    expect(
      routes.some((route) => route.serverName.startsWith('claude.ai ')),
    ).toBe(false);
  });

  it('ignores a server that is not working', () => {
    // A failed server is not a reason to stop offering the connector.
    const routes = parseClaudeAlternateRoutes(REAL_OUTPUT);
    expect(routes.map((route) => route.serverName)).not.toContain('slack');
    expect(routes.map((route) => route.serverName)).not.toContain(
      'unstoppable-domains',
    );
  });
});

describe('normalizeCapabilityName', () => {
  it('takes the last namespaced segment', () => {
    expect(normalizeCapabilityName('plugin:slack:slack')).toBe('slack');
  });

  it('strips case and punctuation so a display name can match', () => {
    expect(normalizeCapabilityName('Google Drive')).toBe('googledrive');
    expect(normalizeCapabilityName('google-drive')).toBe('googledrive');
  });

  it('stays strict enough not to claim an unrelated capability', () => {
    // Wrongly claiming the user already has something is worse than offering
    // a redundant connect.
    expect(normalizeCapabilityName('gdrive')).not.toBe(
      normalizeCapabilityName('Google Drive'),
    );
  });
});

describe('advertised connectors reach Codex', () => {
  it('surfaces whatever the served catalog advertises', () => {
    // The advertised set is served, not compiled in. A hand-kept copy in this
    // module drifted once already — a connector was advertised, not copied
    // here, and Codex reported nothing for it. Taking the names as an argument
    // removes the second list entirely rather than asking anyone to keep two
    // in sync.
    const names = parseCodexDirectory(CODEX_DIRECTORY, EMPTY_LINKED, [
      { displayName: 'Notion' },
    ]).map((c) => c.name);
    expect(names).toEqual(['Notion']);
  });

  it('carries the per-app install URL for an advertised connector', () => {
    const drive = parseCodexDirectory(CODEX_DIRECTORY, EMPTY_LINKED, [
      { displayName: 'Google Drive' },
    ]).find((c) => c.name === 'Google Drive');
    expect(drive?.installUrl).toContain('chatgpt.com/apps/google-drive/');
  });

  it('pins the app by codexConnectorId when the catalog supplies one', () => {
    // The field is documented as pinning an exact app "rather than matching on
    // a collidable name" out of a directory of thousands. It was declared,
    // copied through the normalizer, and read by nothing — so a hub operator
    // who set it got a silent no-op and the collidable name matched anyway.
    const rows = parseCodexDirectory(CODEX_DIRECTORY, EMPTY_LINKED, [
      {
        displayName: 'Whatever The Catalog Calls It',
        codexConnectorId: 'connector_2128aebfecb84f64a069897515042a44',
      },
    ]);
    expect(rows.map((c) => c.name)).toEqual(['Gmail']);
    // Keyed back to the catalog, because every downstream join uses that name.
    // Pinning the right app but emitting the provider's name would select
    // correctly and then match nothing.
    expect(rows[0]?.displayName).toBe('Whatever The Catalog Calls It');
  });

  it('reports a pinned app as linked by its id', () => {
    const rows = parseCodexDirectory(
      CODEX_DIRECTORY,
      parseCodexLinkedApps(CODEX_APPS_TOOLS),
      [
        {
          displayName: 'Gmail',
          codexConnectorId: 'connector_2128aebfecb84f64a069897515042a44',
        },
      ],
    );
    expect(rows[0]?.connected).toBe(true);
  });

  it('surfaces nothing when the catalog advertises nothing', () => {
    // With no bundled fallback, an unconfigured or unreachable catalog means
    // no connectors — the same way it already means no curated MCP servers.
    expect(parseCodexDirectory(CODEX_DIRECTORY, EMPTY_LINKED, [])).toEqual([]);
  });
});

describe('listCodexProviderConnectors', () => {
  afterEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();
  });

  it('reports a missing directory cache rather than "nothing linked"', async () => {
    // An absent cache means Codex has not run yet, not that the user has
    // connected nothing. Reporting the latter sends them to relink something
    // that was already linked.
    jest.resetModules();
    jest.doMock('node:fs/promises', () => ({
      readdir: jest.fn(() => Promise.reject(new Error('ENOENT'))),
      readFile: jest.fn(),
      stat: jest.fn(),
    }));
    const mod = await import('../mcp/provider-connectors');
    const result = await mod.listCodexProviderConnectors([
      { displayName: 'Gmail' },
    ]);

    expect(result.unavailableReason).toBe('no-directory-cache');
    expect(result.connectors).toEqual([]);
  });

  it('prefers the newest cache file and dates staleness by the tools cache', async () => {
    // Codex keys the directory by a per-account hash, so several can exist;
    // and the staleness a negative answer carries must come from the tools
    // cache it was actually derived from, not the directory, which can be
    // weeks old without that meaning anything.
    jest.resetModules();
    const directory = {
      connectors: [
        { id: 'c1', name: 'Gmail', isEnabled: true, isAccessible: false },
      ],
    };
    const tools = {
      tools: [{ connector_id: 'c1', connector_name: 'Gmail' }],
    };
    jest.doMock('node:fs/promises', () => ({
      readdir: jest.fn((dir: string) =>
        Promise.resolve(
          dir.includes('codex_apps_tools')
            ? ['tools.json']
            : ['old.json', 'new.json'],
        ),
      ),
      stat: jest.fn((file: string) =>
        Promise.resolve({
          mtimeMs: file.includes('new') || file.includes('tools') ? 2 : 1,
          mtime: new Date('2026-08-28T00:00:00.000Z'),
        }),
      ),
      readFile: jest.fn((file: string) =>
        Promise.resolve(
          JSON.stringify(file.includes('tools') ? tools : directory),
        ),
      ),
    }));
    const mod = await import('../mcp/provider-connectors');
    const result = await mod.listCodexProviderConnectors([
      { displayName: 'Gmail' },
    ]);

    expect(result.connectors).toHaveLength(1);
    // Linked, from the tools cache — the directory says `isAccessible: false`
    // for every entry it ever ships.
    expect(result.connectors[0]?.connected).toBe(true);
    expect(result.snapshotAt).toBe('2026-08-28T00:00:00.000Z');
  });

  it('drops the timestamp when the tools cache cannot be parsed', async () => {
    // `linkedAt` is assigned from `stat` before the read, so a corrupt cache
    // would otherwise leave a fresh timestamp on a state that was never read —
    // the UI showing "Status may be out of date" from seconds ago while
    // reporting nothing linked, which reads as a confident negative derived
    // from a failure.
    jest.resetModules();
    jest.doMock('node:fs/promises', () => ({
      readdir: jest.fn((dir: string) =>
        Promise.resolve(
          dir.includes('codex_apps_tools') ? ['tools.json'] : ['dir.json'],
        ),
      ),
      stat: jest.fn(() =>
        Promise.resolve({
          mtimeMs: 1,
          mtime: new Date('2026-08-28T00:00:00Z'),
          size: 10,
        }),
      ),
      readFile: jest.fn((file: string) =>
        Promise.resolve(
          file.includes('tools')
            ? 'not json at all'
            : JSON.stringify({
                connectors: [{ id: 'c1', name: 'Gmail', isEnabled: true }],
              }),
        ),
      ),
    }));
    const mod = await import('../mcp/provider-connectors');
    const result = await mod.listCodexProviderConnectors([
      { displayName: 'Gmail' },
    ]);

    expect(result.connectors[0]?.connected).toBe(false);
    expect(result.snapshotAt).toBeUndefined();
  });

  it('refuses to parse a cache above the size ceiling', async () => {
    jest.resetModules();
    jest.doMock('node:fs/promises', () => ({
      readdir: jest.fn(() => Promise.resolve(['dir.json'])),
      stat: jest.fn(() =>
        Promise.resolve({
          mtimeMs: 1,
          mtime: new Date('2026-08-28T00:00:00Z'),
          size: 1_000 * 1024 * 1024,
        }),
      ),
      readFile: jest.fn(() => Promise.reject(new Error('should not be read'))),
    }));
    const mod = await import('../mcp/provider-connectors');
    const result = await mod.listCodexProviderConnectors([
      { displayName: 'Gmail' },
    ]);

    expect(result.unavailableReason).toBe('no-directory-cache');
    expect(result.connectors).toEqual([]);
  });
});

describe('listClaudeProviderConnectors', () => {
  afterEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();
  });

  it('reports API-key precedence instead of an empty list', async () => {
    jest.resetModules();
    // Claude disables account connectors entirely when an API key is set: the
    // list is fetched with the claude.ai OAuth token, and a key means there is
    // none. Reporting "no connectors" would send the user to relink something
    // that was never going to appear.
    jest.doMock('@canopy/desktop-shared/pipelines/config-paths', () => ({
      getBundledClaudeBinaryPath: (): string => '/bin/claude',
      getEnhancedEnv: (): NodeJS.ProcessEnv => ({
        ANTHROPIC_API_KEY: 'sk-test',
      }),
    }));
    const runner = jest.fn();
    jest.doMock('../agents/claude-process-host-runner', () => ({
      runClaudeCliProcessOffMain: runner,
    }));
    const mod = await import('../mcp/provider-connectors');
    const result = await mod.listClaudeProviderConnectors();

    expect(result.unavailableReason).toBe('api-key-precedence');
    expect(result.detail).toContain('ANTHROPIC_API_KEY');
    expect(result.connectors).toEqual([]);
    // The CLI must not be spawned at all — the answer is knowable without it.
    expect(runner).not.toHaveBeenCalled();
  });

  it('reports a CLI failure rather than claiming nothing is linked', async () => {
    jest.resetModules();
    jest.doMock('@canopy/desktop-shared/pipelines/config-paths', () => ({
      getBundledClaudeBinaryPath: (): string => '/bin/claude',
      getEnhancedEnv: (): NodeJS.ProcessEnv => ({}),
    }));
    jest.doMock('../agents/claude-process-host-runner', () => ({
      runClaudeCliProcessOffMain: jest
        .fn()
        .mockRejectedValue(new Error('spawn ENOENT')),
    }));
    const mod = await import('../mcp/provider-connectors');
    const result = await mod.listClaudeProviderConnectors();

    expect(result.unavailableReason).toBe('cli-failed');
    expect(result.detail).toBe('spawn ENOENT');
  });
});

describe('PROVIDER_CONNECTOR_MANAGE_URLS', () => {
  it('sends each provider to its own directory', () => {
    // One shared fallback sent every Codex connect to claude.ai.
    expect(PROVIDER_CONNECTOR_MANAGE_URLS.claude).toContain('claude.ai');
    expect(PROVIDER_CONNECTOR_MANAGE_URLS.codex).toContain('chatgpt.com');
  });
});
