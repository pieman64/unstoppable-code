/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  PluginDetails,
  PluginProviderFacet,
} from '@canopy/protocol/plugins';

import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';
import {
  PluginDetailContent,
  type PluginDetailContentPlugin,
  type PluginDetailReadComponent,
} from '../PluginDetailContent';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function makeDetails(overrides: Partial<PluginDetails> = {}): PluginDetails {
  return {
    skills: [],
    agents: [],
    commands: [],
    hooks: [],
    mcpServers: [],
    lspServers: [],
    hasReadme: false,
    ...overrides,
  };
}

function makeFacet(
  overrides: Partial<PluginProviderFacet> = {},
): PluginProviderFacet {
  return {
    provider: 'claude',
    mode: 'native',
    name: 'My Plugin',
    installLocation: '/tmp/mkt',
    sourcePath: 'plugins/my-plugin',
    ...overrides,
  };
}

function makePlugin(
  overrides: Partial<PluginDetailContentPlugin> = {},
): PluginDetailContentPlugin {
  return {
    name: 'my-plugin',
    displayName: 'My Plugin',
    description: 'Does useful things.',
    version: '1.2.0',
    author: 'Ada',
    category: 'quality',
    homepage: 'https://example.com/my-plugin',
    marketplaceId: 'mkt-1',
    providerSupport: { claude: 'native', codex: 'none' },
    details: makeDetails(),
    ...overrides,
  };
}

