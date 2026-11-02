/** @jest-environment jsdom */
import { act, Profiler, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { useGlidingNumber } from '../use-gliding-number';
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

it('preserves the final count while bounding React updates to a 30Hz beat on a 120Hz display', () => {
  let nextId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const raf = jest
    .spyOn(window, 'requestAnimationFrame')
    .mockImplementation((callback) => {
      frames.set(++nextId, callback);
      return nextId;
    });
  const cancel = jest
    .spyOn(window, 'cancelAnimationFrame')
    .mockImplementation((id) => {
      frames.delete(id);
    });
  function Count({ target }: { target: number }): JSX.Element {
    return <span>{useGlidingNumber(target)}</span>;
  }
  const host = document.createElement('div');
  const root = createRoot(host);
  let commits = 0;
  const render = (target: number): void => {
    act(() =>
      root.render(
        <Profiler
          id="count"
          onRender={() => {
            commits += 1;
          }}
        >
          <Count target={target} />
        </Profiler>,
      ),
    );
  };
  try {
    render(0);
    render(1000);
    commits = 0;
    for (let i = 0; i <= 120; i++)
      act(() => {
        const pending: FrameRequestCallback[] = [];
        frames.forEach((callback) => {
          pending.push(callback);
        });
        frames.clear();
        pending.forEach((callback) => {
          callback((i * 1000) / 120);
        });
      });
    expect(host.textContent).toBe('1000');
    expect(commits).toBeLessThanOrEqual(30);
    expect(frames.size).toBe(0);
  } finally {
    act(() => root.unmount());
    raf.mockRestore();
    cancel.mockRestore();
  }
});
