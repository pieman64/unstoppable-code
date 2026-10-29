/**
 * @jest-environment jsdom
 */
import { act, createElement, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  PlanComment,
  PlanCommentThread,
  TrackedPlanData,
} from '@canopy/desktop-shared/types';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { PlanDocumentPanel } from '../PlanDocumentPanel';
import * as domTextRange from '@/lib/dom-text-range';

jest.mock(
  '@canopy/ui-shared/components/SourcePositionMarkdown',
  (): {
    SourcePositionMarkdown: ({ children }: { children: string }) => string;
  } => ({
    SourcePositionMarkdown: ({ children }): string => children,
  }),
);
jest.mock('@/lib/dom-text-range', () => {
  const actual: typeof domTextRange = jest.requireActual(
    '@/lib/dom-text-range',
  );
  return {
    ...actual,
    rangeContainsPoint: jest.fn(() => false),
  };
});

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

function plan(): TrackedPlanData {
  return {
    id: 'plan-1',
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    source: 'claude',
    title: 'Test plan',
    content: '# Test plan\n\n- [ ] Build the parser',
    reviewStatus: 'pending',
    createdAt: '2026-06-06T00:00:00.000Z',
    updatedAt: '2026-06-06T00:00:00.000Z',
    latestRevisionNumber: 1,
    revisions: [],
    linkedExecutionIds: [],
  };
}

function thread(staged: boolean): PlanCommentThread {
  return {
    id: 'thread-1',
    status: 'open',
    createdAt: '2026-06-06T00:00:00.000Z',
    anchorState: 'matched',
    anchor: {
      quote: '- [ ] Build the parser',
      renderedText: 'Build the parser',
      source: 'document',
    },
    comments: [
      {
        id: 'comment-1',
        author: 'user',
        body: 'Please tighten this',
        createdAt: '2026-06-06T00:00:00.000Z',
        staged,
      },
    ],
  };
}

function render(node: JSX.Element): {
  container: HTMLDivElement;
  cleanup: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return {
    container,
    cleanup: (): void => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function panel(
  overrides: Partial<Parameters<typeof PlanDocumentPanel>[0]> = {},
): JSX.Element {
  return createElement(PlanDocumentPanel, {
    plan: plan(),
    displayContent: plan().content,
    readOnly: false,
    threads: [thread(true)],
    stagedCount: 1,
    addDocumentComment: jest.fn(),
    addReply: jest.fn(),
    editStagedComment: jest.fn(),
    deleteStagedComment: jest.fn(),
    toggleResolved: jest.fn(),
    onSubmit: jest.fn(),
    ...overrides,
  });
}

describe('PlanDocumentPanel session replay', () => {
  it('blocks the panel root, plan and comments included', () => {
    const { container, cleanup } = render(panel());

    expect(container.firstElementChild?.className.split(' ')).toEqual([
      POSTHOG_REPLAY_BLOCK_CLASS,
      'flex',
      'min-h-0',
      'min-w-0',
      'flex-1',
      'flex-col',
    ]);
    cleanup();
  });

  it('blocks the comment draft popover it portals to the document body', () => {
    // jsdom has no layout, so a Range has no client rect to place against.
    const rangeRect = Object.getOwnPropertyDescriptor(
      Range.prototype,
      'getBoundingClientRect',
    );
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: (): DOMRect => new DOMRect(10, 10, 40, 12),
    });
    const { container, cleanup } = render(panel());

    const documentPanel = container.querySelector(
      '[data-testid="plan-explore-plan-panel"]',
    );
    const text = documentPanel?.querySelector('.prose')?.firstChild;
    if (!documentPanel || !(text instanceof Text)) {
      throw new Error('Expected the rendered plan text');
    }
    const range = document.createRange();
    range.setStart(text, 2);
    range.setEnd(text, 11);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    act(() => {
      documentPanel.dispatchEvent(
        new MouseEvent('mouseup', { bubbles: true, cancelable: true }),
      );
    });

    // The popover quotes the selected plan text and holds the draft, and it
    // renders outside the panel root, so it carries its own block.
    const draft = document.body.querySelector(
      '[data-testid="plan-comment-draft"]',
    );
    expect(draft?.parentElement).toBe(document.body);
    expect(draft?.textContent).toContain(range.toString().trim());
    expect(draft?.className.split(' ')[0]).toBe(POSTHOG_REPLAY_BLOCK_CLASS);
    expect(draft?.className).toContain(
      'fixed z-dropdown flex flex-col gap-1.5 rounded-md bg-popover p-2 shadow-lg',
    );

    window.getSelection()?.removeAllRanges();
    cleanup();
    if (rangeRect) {
      Object.defineProperty(
        Range.prototype,
        'getBoundingClientRect',
        rangeRect,
      );
    } else {
      Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect');
    }
  });
});

