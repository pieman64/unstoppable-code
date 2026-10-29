/**
 * @jest-environment jsdom
 */
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InvocableInventoryEntry } from '@canopy/desktop-shared/types';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { InvocableMention } from '../InvocableMention';

jest.mock('@/lib/invocableMentionContent', () => ({
  loadInvocableMentionContent: jest.fn(
    () =>
      new Promise(() => {
        // Left pending: the tooltip test never opens the details dialog.
      }),
  ),
}));

const ENTRY: InvocableInventoryEntry = {
  id: 'claude:private-skill',
  provider: 'claude',
  kind: 'skill',
  name: 'private-skill',
  displayName: '/private-skill',
  description: 'Private skill description',
  insertText: '/private-skill ',
  invocationKey: '/private-skill',
  enableRef: { kind: 'skill', sourceId: 'user', skillName: 'private-skill' },
};

let container: HTMLDivElement;
let root: Root;

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
});

describe('InvocableMention session-replay privacy', () => {
  it('records the portaled preview tooltip', () => {
    act(() => {
      root.render(
        <InvocableMention
          target={{
            entry: ENTRY,
            label: '/private-skill',
            aliases: ['/private-skill'],
          }}
        >
          /private-skill
        </InvocableMention>,
      );
    });

    const button = container.querySelector('button');
    act(() => {
      button?.focus();
    });

    const tooltip = document.body.querySelector(':scope > [role="tooltip"]');
    expect(tooltip?.textContent).toContain('Private skill description');
    expect(tooltip?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBeNull();
    expect(tooltip?.querySelector(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBeNull();
  });
});
