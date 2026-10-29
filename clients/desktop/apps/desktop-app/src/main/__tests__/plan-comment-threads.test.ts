import {
  APP_ADVISOR_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
  type PlanCommentThread,
} from '@canopy/desktop-shared/types';
import type { PlanCommentThreadOwner } from '../lib/plan-persistence';
import { registerWorkspaceTypes } from '../lib/workspace-registry';
import {
  formatPlanCommentSummaryLine,
  formatPlanCommentThread,
  hasTrackedPlanCommentStorage,
} from '../canopy-tools/plan-comment-threads';

const OWNER: PlanCommentThreadOwner = {
  projectId: 'project',
  worktreeId: 'worktree',
  planId: 'plan-1',
  title: 'Ship the plan panel',
  latestRevisionNumber: 4,
  content: '# Ship the plan panel\n',
};

function thread(overrides: Partial<PlanCommentThread> = {}): PlanCommentThread {
  return {
    id: 'thread-1',
    status: 'open',
    createdAt: '2026-09-28T01:00:00.000Z',
    anchorState: 'matched',
    anchor: {
      quote: '- Add the panel\n- Wire the tray',
      renderedText: 'Add the panel Wire the tray',
      lineStart: 6,
      lineEnd: 7,
      planNodeId: 'steps-list',
      headingPath: ['Ship the plan panel', 'Steps'],
    },
    comments: [
      {
        id: 'question',
        author: 'user',
        body: 'Is the tray needed?',
        createdAt: '2026-09-28T01:00:00.000Z',
        staged: false,
      },
    ],
    ...overrides,
  };
}

describe('hasTrackedPlanCommentStorage', () => {
  afterEach(() => {
    registerWorkspaceTypes(new Map());
  });

  it.each([
    APP_ADVISOR_PROJECT_ID,
    PIPELINE_EDITOR_PROJECT_ID,
    PLAN_EXPLORE_CHAT_PROJECT_ID,
    CODE_REVIEW_CHAT_PROJECT_ID,
    STANDALONE_CHAT_PROJECT_ID,
    SHARED_CONTAINER_VIEWER_PROJECT_ID,
  ])('is false for the %s sentinel', (projectId) => {
    expect(hasTrackedPlanCommentStorage(projectId)).toBe(false);
  });

  it('is false for Cowork workspaces and true for code workspaces', () => {
    registerWorkspaceTypes(
      new Map([
        ['cowork-workspace', 'cowork'],
        ['single-repo', 'single-repo'],
        ['multi-repo', 'multi-repo'],
      ]),
    );

    expect(hasTrackedPlanCommentStorage('cowork-workspace')).toBe(false);
    expect(hasTrackedPlanCommentStorage('single-repo')).toBe(true);
    expect(hasTrackedPlanCommentStorage('multi-repo')).toBe(true);
  });
});