describe('PlanDocumentPanel staged comment editing', () => {
  it('saves edits for staged comments', () => {
    const editStagedComment = jest.fn();
    const { container, cleanup } = render(panel({ editStagedComment }));

    const editButton = container.querySelector(
      '[data-testid="plan-comment-edit-comment-1"]',
    );
    expect(editButton).not.toBeNull();

    act(() => {
      editButton?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });

    const input = container.querySelector(
      '[data-testid="plan-comment-edit-input-comment-1"]',
    );
    if (!(input instanceof HTMLTextAreaElement)) {
      throw new Error('Expected staged comment edit textarea');
    }

    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set?.call(input, '  Please clarify this step  ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const saveButton = container.querySelector(
      '[data-testid="plan-comment-edit-save-comment-1"]',
    );
    act(() => {
      saveButton?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });

    expect(editStagedComment).toHaveBeenCalledWith(
      'thread-1',
      'comment-1',
      'Please clarify this step',
    );
    cleanup();
  });

  it('does not offer editing for submitted comments', () => {
    const { container, cleanup } = render(
      panel({ stagedCount: 0, threads: [thread(false)] }),
    );

    expect(
      container.querySelector('[data-testid="plan-comment-edit-comment-1"]'),
    ).toBeNull();
    cleanup();
  });

  it('keeps unanchored diagram comments activatable', () => {
    const onRevealDiagramNode = jest.fn();
    const diagramThread: PlanCommentThread = {
      ...thread(false),
      anchor: {
        quote: '',
        source: 'diagram',
        unanchored: true,
        diagramKind: 'logicDiff',
        planNodeId: 'node-1',
      },
    };
    const { container, cleanup } = render(
      panel({
        stagedCount: 0,
        threads: [diagramThread],
        onRevealDiagramNode,
      }),
    );

    expect(container.textContent).toContain('Diagram comment');
    expect(container.textContent).not.toContain('General comment');
    const referenceButton = container.querySelector(
      '[data-testid="plan-comment-thread-thread-1"] button[aria-label="Open Diagram comment in the diagram"]',
    );
    expect(referenceButton).not.toBeNull();

    act(() => {
      referenceButton?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });

    expect(onRevealDiagramNode).toHaveBeenCalledWith('logicDiff', 'node-1');
    cleanup();
  });

  it('expands and scrolls the comments tray when an anchored highlight is clicked', () => {
    localStorage.setItem('canopy.planExplore.commentsCollapsed.v1', 'true');
    const scrollIntoView = jest.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    jest.mocked(domTextRange.rangeContainsPoint).mockReturnValue(true);
    const { container, cleanup } = render(panel());

    const commentsBody = container.querySelector(
      '[data-testid="plan-explore-comments-tray-body"]',
    );
    expect(commentsBody?.getAttribute('aria-hidden')).toBe('true');

    const documentPanel = container.querySelector(
      '[data-testid="plan-explore-plan-panel"]',
    );
    act(() => {
      documentPanel?.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
        }),
      );
    });

    expect(commentsBody?.getAttribute('aria-hidden')).toBe('false');
    expect(
      localStorage.getItem('canopy.planExplore.commentsCollapsed.v1'),
    ).toBe('false');
    expect(scrollIntoView).toHaveBeenCalled();

    cleanup();
    localStorage.removeItem('canopy.planExplore.commentsCollapsed.v1');
    jest.mocked(domTextRange.rangeContainsPoint).mockReturnValue(false);
  });

  it('keeps an unrelated staged comment edit open when deleting another comment', () => {
    const deleteStagedComment = jest.fn();
    const { container, cleanup } = render(
      panel({
        deleteStagedComment,
        stagedCount: 2,
        threads: [
          {
            ...thread(true),
            comments: [
              {
                id: 'comment-1',
                author: 'user',
                body: 'First draft',
                createdAt: '2026-06-06T00:00:00.000Z',
                staged: true,
              },
              {
                id: 'comment-2',
                author: 'user',
                body: 'Second draft',
                createdAt: '2026-06-06T00:00:00.000Z',
                staged: true,
              },
            ],
          },
        ],
      }),
    );

    const editButton = container.querySelector(
      '[data-testid="plan-comment-edit-comment-1"]',
    );
    act(() => {
      editButton?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });

    const input = container.querySelector(
      '[data-testid="plan-comment-edit-input-comment-1"]',
    );
    if (!(input instanceof HTMLTextAreaElement)) {
      throw new Error('Expected staged comment edit textarea');
    }

    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set?.call(input, 'Updated first draft');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const deleteButton = container.querySelector(
      '[data-testid="plan-comment-delete-comment-2"]',
    );
    act(() => {
      deleteButton?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });

    expect(deleteStagedComment).toHaveBeenCalledWith('thread-1', 'comment-2');
    expect(
      container.querySelector(
        '[data-testid="plan-comment-edit-input-comment-1"]',
      ),
    ).toBe(input);
    expect(input.value).toBe('Updated first draft');
    cleanup();
  });
});

