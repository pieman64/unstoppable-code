/**
 * @jest-environment jsdom
 *
 * Phase F4 Step 2: the settings model preference rows are helper-only surfaces
 * whose execution paths do NOT resolve custom Agent models, so Agent models
 * (`agent_model_*`) are intentionally EXCLUDED from their dropdown options.
 * This test pins that exclusion.
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  AGENT_MODELS,
  initAgentModels,
  initClaudeModels,
} from '@canopy/desktop-shared/types';
import type { AgentModelRegistryEntry } from '@canopy/desktop-shared/types/agent-models';
import {
  settingsSelectOptionValues,
  settingsSelectTrigger,
} from '@canopy/ui-app/settings/__tests__/helpers/settings-select';
import { ModelThinkingPreferenceRow } from '../ModelThinkingPreferenceRow';

const BASE_MODEL = 'claude-settings-test';
const AGENT_ID = 'agent_model_settings_reviewer';

beforeAll(() => {
  initClaudeModels([{ id: BASE_MODEL, label: 'Claude Settings Test' }]);
});

let root: Root | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = '';
  initAgentModels([]);
});

function agentEntry(): AgentModelRegistryEntry {
  return {
    id: AGENT_ID,
    name: 'Settings Reviewer',
    baseModel: BASE_MODEL,
    instructions: '',
    pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    available: true,
  };
}

it('excludes custom Agent models from the settings model select', () => {
  initAgentModels([agentEntry()]);
  expect(AGENT_MODELS).toContain(AGENT_ID);

  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      createElement(ModelThinkingPreferenceRow, {
        title: 'Test model',
        description: 'desc',
        model: BASE_MODEL,
        thinkingLevel: 'medium',
        defaultThinkingLevel: 'medium',
        onModelChange: () => {},
        onThinkingChange: () => {},
        testIdPrefix: 'agents-exclusion',
      }),
    );
  });

  const options = settingsSelectOptionValues(
    settingsSelectTrigger(host, '[data-testid="agents-exclusion-model"]'),
  );
  // The real base model is offered…
  expect(options).toContain(BASE_MODEL);
  // …but no Agent model appears as an option.
  expect(options).not.toContain(AGENT_ID);
  expect(options.some((value) => value.startsWith('agent_model_'))).toBe(false);
});
