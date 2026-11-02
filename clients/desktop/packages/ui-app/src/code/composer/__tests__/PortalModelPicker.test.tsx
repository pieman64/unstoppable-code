/**
 * @jest-environment jsdom
 */
/**
 * Unit coverage for the portal {@link PortalModelPicker} (CAN-1218). The picker
 * renders the desktop's projected model catalog as provider sections + an
 * Agents section, greys out models whose provider is not signed in on the
 * desktop (and stale custom Agents), and fires `portal.chat.set_model` (via
 * `onSelect`) with the chosen model id. Selection reconciles from the projected
 * `currentModel`, so a prop change moves the checked row.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  MODEL_PICKER_AUTO_REASONS,
  type ModelCatalog,
  type ModelPickerAutoOption,
} from '@canopy/ui-shared';
import type { PortalChatProviderAvailability } from '@canopy/protocol/portal';
import type {
  AgentExecutionHarness,
  ModelLibraryAccess,
} from '@canopy/protocol/models';
import {
  PortalModelPicker,
  type PortalModelPickerProps,
} from '../PortalModelPicker';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const catalog: ModelCatalog = [
  {
    id: 'opus',
    label: 'Opus',
    description: 'Best for complex, long-running work.',
    provider: 'claude',
    kind: 'model',
    available: true,
  },
  {
    id: 'sonnet',
    label: 'Sonnet',
    provider: 'claude',
    kind: 'model',
    available: true,
    extraChargeOnly: true,
    extraChargeMessage: 'AI credits only.',
  },
  {
    id: 'gpt-5.6-terra',
    label: 'GPT 5.6 Terra',
    provider: 'codex',
    kind: 'model',
    available: true,
  },
  {
    id: 'gpt-5.5',
    label: 'GPT 5.5',
    provider: 'codex',
    kind: 'model',
    available: true,
    showMoreOnly: true,
  },
  {
    id: 'ollama-llama',
    label: 'llama',
    provider: 'ollama',
    kind: 'model',
    available: true,
  },
  {
    id: 'agent_model_reviewer',
    label: 'Reviewer',
    provider: 'claude',
    harness: 'claude',
    kind: 'agent',
    available: true,
  },
  {
    id: 'agent_model_stale',
    label: 'Stale Agent',
    provider: 'claude',
    kind: 'agent',
    available: false,
    unavailableReason: 'base_model_unavailable',
  },
];

/**
 * Updated desktop payload: every model row carries an explicit `source`, and
 * `source: 'ai-gateway'` rows also carry their effective `harness`. Rows group
 * by source (gateway rows land in the branded AI Credits section) while
 * `provider` keeps driving availability gating.
 */
const sourcedCatalog: ModelCatalog = [
  {
    id: 'agent_model_reviewer',
    label: 'Reviewer',
    provider: 'claude',
    harness: 'claude',
    kind: 'agent',
    available: true,
  },
  {
    id: 'opus',
    label: 'Opus',
    provider: 'claude',
    source: 'claude',
    kind: 'model',
    available: true,
  },
  {
    id: 'gpt-5.6-terra',
    label: 'GPT 5.6 Terra',
    provider: 'codex',
    source: 'codex',
    kind: 'model',
    available: true,
  },
  {
    id: 'gpt-5.5',
    label: 'GPT 5.5',
    provider: 'codex',
    source: 'codex',
    kind: 'model',
    available: true,
    showMoreOnly: true,
  },
  {
    id: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    provider: 'codex',
    source: 'ai-gateway',
    harness: 'codex',
    kind: 'model',
    available: true,
    description: 'Best for long-running gateway work.',
    extraChargeOnly: true,
    extraChargeMessage: 'Billed to AI Credits.',
  },
  {
    id: 'aurora-lite',
    label: 'Aurora Lite',
    provider: 'claude',
    source: 'ai-gateway',
    harness: 'claude',
    kind: 'model',
    available: true,
  },
  {
    id: 'ollama-llama',
    label: 'llama',
    provider: 'ollama',
    source: 'ollama',
    harness: 'codex',
    kind: 'model',
    available: true,
  },
];

