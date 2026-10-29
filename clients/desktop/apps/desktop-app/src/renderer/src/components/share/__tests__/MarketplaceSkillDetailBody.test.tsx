/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import type { PublicShareLanding } from '../usePublicShareLanding';

const mockNavigate = jest.fn();
jest.mock('@/stores/navigationStore', () => ({
  useNavigationStore: {
    getState: (): { navigate: typeof mockNavigate } => ({
      navigate: mockNavigate,
    }),
  },
}));

import { MarketplaceSkillDetailBody } from '../MarketplaceSkillDetailBody';

const link = {
  entity: 'plugin' as const,
  externalId: '2f0c9a1e-4b3d-4f6a-8c2e-1d5b7a9e0c4f',
  intent: 'install' as const,
};

const snapshot = {
  entity: 'plugin' as const,
  externalId: link.externalId,
  name: 'Browser',
  description: 'Browser tools',
  ref: {
    type: 'plugin' as const,
    marketplace: { type: 'github' as const, repo: 'acme/plugins' },
    plugin_name: 'browser',
  },
  refKey: 'plugin:github:acme/plugins:browser',
  marketplaceOrigin: 'github:acme/plugins',
  authorUsername: null,
  updatedAt: '2026-08-01T00:00:00.000Z',
};

function landing(
  overrides: Partial<PublicShareLanding> = {},
): PublicShareLanding {
  return {
    state: { phase: 'ready', snapshot },
    snapshot,
    detecting: false,
    installed: null,
    installing: false,
    installError: '',
    installProgress: '',
    installStatus: '',
    agentReadiness: null,
    agentReadinessLoading: false,
    workspaceReadiness: null,
    workspaceReadinessLoading: false,
    uninstalling: false,
    install: jest.fn(async () => Promise.resolve()),
    tryNow: jest.fn(),
    manage: jest.fn(),
    uninstall: jest.fn(async () => Promise.resolve()),
    installReview: null,
    closeInstallReview: jest.fn(),
    completeInstallReview: jest.fn(),
    ...overrides,
  };
}

const heading = <h2 id="plugin-detail-title">Page title</h2>;

function renderBody(
  root: Root,
  value: PublicShareLanding,
  options: { entity?: 'skill' | 'plugin'; onInstall?: () => void } = {},
): void {
  root.render(
    <MarketplaceSkillDetailBody
      entity={options.entity ?? 'plugin'}
      landing={value}
      onInstall={options.onInstall ?? jest.fn()}
      heading={heading}
    />,
  );
}

// The actions join the page's action bar on the heading's row.
const actionRow = (): Element | null =>
  document.querySelector('[data-testid="detail-action-bar"]');
const body = (): Element | null =>
  document.querySelector('[data-testid="deep-link-share-body"]');

