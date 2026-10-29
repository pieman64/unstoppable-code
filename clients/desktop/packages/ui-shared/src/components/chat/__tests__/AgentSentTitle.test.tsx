/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import type { ChatAgentSentInfo } from '@canopy/protocol/portal';
import {
  AgentSentSenderOpenerProvider,
  type AgentSentSenderOpener,
} from '../AgentSentSenderOpener';
import {
  AgentSentTitle,
  type AgentSentReceivingContext,
} from '../AgentSentTitle';
import { REPLAY_MASK_CLASS } from '../../../lib/replay-privacy';

const project: ChatAgentSentInfo = {
  sender: {
    kind: 'project',
    projectType: 'code',
    projectId: 'project',
    taskId: 'task',
    chatId: 'chat',
  },
  chatTitle: 'Captured chat title',
  projectLabel: 'Captured project label',
};
const bot: ChatAgentSentInfo = {
  sender: { kind: 'bot', botId: 'app_advisor', taskId: 'task', chatId: 'chat' },
  chatTitle: 'Weekly summary',
  projectLabel: 'App Advisor',
};
function title(
  info: ChatAgentSentInfo,
  context: AgentSentReceivingContext,
): HTMLElement {
  const container = document.createElement('div');
  container.innerHTML = renderToString(
    <AgentSentTitle agentSent={info} receivingContext={context} />,
  );
  return container;
}
describe('AgentSentTitle', () => {
  it('shows only the captured chat title in the same project', () => {
    const el = title(project, { kind: 'project', projectId: 'project' });
    expect(el.textContent).toBe(project.chatTitle);
    expect(el.querySelectorAll('svg')).toHaveLength(1);
  });
  it('compares canonical IDs, not labels, across projects and project/bot kinds', () => {
    for (const context of [
      { kind: 'project', projectId: 'other' },
      { kind: 'bot', botId: 'app_advisor' },
    ] satisfies AgentSentReceivingContext[]) {
      expect(title(project, context).textContent).toBe(
        'Captured chat title·Captured project label',
      );
    }
    expect(
      title(bot, { kind: 'project', projectId: 'project' }).textContent,
    ).toBe('Weekly summary·App Advisor');
  });
  it('omits App Advisor for Advisor to Advisor, but not another bot', () => {
    expect(title(bot, { kind: 'bot', botId: 'app_advisor' }).textContent).toBe(
      'Weekly summary',
    );
    expect(title(bot, { kind: 'bot', botId: 'other' }).textContent).toBe(
      'Weekly summary·App Advisor',
    );
  });
  it('renders captured labels literally, masking only text spans with no raw attribute copy', () => {
    const captured = {
      ...project,
      chatTitle: '<img src=x> old title',
      projectLabel: 'Old project & name',
    };
    const el = title(captured, { kind: 'project', projectId: 'renamed' });
    expect(el.querySelector('img, a, button')).toBeNull();
    expect(el.textContent).toContain(captured.chatTitle);
    expect(el.textContent).toContain(captured.projectLabel);
    expect(
      el
        .querySelector('[data-testid="agent-sent-title"]')
        ?.classList.contains(REPLAY_MASK_CLASS),
    ).toBe(false);
    const masked = el.querySelectorAll(`.${REPLAY_MASK_CLASS}`);
    expect(Array.from(masked, (node) => node.textContent)).toEqual([
      captured.chatTitle,
      captured.projectLabel,
    ]);
    expect(el.querySelector('[title], [aria-label]')).toBeNull();
    expect(el.innerHTML).not.toContain('Sent by');
  });
});

describe('AgentSentTitle with a sender opener', () => {
  function rendered(
    info: ChatAgentSentInfo,
    opener: AgentSentSenderOpener,
  ): { container: HTMLElement; unmount: () => void } {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <AgentSentSenderOpenerProvider opener={opener}>
          <div onClick={bubbleClick}>
            <AgentSentTitle
              agentSent={info}
              receivingContext={{ kind: 'project', projectId: 'project' }}
            />
          </div>
        </AgentSentSenderOpenerProvider>,
      );
    });
    return {
      container,
      unmount: (): void => {
        act(() => root.unmount());
        container.remove();
      },
    };
  }
  const bubbleClick = jest.fn();

  beforeEach(() => bubbleClick.mockReset());

  it('opens the sender by its canonical address, not the bubble', () => {
    const open = jest.fn();
    const view = rendered(bot, { canOpen: () => true, open });
    const button = view.container.querySelector('button');
    expect(button?.getAttribute('data-testid')).toBe('agent-sent-title');
    expect(button?.textContent).toBe('Weekly summary·App Advisor');
    act(() => button?.click());
    expect(open).toHaveBeenCalledWith(bot.sender);
    expect(bubbleClick).not.toHaveBeenCalled();
    view.unmount();
  });

  it('stays plain text for a sender the host cannot open', () => {
    const canOpen = jest.fn(
      (sender: ChatAgentSentInfo['sender']) => sender.kind === 'bot',
    );
    const view = rendered(project, { canOpen, open: jest.fn() });
    expect(canOpen).toHaveBeenCalledWith(project.sender);
    expect(view.container.querySelector('button')).toBeNull();
    expect(
      view.container.querySelector('[data-testid="agent-sent-title"]')
        ?.textContent,
    ).toBe(project.chatTitle);
    view.unmount();
  });
});
