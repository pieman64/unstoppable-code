/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  SUBAGENT_VIEW_TREE_LABEL,
  SubagentViewTreeAction,
} from '../SubagentViewTreeAction';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

describe('SubagentViewTreeAction', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders the View tree label and default test id, then calls its action', () => {
    const onClick = jest.fn();
    act(() => root.render(<SubagentViewTreeAction onClick={onClick} />));

    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="agent-activity-view-tree"]',
    );
    expect(button?.textContent).toContain(SUBAGENT_VIEW_TREE_LABEL);
    expect(button).not.toBeNull();
    act(() => button?.click());
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('passes a caller-provided test id through to the button', () => {
    act(() =>
      root.render(
        <SubagentViewTreeAction
          onClick={jest.fn()}
          dataTestId="custom-view-tree"
        />,
      ),
    );

    expect(
      container.querySelector('[data-testid="custom-view-tree"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="agent-activity-view-tree"]'),
    ).toBeNull();
  });
});
