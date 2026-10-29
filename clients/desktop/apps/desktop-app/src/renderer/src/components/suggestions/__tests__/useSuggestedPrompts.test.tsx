/**
 * @jest-environment jsdom
 */
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

jest.mock('../suggestedPromptTelemetry', () => ({
  trackSuggestedPromptImpression: jest.fn(),
  trackSuggestedPromptSelection: jest.fn(),
}));

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import type {
  DetectedMcpServerInfo,
  ListDetectedMcpServersResponse,
} from '@canopy/desktop-shared/types/mcp-servers';
import { trackSuggestedPromptImpression } from '../suggestedPromptTelemetry';
import {
  __resetSuggestedPromptsForTests,
  useSuggestedPrompts,
  type UseSuggestedPromptsOptions,
  type UseSuggestedPromptsResult,
} from '../useSuggestedPrompts';

const trackImpressionMock = jest.mocked(trackSuggestedPromptImpression);

const EMPTY_SELECTIONS: ChatTabPluginSelections = {
  collectionIds: [],
  skillRefs: [],
  pluginRefs: [],
};

function connectedServer(curatedKey: string): DetectedMcpServerInfo {
  return {
    key: `standalone:${curatedKey}:default`,
    source: 'standalone',
    serverName: curatedKey,
    displayName: curatedKey,
    type: 'http',
    curatedKey,
    enabled: true,
    authStatus: 'connected',
    authStatusLabel: 'Connected',
    canConnect: false,
  };
}

const listDetectedMock = jest.fn<
  Promise<ListDetectedMcpServersResponse>,
  [unknown]
>();

interface HookProbe {
  current: UseSuggestedPromptsResult | null;
  renders?: UseSuggestedPromptsResult[];
}

