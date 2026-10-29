/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  PluginDetails,
  PluginProviderFacet,
} from '@canopy/protocol/plugins';

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
    expect(container.textContent).toContain('Plugin Claude');
    expect(container.textContent).toContain('1.0.0');

    const codexButton = container.querySelector(
      '[data-testid="plugin-detail-toggle-codex"]',
    ) as HTMLButtonElement;
    expect(codexButton.dataset.codexCompat).toBe('false');
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

  it('keeps technical server details collapsed and available on demand', () => {
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
          skills: [
            {
              name: 'Find messages',
              path: 'skills/find',
              description: 'Search mail',
            },
          ],
        }),
      }),
    });
    const disclosure = Array.from(container.querySelectorAll('details')).find(
      (element) =>
        element.querySelector('summary')?.textContent?.trim() === 'MCP servers',
    );
    expect(disclosure).not.toBeNull();
    expect(disclosure?.open).toBe(false);
    expect(disclosure?.textContent).toContain('https://mail.example.test/mcp');
    expect(findButton('Find messages').closest('details')).toBeNull();
    act(() => disclosure?.querySelector('summary')?.click());
    expect(disclosure?.open).toBe(true);
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
});
