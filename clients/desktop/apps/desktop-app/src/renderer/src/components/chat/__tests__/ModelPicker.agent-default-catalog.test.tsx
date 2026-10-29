/**
 * @jest-environment jsdom
 *
 * The catalog the picker hands its menu for an Agent on the default model
 * (CAN-3999). The menu is replaced by a probe that records its props, so the
 * projected metadata is asserted directly instead of through menu layout.
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type * as UiShared from '@canopy/ui-shared';
import type { ModelCatalogOption } from '@canopy/ui-shared';
import {
  initAgentModels,
  initClaudeModels,
  initCodexModels,
} from '@canopy/desktop-shared/types';
import type { AgentModelRegistryEntry } from '@canopy/desktop-shared/types/agent-models';

let mockCatalog: readonly ModelCatalogOption[] = [];
jest.mock('@canopy/ui-shared', () => ({
  ...jest.requireActual<typeof UiShared>('@canopy/ui-shared'),
  ModelPickerMenu: (props: {
    catalog: readonly ModelCatalogOption[];
  }): ReactNode => {
    mockCatalog = props.catalog;
    return null;
  },
}));
jest.mock('@/components/settings/AuthLoginModal', () => ({
  AuthLoginModal: (): ReactNode => null,
}));
jest.mock('@/hooks/useCursorChatAvailable', () => ({
  useCursorChatAvailable: (): boolean => false,
}));
jest.mock('@/hooks/useCursorModels', () => ({
  useCursorModels: (): { models: never[]; message: undefined } => ({
    models: [],
    message: undefined,
  }),
}));

import { ModelPicker } from '../ModelPicker';

const CODEX_MODEL = 'codex-catalog-test';
const EXTRA_CHARGE_MODEL = 'claude-extra-charge-test';
const AGENT_ID = 'agent_model_catalog_probe';

function agentEntry(baseModel: string): AgentModelRegistryEntry {
  return {
    id: AGENT_ID,
    name: 'Catalog Probe',
    baseModel,
    instructions: '',
    pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    available: true,
  };
}

let root: Root | null = null;

beforeAll(() => {
  initClaudeModels([
    { id: 'opus', label: 'Opus' },
    {
      id: EXTRA_CHARGE_MODEL,
      label: 'Extra Charge Test',
      extraChargeOnly: true,
      extraChargeMessage: 'Requires extra usage credits',
    },
  ]);
  initCodexModels([{ id: CODEX_MODEL, label: 'Codex Catalog Test' }]);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  mockCatalog = [];
});

function agentOption(
  baseModel: string,
  defaultModel = CODEX_MODEL,
): ModelCatalogOption | undefined {
  initAgentModels([agentEntry(baseModel)]);
  root = createRoot(document.body);
  act(() => {
    root?.render(
      createElement(ModelPicker, {
        currentModel: defaultModel,
        onModelChange: (): void => {},
        inheritedDefaultModel: defaultModel,
      }),
    );
  });
  const option = mockCatalog.find((entry) => entry.id === AGENT_ID);
  act(() => {
    root?.unmount();
  });
  root = null;
  return option;
}

it("describes an Agent on the default with its pinned default's metadata", () => {
  const pinned = agentOption(CODEX_MODEL);
  const inheriting = agentOption('default');
  const routeMetadata = (option: ModelCatalogOption | undefined): unknown => ({
    provider: option?.provider,
    harness: option?.harness,
    contextWindow: option?.contextWindow,
    supportedThinkingLevels: option?.supportedThinkingLevels,
    thinkingLevels: option?.thinkingLevels,
  });
  expect(pinned?.harness).toBe('codex');
  expect(inheriting?.id).toBe(AGENT_ID);
  expect(routeMetadata(inheriting)).toEqual(routeMetadata(pinned));
});

it('carries the extra-charge marker of an extra-charge-only default', () => {
  const pinned = agentOption(EXTRA_CHARGE_MODEL, EXTRA_CHARGE_MODEL);
  const inheriting = agentOption('default', EXTRA_CHARGE_MODEL);
  expect(pinned?.extraChargeOnly).toBe(true);
  expect(inheriting).toMatchObject({
    id: AGENT_ID,
    extraChargeOnly: true,
    extraChargeMessage: pinned?.extraChargeMessage,
  });
});