function HookHarness({
  selections,
  options,
  probe,
}: {
  selections: ChatTabPluginSelections | null;
  options: UseSuggestedPromptsOptions;
  probe: HookProbe;
}): null {
  probe.current = useSuggestedPrompts(selections, options);
  probe.renders?.push(probe.current);
  return null;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('useSuggestedPrompts', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    jest.clearAllMocks();
    __resetSuggestedPromptsForTests();
    listDetectedMock.mockResolvedValue({ servers: [], warnings: [] });
    Object.defineProperty(window, 'mcpServers', {
      configurable: true,
      value: { listDetected: listDetectedMock },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
  });

  async function render(
    probe: HookProbe,
    selections: ChatTabPluginSelections | null,
    options: UseSuggestedPromptsOptions,
  ): Promise<void> {
    await act(async () => {
      root.render(
        <HookHarness selections={selections} options={options} probe={probe} />,
      );
      await Promise.resolve();
    });
    await flush();
    await flush();
  }

  it('returns no prompts for null selections and performs no fetch', async () => {
    const probe: HookProbe = { current: null };
    await render(probe, null, { surface: 'chat', seedKey: 'chat-1' });
    expect(probe.current?.prompts).toEqual([]);
    expect(listDetectedMock).not.toHaveBeenCalled();
  });

  it('records no impression while the host surface is hidden (null selections)', async () => {
    // Hidden hosts pass null selections; the impression slot must stay free
    // for the visible instance.
    const probe: HookProbe = { current: null };
    await render(probe, null, { surface: 'home', seedKey: 'home' });
    expect(trackImpressionMock).not.toHaveBeenCalled();
  });

  it('picks MCP prompts once the inventory fetch completes and stays stable', async () => {
    listDetectedMock.mockResolvedValue({
      servers: [connectedServer('github')],
      warnings: [],
    });
    const probe: HookProbe = { current: null };
    await render(probe, EMPTY_SELECTIONS, {
      surface: 'chat',
      seedKey: 'chat-1',
    });

    const first = probe.current?.prompts ?? [];
    expect(first.length).toBeGreaterThan(0);
    expect(first.some((prompt) => prompt.curatedKey === 'github')).toBe(true);

    // Re-render with identical inputs: the picked set must not re-roll.
    await render(probe, EMPTY_SELECTIONS, {
      surface: 'chat',
      seedKey: 'chat-1',
    });
    expect(probe.current?.prompts).toEqual(first);
  });

  it('falls back to generic prompts when no eligible MCP exists', async () => {
    listDetectedMock.mockResolvedValue({
      servers: [{ ...connectedServer('github'), authStatus: 'not_connected' }],
      warnings: [],
    });
    const probe: HookProbe = { current: null };
    await render(probe, EMPTY_SELECTIONS, {
      surface: 'chat',
      seedKey: 'chat-1',
    });
    const prompts = probe.current?.prompts ?? [];
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts.every((prompt) => prompt.curatedKey === null)).toBe(true);
  });

  it('uses general-purpose fallbacks on home and developer fallbacks in chat', async () => {
    const homeProbe: HookProbe = { current: null };
    await render(homeProbe, EMPTY_SELECTIONS, {
      surface: 'home',
      seedKey: 'home',
    });
    const home = homeProbe.current?.prompts ?? [];
    expect(home).toHaveLength(3);
    expect(home.every((prompt) => prompt.id.startsWith('generic-home-'))).toBe(
      true,
    );

    const chatProbe: HookProbe = { current: null };
    await render(chatProbe, EMPTY_SELECTIONS, {
      surface: 'chat',
      seedKey: 'chat-1',
    });
    const chat = chatProbe.current?.prompts ?? [];
    expect(chat).toHaveLength(3);
    expect(chat.every((prompt) => /^generic-[1-5]$/.test(prompt.id))).toBe(
      true,
    );
  });

  it('re-picks when the surface changes with the same seed key', async () => {
    const probe: HookProbe = { current: null, renders: [] };
    await render(probe, EMPTY_SELECTIONS, {
      surface: 'home',
      seedKey: 'shared',
    });
    expect(
      probe.current?.prompts.every((prompt) =>
        prompt.id.startsWith('generic-home-'),
      ),
    ).toBe(true);

    const renderCountBeforeSurfaceChange = probe.renders?.length ?? 0;
    await render(probe, EMPTY_SELECTIONS, {
      surface: 'chat',
      seedKey: 'shared',
    });
    const surfaceChangeRenders =
      probe.renders?.slice(renderCountBeforeSurfaceChange) ?? [];
    expect(surfaceChangeRenders[0]?.prompts).toEqual([]);
    expect(
      surfaceChangeRenders.every((result) =>
        result.prompts.every(
          (prompt) => !prompt.id.startsWith('generic-home-'),
        ),
      ),
    ).toBe(true);
    expect(
      probe.current?.prompts.every((prompt) =>
        /^generic-[1-5]$/.test(prompt.id),
      ),
    ).toBe(true);
  });

  it('re-picks when the eligible pool changes', async () => {
    listDetectedMock.mockResolvedValue({
      servers: [connectedServer('github')],
      warnings: [],
    });
    const probe: HookProbe = { current: null };
    await render(probe, EMPTY_SELECTIONS, {
      surface: 'chat',
      seedKey: 'chat-1',
    });
    expect(
      probe.current?.prompts.some((prompt) => prompt.curatedKey === 'github'),
    ).toBe(true);

    listDetectedMock.mockResolvedValue({
      servers: [connectedServer('linear')],
      warnings: [],
    });
    // Structurally different selections force a refetch.
    await render(
      probe,
      { ...EMPTY_SELECTIONS, collectionIds: ['c1'] },
      { surface: 'chat', seedKey: 'chat-1' },
    );
    expect(
      probe.current?.prompts.some((prompt) => prompt.curatedKey === 'linear'),
    ).toBe(true);
    expect(
      probe.current?.prompts.some((prompt) => prompt.curatedKey === 'github'),
    ).toBe(false);
  });

  it('fires exactly one impression per distinct displayed set', async () => {
    listDetectedMock.mockResolvedValue({
      servers: [connectedServer('github')],
      warnings: [],
    });
    const probe: HookProbe = { current: null };
    await render(probe, EMPTY_SELECTIONS, {
      surface: 'chat',
      seedKey: 'chat-1',
    });
    await render(probe, EMPTY_SELECTIONS, {
      surface: 'chat',
      seedKey: 'chat-1',
    });
    expect(trackImpressionMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the pick and single impression across disable/re-enable with unchanged selections', async () => {
    listDetectedMock.mockResolvedValue({
      servers: [connectedServer('github')],
      warnings: [],
    });
    const probe: HookProbe = { current: null };
    await render(probe, EMPTY_SELECTIONS, {
      surface: 'chat',
      seedKey: 'chat-1',
    });
    const first = probe.current?.prompts ?? [];
    expect(first.length).toBeGreaterThan(0);

    // Hide (e.g. panel hidden): hook goes inert.
    await render(probe, null, { surface: 'chat', seedKey: 'chat-1' });
    expect(probe.current?.prompts).toEqual([]);

    // Re-show with the SAME selections: the prior pick is immediately
    // active again (no generic flash, no re-roll) and no second
    // impression fires.
    await render(probe, EMPTY_SELECTIONS, {
      surface: 'chat',
      seedKey: 'chat-1',
    });
    expect(probe.current?.prompts).toEqual(first);
    expect(trackImpressionMock).toHaveBeenCalledTimes(1);
  });

  it('suppresses the stale pick while a selections change is fetching', async () => {
    listDetectedMock.mockResolvedValue({
      servers: [connectedServer('github')],
      warnings: [],
    });
    const probe: HookProbe = { current: null };
    await render(probe, EMPTY_SELECTIONS, {
      surface: 'chat',
      seedKey: 'chat-1',
    });
    expect(
      probe.current?.prompts.some((prompt) => prompt.curatedKey === 'github'),
    ).toBe(true);

    // Switch selections with the replacement fetch never resolving: the
    // github-derived pick must not remain clickable.
    listDetectedMock.mockImplementation(
      () =>
        new Promise(() => {
          // never resolves
        }),
    );
    await render(
      probe,
      { ...EMPTY_SELECTIONS, collectionIds: ['other'] },
      { surface: 'chat', seedKey: 'chat-1' },
    );
    expect(probe.current?.prompts).toEqual([]);
    expect(probe.current?.loading).toBe(true);
  });

  it('holds the picked set across remounts while another instance is mounted', async () => {
    listDetectedMock.mockResolvedValue({
      servers: [connectedServer('github')],
      warnings: [],
    });
    const probeA: HookProbe = { current: null };
    const probeB: HookProbe = { current: null };
    const options: UseSuggestedPromptsOptions = {
      surface: 'home',
      seedKey: 'home',
      holdAcrossMounts: true,
    };
    await act(async () => {
      root.render(
        <>
          <HookHarness
            selections={EMPTY_SELECTIONS}
            options={options}
            probe={probeA}
          />
          <HookHarness
            selections={EMPTY_SELECTIONS}
            options={options}
            probe={probeB}
          />
        </>,
      );
      await Promise.resolve();
    });
    await flush();
    await flush();

    const setA = probeA.current?.prompts ?? [];
    expect(setA.length).toBeGreaterThan(0);
    expect(probeB.current?.prompts).toEqual(setA);
    // Both instances display the same held set: one impression total.
    expect(trackImpressionMock).toHaveBeenCalledTimes(1);
  });
});
