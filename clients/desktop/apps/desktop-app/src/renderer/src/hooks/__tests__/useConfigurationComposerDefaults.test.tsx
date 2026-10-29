/** @jest-environment jsdom */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true });

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  initClaudeModels,
  initCodexModels,
} from '@canopy/desktop-shared/types';
import type { AgentModelConfig, ChatModel } from '@canopy/desktop-shared/types';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import { useChatStore } from '@/stores/chatStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { makeTestPreferences } from '@/test-utils/preferences';
import { useConfigurationComposerDefaults } from '../useConfigurationComposerDefaults';

describe('configuration composer defaults', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    initClaudeModels([{ id: 'claude-sonnet-4-5', label: 'Sonnet' }]);
    initCodexModels([{ id: 'gpt-6-sol', label: 'Codex' }]);
    useChatStore.setState({ modelDefaults: null, approvalDefaultsCache: {} });
    useProjectsStore.setState({ projects: [] });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('does not carry incompatible inherited Codex settings into an explicit Claude model', () => {
    const observed: { model: ChatModel; modelConfig: AgentModelConfig }[] = [];
    function Probe(): null {
      observed.push(
        useConfigurationComposerDefaults(
          { kind: 'unresolved', reason: 'No target' },
          'claude-sonnet-4-5',
          undefined,
          'gpt-6-sol',
          { thinkingLevel: 'max', fastMode: true },
          undefined,
        ),
      );
      return null;
    }
    act(() => root.render(<Probe />));
    const result = observed[observed.length - 1];
    expect(result?.model).toBe('claude-sonnet-4-5');
    expect(result?.modelConfig.fastMode).toBeUndefined();
    expect(result?.modelConfig.thinkingLevel).not.toBe('max');
  });

  function resolveSpeed(
    modelConfig: AgentModelConfig | undefined,
    inheritedModelConfig: AgentModelConfig | undefined,
  ): AgentModelConfig | undefined {
    let config: AgentModelConfig | undefined;
    function Probe(): null {
      config = useConfigurationComposerDefaults(
        { kind: 'unresolved', reason: 'No target' },
        'gpt-6-sol',
        modelConfig,
        'gpt-6-sol',
        inheritedModelConfig,
        undefined,
      ).modelConfig;
      return null;
    }
    act(() => root.render(<Probe />));
    return config;
  }

  it('resolves an inherited Ultra fast speed exactly, with its derived boolean', () => {
    expect(
      resolveSpeed(undefined, { speed: 'ultrafast', fastMode: false }),
    ).toMatchObject({ speed: 'ultrafast', fastMode: false });
  });

  it('lets an explicit legacy boolean in the draft replace an inherited Ultra fast', () => {
    expect(
      resolveSpeed(
        { fastMode: false },
        { speed: 'ultrafast', fastMode: false },
      ),
    ).toMatchObject({ speed: 'standard', fastMode: false });
    expect(
      resolveSpeed({ speed: 'fast', fastMode: true }, { speed: 'ultrafast' }),
    ).toMatchObject({ speed: 'fast', fastMode: true });
  });

  it('uses Regular when nothing records a speed', () => {
    expect(resolveSpeed(undefined, undefined)).toMatchObject({
      speed: 'standard',
      fastMode: false,
    });
  });

  it('uses Advisor preferences while model defaults load, including plugins and approval', async () => {
    const preferences = makeTestPreferences({
      appAdvisorModel: 'gpt-6-sol',
      appAdvisorThinkingLevel: 'medium',
      appAdvisorPluginSelections: {
        collectionIds: ['advisor-collection'],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { loadPreferences: () => Promise.resolve(preferences) },
    });
    useChatStore.setState({
      approvalDefaultsCache: { [APP_ADVISOR_PROJECT_ID]: 'allow' },
    });
    const observed: ReturnType<typeof useConfigurationComposerDefaults>[] = [];
    function Probe(): null {
      observed.push(
        useConfigurationComposerDefaults(
          { kind: 'advisor' },
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
        ),
      );
      return null;
    }
    await act(async () => {
      root.render(<Probe />);
      await Promise.resolve();
    });
    const result = observed[observed.length - 1];
    expect(result?.model).toBe('gpt-6-sol');
    expect(result?.modelConfig.thinkingLevel).toBe('medium');
    expect(result?.approvalMode).toBe('allow');
    expect(result?.selections?.collectionIds).toEqual(['advisor-collection']);
  });
});
