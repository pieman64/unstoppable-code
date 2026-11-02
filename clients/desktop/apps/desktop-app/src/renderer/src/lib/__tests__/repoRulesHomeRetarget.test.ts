import type { AppAdvisorRepoRulesModalSource } from '@canopy/desktop-shared/types';
import type { RepoRulesStatus } from '@canopy/protocol/repo-rules';
import {
  captureRepoRulesReviewOrigin,
  isHomeComposerRetargetable,
  retargetHomeAfterRepoRulesApplied,
} from '../repoRulesHomeRetarget';

interface FakeComposer {
  workspaceId: string | null;
  text: string;
  fileReferences: unknown[];
  attachments: unknown[];
  pendingAttachmentImportIds: number[];
  scheduledSendDraft: { runAt: string } | null;
  isSending: boolean;
  workspaceSelectionExplicit: boolean;
  workspaceSelectionReason: 'most-recent-import' | null;
  workspaceSelectionGeneration: number;
  selectWorkspace: jest.Mock;
  clearWorkspaceSelectionReason: jest.Mock;
}

let composer: FakeComposer;
let context: {
  accountEpoch: number;
  state: { revision: number; context: { kind: string; id?: string } };
};
let projects: Array<{ id: string; type: string }>;
let inScope: Set<string>;

jest.mock('@/stores/homeComposerStore', () => ({
  useHomeComposerStore: { getState: (): FakeComposer => composer },
}));
jest.mock('@/stores/workspaceContextStore', () => ({
  useWorkspaceContextStore: { getState: (): typeof context => context },
}));
jest.mock('@/stores/projectsStore', () => ({
  useProjectsStore: {
    getState: (): { projects: typeof projects } => ({ projects }),
  },
}));
jest.mock('@/components/home/homeScope', () => ({
  getHomeScope: (): { isInScope: (id: string) => boolean } => ({
    isInScope: (id: string): boolean => inScope.has(id),
  }),
}));

const ENABLED: RepoRulesStatus = {
  enabled: true,
  disabledRuleIds: [],
  revision: 1,
};

beforeEach(() => {
  composer = {
    workspaceId: 'side-quest',
    text: '',
    fileReferences: [],
    attachments: [],
    pendingAttachmentImportIds: [],
    scheduledSendDraft: null,
    isSending: false,
    workspaceSelectionExplicit: false,
    workspaceSelectionReason: 'most-recent-import',
    workspaceSelectionGeneration: 3,
    selectWorkspace: jest.fn((workspaceId: string) => {
      composer.workspaceId = workspaceId;
      composer.workspaceSelectionReason = null;
      composer.workspaceSelectionGeneration += 1;
    }),
    clearWorkspaceSelectionReason: jest.fn(() => {
      composer.workspaceSelectionReason = null;
      composer.workspaceSelectionGeneration += 1;
    }),
  };
  context = {
    accountEpoch: 1,
    state: { revision: 4, context: { kind: 'personal' } },
  };
  projects = [
    { id: 'side-quest', type: 'single-repo' },
    { id: 'payments-service', type: 'single-repo' },
    { id: 'notes', type: 'cowork' },
  ];
  inScope = new Set(['side-quest', 'payments-service', 'notes']);
});

function apply(
  source: AppAdvisorRepoRulesModalSource = 'first-run-import',
  between?: () => void,
  result: { workspaceId: string; status: RepoRulesStatus } = {
    workspaceId: 'payments-service',
    status: ENABLED,
  },
): boolean {
  const origin = captureRepoRulesReviewOrigin(source);
  between?.();
  return retargetHomeAfterRepoRulesApplied(origin, result);
}

