/**
 * @jest-environment jsdom
 */
import { renderToStaticMarkup } from 'react-dom/server';
import type { JSX } from 'react';
import { ProgressChecklist } from '../ProgressChecklist';
import { PrBadgeTooltipContent } from '../WorktreeRow';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';

function render(element: JSX.Element): HTMLDivElement {
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(element);
  return container;
}

// Both render inside tooltips that portal to `document.body`, out of every
// surface block. Pull request text is recorded; command output carries its
// own block (CAN-3119).
describe('portaled tooltip content session-replay blocks (CAN-3119)', () => {
  it('records the pull request tooltip, title and description included', () => {
    const container = render(
      <PrBadgeTooltipContent
        pr={{
          state: 'open',
          title: 'Rework the orchard billing export',
          description: 'Moves the export behind the new ledger flag.',
          ciStatus: 'passing',
          reviewStatus: 'approved',
        }}
      />,
    );
    const root = container.firstElementChild;
    expect(container.querySelector(`.${REPLAY_BLOCK_CLASS}`)).toBeNull();
    expect(root?.textContent).toContain('Rework the orchard billing export');
    expect(root?.textContent).toContain('Moves the export');
  });

  it('blocks a progress checklist error, not its steps', () => {
    const container = render(
      <ProgressChecklist
        steps={[{ key: 'push', label: 'Push', status: 'error' }]}
        error="fatal: unable to access 'https://example.test/acme/repo.git'"
      />,
    );
    const block = container.querySelector(`.${REPLAY_BLOCK_CLASS}`);
    expect(block?.textContent).toBe(
      "fatal: unable to access 'https://example.test/acme/repo.git'",
    );
    expect(container.querySelectorAll(`.${REPLAY_BLOCK_CLASS}`)).toHaveLength(
      1,
    );
  });

  it('adds no block to a checklist without an error', () => {
    const container = render(
      <ProgressChecklist
        steps={[{ key: 'push', label: 'Push', status: 'completed' }]}
      />,
    );
    expect(container.querySelector(`.${REPLAY_BLOCK_CLASS}`)).toBeNull();
  });
});
