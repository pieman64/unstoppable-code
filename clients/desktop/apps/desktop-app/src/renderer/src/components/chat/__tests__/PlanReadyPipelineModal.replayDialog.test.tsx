/**
 * @jest-environment jsdom
 */
// CAN-3119 (F2): `PipelineRunArtifactCard` and `ChatInput` open
// `PlanReadyPipelineModal`, which renders `PipelineTriggerModal`. `DialogModal`
// records its card: the pipeline rows and the input controls are recorded
// (the recorder masks input values). This pins both inside the recorded card.
jest.mock('@/hooks/useSharedPipelineList', () => ({
  useSharedPipelineList: (): Record<string, unknown> => ({
    cloudAccount: null,
    cloudLoading: false,
    rows: [],
    loading: false,
    loadingMore: false,
    nextCursor: null,
    error: null,
    loaded: false,
    refreshShared: jest.fn(),
    loadMoreShared: jest.fn(),
    setFilters: jest.fn(),
    removeSharedRow: jest.fn(),
  }),
}));

jest.mock('@/hooks/useSkillList', () => ({
  useSkillList: (): { skills: never[]; refresh: jest.Mock } => ({
    skills: [],
    refresh: jest.fn(),
  }),
}));

jest.mock('@/hooks/useMarketplaceList', () => ({
  useMarketplaceList: (): { cache: null; refresh: jest.Mock } => ({
    cache: null,
    refresh: jest.fn(),
  }),
}));

jest.mock('@/hooks/useCollectionList', () => ({
  useCollectionList: (): { collections: never[]; refresh: jest.Mock } => ({
    collections: [],
    refresh: jest.fn(),
  }),
}));

jest.mock('@/stores/navigationStore', () => ({
  useNavigationStore: (
    selector: (state: { openSettings: jest.Mock }) => unknown,
  ): unknown => selector({ openSettings: jest.fn() }),
}));

// The real picker pulls in xterm through `AuthLoginModal`, which jsdom cannot
// construct; this pipeline declares no model aliases, so it never renders.
jest.mock('@/components/chat/ModelPicker', () => ({
  ModelPicker: (): null => null,
}));

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  PipelineData,
  PipelineInfo,
} from '@canopy/desktop-shared/types/pipeline';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { PlanReadyPipelineModal } from '../PlanReadyPipelineModal';
import { expectInRecordedDialogCard } from '@/test-utils/replay';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const PIPELINE_NAME = 'Acme customer rollout';
const INPUT_VALUE = 'acme-prod-cluster-7';

function pipelineData(): PipelineData {
  const info: PipelineInfo = {
    id: 'acme-rollout',
    name: PIPELINE_NAME,
    filename: 'acme-rollout.yml',
    description: 'Rolls out the plan to the customer cluster',
    icon: '',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    triggerTypes: ['plan_ready'],
    source: 'user',
    readonly: false,
  };
  return {
    info,
    content: {
      name: info.name,
      description: info.description,
      icon: info.icon,
      on: {
        plan_ready: {
          inputs: {
            target_cluster: { type: 'string', default: INPUT_VALUE },
          },
        },
      },
      jobs: { deploy: { steps: [] } },
    },
  };
}

async function flushAsync(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    await Promise.resolve();
  });
}

describe('PlanReadyPipelineModal session replay', () => {
  const originalApi = Object.getOwnPropertyDescriptor(window, 'api');
  const originalPipelines = Object.getOwnPropertyDescriptor(
    window,
    'pipelines',
  );
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    const data = pipelineData();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { loadPreferences: jest.fn().mockResolvedValue({}) },
    });
    Object.defineProperty(window, 'pipelines', {
      configurable: true,
      value: {
        list: jest.fn().mockResolvedValue({ success: true, data: [data.info] }),
        discoverProject: jest
          .fn()
          .mockResolvedValue({ success: true, data: [] }),
        get: jest.fn().mockResolvedValue({ success: true, data }),
        resolvePluginCollections: jest.fn(),
        savePluginCollectionPreferences: jest.fn(),
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    for (const [key, descriptor] of [
      ['api', originalApi],
      ['pipelines', originalPipelines],
    ] as const) {
      if (descriptor) {
        Object.defineProperty(window, key, descriptor);
      } else {
        Reflect.deleteProperty(window, key);
      }
    }
  });

  it('records the pipeline row and input controls inside the recorded DialogModal card', async () => {
    act(() => {
      root.render(
        <PlanReadyPipelineModal
          onClose={jest.fn()}
          onRun={jest.fn().mockResolvedValue(undefined)}
        />,
      );
    });
    await flushAsync();

    // Select step: the pipeline row names the user's pipeline.
    const row = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.includes(PIPELINE_NAME) === true,
    );
    if (row === undefined) throw new Error('Pipeline row not rendered');
    expect(container.contains(row)).toBe(false);
    const card = expectInRecordedDialogCard(row);
    expect(card.getAttribute('data-testid')).toBe('pipeline-trigger-modal');

    // Configure step: the input carries the value that will be run.
    await click(row);
    await flushAsync();
    const next = card.querySelector(
      '[data-testid="pipeline-trigger-modal-run"]',
    );
    if (next === null) throw new Error('Continue control not rendered');
    await click(next);
    await flushAsync();

    const input = document.querySelector<HTMLInputElement>(
      '#trigger-input-target_cluster',
    );
    if (input === null) throw new Error('Pipeline input not rendered');
    expect(input.value).toBe(INPUT_VALUE);
    expect(expectInRecordedDialogCard(input)).toBe(card);
    // The input is recorded; the recorder masks its value.
    expect(input.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBeNull();
  });
});
