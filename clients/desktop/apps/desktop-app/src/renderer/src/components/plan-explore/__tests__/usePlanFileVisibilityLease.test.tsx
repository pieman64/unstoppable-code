/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { TrackedPlanFileVisibilityRequest } from '@canopy/desktop-shared/types';
import {
  usePlanFileVisibilityLease,
  type PlanFileVisibilityRef,
} from '../usePlanFileVisibilityLease';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const ROADMAP: PlanFileVisibilityRef = {
  projectId: 'proj-1',
  worktreeId: 'wt-1',
  planId: 'plan-roadmap',
};

function Harness({
  planRef,
  visible,
}: {
  readonly planRef: PlanFileVisibilityRef | null;
  readonly visible: boolean;
}): JSX.Element {
  usePlanFileVisibilityLease(planRef, visible);
  return <div />;
}

let setFileVisibility: jest.Mock<
  Promise<void>,
  [TrackedPlanFileVisibilityRequest]
>;
let container: HTMLDivElement;
let root: Root;

function render(planRef: PlanFileVisibilityRef | null, visible: boolean): void {
  act(() => {
    root.render(<Harness planRef={planRef} visible={visible} />);
  });
}

function requests(): TrackedPlanFileVisibilityRequest[] {
  return setFileVisibility.mock.calls.map(([request]) => request);
}

beforeEach(() => {
  setFileVisibility = jest
    .fn<Promise<void>, [TrackedPlanFileVisibilityRequest]>()
    .mockResolvedValue(undefined);
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { activity: { plans: { setFileVisibility } } },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe('usePlanFileVisibilityLease', () => {
  it('leases while visible and releases on hide and unmount with the same consumer', () => {
    render(ROADMAP, true);
    const consumerId = requests()[0]?.consumerId;
    expect(consumerId).toEqual(expect.stringMatching(/.+/));
    expect(requests()).toEqual([{ ...ROADMAP, consumerId, visible: true }]);

    // A re-render with an equal ref keeps the one lease.
    render({ ...ROADMAP }, true);
    expect(setFileVisibility).toHaveBeenCalledTimes(1);

    render(ROADMAP, false);
    expect(requests()[1]).toEqual({ ...ROADMAP, consumerId, visible: false });

    render(ROADMAP, true);
    act(() => {
      root.unmount();
    });
    expect(requests().slice(2)).toEqual([
      { ...ROADMAP, consumerId, visible: true },
      { ...ROADMAP, consumerId, visible: false },
    ]);
    root = createRoot(container);
  });

  it('moves the lease when the view switches plans', () => {
    render(ROADMAP, true);
    const consumerId = requests()[0]?.consumerId;
    const importer = { ...ROADMAP, planId: 'plan-importer' };

    render(importer, true);

    expect(requests().slice(1)).toEqual([
      { ...ROADMAP, consumerId, visible: false },
      { ...importer, consumerId, visible: true },
    ]);
  });

  it('takes no lease without a plan, and drops it when the plan goes away', () => {
    render(null, true);
    expect(setFileVisibility).not.toHaveBeenCalled();

    render(ROADMAP, true);
    render(null, true);
    expect(requests().map((request) => request.visible)).toEqual([true, false]);
  });

  it('gives each view its own consumer id', () => {
    act(() => {
      root.render(
        <>
          <Harness planRef={ROADMAP} visible />
          <Harness planRef={ROADMAP} visible />
        </>,
      );
    });

    const [first, second] = requests();
    expect(first?.consumerId).toBeTruthy();
    expect(second?.consumerId).toBeTruthy();
    expect(first?.consumerId).not.toBe(second?.consumerId);
  });

  it('ignores a failed lease request', async () => {
    setFileVisibility.mockRejectedValue(new Error('IPC unavailable'));
    render(ROADMAP, true);
    await act(async () => {
      await Promise.resolve();
    });
    render(ROADMAP, false);
    expect(setFileVisibility).toHaveBeenCalledTimes(2);
  });
});
