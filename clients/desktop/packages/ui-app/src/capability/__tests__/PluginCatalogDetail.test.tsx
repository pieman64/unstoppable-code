/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { UnifiedEntryAlternative } from '@canopy/ui-shared';
import {
  PluginCatalogDetail,
  type PluginCatalogDetailModel,
} from '../PluginCatalogDetail';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const entry: PluginCatalogDetailModel = {
  name: 'Slack',
  description: 'Search and send Slack messages.',
  categories: [],
  components: { skills: 2, mcpServers: 1, commands: 0, agents: 0 },
};

const codex: UnifiedEntryAlternative = {
  entryId: 'mkt:openai-curated/slack',
  label: 'Codex official',
  ref: {
    type: 'marketplace-plugin',
    marketplaceId: 'openai-curated',
    pluginName: 'slack',
  },
};

const other: UnifiedEntryAlternative = {
  entryId: 'mkt:openai-curated-remote/slack',
  label: 'Codex · Remote',
  ref: {
    type: 'marketplace-plugin',
    marketplaceId: 'openai-curated-remote',
    pluginName: 'slack',
  },
};

describe('PluginCatalogDetail — also available from (CAN-3653)', () => {
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

  function line(): Element | null {
    return container.querySelector(
      '[data-testid="plugin-catalog-detail-also-available"]',
    );
  }

  it('links the same app from another catalog', () => {
    const onOpenEntryId = jest.fn<void, [string]>();
    act(() =>
      root.render(
        <PluginCatalogDetail
          entry={entry}
          alternatives={[codex]}
          onOpenEntryId={onOpenEntryId}
        />,
      ),
    );
    expect(line()?.textContent).toBe('Also available from Codex official');
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="plugin-catalog-detail-also-available-mkt:openai-curated/slack"]',
        )
        ?.click(),
    );
    expect(onOpenEntryId).toHaveBeenCalledWith('mkt:openai-curated/slack');
  });

  it('joins several alternatives', () => {
    act(() =>
      root.render(
        <PluginCatalogDetail entry={entry} alternatives={[codex, other]} />,
      ),
    );
    expect(line()?.textContent).toBe(
      'Also available from Codex official, Codex · Remote',
    );
  });

  it('renders nothing without alternatives', () => {
    act(() => root.render(<PluginCatalogDetail entry={entry} />));
    expect(line()).toBeNull();
  });
});
