/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { GlobalInstructionsConfig } from '@canopy/desktop-shared/types';
import {
  createEmptyGlobalInstructionsConfig,
  initAiGatewayModels,
} from '@canopy/desktop-shared/types';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { GlobalInstructionsSettings } from '../GlobalInstructionsSettings';

describe('GlobalInstructionsSettings', () => {
  let container: HTMLDivElement;
  let root: Root;
  let latestConfig: GlobalInstructionsConfig;
  const onChange = jest.fn((next: GlobalInstructionsConfig): void => {
    latestConfig = next;
  });

  function render(config: GlobalInstructionsConfig): void {
    act(() => {
      root.render(
        <GlobalInstructionsSettings config={config} onChange={onChange} />,
      );
    });
  }

  beforeEach(() => {
    onChange.mockClear();
    latestConfig = createEmptyGlobalInstructionsConfig();
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

  function query(testId: string): HTMLElement | null {
    return container.querySelector(`[data-testid="${testId}"]`);
  }

  it('renders both sections with their overall textareas', () => {
    render(createEmptyGlobalInstructionsConfig());

    expect(query('settings-global-instructions')).not.toBeNull();
    expect(query('settings-global-instructions-chats')).not.toBeNull();
    expect(query('settings-global-instructions-pipelines')).not.toBeNull();
    expect(query('global-instructions-chats-overall')).not.toBeNull();
    expect(query('global-instructions-pipelines-overall')).not.toBeNull();
  });

  it('blocks the instruction editors from session replay, keeping section headings recorded', () => {
    render(createEmptyGlobalInstructionsConfig());

    expect(
      query('settings-global-instructions')?.classList.contains(
        POSTHOG_REPLAY_BLOCK_CLASS,
      ),
    ).toBe(false);
    for (const kind of ['chats', 'pipelines']) {
      // The instruction text and scoped rules are user content.
      const editor = query(`global-instructions-${kind}-overall`);
      const block = editor?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`);
      expect(block).not.toBeNull();
      expect(
        query(`global-instructions-${kind}-add`)?.closest(
          `.${POSTHOG_REPLAY_BLOCK_CLASS}`,
        ),
      ).toBe(block);
      // The section heading sits outside the block.
      const heading = query(
        `settings-global-instructions-${kind}`,
      )?.querySelector('h2');
      expect(heading?.textContent).toBe(
        kind === 'chats' ? 'Chats' : 'Workflows',
      );
      expect(heading?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBeNull();
    }
  });

  it('adds a scoped instruction with append defaults', () => {
    render(createEmptyGlobalInstructionsConfig());

    act(() => {
      query('global-instructions-chats-add')?.click();
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(latestConfig.chats.scoped).toHaveLength(1);
    expect(latestConfig.chats.scoped[0]).toMatchObject({
      text: '',
      mode: 'append',
      harnesses: [],
      models: [],
      workspaceTypes: [],
    });
    expect(latestConfig.chats.scoped[0].id).toBeTruthy();
  });

  it('shows workspace-type narrowing only for the chats sub-section', () => {
    const config = createEmptyGlobalInstructionsConfig();
    config.chats.scoped = [
      {
        id: 'chat-item',
        text: '',
        mode: 'append',
        harnesses: [],
        models: [],
        workspaceTypes: [],
      },
    ];
    config.pipelines.scoped = [
      {
        id: 'pipeline-item',
        text: '',
        mode: 'append',
        harnesses: [],
        models: [],
        workspaceTypes: [],
      },
    ];
    render(config);

    expect(
      query('global-instructions-chats-item-0-workspace-cowork'),
    ).not.toBeNull();
    expect(
      query('global-instructions-chats-item-0-workspace-app-advisor'),
    ).not.toBeNull();
    expect(
      query('global-instructions-pipelines-item-0-workspace-cowork'),
    ).toBeNull();
    expect(
      query('global-instructions-pipelines-item-0-harness-claude'),
    ).not.toBeNull();
  });

  it('shows a non-blocking priority warning when an earlier replace overlaps a later item', () => {
    const config = createEmptyGlobalInstructionsConfig();
    config.chats.scoped = [
      {
        id: 'first-replace',
        text: 'replace text',
        mode: 'replace',
        harnesses: ['claude'],
        models: [],
        workspaceTypes: [],
      },
      {
        id: 'second-replace',
        text: 'suppressed text',
        mode: 'replace',
        harnesses: ['claude'],
        models: [],
        workspaceTypes: [],
      },
    ];
    render(config);

    expect(query('global-instructions-chats-item-0-warning')).toBeNull();
    const warning = query('global-instructions-chats-item-1-warning');
    expect(warning).not.toBeNull();
    expect(warning?.textContent).toContain('Replace #1 takes priority');
    // Non-blocking: both textareas remain editable.
    const text = query('global-instructions-chats-item-1-text');
    expect(text?.hasAttribute('disabled')).toBe(false);
  });

  it('offers gateway-only models once and includes their assigned harness in overlap warnings', () => {
    initAiGatewayModels(
      [
        {
          id: 'gateway-only-codex',
          label: 'Gateway Only Codex',
          recommendedHarness: 'codex',
          contextWindow: 100_000,
          supportsPromptCaching: false,
          supportedThinkingLevels: [],
          toolSchemaProfile: 'standard',
        },
        {
          id: 'gateway-only-codex',
          label: 'Gateway Only Codex',
          recommendedHarness: 'codex',
          contextWindow: 100_000,
          supportsPromptCaching: false,
          supportedThinkingLevels: [],
          toolSchemaProfile: 'standard',
        },
      ],
      [
        {
          modelId: 'gateway-only-codex',
          gatewayId: 'vendor/gateway-only-codex',
          family: 'chat',
          recommendedHarness: 'codex',
          gatewayOnly: true,
          contextWindow: 100_000,
          supportsPromptCaching: false,
          supportedThinkingLevels: [],
          toolSchemaProfile: 'standard',
        },
      ],
    );
    const config = createEmptyGlobalInstructionsConfig();
    config.chats.scoped = [
      {
        id: 'codex-replace',
        text: 'replace codex',
        mode: 'replace',
        harnesses: ['codex'],
        models: [],
        workspaceTypes: [],
      },
      {
        id: 'gateway-append',
        text: 'gateway append',
        mode: 'append',
        harnesses: [],
        models: ['gateway-only-codex'],
        workspaceTypes: [],
      },
    ];

    try {
      render(config);

      expect(
        container.querySelectorAll(
          '[data-testid="global-instructions-chats-item-0-model-gateway-only-codex"]',
        ),
      ).toHaveLength(1);
      expect(
        query('global-instructions-chats-item-1-warning')?.textContent,
      ).toContain('Replace #1 overrides');
    } finally {
      initAiGatewayModels([], []);
    }
  });

  it('reorders scoped instructions with the move buttons', () => {
    const config = createEmptyGlobalInstructionsConfig();
    config.pipelines.scoped = [
      {
        id: 'a',
        text: 'first',
        mode: 'append',
        harnesses: [],
        models: [],
        workspaceTypes: [],
      },
      {
        id: 'b',
        text: 'second',
        mode: 'append',
        harnesses: [],
        models: [],
        workspaceTypes: [],
      },
    ];
    render(config);

    act(() => {
      query('global-instructions-pipelines-item-1-move-up')?.click();
    });

    expect(latestConfig.pipelines.scoped.map((item) => item.id)).toEqual([
      'b',
      'a',
    ]);
  });

  it('deletes a scoped instruction and switches modes', () => {
    const config = createEmptyGlobalInstructionsConfig();
    config.chats.scoped = [
      {
        id: 'only',
        text: 'text',
        mode: 'append',
        harnesses: [],
        models: [],
        workspaceTypes: [],
      },
    ];
    render(config);

    act(() => {
      query('global-instructions-chats-item-0-mode-replace')?.click();
    });
    expect(latestConfig.chats.scoped[0].mode).toBe('replace');

    act(() => {
      query('global-instructions-chats-item-0-delete')?.click();
    });
    expect(latestConfig.chats.scoped).toHaveLength(0);
  });
});
