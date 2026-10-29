/** @jest-environment jsdom */
import { setTestEarlyAccessFeatures } from '@/test-utils/labsExperiments';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { resetExperimentalFeaturesStoreForTest } from '@/stores/experimentalFeaturesStore';
import { useSidebarStore } from '@/stores/sidebarStore';
import { useTopBarLeadingInsetClassName } from '../useTopBarLeadingInsetClassName';

interface HookProbe {
  current: string | null;
}

function HookHarness({ probe }: { probe: HookProbe }): null {
  probe.current = useTopBarLeadingInsetClassName();
  return null;
}

describe('useTopBarLeadingInsetClassName', () => {
  const initialSidebarHidden = useSidebarStore.getState().hidden;
  let container: HTMLDivElement;
  let root: Root;

  function renderProbe(): HookProbe {
    const probe: HookProbe = { current: null };
    act(() => {
      root.render(createElement(HookHarness, { probe }));
    });
    return probe;
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    resetExperimentalFeaturesStoreForTest();
    useSidebarStore.setState({ hidden: initialSidebarHidden });
  });

  it('uses the inset alignment without a Labs opt-in', () => {
    useSidebarStore.setState({ hidden: false });
    expect(renderProbe().current).toBe('pl-1');
  });

  it('lines up with the first tab in the inset layout while the sidebar is docked', () => {
    useSidebarStore.setState({ hidden: false });
    const probe = renderProbe();
    act(() => {
      setTestEarlyAccessFeatures({ enabled: true });
    });
    expect(probe.current).toBe('pl-1');
  });

  it('keeps the 9px inset after the titlebar corner when the sidebar is hidden', () => {
    useSidebarStore.setState({ hidden: true });
    const probe = renderProbe();
    act(() => {
      setTestEarlyAccessFeatures({ enabled: true });
    });
    expect(probe.current).toBe('pl-2.25');
  });
});
