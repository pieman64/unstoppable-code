/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';
import {
  PluginSection,
  StandaloneConfigsSection,
  type McpPluginSectionContext,
  type McpPluginSectionServer,
} from '../McpServerDetailSections';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('PluginSection', () => {
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

  function render(
    server: McpPluginSectionServer,
    context: McpPluginSectionContext,
  ): void {
    act(() => {
      root.render(
        <PluginSection
          server={server}
          loading={false}
          error={null}
          context={context}
        />,
      );
    });
  }

  /** The value beside the "Author" label, as a reader sees it. */
  function authorShown(): string | null | undefined {
    const label = Array.from(container.querySelectorAll('dt')).find(
      (dt) => dt.textContent === 'Author',
    );
    return label?.nextElementSibling?.textContent;
  }

  it('credits an official wrapper to the product vendor', () => {
    // An MCP server contributed by OpenAI's GitHub listing: the feed names
    // OpenAI as author, while the plugin card and detail credit GitHub.
    render(
      { marketplaceId: 'openai-curated', pluginName: 'github' },
      {
        marketplace: { name: 'Codex official' },
        plugin: { name: 'github', version: '0.1.4', author: 'OpenAI' },
      },
    );

    expect(authorShown()).toBe('GitHub');
  });

  it('keeps the declared author for a plugin outside the official feed', () => {
    // The name alone is not trusted: a community plugin called `github` is
    // not GitHub's.
    render(
      { marketplaceId: 'community-marketplace', pluginName: 'github' },
      {
        marketplace: { name: 'Community' },
        plugin: { name: 'github', author: 'OpenAI' },
      },
    );

    expect(authorShown()).toBe('OpenAI');
  });

  it('renders every plugin and marketplace value', () => {
    render(
      { marketplaceId: 'acme-private', pluginName: 'deal-room' },
      {
        marketplace: {
          name: 'Acme private',
          description: 'Internal tools',
          sourceType: 'github',
          sourceUrl: 'acme/private-market',
        },
        plugin: {
          name: 'deal-room',
          version: '1.2.0',
          description: 'Tracks deals',
          author: 'Acme',
          category: 'Finance',
          homepage: 'https://acme.example/deal-room',
          externalSource: { url: 'https://git.acme.example/deal-room' },
        },
      },
    );

    const values = Array.from(container.querySelectorAll('dd'));
    expect(values).toHaveLength(9);
  });

  it('shows a load error', () => {
    act(() => {
      root.render(
        <PluginSection
          server={{}}
          loading={false}
          error="Couldn't read /Users/me/.claude/plugins"
          context={null}
        />,
      );
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Couldn't read /Users/me/.claude/plugins",
    );
  });
});

describe('StandaloneConfigsSection', () => {
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

  it('shows configuration names, descriptions, and keys', () => {
    act(() => {
      root.render(
        <StandaloneConfigsSection
          loading={false}
          error={null}
          serverData={{
            configs: [
              {
                id: 'c1',
                name: 'Acme prod',
                description: 'Production tenant',
                enabled: true,
                envVars: { ACME_TENANT: 'x' },
                extraArgs: ['--tenant', 'acme'],
                extraHeaders: { 'X-Acme-Org': 'y' },
                authToken: 'secret',
              },
            ],
          }}
        />,
      );
    });
    const leaf = (text: string): Element | undefined =>
      Array.from(container.querySelectorAll('*')).find(
        (element) =>
          element.childElementCount === 0 && element.textContent === text,
      );
    for (const text of [
      'Acme prod',
      'Production tenant',
      'ACME_TENANT',
      '--tenant acme',
      'X-Acme-Org',
    ]) {
      expect(leaf(text)).toBeDefined();
    }
    // Extra args can carry credentials, so session replay blocks them.
    expect(
      leaf('--tenant acme')?.closest(`.${REPLAY_BLOCK_CLASS}`),
    ).not.toBeNull();
    expect(leaf('Acme prod')?.closest(`.${REPLAY_BLOCK_CLASS}`)).toBeNull();
  });
});
