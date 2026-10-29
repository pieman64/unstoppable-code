/** @jest-environment jsdom */

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ActionTooltip } from '../ActionTooltip';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('ActionTooltip session-replay block (CAN-3119)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  function openTooltip(node: JSX.Element): HTMLElement {
    act(() => root.render(node));
    const trigger = container.querySelector('button');
    act(() => {
      trigger?.dispatchEvent(
        new MouseEvent('mouseover', {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
    });
    const tooltip =
      document.body.querySelector<HTMLElement>('[role="tooltip"]');
    if (!tooltip) throw new Error('tooltip did not open');
    return tooltip;
  }

  it('blocks only the portaled description when the host asks', () => {
    const tooltip = openTooltip(
      <ActionTooltip
        title="Nightly triage"
        description="Summarize the open issues"
        blockDescriptionFromReplay
      >
        <button type="button">Trigger</button>
      </ActionTooltip>,
    );
    const blocks = tooltip.querySelectorAll(`.${REPLAY_BLOCK_CLASS}`);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.textContent).toBe('Summarize the open issues');
    const title = Array.from(tooltip.querySelectorAll('span')).find(
      (span) => span.textContent === 'Nightly triage',
    );
    expect(title).toBeDefined();
    expect(title?.closest(`.${REPLAY_BLOCK_CLASS}`)).toBeNull();
  });

  it('adds no replay marker unless the host asks', () => {
    const tooltip = openTooltip(
      <ActionTooltip title="Run now" description="Start the automation">
        <button type="button">Trigger</button>
      </ActionTooltip>,
    );
    expect(tooltip.querySelector(`.${REPLAY_BLOCK_CLASS}`)).toBeNull();
  });
});