describe('formatPlanCommentThread', () => {
  it('prints the plan identity, editable file, anchor, validity, fenced quote, and history', () => {
    expect(
      formatPlanCommentThread({
        owner: OWNER,
        thread: thread(),
        planFile: '/data/plan-explore/plan-1/plan.md',
      }),
    ).toBe(
      [
        'Plan "Ship the plan panel" (plan plan-1, latest revision 4)',
        'Plan file: /data/plan-explore/plan-1/plan.md',
        'Thread thread-1 [open] (anchor matched)',
        'Source: document passage',
        'Anchor: Ship the plan panel > Steps; lines 6-7; node steps-list',
        'Anchor validity: matches revision 4',
        'Quote:',
        '```markdown',
        '- Add the panel',
        '- Wire the tray',
        '```',
        '',
        'Comments:',
        '- [user] 2026-09-28T01:00:00.000Z: Is the tray needed?',
      ].join('\n'),
    );
  });

  it('says no plan file is available when none is current', () => {
    expect(
      formatPlanCommentThread({
        owner: OWNER,
        thread: thread(),
        planFile: null,
      }),
    ).toContain('\nPlan file: none available for editing\n');
  });

  it('reports an outdated anchor against the latest revision', () => {
    const text = formatPlanCommentThread({
      owner: OWNER,
      thread: thread({ anchorState: 'outdated', status: 'resolved' }),
      planFile: null,
    });

    expect(text).toContain('Thread thread-1 [resolved] (anchor outdated)');
    expect(text).toContain(
      'Anchor validity: outdated; the quoted text is no longer in revision 4',
    );
  });

  it.each([
    ['sequence', 'sequence diagram node "Client calls API"'],
    ['logicDiff', 'logic diagram node "Client calls API"'],
    ['dataModelDiff', 'data model diagram node "Client calls API"'],
  ] as const)(
    'describes a %s diagram-node thread by its node, even without a plan quote',
    (diagramKind, source) => {
      const text = formatPlanCommentThread({
        owner: OWNER,
        thread: thread({
          anchor: {
            source: 'diagram',
            diagramKind,
            planNodeId: 'node-1',
            renderedText: 'Client calls API',
            quote: '',
            unanchored: true,
          },
        }),
        planFile: null,
      });

      expect(text).toContain(`Source: ${source}`);
      expect(text).toContain('Anchor: node node-1');
      expect(text).toContain('Quote: none');
    },
  );

  it('keeps a diagram node quote and heading path when the node maps to a passage', () => {
    const text = formatPlanCommentThread({
      owner: OWNER,
      thread: thread({
        anchor: {
          source: 'diagram',
          diagramKind: 'sequence',
          planNodeId: 'node-2',
          renderedText: 'Persist the reply',
          quote: '- Persist the reply',
          headingPath: ['Ship the plan panel', 'Flow'],
        },
      }),
      planFile: null,
    });

    expect(text).toContain('Source: sequence diagram node "Persist the reply"');
    expect(text).toContain('Anchor: Ship the plan panel > Flow; node node-2');
    expect(text).toContain('```markdown\n- Persist the reply\n```');
  });

  it('describes a general note as not anchored', () => {
    const text = formatPlanCommentThread({
      owner: OWNER,
      thread: thread({ anchor: { quote: '', unanchored: true } }),
      planFile: null,
    });

    expect(text).toContain('Source: general note (not anchored)');
    expect(text).toContain('Anchor: none');
    expect(text).toContain('Quote: none');
  });

  it('lengthens the fence so a quoted code block cannot close it early', () => {
    const quote = 'Run:\n\n```bash\nnpm test\n```';
    const text = formatPlanCommentThread({
      owner: OWNER,
      thread: thread({ anchor: { quote, lineStart: 3 } }),
      planFile: null,
    });

    expect(text).toContain(`Anchor: line 3\n`);
    expect(text).toContain(`\`\`\`\`markdown\n${quote}\n\`\`\`\`\n`);
  });

  it('attributes teammates, redacts staged drafts, and keeps the full history in order', () => {
    const text = formatPlanCommentThread({
      owner: OWNER,
      thread: thread({
        comments: [
          {
            id: 'ada',
            author: 'remote',
            remoteAuthor: { userId: 'user-ada', displayName: 'Ada Lovelace' },
            body: 'Please split this.',
            createdAt: '2026-09-28T02:00:00.000Z',
          },
          {
            id: 'unknown',
            author: 'remote',
            body: 'Agreed.',
            createdAt: '2026-09-28T03:00:00.000Z',
          },
          {
            id: 'agent',
            author: 'agent',
            body: 'Split in revision 4.',
            createdAt: '2026-09-28T04:00:00.000Z',
            staged: false,
          },
          {
            id: 'draft',
            author: 'user',
            body: 'secret follow-up',
            createdAt: '2026-09-28T05:00:00.000Z',
            staged: true,
          },
        ],
      }),
      planFile: null,
    });

    expect(text.split('\nComments:\n')[1]).toBe(
      [
        '- [remote: Ada Lovelace] 2026-09-28T02:00:00.000Z: Please split this.',
        '- [remote: unknown teammate] 2026-09-28T03:00:00.000Z: Agreed.',
        '- [agent] 2026-09-28T04:00:00.000Z: Split in revision 4.',
        '- [user] 2026-09-28T05:00:00.000Z (staged draft): [redacted draft]',
      ].join('\n'),
    );
    expect(text).not.toContain('secret follow-up');
  });

  it('marks a thread with no comments', () => {
    expect(
      formatPlanCommentThread({
        owner: OWNER,
        thread: thread({ comments: [] }),
        planFile: null,
      }),
    ).toMatch(/\nComments:\n\(no comments yet\)$/);
  });
});

describe('formatPlanCommentSummaryLine', () => {
  it('summarizes a document thread with its plan and location', () => {
    expect(formatPlanCommentSummaryLine(OWNER, thread())).toBe(
      '- thread-1 [open] 1 comment(s): Plan "Ship the plan panel" (plan-1) document passage (Ship the plan panel > Steps, lines 6-7, node steps-list) [anchor matched]',
    );
  });

  it('summarizes diagram-node and general threads', () => {
    expect(
      formatPlanCommentSummaryLine(
        OWNER,
        thread({
          anchorState: 'outdated',
          anchor: {
            source: 'diagram',
            diagramKind: 'dataModelDiff',
            planNodeId: 'entity-plan',
            renderedText: 'TrackedPlan',
            quote: '- TrackedPlan gains comments',
          },
        }),
      ),
    ).toBe(
      '- thread-1 [open] 1 comment(s): Plan "Ship the plan panel" (plan-1) data model diagram node "TrackedPlan" (node entity-plan) [anchor outdated]',
    );
    expect(
      formatPlanCommentSummaryLine(
        OWNER,
        thread({ anchor: { quote: '', unanchored: true } }),
      ),
    ).toBe(
      '- thread-1 [open] 1 comment(s): Plan "Ship the plan panel" (plan-1) general note (not anchored) [anchor matched]',
    );
  });
});
