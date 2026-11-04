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
import { WorkflowIcon } from '../../../icons/AppIcons';

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
const pipeline: ChatAgentSentInfo = {
  sender: {
    kind: 'pipeline',
    executionId: 'exec-1',
    pipelineId: 'pipeline-1',
    stepId: 'notify',
    automationId: 'automation-1',
  },
  chatTitle: 'Nightly triage',
  projectLabel: '',
};
function title(
  info: ChatAgentSentInfo,
  context: AgentSentReceivingContext,
  options: { steering?: boolean; layout?: 'block' | 'inline' } = {},
): HTMLElement {
  const container = document.createElement('div');
  container.innerHTML = renderToString(
    <AgentSentTitle agentSent={info} receivingContext={context} {...options} />,
  );
  return container;
}
/** The chat sender's icon box in the same layout; a pipeline title matches it. */
function chatIconStyle(layout: 'block' | 'inline'): string | null | undefined {
  return title(project, { kind: 'project', projectId: 'project' }, { layout })
    .querySelector('svg')
    ?.getAttribute('style');
}
function workflowIconMarkup(size: number): string {
  const container = document.createElement('div');
  container.innerHTML = renderToString(
    <WorkflowIcon width={size} height={size} />,
  );
  return container.querySelector('svg')?.innerHTML ?? '';
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
  it('names a cloud chat sender, with its project only from another project', () => {
    const cloudChat: ChatAgentSentInfo = {
      sender: {
        kind: 'cloud_chat',
        projectId: 'workspace',
        taskId: 'task',
        chatId: 'chat',
      },
      chatTitle: 'Billing fix',
      projectLabel: 'Payments',
    };
    expect(
      title(cloudChat, { kind: 'project', projectId: 'workspace' }).textContent,
    ).toBe('Billing fix');
    expect(
      title(cloudChat, { kind: 'project', projectId: 'other' }).textContent,
    ).toBe('Billing fix·Payments');
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

describe('AgentSentTitle for a pipeline sender', () => {
  it('shows the workflow icon and only the captured name, with the kind and no name in attributes', () => {
    for (const context of [
      { kind: 'project', projectId: 'project' },
      { kind: 'bot', botId: 'app_advisor' },
    ] satisfies AgentSentReceivingContext[]) {
      const el = title({ ...pipeline, projectLabel: 'Never shown' }, context);
      const row = el.querySelector('[data-testid="agent-sent-title"]');
      expect(row?.getAttribute('data-sender')).toBe('pipeline');
      expect(row?.tagName).toBe('SPAN');
      expect(el.textContent).toBe('Nightly triage');
      const icons = el.querySelectorAll('svg');
      expect(icons).toHaveLength(1);
      expect(icons[0]?.getAttribute('aria-hidden')).toBe('true');
      expect(icons[0]?.getAttribute('style')).toBe(chatIconStyle('block'));
      expect(icons[0]?.innerHTML).toBe(workflowIconMarkup(11));
      const masked = el.querySelectorAll(`.${REPLAY_MASK_CLASS}`);
      expect(Array.from(masked, (node) => node.textContent)).toEqual([
        'Nightly triage',
      ]);
      const attributes = Array.from(el.querySelectorAll('*')).flatMap((node) =>
        Array.from(node.attributes, (attribute) => attribute.value),
      );
      expect(attributes.join('\n')).not.toContain('Nightly triage');
      expect(attributes.join('\n')).not.toContain('automation-1');
    }
  });

  it('keeps the steering title beside it', () => {
    const el = title(
      pipeline,
      { kind: 'project', projectId: 'project' },
      { steering: true },
    );
    expect(
      el.querySelector('[data-testid="agent-sent-title"]')?.textContent,
    ).toBe('Nightly triage');
    expect(el.querySelector('[data-testid="steering-title"]')).not.toBeNull();
  });

  it('uses the inline sizes and ink in the inline layout', () => {
    const el = title(
      pipeline,
      { kind: 'project', projectId: 'project' },
      { layout: 'inline' },
    );
    const row = el.querySelector('[data-testid="agent-sent-title"]');
    expect(row?.classList.contains('fg-tertiary')).toBe(true);
    expect(el.querySelector('svg')?.getAttribute('style')).toBe(
      chatIconStyle('inline'),
    );
    expect(el.querySelector('svg')?.innerHTML).toBe(workflowIconMarkup(14));
  });

  // CAN-4549: an automation's own send names no run or step.
  it('shows an automation-only sender like a pipeline step, in both layouts', () => {
    const automation: ChatAgentSentInfo = {
      sender: { kind: 'pipeline', automationId: 'automation-1' },
      chatTitle: 'Morning report',
      projectLabel: '',
    };
    for (const layout of ['block', 'inline'] as const) {
      const el = title(
        automation,
        { kind: 'project', projectId: 'project' },
        { layout },
      );
      const row = el.querySelector('[data-testid="agent-sent-title"]');
      expect(row?.getAttribute('data-sender')).toBe('pipeline');
      expect(row?.tagName).toBe('SPAN');
      expect(el.textContent).toBe('Morning report');
      expect(el.querySelector('svg')?.innerHTML).toBe(
        workflowIconMarkup(layout === 'inline' ? 14 : 11),
      );
      const attributes = Array.from(el.querySelectorAll('*')).flatMap((node) =>
        Array.from(node.attributes, (attribute) => attribute.value),
      );
      expect(attributes.join('\n')).not.toContain('automation-1');
    }
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

  it('never asks the opener about a pipeline sender and stays plain text', () => {
    const canOpen = jest.fn(() => true);
    const open = jest.fn();
    const view = rendered(pipeline, { canOpen, open });
    expect(canOpen).not.toHaveBeenCalled();
    expect(view.container.querySelector('button')).toBeNull();
    const row = view.container.querySelector(
      '[data-testid="agent-sent-title"]',
    );
    expect(row?.textContent).toBe('Nightly triage');
    act(() => (row instanceof HTMLElement ? row.click() : undefined));
    expect(open).not.toHaveBeenCalled();
    view.unmount();
  });
});
