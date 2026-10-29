/**
 * @jest-environment jsdom
 *
 * Page Home tells the shared onboarding card when the startup resume row is
 * on screen, so Getting started shows one row beneath it (CAN-4746). Only
 * the page instance may publish or clear that flag.
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, createElement, Fragment, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  SidebarItem,
  UsageLimitedSessionGroup,
} from '@canopy/desktop-shared/types';
import { useProjectsStore } from '@/stores/projectsStore';
import { useStartupResumeStore } from '@/stores/startupResumeStore';
import { useOnboardingSuggestionSurfaces } from '@/stores/onboardingSuggestionSurfacesStore';
import { useHomeInterruptedSessionsBannerStore } from '@/stores/homeInterruptedSessionsBannerStore';
import { HomeContinueSection } from '../HomeContinueSection';

jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: jest.fn(),
}));

jest.mock('@/hooks/useContextScopedWorkspaces', () => ({
  useContextScopedWorkspaces: (): { isInContext: () => boolean } => ({
    isInContext: (): boolean => true,
  }),
}));

const supportOps: SidebarItem = {
  type: 'cowork',
  id: 'support-ops',
  name: 'Support Ops',
  color: '#7c3aed',
  collapsed: false,
  order: 0,
};

const interruptedGroup: UsageLimitedSessionGroup = {
  groupId: 'ws',
  groupKind: 'workspace',
  workspaceId: 'ws',
  workspaceName: 'Workspace',
  sessions: [
    {
      kind: 'chat',
      projectId: 'ws',
      worktreeId: 'wt',
      chatId: 'c1',
      provider: 'claude',
      chatTitle: 'c1',
      detectedAt: 1,
      worktreeName: 'main',
    },
  ],
};

const listSessionsMock = jest.fn<Promise<UsageLimitedSessionGroup[]>, []>();

function pending(): boolean {
  return useOnboardingSuggestionSurfaces.getState().homeResumePending;
}

function resumeRow(): HTMLElement | null {
  return document.querySelector('[data-testid="home-resume-details"]');
}

describe('HomeContinueSection resume visibility', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    listSessionsMock.mockReset().mockResolvedValue([]);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { listUsageLimitedIdleSessions: listSessionsMock },
    });
    useHomeInterruptedSessionsBannerStore.setState({
      dismissedSignature: null,
    });
    useOnboardingSuggestionSurfaces.setState({ homeResumePending: false });
    useProjectsStore.setState({ projects: [supportOps] });
    useStartupResumeStore.setState({
      offer: {
        kind: 'cowork',
        workspaceId: 'support-ops',
        workEntryId: 'weekly-digest',
      },
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  async function render(
    ...instances: readonly {
      key: string;
      isPageVariant: boolean;
      interruptedActive?: boolean;
    }[]
  ): Promise<void> {
    await act(async () => {
      root.render(
        createElement(
          Fragment,
          null,
          instances.map(({ key, isPageVariant, interruptedActive }) =>
            createElement(HomeContinueSection, {
              key,
              isPageVariant,
              interruptedActive: interruptedActive ?? false,
            }),
          ),
        ),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  const page = { key: 'page', isPageVariant: true };
  const embedded = { key: 'embedded', isPageVariant: false };

  it('publishes when an offer arrives after page Home mounts', async () => {
    useStartupResumeStore.setState({ offer: null });
    await render(page);
    expect(pending()).toBe(false);
    act(() =>
      useStartupResumeStore.getState().setOffer({
        kind: 'cowork',
        workspaceId: 'support-ops',
        workEntryId: 'weekly-digest',
      }),
    );
    expect(resumeRow()).not.toBeNull();
    expect(pending()).toBe(true);
  });

  it('survives StrictMode effect cleanup and replay', async () => {
    act(() =>
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(HomeContinueSection, {
            isPageVariant: true,
            interruptedActive: false,
          }),
        ),
      ),
    );
    expect(pending()).toBe(true);
    expect(resumeRow()).not.toBeNull();
    await render();
    expect(pending()).toBe(false);
  });

  it('publishes while page Home renders the resume row and clears with the offer', async () => {
    await render(page);
    expect(resumeRow()?.textContent).toContain('Support Ops');
    expect(pending()).toBe(true);

    act(() => useStartupResumeStore.getState().clearOffer());
    expect(resumeRow()).toBeNull();
    expect(pending()).toBe(false);
  });

  it('clears when the offer loses its destination', async () => {
    await render(page);
    expect(pending()).toBe(true);

    act(() => useProjectsStore.setState({ projects: [] }));
    expect(resumeRow()).toBeNull();
    expect(pending()).toBe(false);
  });

  it('clears on unmount and publishes again on remount', async () => {
    await render(page);
    expect(pending()).toBe(true);

    await render();
    expect(pending()).toBe(false);

    await render({ ...page, key: 'page-again' });
    expect(pending()).toBe(true);
  });

  it('ignores an embedded instance mounting and unmounting beside page Home', async () => {
    await render(page, embedded);
    expect(pending()).toBe(true);

    await render(page);
    expect(pending()).toBe(true);

    await render(page, embedded);
    act(() => useProjectsStore.setState({ projects: [] }));
    expect(pending()).toBe(false);
    act(() => useProjectsStore.setState({ projects: [supportOps] }));
    expect(pending()).toBe(true);
  });

  it('never publishes from an embedded instance alone', async () => {
    await render(embedded);
    expect(resumeRow()).not.toBeNull();
    expect(pending()).toBe(false);

    useOnboardingSuggestionSurfaces.setState({ homeResumePending: true });
    await render();
    // An embedded unmount must not reset page Home's state either.
    expect(pending()).toBe(true);
  });

  it('stays false without an offer, with an unresolved offer, or with only interrupted sessions', async () => {
    useStartupResumeStore.setState({ offer: null });
    await render(page);
    expect(pending()).toBe(false);

    act(() =>
      useStartupResumeStore.setState({
        offer: { kind: 'cowork', workspaceId: 'deleted-workspace' },
      }),
    );
    expect(resumeRow()).toBeNull();
    expect(pending()).toBe(false);

    listSessionsMock.mockResolvedValue([interruptedGroup]);
    act(() => useStartupResumeStore.setState({ offer: null }));
    await render({ ...page, interruptedActive: true });
    expect(
      document.querySelector(
        '[data-testid="home-interrupted-sessions-banner"]',
      ),
    ).not.toBeNull();
    expect(pending()).toBe(false);
  });
});
