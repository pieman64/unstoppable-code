/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RunningSubagentsButton } from '../RunningSubagentsButton';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function button(): HTMLButtonElement | null {
  return host.querySelector<HTMLButtonElement>(
    '[data-testid="running-subagents-button"]',
  );
}

describe('RunningSubagentsButton', () => {
  it('says how many subagents run, in shimmering text', () => {
    act(() =>
      root.render(<RunningSubagentsButton count={6} onClick={jest.fn()} />),
    );
    expect(button()?.textContent).toBe('6 running');
    expect(button()?.querySelector('.canopy-text-shimmer')).not.toBeNull();
    // The shared top-bar action button, in its ghost style: the frame of
    // Launch and Open in beside it.
    expect(button()?.dataset.executionActionButton).toBe('true');
    expect(button()?.className.split(/\s+/)).toEqual(
      expect.arrayContaining(['h-7', 'rounded-md', 'px-2.5', 'text-xs']),
    );
    expect(button()?.getAttribute('aria-label')).toBe(
      '6 subagents running. Show subagents',
    );
  });

  it('names one subagent in the singular', () => {
    act(() =>
      root.render(<RunningSubagentsButton count={1} onClick={jest.fn()} />),
    );
    expect(button()?.getAttribute('aria-label')).toBe(
      '1 subagent running. Show subagents',
    );
  });

  it('opens the Subagents panel when pressed', () => {
    const onClick = jest.fn();
    act(() =>
      root.render(<RunningSubagentsButton count={2} onClick={onClick} />),
    );
    act(() => button()?.click());
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('shows nothing while no subagent runs', () => {
    act(() =>
      root.render(<RunningSubagentsButton count={0} onClick={jest.fn()} />),
    );
    expect(button()).toBeNull();
  });
});
