/**
 * @jest-environment jsdom
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Step } from '@canopy/desktop-shared/types/pipeline';
import { StepDetailPanel } from '../StepDetailPanel';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function renderPanel(step: Step): {
  container: HTMLDivElement;
  cleanup: () => void;
  onChange: jest.Mock<void, [Step]>;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const onChange = jest.fn<void, [Step]>();
  act(() => {
    root.render(
      <StepDetailPanel
        step={step}
        stepIndex={0}
        jobId="build"
        onChange={onChange}
        onClose={jest.fn()}
      />,
    );
  });
  return {
    container,
    onChange,
    cleanup: (): void => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

async function changeInput(
  input: HTMLInputElement,
  value: string,
): Promise<void> {
  await act(async () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    );
    if (!descriptor?.set) {
      throw new Error('Expected input value setter');
    }
    descriptor.set.call(input, value);
    input.dispatchEvent(
      new Event('input', { bubbles: true, cancelable: true }),
    );
    await Promise.resolve();
  });
}

describe('StepDetailPanel', () => {
  it('clears run-pipeline target when uses changes to another action', async () => {
    const rendered = renderPanel({
      id: 'child',
      uses: 'builtin/run-pipeline',
      target: { scope: 'directory', path: 'child-dir' },
    });

    const usesInput = rendered.container.querySelector(
      'input[placeholder="builtin/action-name or project/action-name"]',
    );
    if (!(usesInput instanceof HTMLInputElement)) {
      throw new Error('Expected uses input');
    }

    await changeInput(usesInput, 'builtin/create-worktree');

    const lastCall =
      rendered.onChange.mock.calls[rendered.onChange.mock.calls.length - 1];
    const updated = lastCall?.[0];
    expect(updated?.uses).toBe('builtin/create-worktree');
    expect(updated && 'target' in updated).toBe(false);
    rendered.cleanup();
  });
});
