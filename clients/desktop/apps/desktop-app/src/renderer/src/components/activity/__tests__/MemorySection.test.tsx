/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryExplorer } from '@/components/memory/MemoryExplorer';
import { ActivitySectionChromeContext } from '@/components/shared/panel-section';
import { MemorySection } from '../MemorySection';

jest.mock('@/components/memory/MemoryExplorer', () => ({
  MemoryExplorer: jest.fn((): null => null),
}));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

describe('MemorySection', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    jest.clearAllMocks();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it.each(['body-only', 'frameless'] as const)(
    'binds the shared explorer to workspace memory in %s chrome',
    (chrome) => {
      act(() => {
        root.render(
          <ActivitySectionChromeContext.Provider value={chrome}>
            <MemorySection projectId="project-one" worktreeId="worktree-one" />
          </ActivitySectionChromeContext.Provider>,
        );
      });
      expect(
        jest.mocked(MemoryExplorer).mock.calls[
          jest.mocked(MemoryExplorer).mock.calls.length - 1
        ][0],
      ).toEqual({
        scope: 'workspace',
        hideWhenEmpty: false,
        onEmptyChange: undefined,
        projectId: 'project-one',
      });
      act(() => {
        root.render(
          <ActivitySectionChromeContext.Provider value={chrome}>
            <MemorySection projectId="cowork-two" worktreeId="entry-two" />
          </ActivitySectionChromeContext.Provider>,
        );
      });
      expect(
        jest.mocked(MemoryExplorer).mock.calls[
          jest.mocked(MemoryExplorer).mock.calls.length - 1
        ][0],
      ).toEqual({
        scope: 'workspace',
        hideWhenEmpty: false,
        onEmptyChange: undefined,
        projectId: 'cowork-two',
      });
    },
  );
});
