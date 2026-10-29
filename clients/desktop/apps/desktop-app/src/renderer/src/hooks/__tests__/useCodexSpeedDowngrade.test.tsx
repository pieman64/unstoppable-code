/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CodexSpeed } from '@canopy/desktop-shared/lib/codex-speed';
import { useCodexSpeedDowngrade } from '../useCodexSpeedDowngrade';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type Downgrade = (speed: CodexSpeed) => CodexSpeed | null;

const KEEP: Downgrade = () => null;
const TO_FAST: Downgrade = (speed) => (speed === 'ultrafast' ? 'fast' : null);

describe('useCodexSpeedDowngrade', () => {
  let container: HTMLDivElement;
  let root: Root;
  let shown: CodexSpeed | null;

  function Probe(props: {
    enabled?: boolean;
    speed: CodexSpeed;
    downgrade: Downgrade;
    apply: (next: CodexSpeed) => void;
  }): JSX.Element | null {
    shown = useCodexSpeedDowngrade({
      enabled: props.enabled ?? true,
      speed: props.speed,
      control: { downgrade: props.downgrade },
      apply: props.apply,
    });
    return null;
  }

  beforeEach(() => {
    shown = null;
    container = document.createElement('div');
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it('keeps a speed the route can run', () => {
    const apply = jest.fn();
    act(() =>
      root.render(<Probe speed="ultrafast" downgrade={KEEP} apply={apply} />),
    );
    expect(shown).toBe('ultrafast');
    expect(apply).not.toHaveBeenCalled();
  });

  it('steps down once when the model changes to one without Ultra fast', () => {
    const apply = jest.fn();
    act(() =>
      root.render(<Probe speed="ultrafast" downgrade={KEEP} apply={apply} />),
    );
    act(() =>
      root.render(
        <Probe speed="ultrafast" downgrade={TO_FAST} apply={apply} />,
      ),
    );
    // Shown at once, before the store echoes the new speed back.
    expect(shown).toBe('fast');
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith('fast');
    act(() =>
      root.render(<Probe speed="fast" downgrade={TO_FAST} apply={apply} />),
    );
    expect(shown).toBe('fast');
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('leaves surfaces without a Codex speed alone', () => {
    const apply = jest.fn();
    act(() =>
      root.render(
        <Probe
          enabled={false}
          speed="ultrafast"
          downgrade={TO_FAST}
          apply={apply}
        />,
      ),
    );
    expect(shown).toBe('ultrafast');
    expect(apply).not.toHaveBeenCalled();
  });
});
