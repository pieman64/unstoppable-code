/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type * as ReactModule from 'react';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import type {
  AgentProviderType,
  ChatTabPluginSelections,
} from '@canopy/desktop-shared/types';
import type {
  PluginSelectorInheritedDefaults,
  PluginSelectorProviderScope,
} from '../../shared/PluginSelector';

// Capture the providerScope the modal hands down to PluginSelector.
let capturedProviderScope: PluginSelectorProviderScope | undefined;
let capturedSelections: ChatTabPluginSelections | undefined;
let capturedLockedSelections: ChatTabPluginSelections | undefined;
let capturedInheritedDefaults: PluginSelectorInheritedDefaults | undefined;
let capturedOnChange:
  | ((selections: ChatTabPluginSelections) => void)
  | undefined;
let capturedOnSanitizedChange:
  | ((selections: ChatTabPluginSelections) => void)
  | undefined;
let mockSanitizedSelections: ChatTabPluginSelections | null = null;
jest.mock('../../shared/PluginSelector', () => ({
  PluginSelector: ({
    providerScope,
    selections,
    onChange,
    onSanitizedChange,
    lockedSelections,
    inheritedDefaults,
  }: {
    providerScope?: PluginSelectorProviderScope;
    selections: ChatTabPluginSelections;
    onChange: (selections: ChatTabPluginSelections) => void;
    onSanitizedChange?: (selections: ChatTabPluginSelections) => void;
    lockedSelections?: ChatTabPluginSelections;
    inheritedDefaults?: PluginSelectorInheritedDefaults;
  }): null => {
    const React = jest.requireActual<typeof ReactModule>('react');
    React.useEffect(() => {
      if (mockSanitizedSelections) {
        onSanitizedChange?.(mockSanitizedSelections);
      }
    }, [onSanitizedChange, selections]);
    capturedProviderScope = providerScope;
    capturedSelections = selections;
    capturedLockedSelections = lockedSelections;
    capturedInheritedDefaults = inheritedDefaults;
    capturedOnChange = onChange;
    capturedOnSanitizedChange = onSanitizedChange;
    return null;
  },
}));
let capturedOnAppliedSelections:
  | ((selections: ChatTabPluginSelections) => void)
  | undefined;
jest.mock('../../worktree/RecommendedPluginsSettingsPanel', () => ({
  RecommendedPluginsSettingsPanel: ({
    onAppliedSelections,
  }: {
    onAppliedSelections?: (selections: ChatTabPluginSelections) => void;
  }): null => {
    capturedOnAppliedSelections = onAppliedSelections;
    return null;
  },
}));

import { ChatPluginsModal } from '../ChatPluginsModal';

function emptySelections(): ChatTabPluginSelections {
  return {
    collectionIds: [],
    bundleIds: [],
    skillRefs: [],
    pluginRefs: [],
    mcpServerRefs: [],
  };
}

