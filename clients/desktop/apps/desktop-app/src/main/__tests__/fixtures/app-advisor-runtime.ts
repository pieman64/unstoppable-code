import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
} from '@canopy/desktop-shared/types';
import type { AppAdvisorToolRuntime } from '../../app-advisor/runtime';

export function createAppAdvisorRuntimeFixture(
  overrides: Partial<AppAdvisorToolRuntime> = {},
): AppAdvisorToolRuntime {
  return {
    watcherDestination: {
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: APP_ADVISOR_WORKTREE_ID,
      chatId: 'advisor-chat',
    },
    requestUserAnswers: jest.fn(),
    loadScriptOutput: jest.fn(),
    loadPipelineYaml: jest.fn(),
    showFiles: jest.fn(),
    getScopedFileComments: jest.fn(),
    respondToScopedFileComment: jest.fn(),
    searchWatchers: jest.fn().mockResolvedValue({
      catalog: [],
      activeWatchers: [],
    }),
    setupWatchers: jest.fn().mockResolvedValue({ ok: true, results: [] }),
    watchGitHubItems: jest.fn().mockResolvedValue({
      ok: true,
      status: 'created',
      watcherId: 'watcher-github',
      itemCount: 1,
    }),
    requestUiState: jest.fn(),
    dispatchRendererAction: jest.fn(),
    getPipelineDebugContext: jest.fn(),
    ...overrides,
  };
}
