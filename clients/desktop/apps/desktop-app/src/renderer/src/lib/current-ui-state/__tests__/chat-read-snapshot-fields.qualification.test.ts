/** @jest-environment jsdom */

let mockDirtyTabIds: string[] = [];
jest.mock('@/lib/file-viewer/desktop-file-session-controller', () => ({
  desktopFileSessionController: {
    dirtyTabIds: (): string[] => [...mockDirtyTabIds],
    isDirty: (tabId: string): boolean => mockDirtyTabIds.includes(tabId),
    subscribe: (): (() => void) => () => undefined,
    getRevision: (): number => 0,
  },
}));

import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { buildCurrentUiStateSnapshot } from '../buildCurrentUiStateSnapshot';

describe('UI state fields App Advisor chat reads use (CAN-5999)', () => {
  it('reports the file tabs with unsaved edits, by id only', () => {
    mockDirtyTabIds = ['file-1', 'file-3'];

    const snapshot = buildCurrentUiStateSnapshot({});

    expect(snapshot.dirtyFileTabIds).toEqual(['file-1', 'file-3']);
    expect(JSON.stringify(snapshot.dirtyFileTabIds)).not.toContain('/');
  });

  it('reports no file tab when none has unsaved edits', () => {
    mockDirtyTabIds = [];

    expect(buildCurrentUiStateSnapshot({}).dirtyFileTabIds).toEqual([]);
  });

  it('reports the Cowork project the Chats section shows', () => {
    useStandaloneChatStore.setState({ activeChatProjectId: 'cowork-42' });

    expect(buildCurrentUiStateSnapshot({}).activeCoworkProjectId).toBe(
      'cowork-42',
    );
  });
});
