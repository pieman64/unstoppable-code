/**
 * @jest-environment jsdom
 */
import type { ResolvedProjectStartPage } from '@canopy/desktop-shared/types';
import {
  selectResolvedStartPage,
  useStartPageStore,
} from '@/stores/startPageStore';

const resolveMock = jest.fn<
  Promise<ResolvedProjectStartPage | null>,
  [{ projectId: string; worktreeId?: string }]
>();

beforeEach(() => {
  resolveMock.mockReset();
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { resolveProjectStartPage: resolveMock },
  });
  useStartPageStore.setState({ resolved: {} });
});

describe('startPageStore', () => {
  it('caches resolved values per project and worktree', async () => {
    const value: ResolvedProjectStartPage = {
      startPage: { kind: 'file', path: 'README.md' },
      source: 'local',
    };
    resolveMock.mockResolvedValue(value);

    await useStartPageStore.getState().refresh('p1', 'w1');

    expect(resolveMock).toHaveBeenCalledWith({
      projectId: 'p1',
      worktreeId: 'w1',
    });
    const state = useStartPageStore.getState();
    expect(selectResolvedStartPage(state, 'p1', 'w1')).toEqual(value);
    expect(selectResolvedStartPage(state, 'p1')).toBeUndefined();
  });

  it('dedupes concurrent refreshes and treats failures as none', async () => {
    resolveMock.mockRejectedValue(new Error('boom'));

    const [a, b] = await Promise.all([
      useStartPageStore.getState().refresh('p1'),
      useStartPageStore.getState().refresh('p1'),
    ]);

    expect(resolveMock).toHaveBeenCalledTimes(1);
    expect(a).toBeNull();
    expect(b).toBeNull();
    expect(selectResolvedStartPage(useStartPageStore.getState(), 'p1')).toBe(
      null,
    );
  });

  it('invalidates every entry for one project only', () => {
    useStartPageStore.setState({
      resolved: { p1: null, 'p1:w1': null, p2: null, 'p10:w1': null },
    });

    useStartPageStore.getState().invalidateProject('p1');

    expect(Object.keys(useStartPageStore.getState().resolved).sort()).toEqual([
      'p10:w1',
      'p2',
    ]);
  });

  it('does not restore an invalidated value from an older in-flight refresh', async () => {
    let resolveFirst: (value: ResolvedProjectStartPage | null) => void = () =>
      undefined;
    const first = new Promise<ResolvedProjectStartPage | null>((resolve) => {
      resolveFirst = resolve;
    });
    const latest: ResolvedProjectStartPage = {
      startPage: { kind: 'url', url: 'https://new.example.com' },
      source: 'local',
    };
    resolveMock.mockReturnValueOnce(first).mockResolvedValueOnce(latest);

    const staleRefresh = useStartPageStore.getState().refresh('p1', 'w1');
    useStartPageStore.getState().invalidateProject('p1');
    await useStartPageStore.getState().refresh('p1', 'w1');
    resolveFirst({
      startPage: { kind: 'url', url: 'https://old.example.com' },
      source: 'local',
    });
    await staleRefresh;

    expect(resolveMock).toHaveBeenCalledTimes(2);
    expect(
      selectResolvedStartPage(useStartPageStore.getState(), 'p1', 'w1'),
    ).toEqual(latest);
  });

  it('re-resolves every cached entry for the saved project', async () => {
    const latest: ResolvedProjectStartPage = {
      startPage: { kind: 'file', path: 'docs/start.md' },
      source: 'source',
    };
    useStartPageStore.setState({
      resolved: { p1: null, 'p1:w1': null, p2: null },
    });
    resolveMock.mockResolvedValue(latest);

    await useStartPageStore.getState().refreshProject('p1');

    expect(resolveMock.mock.calls).toEqual([
      [{ projectId: 'p1' }],
      [{ projectId: 'p1', worktreeId: 'w1' }],
    ]);
    const state = useStartPageStore.getState();
    expect(selectResolvedStartPage(state, 'p1')).toEqual(latest);
    expect(selectResolvedStartPage(state, 'p1', 'w1')).toEqual(latest);
    expect(selectResolvedStartPage(state, 'p2')).toBeNull();
  });
});
