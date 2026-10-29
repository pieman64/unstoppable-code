import { useAgentFilePresentationStore } from '../agentFilePresentationStore';

describe('agentFilePresentationStore', () => {
  beforeEach(() => {
    useAgentFilePresentationStore.setState({
      byTabId: {},
      transcriptOpenGenerationByScope: {},
    });
  });

  it.each([
    [{ projectId: 'other-project', worktreeId: 'worktree' }, 'chat'],
    [{ projectId: 'project', worktreeId: 'other-worktree' }, 'chat'],
    [{ projectId: 'project', worktreeId: 'worktree' }, 'other-chat'],
  ])(
    'keeps transcript opens independent of %j / %s',
    (otherTarget, otherChat) => {
      const { beginTranscriptOpen } = useAgentFilePresentationStore.getState();
      const target = { projectId: 'project', worktreeId: 'worktree' };
      const first = beginTranscriptOpen(target, 'chat');
      const other = beginTranscriptOpen(otherTarget, otherChat);
      expect(first()).toBe(true);
      expect(other()).toBe(true);
      const latest = beginTranscriptOpen(target, 'chat');
      expect(first()).toBe(false);
      expect(latest()).toBe(true);
      expect(other()).toBe(true);
    },
  );

  it('replaces transient line presentation and increments its revision', () => {
    const store = useAgentFilePresentationStore.getState();
    store.present('file-1', { line: 8 });

    const presentation =
      useAgentFilePresentationStore.getState().byTabId['file-1'];
    expect(presentation).toEqual({
      revision: 1,
      line: 8,
    });

    store.present('file-1', { line: 12 });
    expect(useAgentFilePresentationStore.getState().byTabId['file-1']).toEqual({
      revision: 2,
      line: 12,
    });
  });

  it('clears the prior line when shown again without one', () => {
    const store = useAgentFilePresentationStore.getState();
    store.present('file-1', { line: 2 });
    store.present('file-1', {});

    expect(useAgentFilePresentationStore.getState().byTabId['file-1']).toEqual({
      revision: 2,
    });
  });

  it('retains the originating chat across later line-only presentations', () => {
    const store = useAgentFilePresentationStore.getState();
    store.present('file-1', {
      line: 2,
      origin: {
        projectId: 'project-origin',
        worktreeId: 'worktree-origin',
        chatTabId: 'chat-origin',
      },
    });
    store.present('file-1', { line: 9 });

    expect(useAgentFilePresentationStore.getState().byTabId['file-1']).toEqual({
      revision: 2,
      line: 9,
      origin: {
        projectId: 'project-origin',
        worktreeId: 'worktree-origin',
        chatTabId: 'chat-origin',
      },
    });
  });
});

it('replaces ranges with single/plain requests and replays identical requests', () => {
  useAgentFilePresentationStore.setState({ byTabId: {} });
  const store = useAgentFilePresentationStore.getState();
  store.present('range', { line: 150, lineEnd: 160 });
  expect(useAgentFilePresentationStore.getState().byTabId.range).toEqual({
    revision: 1,
    line: 150,
    lineEnd: 160,
  });
  store.present('range', { line: 150, lineEnd: 160 });
  expect(useAgentFilePresentationStore.getState().byTabId.range.revision).toBe(
    2,
  );
  store.present('range', { line: 155 });
  expect(useAgentFilePresentationStore.getState().byTabId.range).toEqual({
    revision: 3,
    line: 155,
  });
  store.present('range', {});
  expect(useAgentFilePresentationStore.getState().byTabId.range).toEqual({
    revision: 4,
  });
});
