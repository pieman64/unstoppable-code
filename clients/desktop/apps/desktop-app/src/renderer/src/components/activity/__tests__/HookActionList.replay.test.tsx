/** @jest-environment jsdom */
import { renderToStaticMarkup } from 'react-dom/server';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { HookActionList } from '../HooksSection';

function mount(markup: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = markup;
  return host;
}

function blocked(host: HTMLElement, text: string): boolean {
  const node = Array.from(host.querySelectorAll('pre')).find(
    (element) => element.textContent === text,
  );
  if (!node) throw new Error(`${text} not rendered`);
  return node.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`) !== null;
}

describe('hook actions in session replay', () => {
  it('blocks command and chat labels and if-commands, recording pipeline labels', () => {
    const host = mount(
      renderToStaticMarkup(
        <HookActionList
          actions={[
            {
              type: 'command',
              command: 'curl -H "Authorization: Bearer secret" example.com',
            },
            {
              type: 'chat',
              prompt: 'Review the change',
              'if-command': 'test -n "$TOKEN"',
            },
            { type: 'pipeline', source: 'bundled', id: 'code-review' },
          ]}
        />,
      ),
    );
    expect(
      blocked(host, 'curl -H "Authorization: Bearer secret" example.com'),
    ).toBe(true);
    expect(blocked(host, 'Chat: Review the change [if-command]')).toBe(true);
    expect(blocked(host, 'test -n "$TOKEN"')).toBe(true);
    expect(blocked(host, 'Workflow: bundled/code-review')).toBe(false);
  });
});