describe('PortalModelPicker', () => {
  let container: HTMLDivElement;
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

  function mount(props: {
    /** Catalog override; defaults to the legacy (no `source`) fixture. */
    catalog?: ModelCatalog;
    currentModel?: string;
    currentModelLabel?: string;
    providerType?: string;
    providerAvailability?: PortalChatProviderAvailability;
    capturedHarness?: AgentExecutionHarness;
    selectedHarness?: AgentExecutionHarness;
    brandDisplayName?: string;
    autoOption?: ModelPickerAutoOption;
    modelLibrary?: {
      access: ModelLibraryAccess;
      onUnlock: (modelId?: string) => void;
    };
    libraryAccess?: ModelLibraryAccess;
    rowReadiness?: PortalModelPickerProps['rowReadiness'];
    onSelect: (modelId: string) => void;
  }): void {
    const { catalog: mountCatalog = catalog, ...rest } = props;
    act(() => {
      root.render(<PortalModelPicker catalog={mountCatalog} {...rest} />);
    });
  }

  function rerender(props: {
    currentModel?: string;
    onSelect: (modelId: string) => void;
  }): void {
    act(() => {
      root.render(<PortalModelPicker catalog={catalog} {...props} />);
    });
  }

  function click(el: Element | null): void {
    act(() => {
      el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  function openMenu(): void {
    click(container.querySelector('[data-testid="portal-chat-model-picker"]'));
  }

  // The menu is portaled to document.body (CAN-1226), so options live outside
  // `container` — query the document.
  function options(): HTMLElement[] {
    return Array.from(
      document.querySelectorAll('[data-testid="portal-chat-model-option"]'),
    ).filter(
      (el): el is HTMLElement =>
        el instanceof HTMLElement && !el.closest('[hidden]'),
    );
  }

  function optionById(id: string): HTMLElement | undefined {
    return options().find((el) => el.getAttribute('data-model-id') === id);
  }

  it.each(['search', 'other tab'])(
    'keeps a cloud model without harness metadata selectable through %s',
    (surface) => {
      const onSelect = jest.fn();
      // The cloud projection preserves missing curation metadata as unknown;
      // its Core model-definition ID remains the selection authority.
      const model: ModelCatalog[number] = {
        id: 'core-model-without-harness',
        label: 'Uncurated cloud model',
        provider: 'unknown',
        source: 'ai-gateway',
        kind: 'model',
        available: true,
      };
      mount({ catalog: [model], onSelect });
      openMenu();
      expect(optionById(model.id)).toBeDefined();
      if (surface === 'search') {
        const search = document.querySelector(
          '[data-testid="portal-chat-model-search"]',
        );
        if (!(search instanceof HTMLInputElement))
          throw new Error('Missing search');
        act(() => {
          Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            'value',
          )?.set?.call(search, model.label);
          search.dispatchEvent(new Event('input', { bubbles: true }));
        });
      } else {
        const tab = document.querySelector(
          '[data-testid="portal-chat-model-harness-tab-other"]',
        );
        expect(tab).not.toBeNull();
        click(tab);
      }
      expect(options().map((option) => option.dataset.modelId)).toEqual([
        model.id,
      ]);
      click(optionById(model.id) ?? null);
      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(onSelect).toHaveBeenCalledWith(model.id);
      expect(model.harness).toBeUndefined();
    },
  );

  describe.each(['cursor', 'copilot', 'opencode'] as const)(
    '%s shared-route navigation regressions',
    (harness) => {
      const routeId = `${harness}:shared-sonnet`;
      const sharedCatalog: ModelCatalog = [
        {
          id: 'sonnet',
          label: 'Sonnet',
          provider: 'claude',
          source: 'claude',
          vendor: 'anthropic',
          kind: 'model',
          available: true,
        },
        {
          id: routeId,
          canonicalModelId: 'sonnet',
          label: 'Sonnet',
          provider: harness,
          source: harness,
          vendor: 'anthropic',
          kind: 'model',
          available: true,
        },
      ];
      afterEach(() => localStorage.removeItem('canopy:model-picker-favorites'));
      it.each(['selection', 'removal'])(
        'restores saved account favorites for %s without duplicates or route loss',
        (action) => {
          const saved = [
            `${harness}::${routeId}`,
            'claude::sonnet',
            `${harness}::sonnet`,
            'unknown::unlisted-model',
          ];
          localStorage.setItem(
            'canopy:model-picker-favorites',
            JSON.stringify(saved),
          );
          const onSelect = jest.fn();
          mount({
            catalog: sharedCatalog,
            providerAvailability: { claude: true, [harness]: true },
            onSelect,
          });
          openMenu();
          click(
            document.querySelector(
              '[data-testid="portal-chat-model-harness-tab-favorites"]',
            ),
          );
          const rows = options().filter(
            (row) =>
              row.getAttribute('data-model-id') === 'sonnet' &&
              !row.closest('[hidden]'),
          );
          expect(rows).toHaveLength(2);
          expect(
            JSON.parse(
              localStorage.getItem('canopy:model-picker-favorites') ?? '[]',
            ),
          ).toEqual(saved);
          if (action === 'selection') {
            click(rows[0] ?? null);
            expect(onSelect).toHaveBeenLastCalledWith(routeId);
          } else {
            click(
              document.querySelector(
                `[data-testid="portal-chat-model-harness-tab-${harness}"]`,
              ),
            );
            const star = Array.from(
              document.querySelectorAll(
                '[data-testid="portal-chat-model-favorite-sonnet"]',
              ),
            ).find((el) => !el.closest('[hidden]'));
            expect(star?.getAttribute('aria-label')).toMatch(/^Remove /);
            click(star ?? null);
            expect(
              JSON.parse(
                localStorage.getItem('canopy:model-picker-favorites') ?? '[]',
              ),
            ).toEqual(['claude::sonnet', 'unknown::unlisted-model']);
            click(
              document.querySelector(
                '[data-testid="portal-chat-model-harness-tab-favorites"]',
              ),
            );
            click(
              options().find(
                (el) =>
                  el.getAttribute('data-model-id') === 'sonnet' &&
                  !el.closest('[hidden]'),
              ) ?? null,
            );
            expect(onSelect).toHaveBeenLastCalledWith('sonnet');
          }
        },
      );
      it.each(['selection', 'removal'])(
        'keeps the account favorite after its shared catalog row disappears for %s',
        (action) => {
          const saved = [
            `${harness}::sonnet`,
            ...(action === 'removal' ? [`${harness}::${routeId}`] : []),
            'claude::sonnet',
            'unknown::unlisted-model',
          ];
          localStorage.setItem(
            'canopy:model-picker-favorites',
            JSON.stringify(saved),
          );
          const onSelect = jest.fn();
          const props = {
            providerAvailability: { claude: true, [harness]: true },
            onSelect,
          };
          mount({ ...props, catalog: sharedCatalog });
          openMenu();
          click(
            document.querySelector(
              '[data-testid="portal-chat-model-harness-tab-favorites"]',
            ),
          );
          expect(
            options().filter(
              (row) => row.getAttribute('data-model-id') === 'sonnet',
            ),
          ).toHaveLength(2);
          mount({
            ...props,
            catalog: sharedCatalog.filter((option) => option.id !== 'sonnet'),
          });
          expect(
            options().filter(
              (row) => row.getAttribute('data-model-id') === routeId,
            ),
          ).toHaveLength(1);
          expect(
            JSON.parse(
              localStorage.getItem('canopy:model-picker-favorites') ?? '[]',
            ),
          ).toEqual(saved);
          // Reopen from persisted canonical keys, not component-local history.
          act(() => root.unmount());
          root = createRoot(container);
          mount({
            ...props,
            catalog: sharedCatalog.filter((option) => option.id !== 'sonnet'),
          });
          openMenu();
          click(
            document.querySelector(
              '[data-testid="portal-chat-model-harness-tab-favorites"]',
            ),
          );
          expect(
            options().filter(
              (row) => row.getAttribute('data-model-id') === routeId,
            ),
          ).toHaveLength(1);
          if (action === 'selection') {
            click(optionById(routeId) ?? null);
            expect(onSelect).toHaveBeenLastCalledWith(routeId);
          } else {
            const star = Array.from(
              document.querySelectorAll('[data-testid]'),
            ).find(
              (el) =>
                el.getAttribute('data-testid') ===
                  `portal-chat-model-favorite-${routeId}` &&
                !el.closest('[hidden]'),
            );
            expect(star).toBeDefined();
            click(star ?? null);
            expect(
              JSON.parse(
                localStorage.getItem('canopy:model-picker-favorites') ?? '[]',
              ),
            ).toEqual(['claude::sonnet', 'unknown::unlisted-model']);
          }
        },
      );

      it.each([true, false, undefined])(
        'keeps Favorites after the last account route disappears and on reopening with account connected %s',
        (connected) => {
          localStorage.setItem(
            'canopy:model-picker-favorites',
            JSON.stringify([`${harness}::sonnet`]),
          );
          const onSelect = jest.fn();
          mount({
            catalog: sharedCatalog,
            providerAvailability: { claude: true, [harness]: true },
            onSelect,
          });
          openMenu();
          click(
            document.querySelector(
              '[data-testid="portal-chat-model-harness-tab-favorites"]',
            ),
          );
          const remaining = sharedCatalog.filter(
            (option) => option.id !== routeId,
          );
          const props = {
            catalog: remaining,
            providerAvailability:
              connected === undefined
                ? { claude: true }
                : { claude: true, [harness]: connected },
            onSelect,
          };
          mount(props);
          expect(
            document.querySelector(
              '[data-testid="portal-chat-model-harness-tab-favorites"]',
            ),
          ).not.toBeNull();
          // A new mount mirrors a reload while the account route is absent.
          act(() => root.unmount());
          root = createRoot(container);
          mount(props);
          openMenu();
          const favorites = document.querySelector(
            '[data-testid="portal-chat-model-harness-tab-favorites"]',
          );
          expect(favorites).not.toBeNull();
          click(favorites);
          const row = options().find(
            (el) =>
              el.getAttribute('data-model-id') === 'sonnet' &&
              !el.closest('[hidden]'),
          );
          expect(row?.getAttribute('aria-disabled')).toBe('true');
          click(row ?? null);
          expect(onSelect).not.toHaveBeenCalled();
          mount({
            catalog: sharedCatalog,
            providerAvailability: { claude: true, [harness]: true },
            onSelect,
          });
          const restored = options().find(
            (el) =>
              el.getAttribute('data-model-id') === 'sonnet' &&
              !el.closest('[hidden]'),
          );
          expect(restored?.getAttribute('aria-disabled')).not.toBe('true');
          click(restored ?? null);
          expect(onSelect).toHaveBeenLastCalledWith(routeId);
        },
      );

      it('does not switch a saved account favorite to native after its route disappears', () => {
        localStorage.setItem(
          'canopy:model-picker-favorites',
          JSON.stringify([`${harness}::${routeId}`, 'claude::sonnet']),
        );
        const onSelect = jest.fn();
        const extraRoutes: ModelCatalog = [
          {
            id: 'other-native',
            label: 'Other model',
            provider: 'claude',
            source: 'claude',
            kind: 'model',
            available: true,
          },
          {
            id: `${harness}:other`,
            canonicalModelId: 'other-native',
            label: 'Other model',
            provider: harness,
            source: harness,
            kind: 'model',
            available: true,
          },
        ];
        const props = {
          providerAvailability: { claude: true, [harness]: true },
          onSelect,
        };
        mount({ ...props, catalog: [...sharedCatalog, ...extraRoutes] });
        openMenu();
        click(
          document.querySelector(
            '[data-testid="portal-chat-model-harness-tab-favorites"]',
          ),
        );
        // A normal favorite edit canonicalizes the old account ID in storage.
        const stars = Array.from(
          document.querySelectorAll(
            '[data-testid="portal-chat-model-favorite-sonnet"]',
          ),
        ).filter((el) => !el.closest('[hidden]'));
        expect(stars).toHaveLength(2);
        click(stars[1] ?? null);
        expect(
          JSON.parse(
            localStorage.getItem('canopy:model-picker-favorites') ?? '[]',
          ),
        ).toEqual([`${harness}::sonnet`]);
        mount({
          ...props,
          catalog: [
            ...sharedCatalog.filter((option) => option.id !== routeId),
            ...extraRoutes,
          ],
        });
        const row = options().find(
          (el) =>
            el.getAttribute('data-model-id') === 'sonnet' &&
            !el.closest('[hidden]'),
        );
        expect(row).toBeDefined();
        expect(row?.getAttribute('aria-disabled')).toBe('true');
        click(row ?? null);
        expect(onSelect).not.toHaveBeenCalled();
        mount({ ...props, catalog: [...sharedCatalog, ...extraRoutes] });
        const restored = options().find(
          (el) =>
            el.getAttribute('data-model-id') === 'sonnet' &&
            !el.closest('[hidden]'),
        );
        expect(restored?.getAttribute('aria-disabled')).not.toBe('true');
        click(restored ?? null);
        expect(onSelect).toHaveBeenCalledWith(routeId);
      });

      it.each(['all', 'favorites'])(
        'keeps the captured account enabled in %s',
        (tab) => {
          localStorage.setItem(
            'canopy:model-picker-favorites',
            JSON.stringify(['claude::sonnet']),
          );
          const onSelect = jest.fn();
          mount({
            catalog: sharedCatalog,
            currentModel: routeId,
            capturedHarness: harness,
            providerAvailability: { claude: false, [harness]: true },
            onSelect,
          });
          openMenu();
          click(
            document.querySelector(
              `[data-testid="portal-chat-model-harness-tab-${tab}"]`,
            ),
          );
          const row = options().find(
            (el) =>
              el.getAttribute('data-model-id') === 'sonnet' &&
              !el.closest('[hidden]'),
          );
          expect(row).toBeDefined();
          expect(row?.getAttribute('aria-checked')).toBe('true');
          expect(row?.getAttribute('aria-disabled')).not.toBe('true');
          click(row ?? null);
          expect(onSelect).toHaveBeenCalledWith(routeId);
        },
      );
      it.each([
        { id: 'opus', label: 'Opus', provider: 'claude' as const },
        { id: 'gpt-native', label: 'GPT Native', provider: 'codex' as const },
      ])('finds native-only $id when shared routes enable tabs', (native) => {
        const onSelect = jest.fn();
        mount({
          catalog: [
            ...sharedCatalog,
            {
              ...native,
              source: native.provider,
              kind: 'model',
              available: true,
            },
          ],
          providerAvailability: { claude: true, codex: true, [harness]: true },
          onSelect,
        });
        openMenu();
        const input = document.querySelector(
          'input[placeholder="Search models"]',
        );
        expect(input).toBeInstanceOf(HTMLInputElement);
        act(() => {
          Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            'value',
          )?.set?.call(input, native.label);
          input?.dispatchEvent(new Event('input', { bubbles: true }));
        });
        const row = options().find(
          (el) =>
            el.getAttribute('data-model-id') === native.id &&
            !el.closest('[hidden]'),
        );
        expect(row).toBeDefined();
        click(row ?? null);
        expect(onSelect).toHaveBeenCalledWith(native.id);
      });
    },
  );

  describe.each(['copilot', 'opencode'] as const)(
    '%s routes for shared models',
    (harness) => {
      const routeId =
        harness === 'copilot'
          ? 'copilot:claude-sonnet-5-5'
          : 'opencode:anthropic%2Fclaude-sonnet-5-5';
      const sharedCatalog: ModelCatalog = [
        {
          id: 'sonnet',
          label: 'Sonnet 5.5',
          provider: 'claude',
          source: 'claude',
          vendor: 'anthropic',
          kind: 'model',
          available: true,
        },
        {
          id: routeId,
          canonicalModelId: 'sonnet',
          label: 'Sonnet 5.5',
          provider: harness,
          source: harness,
          vendor: 'anthropic',
          kind: 'model',
          available: true,
        },
      ];
      it('shows one row and selects the exact account route from its harness tab', () => {
        const onSelect = jest.fn();
        mount({
          catalog: sharedCatalog,
          onSelect,
          providerAvailability: { claude: true, [harness]: true },
        });
        openMenu();
        expect(options().filter((el) => !el.closest('[hidden]'))).toHaveLength(
          1,
        );
        click(
          document.querySelector(
            `[data-testid="portal-chat-model-harness-tab-${harness}"]`,
          ),
        );
        const row = optionById('sonnet');
        expect(row?.closest('[role="group"]')?.getAttribute('aria-label')).toBe(
          'Anthropic',
        );
        click(row ?? null);
        expect(onSelect).toHaveBeenCalledWith(routeId);
      });
      it('honors a named search group in a started managed chat', () => {
        const onSelect = jest.fn();
        mount({
          catalog: sharedCatalog,
          currentModel: routeId,
          capturedHarness: harness,
          providerAvailability: { claude: true, [harness]: true },
          onSelect,
        });
        openMenu();
        const search = document.querySelector(
          '[data-testid="portal-chat-model-search"]',
        );
        if (!(search instanceof HTMLInputElement))
          throw new Error('Missing search');
        act(() => {
          Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            'value',
          )?.set?.call(search, 'Sonnet');
          search.dispatchEvent(new Event('input', { bubbles: true }));
        });
        const row = document.querySelector(
          '[role="group"][aria-label="Claude"] [data-model-id="sonnet"]',
        );
        expect(row).not.toBeNull();
        expect(row?.getAttribute('aria-disabled')).toBe('true');
        click(row);
        expect(onSelect).not.toHaveBeenCalled();
      });
      it('keeps an established account route selected and available without native auth', () => {
        mount({
          catalog: sharedCatalog,
          currentModel: routeId,
          capturedHarness: harness,
          providerAvailability: { claude: false, [harness]: true },
          onSelect: jest.fn(),
        });
        openMenu();
        expect(optionById('sonnet')?.getAttribute('aria-checked')).toBe('true');
        expect(optionById('sonnet')?.getAttribute('aria-disabled')).not.toBe(
          'true',
        );
        expect(optionById(routeId)).toBeUndefined();
      });
      it('keeps a route reachable when the native catalog row is absent', () => {
        const onSelect = jest.fn();
        mount({
          catalog: sharedCatalog.slice(1),
          providerAvailability: { [harness]: true },
          onSelect,
        });
        openMenu();
        click(optionById(routeId) ?? null);
        expect(onSelect).toHaveBeenCalledWith(routeId);
      });
      it('shows account details without credits billing on a shared hosted row', () => {
        mount({
          catalog: sharedCatalog.map((option) =>
            option.id === 'sonnet'
              ? {
                  ...option,
                  source: 'ai-gateway',
                  extraChargeOnly: true,
                  extraChargeMessage: 'Billed to AI Credits.',
                  contextWindow: 200_000,
                }
              : { ...option, contextWindow: 128_000 },
          ),
          providerAvailability: { claude: true, [harness]: true },
          onSelect: jest.fn(),
        });
        openMenu();
        click(
          document.querySelector(
            `[data-testid="portal-chat-model-harness-tab-${harness}"]`,
          ),
        );
        const row = options().find(
          (el) =>
            el.getAttribute('data-model-id') === 'sonnet' &&
            !el.closest('[hidden]'),
        );
        expect(row).toBeDefined();
        expect(row?.textContent).not.toContain('AI Credits');
        expect(row?.querySelector('[aria-label="AI Credits only"]')).toBeNull();
        act(() => {
          row?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        });
        const details = document.querySelector(
          '[data-testid="portal-chat-model-option-detail"]',
        )?.textContent;
        expect(details).toContain('128');
        expect(details).not.toContain('Billed to AI Credits.');
      });
    },
  );

  describe('Cursor routes for shared models', () => {
    const cursorId = 'cursor:claude-sonnet-5-5%5B%5D';
    const sharedCatalog: ModelCatalog = [
      {
        id: 'sonnet',
        label: 'Sonnet 5.5',
        provider: 'claude',
        source: 'claude',
        vendor: 'anthropic',
        kind: 'model',
        available: true,
      },
      Object.assign(
        {
          id: cursorId,
          label: 'Sonnet 5.5',
          provider: 'cursor' as const,
          source: 'cursor' as const,
          vendor: 'anthropic',
          kind: 'model' as const,
          available: true,
        },
        { canonicalModelId: 'sonnet' },
      ),
      {
        id: 'cursor-default',
        label: 'Default',
        provider: 'cursor',
        source: 'cursor',
        kind: 'model',
        available: true,
      },
    ];

    function visibleOptions(): HTMLElement[] {
      return options().filter((el) => !el.closest('[hidden]'));
    }

    it('shows one model in All and sends its exact Cursor ID from the Cursor tab', () => {
      const onSelect = jest.fn();
      mount({
        catalog: sharedCatalog,
        onSelect,
        providerAvailability: { claude: true, cursor: true },
      });
      openMenu();
      expect(
        visibleOptions().filter((el) => el.textContent?.includes('Sonnet 5.5')),
      ).toHaveLength(1);
      click(
        document.querySelector(
          '[data-testid="portal-chat-model-harness-tab-cursor"]',
        ),
      );
      const sonnet = visibleOptions().find(
        (el) => el.getAttribute('data-model-id') === 'sonnet',
      );
      expect(
        sonnet?.closest('[role="group"]')?.getAttribute('aria-label'),
      ).toBe('Anthropic');
      click(sonnet ?? null);
      expect(onSelect).toHaveBeenCalledWith(cursorId);
    });

    it('reconciles an existing Cursor selection to the single model row', () => {
      mount({
        catalog: sharedCatalog,
        currentModel: cursorId,
        capturedHarness: 'cursor',
        providerAvailability: { claude: false, cursor: true },
        onSelect: jest.fn(),
      });
      openMenu();
      const sonnet = visibleOptions().find(
        (el) => el.getAttribute('data-model-id') === 'sonnet',
      );
      expect(sonnet?.getAttribute('aria-checked')).toBe('true');
      expect(sonnet?.getAttribute('aria-disabled')).not.toBe('true');
      expect(
        visibleOptions().some(
          (el) => el.getAttribute('data-model-id') === cursorId,
        ),
      ).toBe(false);
    });

    it('shows the chosen Cursor route in the trigger before the first turn', () => {
      mount({
        catalog: sharedCatalog,
        currentModel: cursorId,
        providerType: 'cursor',
        providerAvailability: { claude: true, cursor: true },
        onSelect: jest.fn(),
      });
      expect(
        container
          .querySelector(
            '[data-testid="portal-chat-model-picker-provider-icon"]',
          )
          ?.getAttribute('data-provider'),
      ).toBe('cursor');
    });

    it('keeps a Cursor-only model reachable when its canonical row was filtered out', () => {
      const onSelect = jest.fn();
      mount({
        catalog: sharedCatalog.filter((option) => option.id !== 'sonnet'),
        providerAvailability: { cursor: true },
        onSelect,
      });
      openMenu();
      expect(optionById(cursorId)).toBeDefined();
      click(optionById(cursorId) ?? null);
      expect(onSelect).toHaveBeenCalledWith(cursorId);
    });

    it('explains the harness lock instead of selecting Claude from the Cursor tab', () => {
      const onSelect = jest.fn();
      mount({
        catalog: sharedCatalog,
        capturedHarness: 'claude',
        providerAvailability: { claude: true, cursor: true },
        onSelect,
      });
      openMenu();
      click(
        document.querySelector(
          '[data-testid="portal-chat-model-harness-tab-cursor"]',
        ),
      );
      const sonnet = visibleOptions().find(
        (el) => el.getAttribute('data-model-id') === 'sonnet',
      );
      expect(sonnet?.getAttribute('aria-disabled')).toBe('true');
      click(sonnet ?? null);
      expect(onSelect).not.toHaveBeenCalled();
    });

    it('honors the Claude tab in a Cursor chat by explaining the harness lock', () => {
      const onSelect = jest.fn();
      mount({
        catalog: sharedCatalog,
        currentModel: cursorId,
        capturedHarness: 'cursor',
        providerAvailability: { claude: true, cursor: true },
        onSelect,
      });
      openMenu();
      click(
        document.querySelector(
          '[data-testid="portal-chat-model-harness-tab-claude"]',
        ),
      );
      const sonnet = visibleOptions().find(
        (el) => el.getAttribute('data-model-id') === 'sonnet',
      );
      expect(sonnet).toBeDefined();
      expect(sonnet?.getAttribute('aria-disabled')).toBe('true');
      click(sonnet ?? null);
      expect(onSelect).not.toHaveBeenCalled();
    });

    it('retains separate variants even when they have the same label', () => {
      const variant = {
        ...sharedCatalog[0],
        id: 'cursor:claude-sonnet-5-5%5Bthinking%3Dfalse%5D',
        source: 'cursor' as const,
        provider: 'cursor' as const,
      };
      mount({
        catalog: [...sharedCatalog, variant],
        providerAvailability: { claude: true, cursor: true },
        onSelect: jest.fn(),
      });
      openMenu();
      expect(
        visibleOptions().filter((el) => el.textContent?.includes('Sonnet 5.5')),
      ).toHaveLength(2);
    });

    it('keeps disconnected Cursor routes disabled with desktop connection guidance', () => {
      const onSelect = jest.fn();
      mount({
        catalog: sharedCatalog,
        capturedHarness: 'cursor',
        providerAvailability: { claude: true, cursor: false },
        onSelect,
      });
      openMenu();
      const sonnet = visibleOptions().find(
        (el) => el.getAttribute('data-model-id') === 'sonnet',
      );
      expect(sonnet?.getAttribute('aria-disabled')).toBe('true');
      click(sonnet ?? null);
      expect(onSelect).not.toHaveBeenCalled();
    });
  });

  describe('model library locks', () => {
    const lockedCatalog: ModelCatalog = catalog.map((option) =>
      option.id === 'opus'
        ? { ...option, libraryEligibility: 'locked' }
        : option.id === 'gpt-5.6-terra'
          ? { ...option, libraryEligibility: 'available' }
          : option,
    );

    it('starts recovery for a host-locked row and never selects it', () => {
      const onUnlock = jest.fn();
      const onSelect = jest.fn();
      mount({
        catalog: lockedCatalog,
        modelLibrary: { access: 'needs_purchase', onUnlock },
        onSelect,
      });
      openMenu();
      const row = optionById('opus');
      expect(row?.getAttribute('data-locked')).toBe('true');
      expect(row?.textContent).toContain('Unlock with AI Credit purchase');
      expect(lockLabel(row)).toBeNull();
      click(row ?? null);
      expect(onUnlock).toHaveBeenCalledWith('opus');
      expect(onSelect).not.toHaveBeenCalled();
    });

    function lockLabel(row: Element | undefined): Element | null {
      return (
        row?.querySelector(
          '[data-testid="portal-chat-model-option-lock-label"]',
        ) ?? null
      );
    }

    it.each([
      ['needs_sign_in', 'Unlock with sign-in', 'Sign in'],
      [
        'needs_sign_in_then_purchase',
        'Unlock with sign-in and AI Credit purchase',
        // CAN-5213: the visible label names both steps.
        'Sign in and buy',
      ],
    ] as const)('labels %s rows with %s', (access, hint, label) => {
      const onUnlock = jest.fn();
      const onSelect = jest.fn();
      mount({
        catalog: lockedCatalog,
        modelLibrary: { access, onUnlock },
        onSelect,
      });
      openMenu();
      const row = optionById('opus');
      expect(lockLabel(row)?.textContent).toBe(label);
      expect(row?.textContent).toContain(hint);
      expect(lockLabel(optionById('gpt-5.6-terra'))).toBeNull();
      click(row ?? null);
      expect(onUnlock).toHaveBeenCalledWith('opus');
      expect(onSelect).not.toHaveBeenCalled();
    });

    it('retains the chosen OpenCode harness when a locked row starts recovery', () => {
      const onUnlock = jest.fn();
      const onSelect = jest.fn();
      mount({
        catalog: lockedCatalog.map((row) =>
          row.id === 'opus'
            ? {
                ...row,
                harnessChoices: [
                  {
                    harness: 'opencode',
                    provider: 'opencode',
                    supportedThinkingLevels: [],
                    supportsImages: false,
                    supportsFastMode: false,
                    contextWindow: 64_000,
                    funding: 'ai-credits',
                  },
                ],
              }
            : row,
        ),
        providerAvailability: { claude: true, opencode: true },
        modelLibrary: { access: 'needs_purchase', onUnlock },
        onSelect,
      });
      openMenu();
      const tab = document.querySelector(
        '[data-testid="portal-chat-model-harness-tab-opencode"]',
      );
      expect(tab).not.toBeNull();
      click(tab);
      const row = optionById('opus');
      expect(row?.getAttribute('data-locked')).toBe('true');
      click(row ?? null);
      expect(onUnlock).toHaveBeenCalledWith('opus', 'opencode');
      expect(onSelect).not.toHaveBeenCalled();
    });

    it('adds no lock or label without reported access', () => {
      mount({ catalog: lockedCatalog, onSelect: jest.fn() });
      openMenu();
      const row = optionById('opus');
      expect(row?.getAttribute('data-locked')).toBeNull();
      expect(lockLabel(row)).toBeNull();
    });

    it('still selects rows the host left available', () => {
      const onUnlock = jest.fn();
      const onSelect = jest.fn();
      mount({
        catalog: lockedCatalog,
        modelLibrary: { access: 'needs_sign_in', onUnlock },
        onSelect,
      });
      openMenu();
      click(optionById('gpt-5.6-terra') ?? null);
      expect(onSelect).toHaveBeenCalledWith('gpt-5.6-terra');
      expect(onUnlock).not.toHaveBeenCalled();
    });

    it('keeps a provider restriction ahead of the lock', () => {
      const onUnlock = jest.fn();
      mount({
        catalog: lockedCatalog,
        providerAvailability: { claude: false, codex: true },
        modelLibrary: { access: 'needs_purchase', onUnlock },
        onSelect: () => {},
      });
      openMenu();
      const row = optionById('opus');
      expect(row?.getAttribute('aria-disabled')).toBe('true');
      expect(row?.getAttribute('data-locked')).toBeNull();
      click(row ?? null);
      expect(onUnlock).not.toHaveBeenCalled();
    });

    it('ignores host locks once access is unlocked', () => {
      const onSelect = jest.fn();
      mount({
        catalog: lockedCatalog,
        modelLibrary: { access: 'unlocked', onUnlock: jest.fn() },
        onSelect,
      });
      openMenu();
      expect(lockLabel(optionById('opus'))).toBeNull();
      click(optionById('opus') ?? null);
      expect(onSelect).toHaveBeenCalledWith('opus');
    });

    describe('availability cues (CAN-5213)', () => {
      const gatewayCatalog: ModelCatalog = [
        ...lockedCatalog,
        {
          id: 'deepseek-v4-pro',
          label: 'DeepSeek V4 Pro',
          provider: 'codex',
          source: 'ai-gateway',
          harness: 'codex',
          vendor: 'deepseek',
          kind: 'model',
          available: true,
          libraryEligibility: 'available',
        },
      ];

      function available(row: Element | undefined): boolean {
        return row?.getAttribute('data-available') === 'true';
      }

      it('never infers Available from library eligibility alone', () => {
        mount({
          catalog: gatewayCatalog,
          modelLibrary: { access: 'needs_sign_in', onUnlock: jest.fn() },
          onSelect: jest.fn(),
        });
        openMenu();
        expect(document.querySelector('[data-available]')).toBeNull();
        expect(lockLabel(optionById('deepseek-v4-pro'))).toBeNull();
      });

      it('makes no claim while readiness is unknown', () => {
        mount({
          catalog: gatewayCatalog,
          modelLibrary: { access: 'needs_sign_in', onUnlock: jest.fn() },
          rowReadiness: {
            usableNow: () => 'unknown',
            creditsSufficient: 'unknown',
            dailyCreditsOn: 'unknown',
            onTurnOnDailyCredits: jest.fn(),
          },
          onSelect: jest.fn(),
        });
        openMenu();
        expect(document.querySelector('[data-available]')).toBeNull();
        expect(lockLabel(optionById('deepseek-v4-pro'))).toBeNull();
      });

      it('marks settled usable rows Available and selects them', () => {
        const onSelect = jest.fn();
        mount({
          catalog: gatewayCatalog,
          modelLibrary: { access: 'needs_sign_in', onUnlock: jest.fn() },
          rowReadiness: {
            usableNow: (id) => (id === 'deepseek-v4-pro' ? 'yes' : 'unknown'),
            creditsSufficient: 'yes',
            dailyCreditsOn: 'no',
          },
          onSelect,
        });
        openMenu();
        const row = optionById('deepseek-v4-pro');
        expect(available(row)).toBe(true);
        // The library lock still wins on its own row.
        expect(available(optionById('opus'))).toBe(false);
        expect(lockLabel(optionById('opus'))?.textContent).toBe('Sign in');
        click(row ?? null);
        expect(onSelect).toHaveBeenCalledWith('deepseek-v4-pro');
      });

      const UNFUNDED = {
        usableNow: () => 'no' as const,
        creditsSufficient: 'no' as const,
        dailyCreditsOn: 'no' as const,
      };

      it('offers no daily-credit lock without a host recovery', () => {
        mount({
          catalog: gatewayCatalog,
          modelLibrary: { access: 'needs_sign_in', onUnlock: jest.fn() },
          rowReadiness: UNFUNDED,
          onSelect: jest.fn(),
        });
        openMenu();
        expect(lockLabel(optionById('deepseek-v4-pro'))).toBeNull();
      });

      it('asks for daily credits when the host can turn them on', () => {
        const onTurnOnDailyCredits = jest.fn();
        const onSelect = jest.fn();
        const readiness = UNFUNDED;
        mount({
          catalog: gatewayCatalog,
          modelLibrary: { access: 'needs_sign_in', onUnlock: jest.fn() },
          rowReadiness: { ...readiness, onTurnOnDailyCredits },
          onSelect,
        });
        openMenu();
        const row = optionById('deepseek-v4-pro');
        expect(lockLabel(row)?.textContent).toBe('Needs free daily credits');
        expect(row?.textContent).toContain(
          'Turn on free daily credits to use this model.',
        );
        click(row ?? null);
        expect(onTurnOnDailyCredits).toHaveBeenCalledTimes(1);
        // The same model and harness recovery would carry for a library lock.
        expect(onTurnOnDailyCredits).toHaveBeenCalledWith(
          'deepseek-v4-pro',
          'codex',
        );
        expect(onSelect).not.toHaveBeenCalled();
      });

      it('adds no cue for an unlocked viewer', () => {
        mount({
          catalog: gatewayCatalog,
          modelLibrary: { access: 'unlocked', onUnlock: jest.fn() },
          rowReadiness: {
            usableNow: () => 'yes',
            creditsSufficient: 'yes',
            dailyCreditsOn: 'yes',
          },
          onSelect: jest.fn(),
        });
        openMenu();
        expect(document.querySelector('[data-available]')).toBeNull();
      });
    });

    it('turns Auto into the recovery action while locked', () => {
      const onUnlock = jest.fn();
      const onSelectAuto = jest.fn();
      mount({
        catalog: lockedCatalog,
        modelLibrary: { access: 'needs_sign_in_then_purchase', onUnlock },
        autoOption: { selected: false, onSelect: onSelectAuto },
        onSelect: () => {},
      });
      openMenu();
      const auto = document.querySelector(
        '[data-testid="portal-chat-model-option-auto"]',
      );
      expect(auto?.textContent).toContain(
        'Unlock with sign-in and AI Credit purchase',
      );
      click(auto);
      expect(onUnlock).toHaveBeenCalledWith();
      expect(onSelectAuto).not.toHaveBeenCalled();
    });
  });

  describe('Auto unavailable action', () => {
    function autoRow(): HTMLElement | null {
      return document.querySelector(
        '[data-testid="portal-chat-model-option-auto"]',
      );
    }

    describe.each(['cursor', 'copilot', 'opencode'] as const)(
      '%s execution routes',
      (harness) => {
        it.each([false, true])(
          'blocks Auto in a captured managed session with described routes=%s',
          (described) => {
            const onSelectAuto = jest.fn();
            const onSelect = jest.fn();
            const mergedCatalog: ModelCatalog = ['sonnet', 'opus'].flatMap(
              (id) => [
                {
                  id,
                  label: id,
                  provider: 'claude',
                  source: 'claude',
                  description: 'A native routing candidate.',
                  kind: 'model',
                  available: true,
                },
                {
                  id: `${harness}:${id}`,
                  canonicalModelId: id,
                  label: id,
                  provider: harness,
                  source: harness,
                  ...(described ? { description: 'An account model.' } : {}),
                  kind: 'model',
                  available: true,
                },
              ],
            );
            mount({
              catalog: mergedCatalog,
              currentModel: `${harness}:sonnet`,
              capturedHarness: harness,
              providerAvailability: {
                claude: true,
                codex: true,
                [harness]: true,
              },
              autoOption: { selected: false, onSelect: onSelectAuto },
              onSelect,
            });
            openMenu();
            click(
              document.querySelector(
                '[data-testid="portal-chat-model-harness-tab-all"]',
              ),
            );
            expect(autoRow()).not.toBeNull();
            expect(
              optionById('sonnet')?.getAttribute('aria-disabled'),
            ).not.toBe('true');
            expect(optionById('opus')?.getAttribute('aria-disabled')).not.toBe(
              'true',
            );
            expect(autoRow()?.getAttribute('aria-disabled')).toBe('true');
            expect(autoRow()?.textContent).toContain(
              harness === 'opencode'
                ? MODEL_PICKER_AUTO_REASONS.unsupportedHarness
                : MODEL_PICKER_AUTO_REASONS.tooFewCandidates,
            );
            click(autoRow());
            expect(onSelectAuto).not.toHaveBeenCalled();
            click(optionById('opus') ?? null);
            expect(onSelect).toHaveBeenCalledWith(`${harness}:opus`);
          },
        );
      },
    );

    it('keeps Auto available for two native execution routes merged with managed rows', () => {
      const onSelectAuto = jest.fn();
      const mergedCatalog: ModelCatalog = ['sonnet', 'opus'].flatMap((id) => [
        {
          id,
          label: id,
          provider: 'claude',
          source: 'claude',
          description: 'A native routing candidate.',
          kind: 'model',
          available: true,
        },
        {
          id: `copilot:${id}`,
          canonicalModelId: id,
          label: id,
          provider: 'copilot',
          source: 'copilot',
          kind: 'model',
          available: true,
        },
      ]);
      mount({
        catalog: mergedCatalog,
        currentModel: 'sonnet',
        capturedHarness: 'claude',
        providerAvailability: { claude: true, copilot: true },
        autoOption: { selected: false, onSelect: onSelectAuto },
        onSelect: jest.fn(),
      });
      openMenu();
      click(
        document.querySelector(
          '[data-testid="portal-chat-model-harness-tab-all"]',
        ),
      );
      expect(autoRow()).not.toBeNull();
      expect(autoRow()?.getAttribute('aria-disabled')).not.toBe('true');
      click(autoRow());
      expect(onSelectAuto).toHaveBeenCalledTimes(1);
    });

    it('passes the host fix through for the host reason', () => {
      const onUnavailableAction = jest.fn();
      const onSelectAuto = jest.fn();
      mount({
        onSelect: () => {},
        autoOption: {
          selected: false,
          onSelect: onSelectAuto,
          unavailableReason: MODEL_PICKER_AUTO_REASONS.noCredits,
          unavailableAction: onUnavailableAction,
        },
      });
      openMenu();
      expect(autoRow()?.getAttribute('role')).toBe('menuitem');
      click(autoRow());
      expect(onUnavailableAction).toHaveBeenCalledTimes(1);
      expect(onSelectAuto).not.toHaveBeenCalled();
    });

    it('drops the host fix when the picker owns the reason', () => {
      // Only `opus` carries the description Auto needs, so the picker itself
      // blocks Auto with the candidate-count reason, which has nothing to open.
      const onUnavailableAction = jest.fn();
      const onSelectAuto = jest.fn();
      mount({
        onSelect: () => {},
        autoOption: {
          selected: false,
          onSelect: onSelectAuto,
          unavailableAction: onUnavailableAction,
        },
      });
      openMenu();
      expect(autoRow()?.textContent).toContain(
        MODEL_PICKER_AUTO_REASONS.tooFewCandidates,
      );
      expect(autoRow()?.getAttribute('aria-disabled')).toBe('true');
      click(autoRow());
      expect(onUnavailableAction).not.toHaveBeenCalled();
      expect(onSelectAuto).not.toHaveBeenCalled();
    });
  });

  /**
   * CAN-2701: the per-model summary, context window, extra-charge note, and
   * unavailable reason all live in one hover detail popover now. The native
   * `title` that used to carry the reason was dropped — with the popover always
   * present, a second OS tooltip behind it only duplicated the text.
   */
  function detailTextFor(id: string): string {
    act(() => {
      optionById(id)?.dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true }),
      );
    });
    return (
      document.querySelector('[data-testid="portal-chat-model-option-detail"]')
        ?.textContent ?? ''
    );
  }

  it('adds no credits tag for pre-purchase access on its flat rows (CAN-5028)', () => {
    // The Portal list carries no credits tag today, so the free label has
    // nothing to replace here; rows never gain a tag from access alone.
    mount({ libraryAccess: 'needs_purchase', onSelect: jest.fn() });
    openMenu();
    expect(
      document.querySelector('[data-testid^="portal-chat-model-row-credits-"]'),
    ).toBeNull();
    expect(document.body.textContent).not.toContain('Free AI Credits');
  });

  it('labels the trigger with the selected model and renders provider + agent sections on open', () => {
    mount({ currentModel: 'opus', onSelect: () => {} });
    const trigger = container.querySelector(
      '[data-testid="portal-chat-model-picker"]',
    );
    expect(trigger?.textContent).toContain('Opus');
    expect(trigger?.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    expect(
      document.querySelector('[data-testid="portal-chat-model-menu"]'),
    ).toBeNull();

    openMenu();
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    const menu = document.querySelector(
      '[data-testid="portal-chat-model-menu"]',
    );
    expect(menu).not.toBeNull();
    // Both hosts share the vendor-grouped order: Agents first, then vendors by
    // declared sortOrder. This legacy fixture declares no vendor at all, so
    // the harness-keyed groups use the neutral "Other models" heading. AI
    // Credits remains a per-row badge.
    expect(options()).toHaveLength(6);
    expect(
      options().map((option) => option.getAttribute('data-model-id')),
    ).toEqual([
      'agent_model_reviewer',
      'agent_model_stale',
      'opus',
      'sonnet',
      'gpt-5.6-terra',
      'ollama-llama',
    ]);
    const menuText = menu?.textContent ?? '';
    expect(menuText).toContain('Other models');
    expect(menuText).not.toContain('Claude');
    expect(menuText).not.toContain('Codex');
    expect(menuText).toContain('Ollama');
    expect(menuText).toContain('Agents');
    expect(detailTextFor('sonnet')).toContain('AI credits only.');
    // Provider logos + agent icon render as SVGs in the section headers.
    expect(menu?.querySelectorAll('svg').length ?? 0).toBeGreaterThanOrEqual(4);
    // The summary is no longer inline (it was always truncated there).
    expect(
      document.querySelector(
        '[data-testid="portal-chat-model-option-description"]',
      ),
    ).toBeNull();
    expect(detailTextFor('opus')).toContain(
      'Best for complex, long-running work.',
    );
    act(() => {
      optionById('opus')?.dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true }),
      );
    });
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Best for complex, long-running work.',
    );
  });

  it('keeps GPT 5.5 in Codex Legacy models and marks Legacy models when it is selected', () => {
    const onSelect = jest.fn();
    mount({ currentModel: 'gpt-5.5', onSelect });
    openMenu();

    expect(optionById('gpt-5.5')).toBeUndefined();
    const more = document.querySelector(
      // These fixtures declare no vendor, so they share the single
      // `vendor:unclaimed` section — and its Legacy models flyout (CAN-2701).
      '[data-testid="portal-chat-model-more-vendor:unclaimed"]',
    );
    expect(more).not.toBeNull();
    expect(more?.textContent).toContain('Legacy models');
    expect(more?.querySelector('svg[data-glyph="check"]')).not.toBeNull();

    click(more);
    const gpt55 = optionById('gpt-5.5');
    expect(gpt55?.getAttribute('aria-checked')).toBe('true');
    click(gpt55 ?? null);
    expect(onSelect).toHaveBeenCalledWith('gpt-5.5');
  });

  it('uses one shared leading rail and text column for provider and model labels', () => {
    mount({ currentModel: 'opus', onSelect: () => {} });
    openMenu();

    const providerLabel = document.querySelector(
      '[data-testid="portal-chat-model-provider-label"]',
    );
    const selectedLabel = optionById('opus')?.querySelector(
      '[data-testid="portal-chat-model-option-label"]',
    );
    const unselectedLabel = optionById('gpt-5.6-terra')?.querySelector(
      '[data-testid="portal-chat-model-option-label"]',
    );
    // Indexed with a plain counter: package specs lint through
    // `tsconfig.test.json`, which inherits `lib: ES2020` but sets no `target`,
    // so tsc falls back to ES5 and cannot type the iteration `.entries()`
    // produces — every downstream member access then reads as `any`. The
    // sibling `tsconfig.json` files fix this per package; the test project has
    // not been given the same treatment yet.
    const rows: (Element | null | undefined)[] = [
      providerLabel?.closest('[data-testid="portal-chat-model-provider"]'),
      selectedLabel?.closest('[data-testid="portal-chat-model-option"]'),
      unselectedLabel?.closest('[data-testid="portal-chat-model-option"]'),
    ];
    const labels: (Element | null | undefined)[] = [
      providerLabel,
      selectedLabel,
      unselectedLabel,
    ];
    for (let index = 0; index < labels.length; index += 1) {
      const label = labels[index];
      const row = rows[index];
      expect(row?.className.split(' ')).toEqual(
        expect.arrayContaining(['gap-2', 'px-2']),
      );
      expect(
        index === 0
          ? row?.querySelector('.h-4.w-4.shrink-0.items-center.justify-center')
          : row?.parentElement?.querySelector(
              '[data-testid^="portal-chat-model-favorite-"]',
            ),
      ).not.toBeNull();
      expect(label?.classList).toContain('truncate');
    }
  });

  it('marks the projected current model as checked and reconciles on prop change', () => {
    const onSelect = jest.fn();
    mount({ currentModel: 'opus', onSelect });
    openMenu();
    expect(optionById('opus')?.getAttribute('aria-checked')).toBe('true');
    expect(optionById('gpt-5.6-terra')?.getAttribute('aria-checked')).toBe(
      'false',
    );

    // A new projected model (desktop → portal reconcile) moves the check. The
    // menu stays open across the re-render, so no need to re-open it.
    rerender({ currentModel: 'gpt-5.6-terra', onSelect });
    expect(optionById('gpt-5.6-terra')?.getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(optionById('opus')?.getAttribute('aria-checked')).toBe('false');
  });

  it('selects once from pointer activation and preserves focus on mousedown', () => {
    const picks: string[] = [];
    mount({ currentModel: 'opus', onSelect: (id) => picks.push(id) });
    openMenu();
    const option = optionById('gpt-5.6-terra') ?? null;
    const down = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      option?.dispatchEvent(down);
    });
    expect(down.defaultPrevented).toBe(true);
    expect(picks).toEqual([]);
    click(option);
    expect(picks).toEqual(['gpt-5.6-terra']);
    expect(
      document.querySelector('[data-testid="portal-chat-model-menu"]'),
    ).toBeNull();
  });

  it.each(['Enter', ' '] as const)(
    'selects once from %s keyboard activation',
    (key) => {
      const picks: string[] = [];
      mount({ currentModel: 'opus', onSelect: (id) => picks.push(id) });
      openMenu();
      const target = optionById('gpt-5.6-terra');
      act(() => {
        target?.focus();
        const event = new KeyboardEvent('keydown', {
          key,
          bubbles: true,
          cancelable: true,
        });
        target?.dispatchEvent(event);
        // The tabbed picker uses native button activation. JSDOM does not
        // synthesize its click; the Portal flow covers real Enter/Space keys.
        if (!event.defaultPrevented) target?.click();
      });
      expect(picks).toEqual(['gpt-5.6-terra']);
      expect(
        document.querySelector('[data-testid="portal-chat-model-menu"]'),
      ).toBeNull();
    },
  );

  // A Cursor row exactly as the desktop projects it: the discovered managed
  // model, grouped under the Cursor provider, with no thinking chip.
  const cursorRow: ModelCatalog[number] = {
    id: 'cursor-default',
    label: 'Cursor default',
    provider: 'cursor',
    source: 'cursor',
    harness: 'cursor',
    kind: 'model',
    available: true,
  };

  it('enables Cursor rows when the desktop reports the runtime available', () => {
    const picks: string[] = [];
    mount({
      catalog: [...catalog, cursorRow],
      currentModel: 'opus',
      providerAvailability: { claude: true, cursor: true },
      onSelect: (id) => picks.push(id),
    });
    openMenu();
    expect(
      optionById('cursor-default')?.getAttribute('aria-disabled'),
    ).not.toBe('true');
    click(optionById('cursor-default') ?? null);
    expect(picks).toEqual(['cursor-default']);
  });

  it.each([
    { label: 'unavailable', availability: { claude: true, cursor: false } },
    { label: 'unknown', availability: { claude: true } },
  ])(
    'disables Cursor rows with connect guidance when the runtime is $label',
    ({ availability }) => {
      const onSelect = jest.fn();
      mount({
        catalog: [...catalog, cursorRow],
        currentModel: 'opus',
        providerAvailability: availability,
        onSelect,
      });
      openMenu();
      expect(optionById('cursor-default')?.getAttribute('aria-disabled')).toBe(
        'true',
      );
      expect(detailTextFor('cursor-default')).toContain(
        'Connect Cursor in the desktop app',
      );
      click(optionById('cursor-default') ?? null);
      expect(onSelect).not.toHaveBeenCalled();
    },
  );

  // An OpenCode row exactly as the desktop projects it: the discovered managed
  // model, grouped under the OpenCode provider, with no thinking chip.
  it('can leave an empty OpenCode selection for a native model without a managed route', () => {
    const onSelect = jest.fn();
    mount({
      selectedHarness: 'opencode',
      currentModel: 'opencode:fixture%2Fmodel',
      providerAvailability: { opencode: true, claude: true },
      onSelect,
      catalog: [
        opencodeRow,
        ...catalog,
        {
          id: 'managed',
          label: 'Managed',
          provider: 'codex',
          source: 'ai-gateway',
          harness: 'codex',
          kind: 'model',
          available: true,
          harnessChoices: [
            {
              harness: 'opencode',
              provider: 'opencode',
              supportedThinkingLevels: [],
              supportsImages: false,
              supportsFastMode: false,
              contextWindow: 64_000,
              funding: 'ai-credits',
            },
          ],
        },
      ],
    });
    openMenu();
    const tab = document.querySelector(
      '[data-testid="portal-chat-model-harness-tab-claude"]',
    );
    expect(tab).not.toBeNull();
    click(tab);
    click(optionById('opus') ?? null);
    expect(onSelect).toHaveBeenCalledWith('opus', 'claude');
  });

  it('selects an advertised OpenCode choice without changing the model identity', () => {
    const picks = jest.fn();
    const row = {
      id: 'native-model',
      label: 'Native model',
      provider: 'codex' as const,
      source: 'codex' as const,
      kind: 'model' as const,
      available: true,
      supportsFastMode: true,
      supportedThinkingLevels: ['high' as const],
      harnessChoices: [
        { harness: 'codex' as const, provider: 'codex' as const },
        {
          harness: 'opencode' as const,
          provider: 'opencode' as const,
          supportedThinkingLevels: [],
          supportsFastMode: false,
          supportsImages: false,
          contextWindow: 64_000,
          funding: 'ai-credits' as const,
        },
      ],
    };
    mount({
      catalog: [row],
      providerAvailability: { codex: false, opencode: true },
      onSelect: picks,
    });
    openMenu();
    const tab = document.querySelector(
      '[data-testid="portal-chat-model-harness-tab-opencode"]',
    );
    expect(tab).not.toBeNull();
    click(tab);
    const option = optionById('native-model');
    expect(option?.getAttribute('aria-disabled')).toBe('false');
    click(option ?? null);
    expect(picks).toHaveBeenCalledWith('native-model', 'opencode');
  });

  const opencodeRow: ModelCatalog[number] = {
    id: 'opencode:fixture%2Fmodel',
    label: 'OpenCode default',
    provider: 'opencode',
    source: 'opencode',
    harness: 'opencode',
    kind: 'model',
    available: true,
  };

  it('enables OpenCode rows when the desktop reports the runtime available', () => {
    const picks: string[] = [];
    mount({
      catalog: [...catalog, opencodeRow],
      currentModel: 'opus',
      providerAvailability: { claude: true, opencode: true },
      onSelect: (id) => picks.push(id),
    });
    openMenu();
    expect(
      optionById('opencode:fixture%2Fmodel')?.getAttribute('aria-disabled'),
    ).not.toBe('true');
    click(optionById('opencode:fixture%2Fmodel') ?? null);
    expect(picks).toEqual(['opencode:fixture%2Fmodel']);
  });

  it.each([
    { label: 'unavailable', availability: { claude: true, opencode: false } },
    { label: 'unknown', availability: { claude: true } },
  ])(
    'disables OpenCode rows with connect guidance when the runtime is $label',
    ({ availability }) => {
      const onSelect = jest.fn();
      mount({
        catalog: [...catalog, opencodeRow],
        currentModel: 'opus',
        providerAvailability: availability,
        onSelect,
      });
      openMenu();
      expect(
        optionById('opencode:fixture%2Fmodel')?.getAttribute('aria-disabled'),
      ).toBe('true');
      expect(detailTextFor('opencode:fixture%2Fmodel')).toContain(
        'Connect OpenCode in the desktop app',
      );
      click(optionById('opencode:fixture%2Fmodel') ?? null);
      expect(onSelect).not.toHaveBeenCalled();
    },
  );

  it('greys out models whose provider is unavailable and blocks their selection', () => {
    const picks: string[] = [];
    mount({
      currentModel: 'opus',
      providerAvailability: { claude: true, codex: false },
      onSelect: (id) => picks.push(id),
    });
    openMenu();
    const codexRow = optionById('gpt-5.6-terra');
    expect(codexRow?.getAttribute('aria-disabled')).toBe('true');
    expect(detailTextFor('gpt-5.6-terra')).toContain('Codex');
    click(codexRow ?? null);
    expect(picks).toEqual([]);
    // An available provider row stays selectable.
    click(optionById('opus') ?? null);
    expect(picks).toEqual(['opus']);
  });

  it('treats unknown (cold-cache) provider availability optimistically as available', () => {
    const picks: string[] = [];
    // No `providerAvailability` at all — every provider key is "unknown".
    mount({ currentModel: 'opus', onSelect: (id) => picks.push(id) });
    openMenu();
    expect(optionById('gpt-5.6-terra')?.getAttribute('aria-disabled')).toBe(
      'false',
    );
    click(optionById('gpt-5.6-terra') ?? null);
    expect(picks).toEqual(['gpt-5.6-terra']);
  });

  it('greys out a stale custom Agent and blocks its selection', () => {
    const picks: string[] = [];
    mount({ currentModel: 'opus', onSelect: (id) => picks.push(id) });
    openMenu();
    const stale = optionById('agent_model_stale');
    expect(stale?.getAttribute('aria-disabled')).toBe('true');
    expect(detailTextFor('agent_model_stale')).toContain('base model');
    click(stale ?? null);
    expect(picks).toEqual([]);
    // An available Agent in the same section is still selectable.
    click(optionById('agent_model_reviewer') ?? null);
    expect(picks).toEqual(['agent_model_reviewer']);
  });

  it('closes on Escape (preventDefault) and does not emit a selection', () => {
    const picks: string[] = [];
    mount({ currentModel: 'opus', onSelect: (id) => picks.push(id) });
    openMenu();
    expect(
      document.querySelector('[data-testid="portal-chat-model-menu"]'),
    ).not.toBeNull();
    const escape = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      document.dispatchEvent(escape);
    });
    expect(escape.defaultPrevented).toBe(true);
    expect(
      document.querySelector('[data-testid="portal-chat-model-menu"]'),
    ).toBeNull();
    expect(picks).toEqual([]);
  });

  // A cloud chat with no explicit pick still RUNS the persona's default on
  // core, so the picker must show that model rather than a bare "Model".
  it("shows the catalog's default row when nothing has been picked", () => {
    const withDefault: ModelCatalog = catalog.map((option) =>
      option.id === 'sonnet' ? { ...option, isDefault: true } : option,
    );
    act(() => {
      root.render(
        <PortalModelPicker catalog={withDefault} onSelect={() => {}} />,
      );
    });
    const trigger = container.querySelector(
      '[data-testid="portal-chat-model-picker"]',
    );
    expect(trigger?.textContent).toContain('Sonnet');
    expect(trigger?.textContent).not.toContain('Model');
  });

  it('shows the desktop lane-resolved gateway default when nothing has been picked', () => {
    const withDefault: ModelCatalog = sourcedCatalog.map((option) =>
      option.id === 'deepseek-v4-pro' ? { ...option, isDefault: true } : option,
    );
    mount({ catalog: withDefault, onSelect: () => {} });

    const trigger = container.querySelector(
      '[data-testid="portal-chat-model-picker"]',
    );
    expect(trigger?.textContent).toContain('DeepSeek V4 Pro');
  });

  it('lets an explicit pick win over the catalog default', () => {
    const withDefault: ModelCatalog = catalog.map((option) =>
      option.id === 'sonnet' ? { ...option, isDefault: true } : option,
    );
    act(() => {
      root.render(
        <PortalModelPicker
          catalog={withDefault}
          currentModel="opus"
          onSelect={() => {}}
        />,
      );
    });
    const trigger = container.querySelector(
      '[data-testid="portal-chat-model-picker"]',
    );
    expect(trigger?.textContent).toContain('Opus');
  });

  it('keeps the bare placeholder when no row is flagged default', () => {
    act(() => {
      root.render(<PortalModelPicker catalog={catalog} onSelect={() => {}} />);
    });
    const trigger = container.querySelector(
      '[data-testid="portal-chat-model-picker"]',
    );
    expect(trigger?.textContent).toContain('Model');
  });

  it('falls back to the projected model label when the id is absent from the catalog', () => {
    mount({
      currentModel: 'unknown-model',
      currentModelLabel: 'Some Model',
      onSelect: () => {},
    });
    const trigger = container.querySelector(
      '[data-testid="portal-chat-model-picker"]',
    );
    expect(trigger?.textContent).toContain('Some Model');
  });

  function sectionLabels(): (string | null)[] {
    return Array.from(
      document.querySelectorAll(
        '[data-testid="portal-chat-model-provider-label"]',
      ),
    ).map((el) => el.textContent);
  }

  describe('source-tagged payloads', () => {
    it('uses neutral headings for native rows without vendor metadata', () => {
      mount({
        catalog: sourcedCatalog,
        currentModel: 'opus',
        onSelect: () => {},
      });
      openMenu();
      // `source: 'ai-gateway'` rows leave their provider sections for the
      // branded gateway section; outside a BrandProvider the section falls
      // back to the 'AI Credits' label (and omits the brand icon).
      // ONE "Other models" section, not one per harness: two adjacent
      // headings reading the same thing is the defect this ticket removes
      // wearing a different label.
      expect(sectionLabels()).toEqual([
        'Agents',
        'Other models',
        'AI Credits',
        'Ollama',
      ]);
      expect(
        options().map((option) => option.getAttribute('data-model-id')),
      ).toEqual([
        'agent_model_reviewer',
        'opus',
        // `gpt-5.5` is `showMoreOnly`, so it lives in the section's Legacy
        // models flyout rather than the main list.
        'gpt-5.6-terra',
        // Both gateway rows take the portal's default vendor sortOrder, so
        // they tie and settle alphabetically by label — matching how desktop
        // has always ordered its AI Credits group.
        'aurora-lite',
        'deepseek-v4-pro',
        'ollama-llama',
      ]);
    });

    it('keeps legacy payloads grouped by harness under neutral headings', () => {
      mount({ currentModel: 'opus', onSelect: () => {} });
      openMenu();
      expect(sectionLabels()).toEqual(['Agents', 'Other models', 'Ollama']);
      expect(
        options().map((option) => option.getAttribute('data-model-id')),
      ).toEqual([
        'agent_model_reviewer',
        'agent_model_stale',
        'opus',
        'sonnet',
        'gpt-5.6-terra',
        'ollama-llama',
      ]);
    });

    it('groups gateway rows by their projected vendor, falling back to the brand only without metadata', () => {
      // Vendor-aware hosts project vendor metadata on gateway rows (mirroring
      // desktop's per-vendor sections); only a metadata-free row falls back to
      // the branded section the host names through `vendorLabels`.
      const familyCatalog: ModelCatalog = [
        {
          id: 'deepseek-v4-pro',
          label: 'DeepSeek V4 Pro',
          provider: 'codex',
          source: 'ai-gateway',
          harness: 'codex',
          kind: 'model',
          available: true,
          family: 'deepseek-v4',
          familyLabel: 'DeepSeek V4',
          vendor: 'deepseek',
          sortOrder: 80,
          extraChargeOnly: true,
        },
        {
          id: 'kimi-k3',
          label: 'Kimi K3',
          provider: 'codex',
          source: 'ai-gateway',
          harness: 'codex',
          kind: 'model',
          available: true,
          family: 'kimi',
          familyLabel: 'Kimi',
          vendor: 'moonshotai',
          sortOrder: 90,
        },
        {
          id: 'aurora-lite',
          label: 'Aurora Lite',
          provider: 'claude',
          source: 'ai-gateway',
          harness: 'claude',
          kind: 'model',
          available: true,
        },
      ];
      mount({
        catalog: familyCatalog,
        currentModel: 'deepseek-v4-pro',
        onSelect: () => {},
      });
      openMenu();

      // Two gateway rows with different vendors land in different sections,
      // ordered by their declared sortOrder, each headed by the vendor's own
      // brand casing; the metadata-free row falls back to AI Credits (400).
      expect(sectionLabels()).toEqual([
        'DeepSeek',
        'Moonshot AI',
        'AI Credits',
      ]);
      expect(
        options().map((option) => option.getAttribute('data-model-id')),
      ).toEqual(['deepseek-v4-pro', 'kimi-k3', 'aurora-lite']);
      // The tabbed browser labels credit billing independently of grouping.
      expect(optionById('deepseek-v4-pro')?.textContent).toContain(
        'AI Credits',
      );
      expect(optionById('kimi-k3')?.textContent).not.toContain('$');
    });

    it('labels the vendorless gateway section with the host brand', () => {
      // The one branch `brandDisplayName` controls: a gateway row with no
      // vendor metadata of its own is filed under the running brand, and only
      // falls back to 'AI Credits' when the host supplies no name. The picker
      // read this from the brand context before it was shared, so without a
      // case here a host that forgets the prop silently renders the fallback.
      const vendorlessGatewayRow: ModelCatalog = [
        {
          id: 'aurora-lite',
          label: 'Aurora Lite',
          provider: 'claude',
          source: 'ai-gateway',
          harness: 'claude',
          kind: 'model',
          available: true,
        },
      ];
      mount({
        catalog: vendorlessGatewayRow,
        brandDisplayName: 'Unstoppable',
        currentModel: 'aurora-lite',
        onSelect: () => {},
      });
      openMenu();

      expect(sectionLabels()).toEqual(['Unstoppable']);
      expect(sectionLabels()).not.toContain('AI Credits');
    });

    it('orders gateway family sections by vendor priority', () => {
      const gatewayRow = (
        id: string,
        label: string,
        vendor: string,
      ): ModelCatalog[number] => ({
        id,
        label,
        provider: 'codex',
        source: 'ai-gateway',
        harness: 'codex',
        kind: 'model',
        available: true,
        family: vendor,
        familyLabel: label,
        vendor,
      });
      mount({
        catalog: [
          gatewayRow('deepseek-v4', 'DeepSeek V4', 'deepseek'),
          gatewayRow('glm-5', 'GLM 5', 'zai'),
          gatewayRow('gpt-5.6', 'GPT 5.6', 'openai'),
          gatewayRow('opus-5', 'Opus 5', 'anthropic'),
          gatewayRow('minimax-m3', 'MiniMax M3', 'minimax'),
        ],
        currentModel: 'opus-5',
        onSelect: () => {},
      });
      openMenu();

      expect(sectionLabels()).toEqual([
        'Opus 5',
        'OpenAI',
        'GLM 5',
        'DeepSeek V4',
        'MiniMax M3',
      ]);
    });

    it('keeps the extraChargeOnly badge and tooltip on gateway rows', () => {
      mount({
        catalog: sourcedCatalog,
        currentModel: 'opus',
        onSelect: () => {},
      });
      openMenu();
      const row = optionById('deepseek-v4-pro');
      expect(row?.getAttribute('aria-disabled')).toBe('false');
      expect(row?.textContent).toContain('AI Credits');
      const detail = detailTextFor('deepseek-v4-pro');
      expect(detail).toContain('Extra charge only');
      expect(detail).toContain('Billed to AI Credits.');
      expect(detail).toContain('Best for long-running gateway work.');
      // Extra-charge copy leads the popover; the description follows.
      expect(detail.indexOf('Billed to AI Credits.')).toBeLessThan(
        detail.indexOf('Best for long-running gateway work.'),
      );
      // The native `title` is gone: the popover carries this content, and a
      // second OS tooltip behind it would only duplicate it.
      expect(row?.getAttribute('title')).toBeNull();
    });

    it('keeps gateway rows selectable when native providers are signed out', () => {
      const picks: string[] = [];
      mount({
        catalog: sourcedCatalog,
        currentModel: 'opus',
        providerAvailability: { claude: false, codex: false },
        onSelect: (id) => picks.push(id),
      });
      openMenu();

      expect(optionById('opus')?.getAttribute('aria-disabled')).toBe('true');
      expect(optionById('gpt-5.6-terra')?.getAttribute('aria-disabled')).toBe(
        'true',
      );
      expect(optionById('deepseek-v4-pro')?.getAttribute('aria-disabled')).toBe(
        'false',
      );
      expect(optionById('aurora-lite')?.getAttribute('aria-disabled')).toBe(
        'false',
      );

      click(optionById('deepseek-v4-pro') ?? null);
      expect(picks).toEqual(['deepseek-v4-pro']);
    });
  });

  describe('captured harness lock', () => {
    it('keeps legacy provider-only Claude rows selectable on a captured Claude harness', () => {
      const picks: string[] = [];
      mount({
        currentModel: 'opus',
        capturedHarness: 'claude',
        onSelect: (id) => picks.push(id),
      });
      openMenu();
      click(
        document.querySelector(
          '[data-testid="portal-chat-model-harness-tab-all"]',
        ),
      );

      expect(optionById('opus')?.getAttribute('aria-disabled')).toBe('false');
      expect(optionById('gpt-5.6-terra')?.getAttribute('aria-disabled')).toBe(
        'true',
      );
      expect(optionById('ollama-llama')?.getAttribute('aria-disabled')).toBe(
        'true',
      );

      click(optionById('opus') ?? null);
      expect(picks).toEqual(['opus']);
    });

    it('keeps legacy provider-only Codex and Ollama rows selectable on a captured Codex harness', () => {
      const picks: string[] = [];
      mount({
        currentModel: 'gpt-5.6-terra',
        capturedHarness: 'codex',
        onSelect: (id) => picks.push(id),
      });
      openMenu();
      click(
        document.querySelector(
          '[data-testid="portal-chat-model-harness-tab-all"]',
        ),
      );

      expect(optionById('opus')?.getAttribute('aria-disabled')).toBe('true');
      expect(optionById('gpt-5.6-terra')?.getAttribute('aria-disabled')).toBe(
        'false',
      );
      expect(optionById('ollama-llama')?.getAttribute('aria-disabled')).toBe(
        'false',
      );

      click(optionById('gpt-5.6-terra') ?? null);
      openMenu();
      click(
        document.querySelector(
          '[data-testid="portal-chat-model-harness-tab-all"]',
        ),
      );
      click(optionById('ollama-llama') ?? null);
      expect(picks).toEqual(['gpt-5.6-terra', 'ollama-llama']);
    });

    it('keeps the trigger logo pinned to the captured harness after the assignment changes', () => {
      const reassignedCatalog: ModelCatalog = sourcedCatalog.map((option) =>
        option.id === 'deepseek-v4-pro'
          ? { ...option, provider: 'claude', harness: 'claude' }
          : option,
      );
      mount({
        catalog: reassignedCatalog,
        currentModel: 'deepseek-v4-pro',
        capturedHarness: 'codex',
        onSelect: () => {},
      });

      expect(
        container
          .querySelector(
            '[data-testid="portal-chat-model-picker-provider-icon"]',
          )
          ?.getAttribute('data-provider'),
      ).toBe('codex');
    });

    it('keeps the Ollama source logo for an Ollama model captured on Codex', () => {
      mount({
        catalog: sourcedCatalog,
        currentModel: 'ollama-llama',
        capturedHarness: 'codex',
        onSelect: () => {},
      });

      expect(
        container
          .querySelector(
            '[data-testid="portal-chat-model-picker-provider-icon"]',
          )
          ?.getAttribute('data-provider'),
      ).toBe('ollama');
    });

    it('disables every codex-effective row under capturedHarness="claude" and blocks selection', () => {
      const picks: string[] = [];
      mount({
        catalog: sourcedCatalog,
        currentModel: 'opus',
        capturedHarness: 'claude',
        onSelect: (id) => picks.push(id),
      });
      openMenu();
      click(
        document.querySelector(
          '[data-testid="portal-chat-model-harness-tab-all"]',
        ),
      );

      // ai-gateway row whose explicit harness is codex.
      const deepseek = optionById('deepseek-v4-pro');
      expect(deepseek?.getAttribute('aria-disabled')).toBe('true');
      expect(detailTextFor('deepseek-v4-pro')).toContain(
        'started on the Claude harness',
      );
      // Rows with no explicit harness fall back to provider-effective:
      // codex → codex, ollama → codex.
      expect(optionById('gpt-5.6-terra')?.getAttribute('aria-disabled')).toBe(
        'true',
      );
      expect(optionById('ollama-llama')?.getAttribute('aria-disabled')).toBe(
        'true',
      );
      // Claude-harness rows (managed, gateway, and agent) stay enabled.
      expect(optionById('opus')?.getAttribute('aria-disabled')).toBe('false');
      expect(optionById('aurora-lite')?.getAttribute('aria-disabled')).toBe(
        'false',
      );
      expect(
        optionById('agent_model_reviewer')?.getAttribute('aria-disabled'),
      ).toBe('false');

      // A disabled row never fires onSelect…
      click(deepseek ?? null);
      click(optionById('gpt-5.6-terra') ?? null);
      expect(picks).toEqual([]);
      // …while an enabled claude-harness gateway row still selects.
      click(optionById('aurora-lite') ?? null);
      expect(picks).toEqual(['aurora-lite']);
    });

    it('disables claude-harness rows under capturedHarness="codex"', () => {
      mount({
        catalog: sourcedCatalog,
        currentModel: 'gpt-5.6-terra',
        capturedHarness: 'codex',
        onSelect: () => {},
      });
      openMenu();
      click(
        document.querySelector(
          '[data-testid="portal-chat-model-harness-tab-all"]',
        ),
      );
      expect(optionById('opus')?.getAttribute('aria-disabled')).toBe('true');
      expect(detailTextFor('opus')).toContain('started on the Codex harness');
      expect(optionById('aurora-lite')?.getAttribute('aria-disabled')).toBe(
        'true',
      );
      expect(optionById('deepseek-v4-pro')?.getAttribute('aria-disabled')).toBe(
        'false',
      );
      expect(optionById('ollama-llama')?.getAttribute('aria-disabled')).toBe(
        'false',
      );
    });

    it('disables an AI SDK row whose effective harness is unknown', () => {
      const unknownHarnessCatalog: ModelCatalog = [
        {
          id: 'uncurated-anthropic',
          label: 'Uncurated Anthropic',
          provider: 'unknown',
          source: 'ai-gateway',
          vendor: 'anthropic',
          kind: 'model',
          available: true,
        },
      ];
      mount({
        catalog: unknownHarnessCatalog,
        currentModel: 'uncurated-anthropic',
        capturedHarness: 'claude',
        onSelect: () => {},
      });
      openMenu();
      click(
        document.querySelector(
          '[data-testid="portal-chat-model-harness-tab-all"]',
        ),
      );

      expect(
        optionById('uncurated-anthropic')?.getAttribute('aria-disabled'),
      ).toBe('true');
    });
  });
});
