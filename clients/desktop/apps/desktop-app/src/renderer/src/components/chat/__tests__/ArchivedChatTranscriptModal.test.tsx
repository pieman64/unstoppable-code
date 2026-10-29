/**
 * @jest-environment jsdom
 */
import { act, type JSX, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  ArchivedChatSummary,
  PersistedChatTab,
  SharedRunMetadata,
} from '@canopy/desktop-shared/types';
import { ArchivedChatTranscriptModal } from '../ArchivedChatTranscriptModal';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let capturedExistingShare: SharedRunMetadata | undefined;

jest.mock('@/components/shared/ShareRunModal', () => ({
  ShareRunModal: (props: {
    existingShare?: SharedRunMetadata;
  }): JSX.Element => {
    capturedExistingShare = props.existingShare;
    return <div data-testid="share-run-modal" />;
  },
}));
jest.mock('@/lib/share-targets', () => ({
  useTeamOrgShareEntryVisible: (): boolean => true,
}));
jest.mock('../ChatMessageList', () => ({
  ChatMessageList: (): null => null,
}));
jest.mock('../../shared/search/SearchBar', () => ({
  SearchBar: (): null => null,
}));
jest.mock('../../shared/loading/spinners/LoadingSpinner', () => ({
  LoadingSpinner: (): null => null,
}));
jest.mock('@/hooks/useTranscriptSearch', () => ({
  useTranscriptSearch: (): Record<string, unknown> => ({
    query: '',
    setQuery: jest.fn(),
    currentIndex: 0,
    totalCount: 0,
    goToNext: jest.fn(),
    goToPrevious: jest.fn(),
    selection: null,
    error: null,
    refresh: jest.fn(),
  }),
}));
jest.mock('@canopy/ui-shared/components', () => ({
  DialogModal: ({
    headerActions,
    children,
  }: {
    headerActions?: ReactNode;
    children?: ReactNode;
  }): JSX.Element => (
    <div>
      {headerActions}
      {children}
    </div>
  ),
  TranscriptPagingControls: (): null => null,
}));

const EXISTING_SHARE: SharedRunMetadata = {
  externalId: 'run-1',
  shareScope: 'team',
  teamId: 'team-1',
  teamName: 'Platform',
  sharedAt: '2026-09-24T20:00:00.000Z',
};

const SUMMARY = {
  chatId: 'chat-1',
  title: 'Archived session',
  turnCount: 1,
  restorable: true,
} as ArchivedChatSummary;

const TAB = {
  id: 'chat-1',
  title: 'Archived session',
  messages: [],
  sharedRun: EXISTING_SHARE,
} as PersistedChatTab;

describe('ArchivedChatTranscriptModal', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    capturedExistingShare = undefined;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    window.api = {
      chat: {
        readArchive: jest.fn().mockResolvedValue({ tab: TAB }),
      },
    } as typeof window.api;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('forwards the archived run share when opening its management modal', async () => {
    await act(async () => {
      root.render(
        <ArchivedChatTranscriptModal
          projectId="project-1"
          worktreeId="worktree-1"
          summary={SUMMARY}
          onRestore={jest.fn()}
          onSummarize={jest.fn()}
          restoring={false}
          summarizing={false}
          onClose={jest.fn()}
        />,
      );
      for (let flush = 0; flush < 4; flush += 1) await Promise.resolve();
    });

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="archived-chat-transcript-share-run"]',
        )
        ?.click();
      await Promise.resolve();
    });

    expect(capturedExistingShare).toEqual(EXISTING_SHARE);
  });
});