describe('retargetHomeAfterRepoRulesApplied (CAN-4674)', () => {
  it.each<AppAdvisorRepoRulesModalSource>([
    'first-run-import',
    'import-results',
  ])('aims an untouched composer at the applied project from %s', (source) => {
    expect(apply(source)).toBe(true);
    expect(composer.selectWorkspace).toHaveBeenCalledWith('payments-service', {
      explicit: false,
    });
  });

  it.each<AppAdvisorRepoRulesModalSource>([
    'add-project',
    'settings',
    'checklist',
    'project-settings',
    'app-advisor',
  ])('leaves the composer alone for %s', (source) => {
    expect(apply(source)).toBe(false);
    expect(composer.selectWorkspace).not.toHaveBeenCalled();
  });

  it('treats whitespace-only text as empty', () => {
    composer.text = '  \n ';
    expect(apply()).toBe(true);
  });

  it('does not retarget when rules were turned off', () => {
    expect(
      apply('first-run-import', undefined, {
        workspaceId: 'payments-service',
        status: { ...ENABLED, enabled: false },
      }),
    ).toBe(false);
    expect(composer.selectWorkspace).not.toHaveBeenCalled();
  });

  it.each<[string, () => void]>([
    ['typed text', (): void => void (composer.text = 'Fix the bug')],
    ['file references', (): void => void composer.fileReferences.push({})],
    ['staged attachments', (): void => void composer.attachments.push({})],
    [
      'pending attachment imports',
      (): void => void composer.pendingAttachmentImportIds.push(1),
    ],
    [
      'a staged schedule',
      (): void => void (composer.scheduledSendDraft = { runAt: 'soon' }),
    ],
    ['a send in flight', (): void => void (composer.isSending = true)],
    [
      'an explicit project choice',
      (): void => void (composer.workspaceSelectionExplicit = true),
    ],
  ])('protects a composer with %s', (_label, protect) => {
    protect();
    expect(apply()).toBe(false);
    expect(composer.selectWorkspace).not.toHaveBeenCalled();
    expect(composer.clearWorkspaceSelectionReason).not.toHaveBeenCalled();
    expect(composer.workspaceId).toBe('side-quest');
  });

  it('protects a draft typed while Apply was pending', () => {
    expect(
      apply('first-run-import', () => void (composer.text = 'Ship it')),
    ).toBe(false);
    expect(composer.selectWorkspace).not.toHaveBeenCalled();
  });

  it('rejects a completion after a newer selection, even back to the same project', () => {
    expect(
      apply('first-run-import', () => {
        composer.selectWorkspace('payments-service');
        composer.selectWorkspace('side-quest');
        composer.selectWorkspace.mockClear();
      }),
    ).toBe(false);
    expect(composer.selectWorkspace).not.toHaveBeenCalled();
  });

  it('rejects a completion after the context changed', () => {
    expect(
      apply('first-run-import', () => {
        context = {
          accountEpoch: 1,
          state: { revision: 5, context: { kind: 'organization', id: 'org' } },
        };
      }),
    ).toBe(false);
  });

  it('rejects a completion after the account changed', () => {
    expect(
      apply('first-run-import', () => {
        context = { ...context, accountEpoch: 2 };
      }),
    ).toBe(false);
  });

  it('does not target a project outside the current context', () => {
    inScope.delete('payments-service');
    expect(apply()).toBe(false);
  });

  it('does not target a removed project or a Cowork project', () => {
    projects = projects.filter((project) => project.id !== 'payments-service');
    expect(apply()).toBe(false);
    expect(
      apply('first-run-import', undefined, {
        workspaceId: 'notes',
        status: ENABLED,
      }),
    ).toBe(false);
    expect(composer.selectWorkspace).not.toHaveBeenCalled();
  });

  it('only clears the landing reason when the project is already selected', () => {
    composer.text = '';
    composer.workspaceId = 'payments-service';
    expect(apply()).toBe(true);
    expect(composer.selectWorkspace).not.toHaveBeenCalled();
    expect(composer.clearWorkspaceSelectionReason).toHaveBeenCalled();
    expect(composer.workspaceSelectionReason).toBeNull();
  });

  it('lets a later, current Apply select its own project', () => {
    expect(apply()).toBe(true);
    expect(
      apply('import-results', undefined, {
        workspaceId: 'side-quest',
        status: ENABLED,
      }),
    ).toBe(true);
    expect(composer.workspaceId).toBe('side-quest');
  });

  it.each([null, 'most-recent-import'] as const)(
    'rejects an older review after a newer same-project Apply with reason %s',
    (reason) => {
      composer.workspaceSelectionReason = reason;
      const older = captureRepoRulesReviewOrigin('first-run-import');
      const newer = captureRepoRulesReviewOrigin('import-results');
      retargetHomeAfterRepoRulesApplied(newer, {
        workspaceId: 'side-quest',
        status: ENABLED,
      });
      expect(
        retargetHomeAfterRepoRulesApplied(older, {
          workspaceId: 'payments-service',
          status: ENABLED,
        }),
      ).toBe(false);
      expect(composer.workspaceId).toBe('side-quest');
      expect(composer.selectWorkspace).not.toHaveBeenCalled();
    },
  );

  it('rejects a context that changed away and back while Apply was pending', () => {
    expect(
      apply('import-results', () => {
        context.state.revision += 2;
      }),
    ).toBe(false);
    expect(composer.clearWorkspaceSelectionReason).not.toHaveBeenCalled();
  });

  it('protects an explicit choice made while Apply was pending', () => {
    expect(
      apply('import-results', () => {
        composer.workspaceSelectionExplicit = true;
      }),
    ).toBe(false);
    expect(composer.workspaceSelectionReason).toBe('most-recent-import');
  });
});

describe('isHomeComposerRetargetable', () => {
  it('accepts an empty, inherited composer', () => {
    expect(isHomeComposerRetargetable(composer)).toBe(true);
  });
});
