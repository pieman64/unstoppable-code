/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  PipelineArtifactReceiptV1,
  SkillArtifactReceiptV1,
} from '@canopy/desktop-shared/types';
import type { InstalledSkillInfo } from '@canopy/desktop-shared/types/skills';
import type { ChatShareData } from '@/hooks/useChatShareData';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

let mockData: ChatShareData;
const mockUseChatShareData = jest.fn();
jest.mock('@/hooks/useChatShareData', () => ({
  useChatShareData: (active: boolean): ChatShareData => {
    mockUseChatShareData(active);
    return mockData;
  },
}));

const mockOpenNavigation = jest.fn(() => Promise.resolve());
jest.mock('../agent-artifact-navigation', () => ({
  openAgentArtifactNavigation: (target: unknown): Promise<void> =>
    mockOpenNavigation(target),
}));

import { AgentArtifactCard } from '../AgentArtifactCard';
import { useShareRequestStore } from '@/stores/shareRequestStore';

const installedSkill: InstalledSkillInfo = {
  name: 'review',
  sourceId: 'custom:app',
  description: '',
  source: 'custom',
  installedAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  updateAvailable: false,
  custom: true,
};

const receipt: SkillArtifactReceiptV1 = {
  version: 1,
  kind: 'skill',
  operation: 'skills.create_custom',
  dedupeKey: 'skill:installed:custom:app:review',
  createdAt: '2026-08-04T12:00:00.000Z',
  source: 'installed',
  sourceId: 'custom:app',
  installedName: 'review',
  name: 'Review',
  description: 'Reviews changes',
  canUpdate: true,
  navigationTarget: {
    kind: 'installed_skill',
    sourceId: 'custom:app',
    skillName: 'review',
  },
};

function data(installedSkills: InstalledSkillInfo[] | null): ChatShareData {
  return {
    installedSkills,
    marketplaces: [],
    localSettled: installedSkills !== null,
    skillsSettled: installedSkills !== null,
    marketplacesSettled: true,
    skillAudienceReady: installedSkills !== null,
    sharedPlugins: null,
    accountId: null,
    inventoryEntries: null,
    mentionIndex: null,
  };
}

describe('AgentArtifactCard share action', () => {
  let container: HTMLElement;
  let root: Root;
  let unregisterHost: (() => void) | null;

  const render = (
    value: SkillArtifactReceiptV1 | PipelineArtifactReceiptV1,
  ): void => {
    act(() => {
      root.render(<AgentArtifactCard receipt={value} />);
    });
  };
  const shareButton = (): HTMLButtonElement | null =>
    container.querySelector('[data-testid="agent-artifact-share"]');
  const cardButton = (): HTMLButtonElement | null =>
    container.querySelector('[data-testid="agent-artifact-skill"]');

  beforeEach(() => {
    mockData = data([installedSkill]);
    mockUseChatShareData.mockClear();
    mockOpenNavigation.mockClear();
    useShareRequestStore.setState({ hostCount: 0, request: null });
    unregisterHost = useShareRequestStore.getState().registerHost();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    unregisterHost?.();
  });

  it('adds Share beside the card button, never inside it', () => {
    render(receipt);
    const share = shareButton();
    expect(share).not.toBeNull();
    expect(share?.getAttribute('aria-label')).toBe('Share Review');
    expect(cardButton()?.contains(share)).toBe(false);
    expect(container.querySelector('button button')).toBeNull();
  });

  it('requests sharing without navigating to the skill', () => {
    render(receipt);
    act(() => shareButton()?.click());
    expect(mockOpenNavigation).not.toHaveBeenCalled();
    expect(useShareRequestStore.getState().request).toMatchObject({
      target: { kind: 'skill', sourceId: 'custom:app', name: 'review' },
      source: 'artifact_card',
      ownerDocument: document,
    });
  });

  it('keeps the whole card opening the skill', () => {
    render(receipt);
    act(() => cardButton()?.click());
    expect(mockOpenNavigation).toHaveBeenCalledWith(receipt.navigationTarget);
    expect(useShareRequestStore.getState().request).toBeNull();
  });

  it('offers no Share for a shared-skill receipt', () => {
    render({
      ...receipt,
      operation: 'skills.share_custom',
      source: 'shared',
      sourceId: undefined,
      installedName: undefined,
      sharedSkillId: 'shared-1',
      navigationTarget: { kind: 'shared_skill', skillId: 'shared-1' },
    });
    expect(shareButton()).toBeNull();
    // A receipt that can never be shared loads no share data.
    expect(mockUseChatShareData.mock.calls.every(([active]) => !active)).toBe(
      true,
    );
  });

  it.each([
    ['the inventory has not loaded', (): ChatShareData => data(null)],
    ['the skill is no longer installed', (): ChatShareData => data([])],
    [
      'the skill comes from an unshareable source',
      (): ChatShareData =>
        data([
          { ...installedSkill, custom: false, sourceId: 'github:acme/skills' },
        ]),
    ],
  ])('offers no Share while %s', (_label, build) => {
    mockData = build();
    render(receipt);
    expect(shareButton()).toBeNull();
    expect(cardButton()).not.toBeNull();
  });

  const pipelineReceipt: PipelineArtifactReceiptV1 = {
    version: 1,
    kind: 'pipeline',
    operation: 'capability_package.analyze',
    dedupeKey: 'pipeline:user:release',
    createdAt: '2026-08-04T12:00:00.000Z',
    source: 'user',
    localId: 'release',
    name: 'Release',
    enabled: true,
    scopes: ['directory'],
    runModes: ['dispatch'],
    jobCount: 1,
    stepCount: 2,
    navigationTarget: {
      kind: 'pipeline_editor',
      pipelineId: 'release',
      source: 'user',
    },
    shareTarget: { kind: 'pipeline', source: 'stored', pipelineId: 'release' },
  };

  it('labels read-only analysis receipts without claiming an update', () => {
    render({ ...pipelineReceipt, operation: 'capability_package.analyze' });
    expect(container.textContent).toContain('Checked');
    expect(container.textContent).not.toContain('Updated');
  });

  it('asks to share the saved pipeline a receipt points at', () => {
    render(pipelineReceipt);
    expect(shareButton()?.getAttribute('aria-label')).toBe('Share Release');
    act(() => shareButton()?.click());
    expect(mockOpenNavigation).not.toHaveBeenCalled();
    expect(useShareRequestStore.getState().request).toMatchObject({
      target: { kind: 'pipeline', source: 'stored', pipelineId: 'release' },
      source: 'artifact_card',
    });
  });

  it('offers no Share for a pipeline receipt without a share target', () => {
    render({ ...pipelineReceipt, shareTarget: undefined });
    expect(shareButton()).toBeNull();
  });

  it('offers no Share in a window without a share host', () => {
    unregisterHost?.();
    unregisterHost = null;
    render(receipt);
    expect(shareButton()).toBeNull();
  });
});
