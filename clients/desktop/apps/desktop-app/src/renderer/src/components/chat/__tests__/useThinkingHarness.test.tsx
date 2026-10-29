/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ModelHarnessAssignmentSnapshot } from '@canopy/desktop-shared/types';
import { initModelHarnessAssignments } from '@canopy/desktop-shared/types';
import { useModelCatalogStore } from '@/stores/modelCatalogStore';
import { useThinkingHarness } from '../useThinkingHarness';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const MODEL_ID = 'gateway-configurable-model';

function assignmentSnapshot(
  revision: number,
  harness: 'claude' | 'codex',
): ModelHarnessAssignmentSnapshot {
  return {
    revision,
    assignments: [
      {
        modelId: MODEL_ID,
        source: 'ai-gateway',
        harness,
        defaultHarness: 'claude',
        configurable: true,
        overridden: harness !== 'claude',
      },
    ],
  };
}

function ThinkingHarnessProbe(): JSX.Element {
  const harness = useThinkingHarness({
    lockedHarness: undefined,
    model: MODEL_ID,
    effectiveProviderType: 'claude',
  });
  return <output data-testid="thinking-harness">{harness}</output>;
}

describe('useThinkingHarness', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    const snapshot = assignmentSnapshot(1, 'claude');
    initModelHarnessAssignments(snapshot);
    useModelCatalogStore.setState({ harnessAssignments: snapshot });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useModelCatalogStore.setState({ harnessAssignments: null });
    initModelHarnessAssignments({ revision: 0, assignments: [] });
  });

  it('updates mounted composer thinking semantics when an assignment changes', () => {
    act(() => root.render(<ThinkingHarnessProbe />));
    expect(container.textContent).toBe('claude');

    const reassigned = assignmentSnapshot(2, 'codex');
    act(() => {
      initModelHarnessAssignments(reassigned);
      useModelCatalogStore.setState({ harnessAssignments: reassigned });
    });

    expect(container.textContent).toBe('codex');
  });
});
