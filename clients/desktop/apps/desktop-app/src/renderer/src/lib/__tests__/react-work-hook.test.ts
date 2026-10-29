/**
 * @jest-environment jsdom
 */
import {
  act,
  createElement,
  memo,
  useState,
  type Dispatch,
  type JSX,
  type SetStateAction,
} from 'react';
import {
  countPerformedWorkFibers,
  createReactWorkHook,
  installReactWorkHook,
  type ReactWorkQuery,
} from '../react-work-hook';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const DEVTOOLS_HOOK_KEY = '__REACT_DEVTOOLS_GLOBAL_HOOK__';
// The query the E2E harness reads (`monitor.mjs`).
const REACT_WORK_QUERY_KEY = '__CANOPY_REACT_WORK__';

function setE2eBuild(value: boolean): void {
  Object.defineProperty(globalThis, '__CANOPY_E2E__', {
    configurable: true,
    value,
  });
}

interface TestFiber {
  flags: number;
  child: TestFiber | null;
  sibling: TestFiber | null;
  alternate: TestFiber | null;
}

function fiber(flags: number, children: TestFiber[] = []): TestFiber {
  const node: TestFiber = {
    flags,
    child: children[0] ?? null,
    sibling: null,
    alternate: null,
  };
  children.forEach((child, index) => {
    child.sibling = children[index + 1] ?? null;
  });
  return node;
}

describe('React work hook', () => {
  afterEach(() => {
    setE2eBuild(false);
    Reflect.deleteProperty(globalThis, DEVTOOLS_HOOK_KEY);
    Reflect.deleteProperty(globalThis, REACT_WORK_QUERY_KEY);
  });

  it('counts fibers that performed work and skips subtrees React reused', () => {
    // A reused child list still points at the previous commit's fibers, whose
    // PerformedWork flags describe that earlier commit.
    const reusedChild = fiber(1, [fiber(1)]);
    const reused = fiber(0, [reusedChild]);
    reused.alternate = fiber(0, []);
    reused.alternate.child = reusedChild;
    const rendered = fiber(1, [fiber(0, [fiber(1)]), fiber(1)]);
    const root = fiber(0, [reused, rendered]);

    expect(countPerformedWorkFibers({ current: root })).toBe(3);
    expect(countPerformedWorkFibers({ current: null })).toBe(0);
    expect(countPerformedWorkFibers(undefined)).toBe(0);
  });

  it('installs only in E2E builds and never over an existing DevTools hook', () => {
    const target = {};
    expect(installReactWorkHook(target)).toBe(false);
    expect(Reflect.has(target, DEVTOOLS_HOOK_KEY)).toBe(false);

    setE2eBuild(true);
    const existing = { supportsFiber: true };
    const withDevtools = { [DEVTOOLS_HOOK_KEY]: existing };
    expect(installReactWorkHook(withDevtools)).toBe(false);
    expect(Reflect.get(withDevtools, DEVTOOLS_HOOK_KEY)).toBe(existing);

    expect(installReactWorkHook(target)).toBe(true);
    expect(Reflect.get(target, DEVTOOLS_HOOK_KEY)).toMatchObject({
      supportsFiber: true,
    });
    expect(Reflect.get(target, REACT_WORK_QUERY_KEY)).toBeDefined();
  });

  it('resets its counts into a new generation', () => {
    const { hook, query } = createReactWorkHook();
    hook.onCommitFiberRoot(1, { current: fiber(1) });
    const before = query.snapshot();
    expect(before.counters).toEqual({ commits: 1, performedWorkFibers: 1 });

    const reset = query.reset();
    expect(reset.counters).toEqual({ commits: 0, performedWorkFibers: 0 });
    expect(reset.generation).not.toBe(before.generation);
    expect(query.snapshot().generation).toBe(reset.generation);
  });

  it('records the first commit as the page mount milestone, kept across resets', () => {
    let now = 410.8;
    const { hook, query } = createReactWorkHook(() => now);
    expect(query.snapshot().milestones).toEqual({});

    hook.onCommitFiberRoot(1, { current: fiber(1) });
    now = 900;
    hook.onCommitFiberRoot(1, { current: fiber(1) });
    expect(query.snapshot().milestones).toEqual({ firstCommitAtMs: 410.8 });

    // A counter reset starts a new window, not a new page.
    expect(query.reset().milestones).toEqual({ firstCommitAtMs: 410.8 });
  });

  it('counts real React commits and the components each one rendered', async () => {
    setE2eBuild(true);
    expect(installReactWorkHook(globalThis)).toBe(true);
    const query: unknown = Reflect.get(globalThis, REACT_WORK_QUERY_KEY);
    if (!isQuery(query)) throw new Error('Missing React work query');
    // react-dom injects into the hook when it first loads, so load it only now.
    const { createRoot } = await import('react-dom/client');

    let setCount: Dispatch<SetStateAction<number>> = () => undefined;
    function Leaf({ label }: { label: string }): JSX.Element {
      return createElement('span', null, label);
    }
    function Counter(): JSX.Element {
      const [count, set] = useState(0);
      setCount = set;
      return createElement(
        'div',
        null,
        createElement(Leaf, { label: `${count}` }),
      );
    }
    const Static = memo(function Static(): JSX.Element {
      return createElement('p', null, 'static');
    });
    function App(): JSX.Element {
      return createElement(
        'main',
        null,
        createElement(Counter),
        createElement(Static),
      );
    }

    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(createElement(App));
    });
    // Mount renders App, Counter, Leaf and the memoized Static.
    expect(query.snapshot().counters).toEqual({
      commits: 1,
      performedWorkFibers: 4,
    });

    query.reset();
    act(() => {
      setCount(1);
    });
    // Only Counter and its Leaf re-render; App and Static are reused.
    expect(query.snapshot().counters).toEqual({
      commits: 1,
      performedWorkFibers: 2,
    });
    act(() => {
      root.unmount();
    });
  });
});

function isQuery(value: unknown): value is ReactWorkQuery {
  return (
    typeof value === 'object' &&
    value !== null &&
    'snapshot' in value &&
    typeof value.snapshot === 'function' &&
    'reset' in value &&
    typeof value.reset === 'function'
  );
}