describe('PlanDocumentPanel teammate comments', () => {
  function remoteThread(): PlanCommentThread {
    const pendingRemoteComment: PlanComment = {
      id: 'comment-remote-ada',
      author: 'remote',
      remoteAuthor: { userId: 'user-ada', displayName: 'Ada Lovelace' },
      body: 'Can we clarify this step?',
      createdAt: '2026-06-06T00:00:00.000Z',
    };
    const submittedRemoteComment: PlanComment = {
      id: 'comment-remote-unknown',
      author: 'remote',
      remoteAuthor: { userId: 'user-unknown', displayName: null },
      body: 'Already handed this off.',
      createdAt: '2026-06-06T00:01:00.000Z',
      submittedToChat: true,
    };
    const userComment: PlanComment = {
      id: 'comment-user-1',
      author: 'user',
      body: 'Thanks for flagging.',
      createdAt: '2026-06-06T00:02:00.000Z',
    };
    return {
      id: 'thread-remote-1',
      status: 'open',
      createdAt: '2026-06-06T00:00:00.000Z',
      anchorState: 'matched',
      anchor: {
        quote: '- [ ] Build the parser',
        renderedText: 'Build the parser',
        source: 'document',
      },
      comments: [pendingRemoteComment, submittedRemoteComment, userComment],
    };
  }

  function outdatedRemoteThread(): PlanCommentThread {
    const comment: PlanComment = {
      id: 'comment-outdated-1',
      author: 'remote',
      remoteAuthor: { userId: 'user-grace', displayName: 'Grace Hopper' },
      body: 'This section changed since I commented.',
      createdAt: '2026-06-05T00:00:00.000Z',
    };
    return {
      id: 'thread-outdated-1',
      status: 'open',
      createdAt: '2026-06-05T00:00:00.000Z',
      anchorState: 'outdated',
      anchor: {
        quote: 'stale quote',
        renderedText: 'stale quote',
        source: 'document',
      },
      comments: [comment],
    };
  }

  it('renders a teammate thread alongside the owner comment and archives outdated remote threads', () => {
    const { container, cleanup } = render(
      panel({
        stagedCount: 0,
        threads: [remoteThread(), outdatedRemoteThread()],
      }),
    );

    const card = container.querySelector(
      '[data-testid="plan-comment-thread-thread-remote-1"]',
    );
    if (!card) {
      throw new Error('Expected the remote thread card to render');
    }

    // Remote author identity: known display name, and the "Teammate"
    // fallback when `remoteAuthor.displayName` is null.
    expect(card.textContent).toContain('Ada Lovelace');
    expect(card.textContent).toContain('Can we clarify this step?');
    expect(card.textContent).toContain('Teammate');
    expect(card.textContent).toContain('Already handed this off.');

    // Anchor quote reference (jump-to-passage button).
    const referenceButton = card.querySelector(
      'button[aria-label="Jump to this passage in the plan"]',
    );
    expect(referenceButton?.textContent).toBe('“Build the parser”');

    // Comment count and open status from the shared thread header.
    expect(card.textContent).toContain('3 comments');
    expect(card.textContent).toContain('Open');

    // The owner's own comment renders as "You" plus the "you" badge.
    const nameSpans = Array.from(card.querySelectorAll('span')).filter(
      (el) => el.textContent === 'You',
    );
    expect(nameSpans.length).toBe(1);
    const youBadges = Array.from(card.querySelectorAll('span')).filter(
      (el) => el.textContent === 'you',
    );
    expect(youBadges.length).toBe(1);

    // Exactly one pending chip: the un-submitted remote comment. The
    // submitted remote comment and the (non-staged) user comment get none.
    const pendingChips = Array.from(card.querySelectorAll('span')).filter(
      (el) => el.textContent === 'pending',
    );
    expect(pendingChips.length).toBe(1);

    // Remote comments are never staged, so no edit/delete actions render
    // for their ids.
    expect(
      container.querySelector(
        '[data-testid="plan-comment-edit-comment-remote-ada"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-testid="plan-comment-delete-comment-remote-ada"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-testid="plan-comment-edit-comment-remote-unknown"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-testid="plan-comment-delete-comment-remote-unknown"]',
      ),
    ).toBeNull();

    // The outdated remote thread is archived: hidden until the archived
    // toggle is expanded, then it shows the "outdated" chip.
    expect(container.textContent).not.toContain('Grace Hopper');
    const archivedToggle = container.querySelector(
      '[data-testid="plan-comments-archived-toggle"]',
    );
    expect(archivedToggle).not.toBeNull();

    act(() => {
      archivedToggle?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });

    expect(container.textContent).toContain('Grace Hopper');
    const outdatedCard = container.querySelector(
      '[data-testid="plan-comment-thread-thread-outdated-1"]',
    );
    expect(outdatedCard?.textContent).toContain('outdated');

    cleanup();
  });
});