describe('MarketplaceSkillDetailBody plugin page', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('blocks the shared snapshot body from session replay, keeping the actions recorded', () => {
    act(() => {
      renderBody(root, landing());
    });
    const contentRoot = body()?.parentElement;
    expect(contentRoot?.parentElement).toBe(container);
    expect(contentRoot?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(
      false,
    );
    expect(body()?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(true);
    expect(actionRow()).not.toBeNull();
    expect(actionRow()?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBeNull();
  });

  it('renders the plugin description as Markdown inside its summary', () => {
    const markdownSnapshot = {
      ...snapshot,
      description: 'Browser tools.\n\n1. Opens pages\n2. Reads them',
    };
    act(() => {
      renderBody(
        root,
        landing({
          state: { phase: 'ready', snapshot: markdownSnapshot },
          snapshot: markdownSnapshot,
        }),
      );
    });
    const descriptions = document.querySelectorAll(
      '[data-testid="share-description"]',
    );
    expect(descriptions).toHaveLength(1);
    expect(
      descriptions[0]?.closest('[data-testid="deep-link-plugin-summary"]'),
    ).not.toBeNull();
    expect(
      Array.from(
        descriptions[0]?.querySelectorAll('ol > li') ?? [],
        (item) => item.textContent,
      ),
    ).toEqual(['Opens pages', 'Reads them']);
  });

  it('falls back when a plugin description has no visible text', () => {
    const emptySnapshot = { ...snapshot, description: '---' };
    act(() => {
      renderBody(
        root,
        landing({
          state: { phase: 'ready', snapshot: emptySnapshot },
          snapshot: emptySnapshot,
        }),
      );
    });
    expect(
      document.querySelector('[data-testid="share-description"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="deep-link-plugin-summary"]')
        ?.textContent,
    ).toContain('No description provided.');
  });

  it('shows the pinned plugin source, and Install opens the review without writing', () => {
    const value = landing();
    const onInstall = jest.fn();
    act(() => {
      renderBody(root, value, { onInstall });
    });
    expect(document.body.textContent).toContain('github:acme/plugins');
    document
      .querySelector<HTMLButtonElement>(
        '[data-testid="deep-link-share-install"]',
      )
      ?.click();
    expect(onInstall).toHaveBeenCalledTimes(1);
    expect(value.install).not.toHaveBeenCalled();
  });

  it('offers Manage without an unsafe plugin uninstall action', () => {
    const value = landing({
      installed: {
        entity: 'plugin',
        marketplaceId: 'acme',
        pluginName: 'browser',
        entryId: 'mkt:acme/browser',
      },
    });
    act(() => {
      renderBody(root, value);
    });
    expect(
      document.querySelector('[data-testid="deep-link-share-manage"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="deep-link-share-kebab"]'),
    ).toBeNull();
  });

  it('names the plugin while it is still loading', () => {
    act(() => {
      renderBody(
        root,
        landing({ state: { phase: 'loading' }, snapshot: null }),
      );
    });
    expect(body()?.textContent).toContain('Loading shared plugin…');
    expect(actionRow()).toBeNull();
  });
});

describe('MarketplaceSkillDetailBody skill page', () => {
  let container: HTMLElement;
  let root: Root;
  const getDependencyReadiness = jest.fn();

  const skillSnapshot = {
    entity: 'skill' as const,
    externalId: link.externalId,
    name: 'Deploy',
    description: 'Ship a build',
    rawSkill: '---\nname: deploy\n---\n# Deploy\n',
    contentHash: 'c'.repeat(64),
    dependencies: [
      { kind: 'mcp' as const, name: 'Slack' },
      { kind: 'plugin' as const, name: 'superpowers' },
    ],
    authorUsername: null,
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
  const readiness = {
    status: 'ready' as const,
    requirements: [
      {
        id: 'mcp-slack',
        kind: 'mcp' as const,
        displayName: 'Slack',
        required: false,
        affectedSteps: [],
        setupHint: 'Connect the Slack MCP server in Settings.',
        status: 'missing' as const,
        detail: 'MCP server is not installed.',
      },
      {
        id: 'runtime-superpowers',
        kind: 'runtime' as const,
        displayName: 'superpowers',
        required: false,
        affectedSteps: [],
        setupHint: 'Install the superpowers plugin.',
        status: 'available' as const,
        detail: 'Plugin is installed.',
      },
    ],
  };
  const packagedSnapshot = {
    ...skillSnapshot,
    distributionMode: 'package' as const,
    package: {
      digest: 'pp:v1:' + 'A'.repeat(43),
      version: 1 as const,
      resources: [
        {
          id: 'deploy',
          displayName: 'Deploy',
          kind: 'standalone_skill' as const,
          sourceLabel: 'local',
          fileCount: 3,
          totalBytes: 2048,
          affectedSteps: [],
          executableFiles: ['scripts/ship.sh'],
        },
      ],
      environmentRequirements: [],
      totalFiles: 3,
      totalBytes: 2048,
    },
  };

  beforeEach(() => {
    getDependencyReadiness.mockReset();
    getDependencyReadiness.mockResolvedValue(readiness);
    Object.assign(window, { skills: { getDependencyReadiness } });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(
    value: PublicShareLanding,
    onInstall: () => void = jest.fn(),
  ): Promise<void> {
    await act(async () => {
      renderBody(root, value, { entity: 'skill', onInstall });
      await Promise.resolve();
    });
  }

  it('shows what a packaged skill brings and what this machine is missing', async () => {
    await render(
      landing({
        state: { phase: 'ready', snapshot: packagedSnapshot },
        snapshot: packagedSnapshot,
      }),
    );

    expect(
      document.querySelector('[data-testid="deep-link-share-package-summary"]'),
    ).not.toBeNull();
    expect(
      document.querySelector(
        '[data-testid="deep-link-share-package-executable-files"]',
      )?.textContent,
    ).toBe('Runnable scripts: scripts/ship.sh');
    expect(getDependencyReadiness).toHaveBeenCalledWith({
      dependencies: skillSnapshot.dependencies,
    });
    const readinessSection = document.querySelector(
      '[data-testid="deep-link-share-skill-readiness"]',
    );
    // Only what is missing leads; an installed plugin is not a warning.
    expect(
      readinessSection
        ?.querySelector('[data-testid="pipeline-readiness-mcp-slack"]')
        ?.getAttribute('data-requirement-status'),
    ).toBe('missing');
    expect(readinessSection?.textContent).toContain(
      'This skill uses these. Set them up before you run it.',
    );
    // Installing is never blocked by a missing requirement.
    expect(
      document.querySelector<HTMLButtonElement>(
        '[data-testid="deep-link-share-install"]',
      )?.disabled,
    ).toBe(false);
  });

  it('leads with the action row beside the host heading', async () => {
    const onInstall = jest.fn();
    const value = landing({
      state: { phase: 'ready', snapshot: skillSnapshot },
      snapshot: skillSnapshot,
      installError: 'The skill could not be installed.',
    });
    await render(value, onInstall);
    const title = document.getElementById('plugin-detail-title');
    // One row holds the title and the actions, and the body follows it.
    expect(actionRow()?.parentElement).toBe(title?.parentElement);
    expect(title?.parentElement?.nextElementSibling).toBe(body());
    expect(body()?.nextElementSibling).toBeNull();
    // A failure reports under the action row, not under the README.
    expect(body()?.firstElementChild?.textContent).toContain(
      'The skill could not be installed.',
    );
    actionRow()
      ?.querySelector<HTMLButtonElement>(
        '[data-testid="deep-link-share-install"]',
      )
      ?.click();
    expect(onInstall).toHaveBeenCalledTimes(1);
    expect(value.install).not.toHaveBeenCalled();
  });

  // CAN-3710: clicking Install is the confirmation. No disclaimer leads the
  // body; the package review still names the runnable files.
  it('adds no runnable-scripts notice ahead of the README', async () => {
    await render(
      landing({
        state: { phase: 'ready', snapshot: packagedSnapshot },
        snapshot: packagedSnapshot,
      }),
    );
    expect(
      document.querySelector(
        '[data-testid="deep-link-share-runnable-scripts"]',
      ),
    ).toBeNull();
  });

  it('offers Try now and the shared menu once the skill is installed', async () => {
    const value = landing({
      state: { phase: 'ready', snapshot: skillSnapshot },
      snapshot: skillSnapshot,
      installed: {
        entity: 'skill',
        sourceId: 'custom:app',
        skillName: 'deploy',
      },
    });
    await render(value);
    expect(
      document.querySelector('[data-testid="deep-link-share-installed-status"]')
        ?.textContent,
    ).toBe('Installed as “deploy”.');
    expect(
      document.querySelector('[data-testid="deep-link-share-install"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="deep-link-share-kebab"]'),
    ).not.toBeNull();
    document
      .querySelector<HTMLButtonElement>('[data-testid="deep-link-share-try"]')
      ?.click();
    expect(value.tryNow).toHaveBeenCalledTimes(1);
  });

  it('keeps the host heading at the top while the share is still loading', async () => {
    await render(landing({ state: { phase: 'loading' }, snapshot: null }));
    expect(
      document.getElementById('plugin-detail-title')?.parentElement
        ?.nextElementSibling,
    ).toBe(body());
    expect(body()?.textContent).toContain('Loading shared skill…');
    expect(actionRow()).toBeNull();
  });

  it('shows the publisher license and pinned source without installing', async () => {
    const publisher = {
      name: 'Anthropic',
      license: 'Apache-2.0',
      pluginName: 'example-skills',
      sourceUrl: `https://github.com/anthropics/skills/tree/${'a'.repeat(40)}/skills/deploy`,
    };
    const published = { ...skillSnapshot, publisher };
    const install = jest.fn();
    await render(
      landing({
        state: { phase: 'ready', snapshot: published },
        snapshot: published,
        install,
      }),
    );
    expect(
      container.querySelector('[data-testid="publisher-skill-provenance"]')
        ?.textContent,
    ).toContain('Apache-2.0');
    expect(container.querySelector('a[href]')?.getAttribute('href')).toBe(
      publisher.sourceUrl,
    );
    expect(install).not.toHaveBeenCalled();
  });

  it('shows a skill description once when SKILL.md frontmatter already lists it', async () => {
    const withFrontmatterDescription = {
      ...skillSnapshot,
      rawSkill: '---\nname: deploy\ndescription: Ship a build\n---\n# Deploy\n',
    };
    await render(
      landing({
        state: { phase: 'ready', snapshot: withFrontmatterDescription },
        snapshot: withFrontmatterDescription,
      }),
    );

    expect(
      document.querySelector('[data-testid="share-description"]'),
    ).toBeNull();
    expect(body()?.textContent?.split('Ship a build').length).toBe(2);
  });

  // CAN-4261: under the page's shared header the body adds no title row,
  // no Name/Description card and no repeated `# Title`.
  it('leaves the title and description to the page header', async () => {
    const withFrontmatter = {
      ...skillSnapshot,
      rawSkill:
        '---\nname: deploy\ndescription: Ship a build\n---\n# Deploy\n\nRun the release.\n',
    };
    await act(async () => {
      root.render(
        <MarketplaceSkillDetailBody
          entity="skill"
          landing={landing({
            state: { phase: 'ready', snapshot: withFrontmatter },
            snapshot: withFrontmatter,
          })}
          onInstall={jest.fn()}
          headerTitle="Deploy"
          headerDescription="Ship a build"
        />,
      );
      await Promise.resolve();
    });
    expect(
      container.querySelectorAll('h1, h2#plugin-detail-title'),
    ).toHaveLength(0);
    expect(body()?.querySelector('dl')).toBeNull();
    expect(body()?.textContent).not.toContain('Ship a build');
    expect(body()?.textContent).not.toContain('Deploy');
    expect(body()?.textContent).toContain('Run the release.');
  });

  it('omits a top description with no visible text', async () => {
    const emptySnapshot = { ...skillSnapshot, description: '---' };
    await render(
      landing({
        state: { phase: 'ready', snapshot: emptySnapshot },
        snapshot: emptySnapshot,
      }),
    );
    expect(
      document.querySelector('[data-testid="share-description"]'),
    ).toBeNull();
  });

  it('shows a skill description at the top when the frontmatter has none', async () => {
    await render(
      landing({
        state: { phase: 'ready', snapshot: skillSnapshot },
        snapshot: skillSnapshot,
      }),
    );

    expect(
      document.querySelector('[data-testid="share-description"]')?.textContent,
    ).toBe('Ship a build');
  });

  it('checks the requirements of a skill shared before packages existed', async () => {
    await render(
      landing({
        state: { phase: 'ready', snapshot: skillSnapshot },
        snapshot: skillSnapshot,
      }),
    );

    expect(
      document.querySelector('[data-testid="deep-link-share-package-summary"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="deep-link-share-skill-readiness"]'),
    ).not.toBeNull();
  });

  it('still lists the requirements when this machine cannot check them', async () => {
    getDependencyReadiness.mockRejectedValue(new Error('ipc gone'));
    await render(
      landing({
        state: { phase: 'ready', snapshot: skillSnapshot },
        snapshot: skillSnapshot,
      }),
    );

    expect(
      document
        .querySelector('[data-testid="pipeline-readiness-mcp-slack"]')
        ?.getAttribute('data-requirement-status'),
    ).toBe('unknown');
  });
});
