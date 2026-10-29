/** @jest-environment jsdom */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

// jsdom omits structuredClone; these editor fixtures contain only JSON data.
if (typeof globalThis.structuredClone === 'undefined') {
  Object.defineProperty(globalThis, 'structuredClone', {
    configurable: true,
    value: <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T,
  });
}

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';

jest.mock('../../shared/PageTitlebar', () => ({
  PageTitlebar: (): null => null,
}));

// The real Electron flow covers ChatContent; this test checks gallery routing.
jest.mock('../../chat/ChatContent', () => ({
  ChatContent: (): JSX.Element => <div data-testid="desktop-chat-content" />,
}));

import { ActivityStateGalleryPage } from '../ActivityStateGalleryPage';
import {
  ACTIVITY_GALLERY_SECTIONS,
  ACTIVITY_GALLERY_SECTION_IDS,
  createInitialActivityGalleryMachine,
  reduceActivityGalleryMachine,
} from '../activityStateGalleryData';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<ActivityStateGalleryPage />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('Activity States catalog', () => {
  it('covers every desktop activity section exactly once', () => {
    expect(ACTIVITY_GALLERY_SECTION_IDS).toEqual([
      'summary',
      'changed-files',
      'pull-request',
      'background-processes',
      'mcp-servers',
      'plans',
      'pipeline-runs',
      'scripts',
      'hooks',
      'terminals',
      'todo',
      'notes',
      'prompts',
      'attachments',
    ]);
    expect(ACTIVITY_GALLERY_SECTIONS.map((section) => section.id)).toEqual(
      ACTIVITY_GALLERY_SECTION_IDS,
    );
  });

  it('has unique state ids and an explicit empty/hidden or action-only state per section', () => {
    for (const section of ACTIVITY_GALLERY_SECTIONS) {
      const ids = section.states.map((state) => state.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(section.states.length).toBeGreaterThan(1);
      expect(
        section.states.some(
          (state) =>
            state.presentation === 'hidden' ||
            state.presentation === 'action-only' ||
            state.id === 'empty',
        ),
      ).toBe(true);
    }
  });

  it('covers the status vocabulary rendered by the production activity bodies', () => {
    const expectedStates: Partial<
      Record<(typeof ACTIVITY_GALLERY_SECTION_IDS)[number], readonly string[]>
    > = {
      'pull-request': ['closed'],
      'background-processes': ['queued', 'stopped'],
      'pipeline-runs': ['pending', 'cancelled'],
      scripts: ['stopping', 'success'],
      hooks: ['success', 'stopped'],
    };

    for (const [sectionId, requiredStates] of Object.entries(expectedStates)) {
      const section = ACTIVITY_GALLERY_SECTIONS.find(
        (candidate) => candidate.id === sectionId,
      );
      expect(section).toBeDefined();
      const stateIds = section?.states.map((state) => state.id) ?? [];
      for (const stateId of requiredStates) {
        expect(stateIds).toContain(stateId);
      }
    }
  });
});

describe('Activity States machine', () => {
  it('advances, wraps, selects, and resets each section independently', () => {
    const initial = createInitialActivityGalleryMachine();
    const summary = ACTIVITY_GALLERY_SECTIONS.find(
      (section) => section.id === 'summary',
    );
    if (!summary) throw new Error('Summary gallery section is missing');

    const advanced = reduceActivityGalleryMachine(initial, {
      type: 'advance',
      sectionId: 'summary',
    });
    expect(advanced.summary).toBe(
      (initial.summary + 1) % summary.states.length,
    );
    expect(advanced['changed-files']).toBe(initial['changed-files']);

    const selected = reduceActivityGalleryMachine(advanced, {
      type: 'select',
      sectionId: 'summary',
      stateId: 'failed',
    });
    expect(selected.summary).toBe(summary.states.length - 1);

    const wrapped = reduceActivityGalleryMachine(selected, {
      type: 'advance',
      sectionId: 'summary',
    });
    expect(wrapped.summary).toBe(0);
    expect(reduceActivityGalleryMachine(wrapped, { type: 'reset' })).toEqual(
      initial,
    );
  });

  it('follows each state action target', () => {
    const initial = createInitialActivityGalleryMachine();
    const generating = reduceActivityGalleryMachine(initial, {
      type: 'act',
      sectionId: 'summary',
    });
    expect(
      ACTIVITY_GALLERY_SECTIONS.find((section) => section.id === 'summary')
        ?.states[generating.summary].id,
    ).toBe('generating');

    const plans = reduceActivityGalleryMachine(initial, {
      type: 'act',
      sectionId: 'plans',
    });
    expect(
      ACTIVITY_GALLERY_SECTIONS.find((section) => section.id === 'plans')
        ?.states[plans.plans].id,
    ).toBe('tracked');
  });
});

describe('ActivityStateGalleryPage render', () => {
  it('renders one real activity-card preview per section', () => {
    expect(
      container.querySelector('[data-testid="page-activity-states"]'),
    ).not.toBeNull();
    for (const section of ACTIVITY_GALLERY_SECTIONS) {
      const machine = container.querySelector(
        `[data-testid="activity-state-machine-${section.id}"]`,
      );
      expect(machine).not.toBeNull();
      expect(
        machine?.querySelector('[data-activity-gallery-preview="true"]'),
      ).not.toBeNull();
    }
  });

  it('advances a single card without changing the other cards', () => {
    const summaryMachine = container.querySelector(
      '[data-testid="activity-state-machine-summary"]',
    );
    const changedFilesMachine = container.querySelector(
      '[data-testid="activity-state-machine-changed-files"]',
    );
    const summaryBefore = summaryMachine?.getAttribute('data-current-state');
    const changedBefore =
      changedFilesMachine?.getAttribute('data-current-state');
    const advance = summaryMachine?.querySelector<HTMLButtonElement>(
      '[data-testid="activity-state-advance-summary"]',
    );
    act(() => advance?.click());
    expect(summaryMachine?.getAttribute('data-current-state')).not.toBe(
      summaryBefore,
    );
    expect(changedFilesMachine?.getAttribute('data-current-state')).toBe(
      changedBefore,
    );
  });

  it('uses the cross glyph for cancel actions', () => {
    const cancelButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Cancel"]',
    );

    expect(cancelButton).not.toBeNull();
    expect(cancelButton?.querySelector('svg')?.getAttribute('data-glyph')).toBe(
      'x',
    );
  });

  it('uses the medium plus glyph for add actions', () => {
    const notesMachine = container.querySelector(
      '[data-testid="activity-state-machine-notes"]',
    );
    const populatedState = Array.from(
      notesMachine?.querySelectorAll('button') ?? [],
    ).find((button) => button.textContent === 'Populated');
    act(() => populatedState?.click());

    const addButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Add"]',
    );

    expect(addButton).not.toBeNull();
    expect(addButton?.querySelector('svg')?.getAttribute('data-glyph')).toBe(
      'plus',
    );
  });

  it('renders additions and deletions with semantic colors', () => {
    const changedFilesMachine = container.querySelector(
      '[data-testid="activity-state-machine-changed-files"]',
    );
    const additions = changedFilesMachine?.querySelector(
      '[data-activity-gallery-additions="true"]',
    );
    const deletions = changedFilesMachine?.querySelector(
      '[data-activity-gallery-deletions="true"]',
    );

    expect(additions?.className).toContain('fg-positive');
    expect(deletions?.className).toContain('fg-destructive');
  });

  it('lets the visible card action advance its state machine', () => {
    const summaryMachine = container.querySelector(
      '[data-testid="activity-state-machine-summary"]',
    );
    expect(summaryMachine?.getAttribute('data-current-state')).toBe('ready');
    const refresh = summaryMachine?.querySelector<HTMLButtonElement>(
      'button[aria-label="Refresh"]',
    );

    act(() => refresh?.click());

    expect(summaryMachine?.getAttribute('data-current-state')).toBe(
      'generating',
    );
  });

  it('uses the page-text-add glyph for import actions', () => {
    const attachmentsMachine = container.querySelector(
      '[data-testid="activity-state-machine-attachments"]',
    );
    const populatedState = Array.from(
      attachmentsMachine?.querySelectorAll('button') ?? [],
    ).find((button) => button.textContent === 'Populated');
    act(() => populatedState?.click());

    const importButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Import"]',
    );
    expect(importButton?.querySelector('svg')?.getAttribute('data-glyph')).toBe(
      'clipboard-plus',
    );
  });

  it('keeps a 12px gap between body copy and detail cards', () => {
    const summaryCopy = Array.from(container.querySelectorAll('p')).find(
      (element) =>
        element.textContent?.startsWith('Activity sidebar polish is ready'),
    );

    expect(summaryCopy?.parentElement?.className).toContain('space-y-3');
  });

  it('keeps a 10px gap between progress text and its bar', () => {
    const pullRequestMachine = container.querySelector(
      '[data-testid="activity-state-machine-pull-request"]',
    );
    const creatingState = Array.from(
      pullRequestMachine?.querySelectorAll('button') ?? [],
    ).find((button) => button.textContent === 'Creating');
    act(() => creatingState?.click());

    const progressLabel = Array.from(container.querySelectorAll('span')).find(
      (element) => element.textContent === 'Pushing branch',
    );

    expect(progressLabel?.parentElement?.parentElement?.className).toContain(
      'space-y-2.5',
    );
  });

  it('switches to the exhaustive catalog and renders every declared state', () => {
    const catalogButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="activity-gallery-view-catalog"]',
    );
    act(() => catalogButton?.click());
    for (const section of ACTIVITY_GALLERY_SECTIONS) {
      for (const state of section.states) {
        expect(
          container.querySelector(
            `[data-testid="activity-gallery-catalog-${section.id}-${state.id}"]`,
          ),
        ).not.toBeNull();
      }
    }
  });
});

describe('Chat playground', () => {
  it('mounts desktop ChatContent from the dev gallery', () => {
    const tab = container.querySelector<HTMLButtonElement>(
      '[data-testid="activity-gallery-view-chat"]',
    );
    expect(tab).not.toBeNull();
    act(() => tab?.click());
    expect(
      container.querySelector('[data-testid="chat-question-playground"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="desktop-chat-content"]'),
    ).not.toBeNull();
  });
});
