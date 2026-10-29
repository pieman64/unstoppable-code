/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AppAdvisorJson } from '@canopy/desktop-shared/types';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';
import { useCurrentUiStateReporter } from '../useCurrentUiStateReporter';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const KEY = 'pipelineRuns.detailModal';

function Reporter({
  reportKey = KEY,
  value,
}: {
  reportKey?: string | null;
  value: AppAdvisorJson | null;
}): JSX.Element {
  useCurrentUiStateReporter(reportKey, value);
  return <></>;
}

function slice(key: string = KEY): AppAdvisorJson | undefined {
  return useCurrentUiStateStore.getState().slices[key];
}

describe('useCurrentUiStateReporter ownership', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useCurrentUiStateStore.setState({ revision: 0, slices: {} });
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

  it('reports a value and clears it on unmount', () => {
    act(() => {
      root.render(<Reporter value={{ executionId: 'a' }} />);
    });
    expect(slice()).toEqual({ executionId: 'a' });

    act(() => {
      root.render(<></>);
    });
    expect(slice()).toBeUndefined();
  });

  it('never clears a key it did not report when a non-reporting instance unmounts', () => {
    act(() => {
      root.render(
        <>
          <Reporter value={{ executionId: 'owner' }} />
          <Reporter value={null} />
        </>,
      );
    });
    expect(slice()).toEqual({ executionId: 'owner' });

    // The non-reporting instance (an inline child or archived view) goes.
    act(() => {
      root.render(
        <>
          <Reporter value={{ executionId: 'owner' }} />
        </>,
      );
    });
    expect(slice()).toEqual({ executionId: 'owner' });
  });

  it('does not clear a value another instance wrote after it', () => {
    act(() => {
      root.render(
        <>
          <Reporter key="first" value={{ executionId: 'first' }} />
          <Reporter key="second" value={{ executionId: 'second' }} />
        </>,
      );
    });
    expect(slice()).toEqual({ executionId: 'second' });

    // The earlier writer unmounts: the later writer still owns the key.
    act(() => {
      root.render(
        <>
          <Reporter key="second" value={{ executionId: 'second' }} />
        </>,
      );
    });
    expect(slice()).toEqual({ executionId: 'second' });
  });

  it('clears only its own value when it turns null', () => {
    act(() => {
      root.render(
        <>
          <Reporter key="first" value={{ executionId: 'first' }} />
          <Reporter key="second" value={{ executionId: 'second' }} />
        </>,
      );
    });
    act(() => {
      root.render(
        <>
          <Reporter key="first" value={null} />
          <Reporter key="second" value={{ executionId: 'second' }} />
        </>,
      );
    });
    expect(slice()).toEqual({ executionId: 'second' });

    act(() => {
      root.render(
        <>
          <Reporter key="first" value={null} />
          <Reporter key="second" value={null} />
        </>,
      );
    });
    expect(slice()).toBeUndefined();
  });

  it('reports nothing under a null key', () => {
    act(() => {
      root.render(<Reporter reportKey={null} value={{ executionId: 'a' }} />);
    });
    expect(useCurrentUiStateStore.getState().slices).toEqual({});
  });
});
