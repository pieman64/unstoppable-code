/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  captureActivePlanContext,
  resetActivePlanStoreForTests,
  useActivePlanStore,
} from '@/stores/activePlanStore';
import { planViewKey } from '@/stores/planViewStore';
import { useActivePlanRegistration } from '../useActivePlanRegistration';
import type { PlanFileVisibilityRef } from '../usePlanFileVisibilityLease';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const SCOPE = { projectId: 'proj-1', worktreeId: 'wt-1' };
const ROADMAP: PlanFileVisibilityRef = { ...SCOPE, planId: 'plan-roadmap' };
const IMPORTER: PlanFileVisibilityRef = { ...SCOPE, planId: 'plan-importer' };

const markers: Record<string, () => void> = {};

function View({
  name,
  planRef,
  active,
}: {
  readonly name: string;
  readonly planRef: PlanFileVisibilityRef | null;
  readonly active: boolean;
}): JSX.Element {
  markers[name] = useActivePlanRegistration(planRef, active);
  return <div />;
}

let container: HTMLDivElement;
let root: Root;

function render(node: JSX.Element): void {
  act(() => {
    root.render(node);
  });
}

function activePlanId(): string | undefined {
  return captureActivePlanContext(SCOPE)?.planId;
}

function mark(name: string): void {
  act(() => {
    markers[name]?.();
  });
}

beforeEach(() => {
  resetActivePlanStoreForTests();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  resetActivePlanStoreForTests();
});

describe('useActivePlanRegistration', () => {
  it('marks a view active when it becomes active, and clears it on unmount', () => {
    render(<View name="roadmap" planRef={ROADMAP} active={false} />);
    expect(
      useActivePlanStore.getState().viewCounts[
        planViewKey(SCOPE.projectId, SCOPE.worktreeId, ROADMAP.planId)
      ],
    ).toBe(1);
    expect(activePlanId()).toBeUndefined();

    render(<View name="roadmap" planRef={ROADMAP} active />);
    expect(activePlanId()).toBe(ROADMAP.planId);

    render(<></>);
    expect(activePlanId()).toBeUndefined();
    expect(useActivePlanStore.getState().viewCounts).toEqual({});
  });

  it('registers a view that mounts already active', () => {
    render(<View name="roadmap" planRef={ROADMAP} active />);
    expect(activePlanId()).toBe(ROADMAP.planId);
  });

  it('lets the last focused view win and returns a stable marker', () => {
    render(
      <>
        <View name="roadmap" planRef={ROADMAP} active />
        <View name="importer" planRef={IMPORTER} active={false} />
      </>,
    );
    const importerMarker = markers.importer;
    expect(activePlanId()).toBe(ROADMAP.planId);

    mark('importer');
    expect(activePlanId()).toBe(IMPORTER.planId);

    mark('roadmap');
    expect(activePlanId()).toBe(ROADMAP.planId);

    render(
      <>
        <View name="roadmap" planRef={{ ...ROADMAP }} active />
        <View name="importer" planRef={{ ...IMPORTER }} active={false} />
      </>,
    );
    expect(markers.importer).toBe(importerMarker);
  });

  it('never registers or marks a view without a plan', () => {
    render(<View name="recipient" planRef={null} active />);
    mark('recipient');

    expect(activePlanId()).toBeUndefined();
    expect(useActivePlanStore.getState().viewCounts).toEqual({});
  });

  it('keeps the plan active while another of its views stays mounted', () => {
    render(
      <>
        <View key="document" name="document" planRef={ROADMAP} active />
        <View key="diagram" name="diagram" planRef={ROADMAP} active={false} />
      </>,
    );
    expect(activePlanId()).toBe(ROADMAP.planId);

    render(
      <>
        <View key="diagram" name="diagram" planRef={ROADMAP} active={false} />
      </>,
    );
    expect(activePlanId()).toBe(ROADMAP.planId);

    render(<></>);
    expect(activePlanId()).toBeUndefined();
  });
});