describe('PluginDetailContent', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  const noopRead: PluginDetailReadComponent = () => Promise.resolve(null);

  function render(
    props: Partial<Parameters<typeof PluginDetailContent>[0]> & {
      plugin: PluginDetailContentPlugin;
    },
  ): void {
    act(() => {
      root.render(
        <PluginDetailContent
          onBack={(): void => undefined}
          onReadComponent={noopRead}
          {...props}
        />,
      );
    });
  }

  const findButton = (label: string): HTMLButtonElement => {
    const button = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    if (!button) throw new Error(`Button "${label}" not found`);
    return button;
  };

  const showTooltip = (target: Element | null): string | null | undefined => {
    if (!target) throw new Error('Tooltip target not found');
    act(() => {
      target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    return document.body.querySelector('[role="tooltip"]')?.textContent;
  };

  it.each([
    [undefined, 'Claude Security'],
    ['dbt labs', 'dbt labs'],
  ])(
    'resolves the title with display name %s',
    (displayName, expected): void => {
      render({ plugin: makePlugin({ name: 'claude-security', displayName }) });
      expect(container.querySelector('#plugin-detail-title')?.textContent).toBe(
        expected,
      );
    },
  );

  it.each([
    ['   ', 'Facet Label', 'Facet Label'],
    ['  Writer Toolkit  ', 'Facet Label', 'Writer Toolkit'],
    ['   ', '   ', 'Claude Security'],
    ['', '', 'Claude Security'],
    [undefined, '  Facet Label  ', 'Facet Label'],
  ])(
    'normalizes title candidates %p and %p',
    (displayName, facetDisplayName, expected): void => {
      render({
        plugin: makePlugin({
          name: 'fallback-plugin',
          displayName,
          facets: {
            claude: makeFacet({
              name: 'claude-security',
              displayName: facetDisplayName,
              details: makeDetails(),
            }),
          },
        }),
      });
      expect(container.querySelector('#plugin-detail-title')?.textContent).toBe(
        expected,
      );
    },
  );

  it('renders the plugin header from top-level fields (no facets, web shape)', () => {
    render({ plugin: makePlugin() });

    expect(container.querySelectorAll('h2')).toHaveLength(1);
    expect(container.querySelector('h2')?.textContent).toBe('My Plugin');
    expect(
      container.querySelector('[data-testid="plugin-detail-chrome"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="plugin-detail-back"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain('My Plugin');
    expect(container.textContent).toContain('v1.2.0');
    expect(container.textContent).toContain('quality');
    expect(container.textContent).toContain('by Ada');
    expect(container.textContent).toContain('Does useful things.');
    expect(
      container.querySelector('a[href="https://example.com/my-plugin"]'),
    ).not.toBeNull();
    // No facets → no provider toggle.
    expect(
      container.querySelector('[data-testid="plugin-detail-provider-toggle"]'),
    ).toBeNull();
    expect(container.textContent).toContain(
      'No components found for this provider.',
    );
  });

  it('credits the product vendor even when the active facet names the publisher', () => {
    // The shape OpenAI's official feed actually ships: the Codex facet, not
    // just the top-level row, declares `author: 'OpenAI'` for a Microsoft
    // product. Reading the facet author first skipped the correction, so an
    // installed Teams still read "by OpenAI" under a Microsoft mark.
    render({
      plugin: makePlugin({
        name: 'teams',
        displayName: 'Teams',
        author: 'OpenAI',
        marketplaceId: 'openai-curated',
        providerSupport: { claude: 'none', codex: 'native' },
        facets: {
          codex: makeFacet({
            provider: 'codex',
            name: 'teams',
            displayName: 'Teams',
            author: 'OpenAI',
            details: makeDetails(),
          }),
        },
      }),
    });

    expect(
      container.querySelector('[data-testid="plugin-detail-author"]')
        ?.textContent,
    ).toBe('by Microsoft');
  });

  it('shows the website link in its own row, apart from the author', () => {
    render({ plugin: makePlugin() });
    const author = container.querySelector(
      '[data-testid="plugin-detail-author"]',
    );
    const website = Array.from(container.querySelectorAll('a')).find(
      (link) => link.textContent === 'Website',
    );
    if (!author || !website) throw new Error('Author or Website not found');
    expect(website.getAttribute('href')).toBe('https://example.com/my-plugin');
    // Beside "by Ada" in the metadata line it read as "by Ada Website".
    expect(author.parentElement?.contains(website)).toBe(false);
    expect(
      website.closest('[data-testid="plugin-detail-links"]'),
    ).not.toBeNull();
    const description = Array.from(container.querySelectorAll('p')).find(
      (paragraph) => paragraph.textContent === 'Does useful things.',
    );
    if (!description) throw new Error('Description not found');
    expect(
      description.compareDocumentPosition(website) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("keeps a facet's own vendor wording on an official listing", () => {
    // Only the publisher-for-vendor conflation is corrected; a vendor naming
    // itself precisely is left alone even when a facet supplies it.
    render({
      plugin: makePlugin({
        name: 'linear',
        displayName: 'Linear',
        author: 'Linear Orbit, Inc',
        marketplaceId: 'openai-curated',
        providerSupport: { claude: 'none', codex: 'native' },
        facets: {
          codex: makeFacet({
            provider: 'codex',
            name: 'linear',
            author: 'Linear Orbit, Inc',
            details: makeDetails(),
          }),
        },
      }),
    });

    expect(
      container.querySelector('[data-testid="plugin-detail-author"]')
        ?.textContent,
    ).toBe('by Linear Orbit, Inc');
  });

  it('switches facet metadata via the provider toggle', () => {
    const plugin = makePlugin({
      displayName: undefined,
      description: undefined,
      version: undefined,
      details: undefined,
      providerSupport: { claude: 'native', codex: 'native' },
      facets: {
        claude: makeFacet({
          name: 'Plugin Claude',
          version: '1.0.0',
          description: 'Claude facet description',
          details: makeDetails(),
        }),
        codex: makeFacet({
          provider: 'codex',
          name: 'Plugin Codex',
          version: '2.0.0',
          description: 'Codex facet description',
          details: makeDetails(),
        }),
      },
    });
    render({ plugin });

    const toggle = container.querySelector(
      '[data-testid="plugin-detail-provider-toggle"]',
    );
    const toggleLabel = container.querySelector(
      '[data-testid="plugin-detail-provider-toggle-label"]',
    );
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute('aria-label')).toBe(
      'Show plugin details for Claude or Codex',
    );
    expect(toggleLabel?.textContent).toBe('Show:');
    expect(toggleLabel?.getAttribute('aria-hidden')).toBe('true');
    expect(toggleLabel?.parentElement).toBe(toggle?.parentElement);
    expect(toggleLabel?.parentElement?.className).toContain('gap-1.5');
    // CAN-4842: the switch heads the content it changes; the chrome row
    // holds page actions only.
    expect(
      container
        .querySelector('[data-testid="plugin-detail-provider-toggle-row"]')
        ?.contains(toggle),
    ).toBe(true);
    expect(
      container
        .querySelector('[data-testid="plugin-detail-chrome"]')
        ?.contains(toggle),
    ).toBe(false);
    expect(container.textContent).toContain('Plugin Claude');
    expect(container.textContent).toContain('1.0.0');

    const codexButton = container.querySelector(
      '[data-testid="plugin-detail-toggle-codex"]',
    ) as HTMLButtonElement;
    act(() => {
      codexButton.click();
    });
    expect(container.textContent).toContain('Plugin Codex');
    expect(container.textContent).toContain('2.0.0');
  });

  it('explains the Claude detail tab with a tooltip', () => {
    render({
      plugin: makePlugin({
        providerSupport: { claude: 'native', codex: 'native' },
        facets: {
          claude: makeFacet(),
          codex: makeFacet({ provider: 'codex' }),
        },
      }),
    });

    expect(
      showTooltip(
        container.querySelector('[data-testid="plugin-detail-toggle-claude"]'),
      ),
    ).toBe("Show this plugin's Claude details");
  });

  it('explains the native Codex detail tab', () => {
    render({
      plugin: makePlugin({
        providerSupport: { claude: 'native', codex: 'native' },
        facets: {
          claude: makeFacet(),
          codex: makeFacet({ provider: 'codex' }),
        },
      }),
    });

    expect(
      showTooltip(
        container.querySelector('[data-testid="plugin-detail-toggle-codex"]'),
      ),
    ).toBe("Show this plugin's Codex details");
  });

  it('explains Codex details generated through compatibility mode', () => {
    render({
      plugin: makePlugin({
        providerSupport: { claude: 'native', codex: 'compat' },
        facets: {
          claude: makeFacet(),
          codexCompatibility: makeFacet({ provider: 'codex', mode: 'compat' }),
        },
      }),
    });

    expect(
      showTooltip(
        container.querySelector('[data-testid="plugin-detail-toggle-codex"]'),
      ),
    ).toBe(
      "Show the Codex details generated from this plugin's Claude version",
    );
  });

  it('describes the compatibility badge without advertising an action', () => {
    render({
      plugin: makePlugin({
        providerSupport: { claude: 'native', codex: 'compat' },
        facets: {
          claude: makeFacet(),
          codexCompatibility: makeFacet({ provider: 'codex', mode: 'compat' }),
        },
      }),
    });
    const codexButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="plugin-detail-toggle-codex"]',
    );
    act(() => {
      codexButton?.click();
    });

    expect(
      showTooltip(
        container.querySelector(
          '[data-testid="plugin-detail-codex-compat-badge"]',
        ),
      ),
    ).toBe(
      "Generated from this plugin's Claude version for Codex compatibility",
    );
  });

  it('explains why the compatibility Codex tab is disabled', () => {
    render({
      plugin: makePlugin({
        providerSupport: { claude: 'native', codex: 'compat' },
        codexCompatDisabled: true,
        facets: { claude: makeFacet() },
      }),
    });

    expect(
      showTooltip(
        container.querySelector('[data-testid="plugin-detail-toggle-codex"]'),
      ),
    ).toBe('Codex compatibility is turned off for this plugin');
  });

  it('explains the disabled Codex compatibility badge', () => {
    render({
      plugin: makePlugin({
        providerSupport: { claude: 'native', codex: 'compat' },
        codexCompatDisabled: true,
        facets: { claude: makeFacet() },
      }),
    });

    expect(
      showTooltip(
        container.querySelector(
          '[data-testid="plugin-detail-codex-compat-disabled-badge"]',
        ),
      ),
    ).toBe('Codex compatibility is turned off for this plugin');
  });

  it('keeps a top-level displayName as the title on every facet while other metadata switches (desktop precedence)', () => {
    // Pins the pre-extraction desktop precedence verbatim:
    // plugin.displayName ?? facet.displayName ?? facet.name ?? plugin.name —
    // a curated top-level displayName is the stable human label across
    // provider facets; version/description remain facet-first.
    const plugin = makePlugin({
      name: 'writer-toolkit',
      displayName: 'Writer Toolkit',
      description: undefined,
      version: undefined,
      details: undefined,
      providerSupport: { claude: 'native', codex: 'native' },
      facets: {
        claude: makeFacet({
          name: 'Plugin Claude',
          version: '1.0.0',
          description: 'Claude facet description',
          details: makeDetails(),
        }),
        codex: makeFacet({
          provider: 'codex',
          name: 'Plugin Codex',
          version: '2.0.0',
          description: 'Codex facet description',
          details: makeDetails(),
        }),
      },
    });
    render({ plugin });

    const title = (): string | null | undefined =>
      container.querySelector('h2')?.textContent;

    expect(title()).toBe('Writer Toolkit');
    expect(container.textContent).toContain('1.0.0');
    expect(container.textContent).toContain('Claude facet description');

    act(() => {
      (
        container.querySelector(
          '[data-testid="plugin-detail-toggle-codex"]',
        ) as HTMLButtonElement
      ).click();
    });

    expect(title()).toBe('Writer Toolkit');
    expect(container.textContent).toContain('2.0.0');
    expect(container.textContent).toContain('Codex facet description');
  });

  it('falls back to facet displayName, then facet name, without a top-level displayName', () => {
    const plugin = makePlugin({
      displayName: undefined,
      facets: {
        claude: makeFacet({
          name: 'facet-name',
          displayName: 'Facet Display Name',
          details: makeDetails(),
        }),
      },
    });
    render({ plugin });
    expect(container.querySelector('h2')?.textContent).toBe(
      'Facet Display Name',
    );
  });

  it('opens the settings of an installed server hidden behind the plugin', () => {
    const onOpenEntryId = jest.fn();
    render({
      plugin: makePlugin({
        details: makeDetails({
          mcpServers: [
            { name: 'slack', type: 'http', url: 'https://mcp.slack.test/mcp' },
            { name: 'notes', type: 'http', url: 'https://notes.test/mcp' },
          ],
        }),
      }),
      bundledServerRows: [
        {
          serverName: 'slack',
          endpoint: 'http:mcp.slack.test',
          entryId: 'mcp-local:slack-row',
          serverId: 'slack-row',
        },
      ],
      onOpenEntryId,
    });

    const settings = container.querySelector(
      '[data-testid="plugin-detail-mcp-server-settings-slack"] button',
    );
    expect(settings?.textContent).toContain('Open server settings');
    act(() => {
      settings?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onOpenEntryId).toHaveBeenCalledWith('mcp-local:slack-row');
    // A bundled server with no installed row stays plain text.
    expect(
      container.querySelector(
        '[data-testid="plugin-detail-mcp-server-settings-notes"]',
      ),
    ).toBeNull();
  });

  it('keeps bundled server names plain without an entry opener', () => {
    render({
      plugin: makePlugin({
        details: makeDetails({
          mcpServers: [
            { name: 'slack', type: 'http', url: 'https://mcp.slack.test/mcp' },
          ],
        }),
      }),
      bundledServerRows: [
        {
          serverName: 'slack',
          endpoint: 'http:mcp.slack.test',
          entryId: 'mcp-local:slack-row',
          serverId: 'slack-row',
        },
      ],
    });
    expect(
      container.querySelector(
        '[data-testid="plugin-detail-mcp-server-settings-slack"]',
      ),
    ).toBeNull();
  });

  it('lazily reads component content through the injected callback', async () => {
    const onReadComponent = jest.fn().mockResolvedValue({
      frontmatter: {},
      body: 'component body',
    });
    const claudeFacet = makeFacet({
      details: makeDetails({
        skills: [
          {
            name: 'Claude Skill',
            description: 'Skill description',
            path: 'skills/claude-skill',
          },
        ],
      }),
    });
    render({
      plugin: makePlugin({ facets: { claude: claudeFacet } }),
      onReadComponent,
    });

    await act(async () => {
      findButton('Claude Skill').click();
      await Promise.resolve();
    });

    expect(onReadComponent).toHaveBeenCalledWith(
      'skill',
      'skills/claude-skill/SKILL.md',
      { kind: 'claude', facet: claudeFacet },
    );
    expect(container.textContent).toContain('component body');

    act(() => {
      findButton('Back').click();
    });
    expect(container.textContent).toContain('Claude Skill');
    expect(container.textContent).toContain('Skill description');
  });

  it('keeps one chrome back action and the labelled title while viewing a component', async () => {
    const claudeFacet = makeFacet({
      details: makeDetails({
        skills: [
          {
            name: 'Claude Skill',
            description: 'Skill description',
            path: 'skills/claude-skill',
          },
        ],
      }),
    });
    render({
      plugin: makePlugin({
        providerSupport: { claude: 'native', codex: 'native' },
        facets: {
          claude: claudeFacet,
          codex: makeFacet({ provider: 'codex', name: 'Codex Plugin' }),
        },
      }),
      headerActions: <button data-testid="close-action">Close</button>,
    });

    await act(async () => {
      findButton('Claude Skill').click();
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-testid="plugin-detail-chrome"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="close-action"]'),
    ).not.toBeNull();
    expect(
      Array.from(container.querySelectorAll('button')).filter(
        (button) => button.textContent?.trim() === 'Back',
      ),
    ).toHaveLength(1);
    expect(
      container
        .querySelector('[data-testid="plugin-detail-back"] svg')
        ?.getAttribute('aria-hidden'),
    ).toBe('true');
    expect(container.querySelector('#plugin-detail-title')?.textContent).toBe(
      'Claude Skill',
    );
    const drillDown = container.querySelector(
      '[data-testid="plugin-detail-chrome"]',
    )?.parentElement;
    expect(drillDown?.children).toHaveLength(2);
    expect(drillDown?.lastElementChild?.querySelector('h2')?.textContent).toBe(
      'Claude Skill',
    );
    expect(
      container.querySelector('[data-testid="plugin-detail-provider-toggle"]'),
    ).toBeNull();
  });

  it('shows the stock error copy when the component read resolves null', async () => {
    render({
      plugin: makePlugin({
        details: makeDetails({
          skills: [
            { name: 'Broken Skill', description: '', path: 'skills/broken' },
          ],
        }),
      }),
      onReadComponent: noopRead,
    });

    await act(async () => {
      findButton('Broken Skill').click();
      await Promise.resolve();
    });

    expect(container.textContent).toContain(
      'Failed to load component content.',
    );
  });

  describe('session replay privacy', () => {
    const leaf = (text: string): Element => {
      const match = Array.from(container.querySelectorAll('*')).find(
        (element) =>
          element.childElementCount === 0 && element.textContent === text,
      );
      if (!match) throw new Error(`No element with text: ${text}`);
      return match;
    };

    it('records the description and keeps the Back chrome recorded', () => {
      render({ plugin: makePlugin() });

      expect(leaf('Does useful things.').closest('.ph-no-capture')).toBeNull();
      expect(findButton('Back').closest('.ph-no-capture')).toBeNull();
    });

    it('blocks MCP server commands, which can carry credentials, but not names', () => {
      render({
        plugin: makePlugin({
          details: makeDetails({
            mcpServers: [
              {
                name: 'mail',
                type: 'command',
                command: 'npx',
                args: ['mail-mcp', '--token', 'secret'],
              },
            ],
          }),
        }),
      });
      expect(
        leaf('npx mail-mcp --token secret').closest('.ph-no-capture'),
      ).not.toBeNull();
      expect(leaf('mail').closest('.ph-no-capture')).toBeNull();
    });

    it('records an HTTP MCP endpoint, whose credentials are redacted centrally', () => {
      render({
        plugin: makePlugin({
          details: makeDetails({
            mcpServers: [
              {
                name: 'mail',
                type: 'http',
                url: 'https://mail.example.test/mcp',
              },
            ],
          }),
        }),
      });
      expect(
        leaf('https://mail.example.test/mcp').closest('.ph-no-capture'),
      ).toBeNull();
    });

    it('blocks the README body but not its heading', () => {
      render({
        plugin: makePlugin({ details: makeDetails({ hasReadme: true }) }),
        readme: { body: 'Readme body text' },
      });
      expect(leaf('Readme body text').closest('.ph-no-capture')).not.toBeNull();
      expect(leaf('README').closest('.ph-no-capture')).toBeNull();
    });

    it('blocks a component file body while its name and the Back chrome stay recorded', async () => {
      render({
        plugin: makePlugin({
          details: makeDetails({
            skills: [
              {
                name: 'Deal Memo',
                description: '',
                path: 'skills/deal-memo',
              },
            ],
          }),
        }),
        onReadComponent: () =>
          Promise.resolve({ frontmatter: {}, body: 'Secret component body' }),
      });

      await act(async () => {
        findButton('Deal Memo').click();
        await Promise.resolve();
      });

      expect(
        leaf('Secret component body').closest('.ph-no-capture'),
      ).not.toBeNull();
      const heading = container.querySelector('#plugin-detail-title');
      expect(heading?.textContent).toBe('Deal Memo');
      expect(heading?.closest('.ph-no-capture')).toBeNull();
      expect(
        container
          .querySelector('[data-testid="plugin-detail-back"]')
          ?.closest('.ph-no-capture'),
      ).toBeNull();
    });
  });

  it('renders a preloaded README expanded (no components) with a truncation notice', () => {
    render({
      plugin: makePlugin({
        details: makeDetails({ hasReadme: true }),
      }),
      readme: { body: 'Readme body text', truncated: true },
    });

    expect(container.textContent).toContain('README');
    expect(container.textContent).toContain('Readme body text');
    expect(
      container.querySelector('[data-testid="plugin-detail-truncated-notice"]'),
    ).not.toBeNull();
  });

  it('renders README inline code without typography backtick decoration', () => {
    render({
      plugin: makePlugin({
        details: makeDetails({ hasReadme: true }),
      }),
      readme: { body: 'Edit `.app.json` to register.' },
    });

    const code = container.querySelector('code');
    expect(code?.textContent).toBe('.app.json');
    const prose = code?.closest('.prose');
    expect(prose?.classList.contains('prose-code:before:content-none')).toBe(
      true,
    );
    expect(prose?.classList.contains('prose-code:after:content-none')).toBe(
      true,
    );
  });

  it('renders the injected metadata footer, install actions, and related content', () => {
    render({
      plugin: makePlugin(),
      metadataFooter: <p>metadata footer slot</p>,
      installActions: <p>install actions slot</p>,
      relatedContent: <p>related content slot</p>,
    });

    expect(container.textContent).toContain('metadata footer slot');
    expect(container.textContent).toContain('install actions slot');
    expect(container.textContent).toContain('related content slot');
  });

  function expectInDocumentOrder(nodes: readonly (Element | null)[]): void {
    nodes.forEach((node, index) => {
      expect(node).not.toBeNull();
      const next = nodes[index + 1];
      if (node && next) {
        expect(
          node.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
      }
    });
  }

  const sectionHeading = (text: string): Element | null =>
    Array.from(
      container.querySelectorAll(
        '[data-testid="plugin-detail-section-heading"]',
      ),
    ).find((heading) => heading.textContent === text) ??
    Array.from(container.querySelectorAll('h3, summary, button')).find(
      (heading) => heading.textContent?.trim() === text,
    ) ??
    null;

  it('renders host slots in order (CAN-4842)', () => {
    render({
      plugin: makePlugin({
        details: makeDetails({
          hasReadme: true,
          skills: [{ name: 'Skill', description: 'S', path: 'skills/s' }],
          mcpServers: [
            { name: 'm', type: 'http', url: 'https://m.example.test/mcp' },
          ],
        }),
      }),
      readme: { body: 'Readme body' },
      updateNotice: <p data-testid="t-update" />,
      statusContent: <p data-testid="t-status" />,
      harnessRows: [
        { id: 'claude', name: 'Claude', installation: 'Installed' },
      ],
      installActions: <p data-testid="t-install" />,
      sharedContent: <p data-testid="t-shared" />,
    });
    const byId = (id: string): Element | null =>
      container.querySelector(`[data-testid="${id}"]`);
    expectInDocumentOrder([
      container.querySelector('#plugin-detail-title'),
      byId('t-update'),
      byId('t-status'),
      byId('plugin-harness-connections'),
      byId('t-install'),
      sectionHeading('MCP servers'),
      byId('t-shared'),
      sectionHeading('README'),
      sectionHeading('Skills'),
    ]);
  });

  it('leaves no wrapper for empty slots (CAN-4842)', () => {
    const plugin = makePlugin({
      details: makeDetails({
        skills: [{ name: 'Skill', description: 'S', path: 'skills/s' }],
      }),
    });
    render({ plugin });
    const column = container.firstElementChild;
    const bare = column?.childElementCount ?? 0;
    render({
      plugin,
      updateNotice: <p />,
      statusContent: <p />,
      harnessRows: [
        { id: 'claude', name: 'Claude', installation: 'Installed' },
      ],
      sharedContent: <p />,
    });
    // Each filled slot adds exactly its own node; no wrapper around it.
    expect(container.firstElementChild?.childElementCount).toBe(bare + 4);
    render({ plugin, harnessRows: [] });
    expect(container.firstElementChild?.childElementCount).toBe(bare);
  });

  it('offers keyboard-native descriptions without requiring a component source file', () => {
    const description =
      'Detailed third-party instructions that remain available on demand.';
    render({
      plugin: makePlugin({
        details: makeDetails({
          skills: [{ name: 'Skill', path: 'skills/s', description }],
          agents: [{ name: 'Agent', description, filePath: '' }],
          commands: [{ name: 'Command', description, filePath: '' }],
          apps: [{ name: 'App', description, filePath: '' }],
        }),
      }),
    });
    for (const name of ['Skill', 'Agent', 'Command', 'App']) {
      const summary = container.querySelector(
        `summary[aria-label="Description for ${name}"]`,
      );
      expect(summary).not.toBeNull();
      expect(summary?.closest('details')?.open).toBe(false);
      expect(summary?.closest('details')?.querySelector('p')?.textContent).toBe(
        description,
      );
    }
  });

  it('hides the component tables when hideComponents is set', () => {
    render({
      plugin: makePlugin({
        details: makeDetails({
          skills: [{ name: 'Hidden Skill', description: '', path: 'skills/x' }],
        }),
      }),
      hideComponents: true,
    });

    expect(container.textContent).not.toContain('Hidden Skill');
    expect(container.textContent).not.toContain(
      'No components found for this provider.',
    );
  });

  it('shows MCP servers in an always-visible section before the README (CAN-4842)', () => {
    render({
      plugin: makePlugin({
        details: makeDetails({
          hasReadme: true,
          mcpServers: [
            {
              name: 'mail',
              type: 'http',
              url: 'https://mail.example.test/mcp',
            },
            {
              name: 'local',
              type: 'command',
              command: 'mail-mcp',
              args: ['--x'],
            },
          ],
          skills: [
            {
              name: 'Find messages',
              path: 'skills/find',
              description: 'Search mail',
            },
          ],
          agents: [
            { name: 'Agent', description: 'Detail', filePath: 'agents/x.md' },
          ],
          commands: [
            {
              name: 'Command',
              description: 'Detail',
              filePath: 'commands/x.md',
            },
          ],
        }),
      }),
    });
    expect(
      Array.from(container.querySelectorAll('summary')).some(
        (summary) => summary.textContent?.trim() === 'MCP servers',
      ),
    ).toBe(false);
    const heading = sectionHeading('MCP servers');
    const section = heading?.closest('section');
    expect(section).not.toBeNull();
    expect(
      Array.from(section?.querySelectorAll('thead th') ?? []).map(
        (cell) => cell.textContent,
      ),
    ).toEqual(['Name', 'Status', 'Actions']);
    expect(section?.querySelector('thead th:last-child span')?.className).toBe(
      'sr-only',
    );
    expect(section?.textContent).toContain('https://mail.example.test/mcp');
    const command = Array.from(section?.querySelectorAll('span') ?? []).find(
      (span) => span.textContent === 'mail-mcp --x',
    );
    expect(command?.classList.contains(REPLAY_BLOCK_CLASS)).toBe(true);
    expect(
      Array.from(
        container.querySelectorAll(
          '[data-testid="plugin-detail-section-heading"]',
        ),
      ).map((node) => node.textContent),
    ).toEqual(['MCP servers', 'README', 'Skills', 'Agents', 'Commands']);
  });

  it('reads "Not configured yet" without a host status and renders the host status cell', () => {
    const plugin = makePlugin({
      details: makeDetails({
        mcpServers: [
          { name: 'a', type: 'http', url: 'https://a.example.test/mcp' },
          { name: 'b', type: 'http', url: 'https://b.example.test/mcp' },
        ],
      }),
    });
    render({ plugin });
    expect(
      Array.from(
        container.querySelectorAll(
          '[data-testid="plugin-detail-mcp-status-unavailable"]',
        ),
      ).map((node) => node.textContent),
    ).toEqual(['Not configured yet', 'Not configured yet']);
    render({
      plugin,
      renderMcpServerStatus: (server) =>
        server.name === 'a' ? <span data-testid="t-health-a" /> : undefined,
    });
    const rowA = container.querySelector('[data-mcp-member="a"]');
    const rowB = container.querySelector('[data-mcp-member="b"]');
    expect(rowA?.querySelector('[data-testid="t-health-a"]')).not.toBeNull();
    expect(
      rowA?.querySelector(
        '[data-testid="plugin-detail-mcp-status-unavailable"]',
      ),
    ).toBeNull();
    expect(
      rowB?.querySelector(
        '[data-testid="plugin-detail-mcp-status-unavailable"]',
      )?.textContent,
    ).toBe('Not configured yet');
  });

  it('renders no empty components wrapper for an MCP-only plugin and hides the section with the components', () => {
    const plugin = makePlugin({
      details: makeDetails({
        mcpServers: [
          { name: 'a', type: 'http', url: 'https://a.example.test/mcp' },
        ],
      }),
    });
    render({ plugin });
    const column = container.firstElementChild;
    expect(
      Array.from(column?.children ?? []).filter(
        (child) =>
          child.tagName === 'DIV' &&
          child.classList.contains('gap-6') &&
          child.childElementCount === 0,
      ),
    ).toHaveLength(0);
    expect(container.textContent).not.toContain(
      'No components found for this provider.',
    );
    expect(sectionHeading('MCP servers')).not.toBeNull();
    render({ plugin, hideComponents: true });
    expect(sectionHeading('MCP servers')).toBeNull();
  });

  it('uses one heading treatment for README and component sections', () => {
    render({
      plugin: makePlugin({
        details: makeDetails({
          hasReadme: true,
          skills: [
            {
              name: 'Long skill name',
              description: 'Detail',
              path: 'skills/x',
            },
          ],
          agents: [
            { name: 'Agent', description: 'Detail', filePath: 'agents/x.md' },
          ],
          commands: [
            {
              name: 'Command',
              description: 'Detail',
              filePath: 'commands/x.md',
            },
          ],
        }),
      }),
    });

    const headings = Array.from(
      container.querySelectorAll(
        '[data-testid="plugin-detail-section-heading"]',
      ),
    );
    expect(headings.map((heading) => heading.textContent)).toEqual([
      'README',
      'Skills',
      'Agents',
      'Commands',
    ]);
    expect(new Set(headings.map((heading) => heading.className)).size).toBe(1);
  });
  it('opens and focuses the exact provider member once per navigation request', () => {
    const claude = makeFacet({
      details: makeDetails({
        mcpServers: [
          {
            name: 'same',
            type: 'http',
            url: 'https://claude.example.test/mcp',
          },
        ],
      }),
    });
    const codex = makeFacet({
      provider: 'codex',
      details: makeDetails({
        mcpServers: [
          { name: 'same', type: 'http', url: 'https://codex.example.test/mcp' },
        ],
      }),
    });
    const plugin = makePlugin({
      providerSupport: { claude: 'native', codex: 'native' },
      facets: { claude, codex },
    });
    const mcpTarget = {
      serverName: 'same',
      provider: 'codex' as const,
      requestId: 'one',
    };
    render({ plugin, mcpTarget });
    const member = container.querySelector<HTMLTableRowElement>(
      '[data-mcp-member="same"]',
    );
    expect(member?.textContent).toContain('https://codex.example.test/mcp');
    expect(document.activeElement).toBe(member);
    expect(member?.closest('details')).toBeNull();
    // The same request does not refocus; a new request does.
    act(() => {
      if (document.activeElement instanceof HTMLElement)
        document.activeElement.blur();
    });
    render({ plugin: { ...plugin }, mcpTarget: { ...mcpTarget } });
    expect(document.activeElement).not.toBe(member);
    render({ plugin, mcpTarget: { ...mcpTarget, requestId: 'two' } });
    expect(document.activeElement).toBe(
      container.querySelector('[data-mcp-member="same"]'),
    );
  });

  it('links a hidden server only on the provider member with its endpoint (CAN-3653)', () => {
    const claude = makeFacet({
      details: makeDetails({
        mcpServers: [
          {
            name: 'same',
            type: 'http',
            url: 'https://claude.example.test/mcp',
          },
        ],
      }),
    });
    const codex = makeFacet({
      provider: 'codex',
      details: makeDetails({
        mcpServers: [
          { name: 'same', type: 'http', url: 'https://codex.example.test/mcp' },
        ],
      }),
    });
    const plugin = makePlugin({
      providerSupport: { claude: 'native', codex: 'native' },
      facets: { claude, codex },
    });
    const props = {
      plugin,
      bundledServerRows: [
        {
          serverName: 'same',
          endpoint: 'http:claude.example.test',
          entryId: 'mcp-local:claude-row',
          serverId: 'claude-row',
        },
      ],
      onOpenEntryId: jest.fn(),
    };
    const settings = (): Element | null =>
      container.querySelector(
        '[data-testid="plugin-detail-mcp-server-settings-same"]',
      );
    render({
      ...props,
      mcpTarget: { serverName: 'same', provider: 'codex', requestId: 'one' },
    });
    expect(
      container.querySelector('[data-mcp-member="same"]')?.textContent,
    ).toContain('https://codex.example.test/mcp');
    expect(settings()).toBeNull();
    render({
      ...props,
      mcpTarget: { serverName: 'same', provider: 'claude', requestId: 'two' },
    });
    expect(
      container.querySelector('[data-mcp-member="same"]')?.textContent,
    ).toContain('https://claude.example.test/mcp');
    expect(settings()).not.toBeNull();
  });

  it('shows an unavailable target without selecting an unrelated provider member', () => {
    render({
      plugin: makePlugin({
        facets: {
          claude: makeFacet({
            details: makeDetails({
              mcpServers: [
                {
                  name: 'same',
                  type: 'http',
                  url: 'https://claude.example.test/mcp',
                },
              ],
            }),
          }),
        },
      }),
      mcpTarget: {
        serverName: 'same',
        provider: 'codex',
        requestId: 'missing',
      },
    });
    expect(
      container.querySelector('[data-testid="plugin-mcp-target-unavailable"]')
        ?.textContent,
    ).toBe('This MCP server is no longer available');
    expect(document.activeElement?.hasAttribute('data-mcp-member')).toBe(false);
  });
});