describe('ChatPluginsModal provider scope wiring', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    capturedProviderScope = undefined;
    capturedSelections = undefined;
    capturedLockedSelections = undefined;
    capturedInheritedDefaults = undefined;
    capturedOnChange = undefined;
    capturedOnSanitizedChange = undefined;
    capturedOnAppliedSelections = undefined;
    mockSanitizedSelections = null;
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function mountWith(provider: AgentProviderType | undefined): void {
    act(() => {
      root.render(
        <ChatPluginsModal
          initial={emptySelections()}
          onSave={() => undefined}
          onClose={() => undefined}
          effectiveProviderType={provider}
        />,
      );
    });
  }

  it('passes claude scope when provider is claude', () => {
    mountWith('claude');
    expect(capturedProviderScope).toBe('claude');
  });

  it('passes codex scope when provider is codex', () => {
    mountWith('codex');
    expect(capturedProviderScope).toBe('codex');
  });

  it('passes ollama scope when provider is ollama', () => {
    mountWith('ollama');
    expect(capturedProviderScope).toBe('ollama');
  });

  it('passes opencode scope to keep provider-incompatible plugins disabled', () => {
    mountWith('opencode');
    expect(capturedProviderScope).toBe('opencode');
  });

  it('passes mixed scope when provider is undefined', () => {
    mountWith(undefined);
    expect(capturedProviderScope).toBe('mixed');
  });

  it('records the card and its scrim', () => {
    mountWith(undefined);

    // The modal portals to the document body.
    const card = document.querySelector('[role="dialog"]');
    expect(
      card?.querySelector('[data-testid="plugin-picker-region"]'),
    ).not.toBeNull();
    expect(card?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(false);
    expect(card?.querySelector('h2')?.textContent).toBe('Plugins');
    expect(
      card?.parentElement?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS),
    ).toBe(false);
  });

  it('keeps the plugin picker height-constrained so its table can scroll', () => {
    mountWith(undefined);

    const pickerRegion = document.querySelector(
      '[data-testid="plugin-picker-region"]',
    );
    if (!(pickerRegion instanceof HTMLElement)) {
      throw new Error('Plugin picker region not found');
    }

    expect(Array.from(pickerRegion.classList)).toEqual(
      expect.arrayContaining(['flex', 'flex-1', 'flex-col', 'min-h-0']),
    );
  });

  it('forwards Agent-provided selections as checked and locked', () => {
    const lockedSelections: ChatTabPluginSelections = {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [{ marketplaceId: 'mkt', pluginName: 'review-tools' }],
      mcpServerRefs: [],
    };
    act(() => {
      root.render(
        <ChatPluginsModal
          initial={emptySelections()}
          onSave={() => undefined}
          onClose={() => undefined}
          effectiveProviderType="claude"
          lockedSelections={lockedSelections}
        />,
      );
    });

    expect(capturedSelections?.pluginRefs).toEqual(lockedSelections.pluginRefs);
    expect(capturedLockedSelections).toBe(lockedSelections);
  });

  it('forwards inherited default layers to the picker for badges', () => {
    const inheritedDefaults: PluginSelectorInheritedDefaults = {
      project: {
        ...emptySelections(),
        pluginRefs: [{ marketplaceId: 'mkt', pluginName: 'project-tool' }],
      },
      global: {
        ...emptySelections(),
        pluginRefs: [{ marketplaceId: 'mkt', pluginName: 'global-tool' }],
      },
    };
    act(() => {
      root.render(
        <ChatPluginsModal
          initial={emptySelections()}
          onSave={() => undefined}
          onClose={() => undefined}
          inheritedDefaults={inheritedDefaults}
        />,
      );
    });
    expect(capturedInheritedDefaults).toBe(inheritedDefaults);
  });

  it('disables save until sanitized selections are available', () => {
    const onSave = jest.fn();

    act(() => {
      root.render(
        <ChatPluginsModal
          initial={emptySelections()}
          onSave={onSave}
          onClose={() => undefined}
          effectiveProviderType="claude"
        />,
      );
    });

    const saveButton = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'Save',
    );
    if (!(saveButton instanceof HTMLButtonElement)) {
      throw new Error('Save button not found');
    }

    expect(saveButton.disabled).toBe(true);

    act(() => {
      saveButton.click();
    });

    expect(onSave).not.toHaveBeenCalled();
  });

  it('saves provider-sanitized selections instead of stale raw selections', () => {
    const initial: ChatTabPluginSelections = {
      collectionIds: [],
      bundleIds: [],
      skillRefs: [],
      pluginRefs: [{ marketplaceId: 'mkt', pluginName: 'codex-only' }],
      mcpServerRefs: [],
    };
    mockSanitizedSelections = emptySelections();
    const onSave = jest.fn();

    act(() => {
      root.render(
        <ChatPluginsModal
          initial={initial}
          onSave={onSave}
          onClose={() => undefined}
          effectiveProviderType="claude"
        />,
      );
    });

    const saveButton = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'Save',
    );
    if (!(saveButton instanceof HTMLButtonElement)) {
      throw new Error('Save button not found');
    }

    act(() => {
      saveButton.click();
    });

    expect(onSave).toHaveBeenCalledWith(emptySelections(), true);
  });

  it('preserves staged selections when a parent recreates equivalent initial values', () => {
    const onSave = jest.fn();
    const selected: ChatTabPluginSelections = {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [{ marketplaceId: 'mkt', pluginName: 'windowed-tool' }],
      mcpServerRefs: [],
    };
    const renderModal = (): void => {
      root.render(
        <ChatPluginsModal
          initial={emptySelections()}
          onSave={onSave}
          onClose={() => undefined}
        />,
      );
    };

    act(renderModal);
    act(() => {
      capturedOnChange?.(selected);
      capturedOnSanitizedChange?.(selected);
    });

    // ChatInput historically supplied an inline empty fallback, so unrelated
    // parent renders changed the object identity while preserving its value.
    act(renderModal);

    const saveButton = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'Save',
    );
    if (!(saveButton instanceof HTMLButtonElement)) {
      throw new Error('Save button not found');
    }
    act(() => {
      saveButton.click();
    });

    expect(onSave).toHaveBeenCalledWith(selected, true);
  });

  it('keeps the accepted sign-in route when the picker saves rebuilt selections', () => {
    const route = {
      target: {
        kind: 'plugin' as const,
        marketplaceId: 'curated/cloud',
        pluginName: 'repo-search',
        serverName: 'repo-search',
      },
      handler: 'canopy' as const,
    };
    const initial: ChatTabPluginSelections = {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [
        { marketplaceId: 'curated/cloud', pluginName: 'repo-search' },
      ],
      mcpServerRefs: [],
      mcpHttpAuthPreferences: [route],
    };
    const onSave = jest.fn();
    act(() => {
      root.render(
        <ChatPluginsModal
          initial={initial}
          onSave={onSave}
          onClose={() => undefined}
        />,
      );
    });
    // The picker rebuilds selections from its checkboxes, without routes.
    act(() => {
      capturedOnChange?.(emptySelections());
      capturedOnSanitizedChange?.(emptySelections());
    });
    const saveButton = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'Save',
    );
    if (!(saveButton instanceof HTMLButtonElement)) {
      throw new Error('Save button not found');
    }
    act(() => {
      saveButton.click();
    });

    expect(onSave).toHaveBeenCalledWith(
      { ...emptySelections(), mcpHttpAuthPreferences: [route] },
      true,
    );
  });

  it('shows and saves the per-chat deferred-tools permission', () => {
    const onSave = jest.fn();

    act(() => {
      root.render(
        <ChatPluginsModal
          initial={emptySelections()}
          onSave={onSave}
          onClose={() => undefined}
          showDeferredToolsToggle
          deferredToolsAllowed
        />,
      );
    });

    const toggle = document.querySelector(
      '[data-testid="chat-plugins-deferred-tools-toggle"]',
    );
    const state = document.querySelector(
      '[data-testid="chat-plugins-deferred-tools-state"]',
    );
    if (!(toggle instanceof HTMLButtonElement)) {
      throw new Error('Deferred-tools toggle not found');
    }

    expect(toggle.getAttribute('role')).toBe('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(state?.textContent).toBe('Deferred plugins allowed');

    act(() => {
      toggle.click();
    });

    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(state?.textContent).toBe('Deferred plugins not allowed');

    const saveButton = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'Save',
    );
    if (!(saveButton instanceof HTMLButtonElement)) {
      throw new Error('Save button not found');
    }
    expect(saveButton.disabled).toBe(false);

    act(() => {
      saveButton.click();
    });

    expect(onSave).toHaveBeenCalledWith(emptySelections(), false);
  });

  it('keeps the modal open and reports the transactional save failure', async () => {
    mockSanitizedSelections = emptySelections();
    const onClose = jest.fn();
    let rejectSave!: (error: Error) => void;
    const onSave = jest.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectSave = reject;
        }),
    );

    act(() => {
      root.render(
        <ChatPluginsModal
          initial={emptySelections()}
          onSave={onSave}
          onClose={onClose}
          effectiveProviderType="codex"
        />,
      );
    });

    const saveButton = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'Save',
    );
    if (!(saveButton instanceof HTMLButtonElement)) {
      throw new Error('Save button not found');
    }

    act(() => {
      saveButton.click();
    });
    expect(saveButton.textContent).toBe('Saving…');
    expect(saveButton.disabled).toBe(true);
    expect(
      document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')
        ?.disabled,
    ).toBe(true);

    await act(async () => {
      rejectSave(new Error('injection failed'));
      await Promise.resolve();
    });

    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'Couldn’t update tools. Your current session and selections were kept.',
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(saveButton.textContent).toBe('Save');
  });
  describe('applying a recommendation', () => {
    const KEPT = { marketplaceId: 'mkt', pluginName: 'kept-default' };
    const TURNED_OFF = { marketplaceId: 'mkt', pluginName: 'turned-off' };
    const RECOMMENDED = { marketplaceId: 'mkt', pluginName: 'recommended' };
    const OWN = { marketplaceId: 'mkt', pluginName: 'own-pick' };

    function withPlugins(
      pluginRefs: ChatTabPluginSelections['pluginRefs'],
    ): ChatTabPluginSelections {
      return {
        collectionIds: [],
        skillRefs: [],
        pluginRefs,
        mcpServerRefs: [],
      };
    }

    function clickSave(): void {
      const saveButton = Array.from(document.querySelectorAll('button')).find(
        (button) => button.textContent === 'Save',
      );
      if (!(saveButton instanceof HTMLButtonElement)) {
        throw new Error('Save button not found');
      }
      act(() => {
        saveButton.click();
      });
    }

    it('shows new project defaults as inherited and saves against them', () => {
      const onSave = jest.fn();
      const previousDefaults = withPlugins([KEPT, TURNED_OFF]);
      const newDefaults = withPlugins([KEPT, TURNED_OFF, RECOMMENDED]);
      act(() => {
        root.render(
          <ChatPluginsModal
            // The chat turned one default off and picked a plugin of its own.
            initial={withPlugins([KEPT, OWN])}
            onSave={onSave}
            onClose={() => undefined}
            projectId="project"
            worktreeId="worktree"
            inheritedDefaults={{ project: previousDefaults }}
          />,
        );
      });

      act(() => {
        capturedOnAppliedSelections?.(newDefaults);
      });

      expect(capturedSelections?.pluginRefs).toEqual([KEPT, OWN, RECOMMENDED]);
      expect(capturedInheritedDefaults?.project?.pluginRefs).toEqual(
        newDefaults.pluginRefs,
      );

      act(() => {
        capturedOnSanitizedChange?.(capturedSelections ?? emptySelections());
      });
      clickSave();

      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ pluginRefs: [KEPT, OWN, RECOMMENDED] }),
        true,
        withPlugins([KEPT, TURNED_OFF, RECOMMENDED]),
      );
    });

    it('adds applied defaults to the selection of a chat that does not inherit them', () => {
      const onSave = jest.fn();
      act(() => {
        root.render(
          <ChatPluginsModal
            initial={withPlugins([OWN])}
            onSave={onSave}
            onClose={() => undefined}
            projectId="project"
            worktreeId="worktree"
          />,
        );
      });

      act(() => {
        capturedOnAppliedSelections?.(withPlugins([RECOMMENDED]));
      });

      expect(capturedSelections?.pluginRefs).toEqual([OWN, RECOMMENDED]);

      act(() => {
        capturedOnSanitizedChange?.(capturedSelections ?? emptySelections());
      });
      clickSave();

      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ pluginRefs: [OWN, RECOMMENDED] }),
        true,
      );
    });
  });

  describe('stacking', () => {
    // The Home composer shell is transformed, which makes it a stacking
    // context. A modal rendered inside it cannot rise above later positioned
    // siblings such as the Getting started checklist rows.
    it('portals the dialog out of its host so ancestor stacking contexts cannot trap it', () => {
      container.style.transform = 'translateY(-50%)';
      mountWith(undefined);

      const dialog = document.querySelector('[role="dialog"]');
      if (!(dialog instanceof HTMLElement)) {
        throw new Error('Plugins dialog not found');
      }

      expect(container.contains(dialog)).toBe(false);
      expect(dialog.parentElement?.parentElement).toBe(document.body);
    });

    it('portals into the composer document when it is popped out', () => {
      const popOutDocument = document.implementation.createHTMLDocument();
      act(() => {
        root.render(
          <ChatPluginsModal
            initial={emptySelections()}
            onSave={() => undefined}
            onClose={() => undefined}
            ownerDocument={popOutDocument}
          />,
        );
      });

      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(
        popOutDocument.body.querySelector('[role="dialog"]'),
      ).not.toBeNull();
    });

    it('closes on Escape pressed in the popped-out document', () => {
      const popOutDocument = document.implementation.createHTMLDocument();
      const onClose = jest.fn();
      act(() => {
        root.render(
          <ChatPluginsModal
            initial={emptySelections()}
            onSave={() => undefined}
            onClose={onClose}
            ownerDocument={popOutDocument}
          />,
        );
      });

      act(() => {
        popOutDocument.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape' }),
        );
      });

      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});