describe('PlanDocumentPanel comment submission', () => {
  it('offers no submit action when the host passes no submit handler', () => {
    const { container, cleanup } = render(panel({ onSubmit: undefined }));

    expect(
      container.querySelector('[data-testid="plan-comments-submit"]'),
    ).toBeNull();
    // Comments can still be staged.
    expect(
      container.querySelector('[data-testid="plan-comment-add-note"]'),
    ).not.toBeNull();
    cleanup();
  });

  it('submits staged comments through the host handler', () => {
    const onSubmit = jest.fn();
    const { container, cleanup } = render(panel({ onSubmit }));

    const submit = container.querySelector(
      '[data-testid="plan-comments-submit"]',
    );
    act(() => {
      submit?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    cleanup();
  });
});

describe('PlanDocumentPanel owner document', () => {
  /** Minimal stand-in for the Custom Highlight API, which jsdom lacks. */
  class FakeHighlight {
    readonly ranges: readonly Range[];
    constructor(...ranges: Range[]) {
      this.ranges = ranges;
    }
  }

  function installFakeHighlights(view: Window): Map<string, FakeHighlight> {
    const registry = new Map<string, FakeHighlight>();
    Object.defineProperty(view, 'CSS', {
      configurable: true,
      value: { highlights: registry },
    });
    Object.defineProperty(view, 'Highlight', {
      configurable: true,
      value: FakeHighlight,
    });
    return registry;
  }

  afterEach(() => {
    Reflect.deleteProperty(window, 'CSS');
    Reflect.deleteProperty(window, 'Highlight');
    document.body.innerHTML = '';
  });

  it("keeps another view's anchor highlights when one view unmounts", () => {
    const registry = installFakeHighlights(window);
    const first = render(panel({ stagedCount: 0, threads: [thread(false)] }));
    const second = render(panel({ stagedCount: 0, threads: [thread(false)] }));

    expect(registry.get('plan-comment-anchor')?.ranges).toHaveLength(2);

    first.cleanup();
    expect(registry.get('plan-comment-anchor')?.ranges).toHaveLength(1);

    second.cleanup();
    expect(registry.has('plan-comment-anchor')).toBe(false);
  });

  it('drafts a comment in the popped-out window that shows the panel', () => {
    const mainRegistry = installFakeHighlights(window);
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const frameDocument = frame.contentDocument;
    const frameWindow = frame.contentWindow;
    if (!frameDocument || !frameWindow) {
      throw new Error('Expected an iframe document');
    }
    const frameRegistry = installFakeHighlights(frameWindow);

    const host = frameDocument.createElement('div');
    frameDocument.body.appendChild(host);
    const frameRoot = createRoot(host);
    act(() => {
      frameRoot.render(panel({ stagedCount: 0, threads: [thread(false)] }));
    });

    // Committed anchors paint into the popped-out window only.
    expect(frameRegistry.get('plan-comment-anchor')?.ranges).toHaveLength(1);
    expect(mainRegistry.has('plan-comment-anchor')).toBe(false);

    const documentPanel = frameDocument.querySelector(
      '[data-testid="plan-explore-plan-panel"]',
    );
    if (!documentPanel) {
      throw new Error('Expected the plan document in the frame');
    }
    const textRange = frameDocument.createRange();
    textRange.selectNodeContents(documentPanel);
    // jsdom does not lay out ranges; the popover only needs a rect.
    Object.defineProperty(textRange, 'getBoundingClientRect', {
      configurable: true,
      value: (): DOMRect => new DOMRect(20, 40, 100, 16),
    });
    const selection = frameDocument.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(textRange);

    act(() => {
      documentPanel.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    expect(
      frameDocument.body.querySelector('[data-testid="plan-comment-draft"]'),
    ).not.toBeNull();
    expect(
      document.body.querySelector('[data-testid="plan-comment-draft"]'),
    ).toBeNull();
    expect(frameRegistry.get('plan-comment-draft')?.ranges).toHaveLength(1);
    expect(mainRegistry.has('plan-comment-draft')).toBe(false);

    act(() => {
      frameRoot.unmount();
    });
    expect(frameRegistry.size).toBe(0);
    frame.remove();
  });
});
