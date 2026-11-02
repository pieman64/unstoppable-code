/** @jest-environment jsdom */

import { act, StrictMode, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  ComposerTipArbiterProvider,
  useComposerTipClaim,
  type ComposerTipKind,
} from '../composer-tip-arbiter';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;

function Tip({
  kind,
  wants = true,
  id = kind,
}: {
  kind: ComposerTipKind;
  wants?: boolean;
  id?: string;
}): ReactNode {
  const { visible } = useComposerTipClaim(kind, wants);
  return visible ? <span data-testid={id}>{kind}</span> : null;
}

function render(children: ReactNode): void {
  act(() => root.render(children));
}

function visible(id: string): boolean {
  return container.querySelector(`[data-testid="${id}"]`) !== null;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it('releases unmounted claims, including independent claims of the same kind', () => {
  const tree = (count: number): ReactNode => (
    <StrictMode>
      <ComposerTipArbiterProvider>
        {count > 0 && <Tip kind="plan-mode" id="first" />}
        {count > 1 && <Tip kind="plan-mode" id="second" />}
        <Tip kind="plan-mode" />
      </ComposerTipArbiterProvider>
    </StrictMode>
  );
  render(tree(2));
  render(tree(1));
  expect(visible('first')).toBe(true);
  expect(visible('second')).toBe(false);
  render(tree(0));
  expect(visible('first')).toBe(false);
  expect(visible('plan-mode')).toBe(true);
});

it('does not suppress outside a provider and respects wantsToShow', () => {
  render(<Tip kind="plan-mode" />);
  expect(visible('plan-mode')).toBe(true);
  render(<Tip kind="plan-mode" wants={false} />);
  expect(visible('plan-mode')).toBe(false);
});

it('isolates composers', () => {
  render(
    <>
      <ComposerTipArbiterProvider>
        <Tip kind="plan-mode" />
      </ComposerTipArbiterProvider>
      <ComposerTipArbiterProvider>
        <Tip kind="plan-mode" />
      </ComposerTipArbiterProvider>
    </>,
  );
  expect(visible('plan-mode')).toBe(true);
});
