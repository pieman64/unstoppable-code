/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { AnySubagentChatTranscriptItem } from '@canopy/ui-shared';
import { SubagentTranscriptRows } from '../SubagentTranscriptRows';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const items: readonly AnySubagentChatTranscriptItem[] = [
  { kind: 'task', key: 'task', sender: 'Root chat', text: 'Review the notes' },
  { kind: 'user', key: 'user', text: 'Also check tests', steering: true },
  { kind: 'part', key: 'part', part: { kind: 'text', data: { text: 'Done' } } },
  { kind: 'divider', key: 'divider', runGeneration: 2 },
  { kind: 'follow_up', key: 'follow-up', sender: 'Root chat', text: 'More' },
  { kind: 'truncated', key: 'truncated', omittedSubBlocks: 3 },
];

describe('SubagentTranscriptRows', () => {
  it('renders authored rows with the shared bubbles and hands the rest to the host in order', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const contentKinds: string[] = [];
    act(() => {
      root.render(
        <SubagentTranscriptRows
          items={items}
          renderContent={(item) => {
            contentKinds.push(item.kind);
            return <span data-testid={`content-${item.key}`}>{item.kind}</span>;
          }}
        />,
      );
    });

    expect(contentKinds).toEqual(['part', 'truncated']);
    const text = container.textContent ?? '';
    const order = [
      'Review the notes',
      'Also check tests',
      'part',
      'More',
      'truncated',
    ];
    const positions = order.map((fragment) => text.indexOf(fragment));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(
      container.querySelector('[data-testid="content-part"]'),
    ).not.toBeNull();
    act(() => root.unmount());
  });

  it('titles an agent-sent user row with its sender, using the receiving context', () => {
    const agentSentItems: readonly AnySubagentChatTranscriptItem[] = [
      {
        kind: 'user',
        key: 'agent-user',
        text: 'Continue the review.',
        steering: true,
        agentSent: {
          sender: {
            kind: 'project',
            projectType: 'code',
            projectId: 'sender-project',
            taskId: 'sender-task',
            chatId: 'sender-chat',
          },
          chatTitle: 'Captured sender chat',
          projectLabel: 'Source project',
        },
      },
    ];
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <SubagentTranscriptRows
          items={agentSentItems}
          renderContent={() => null}
        />,
      );
    });
    expect(
      container.querySelector('[data-testid="agent-sent-title"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="steering-title"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain('Captured sender chat');
    expect(container.textContent).toContain('Source project');

    act(() => {
      root.render(
        <SubagentTranscriptRows
          items={agentSentItems}
          renderContent={() => null}
          receivingContext={{ kind: 'project', projectId: 'sender-project' }}
        />,
      );
    });
    expect(container.textContent).toContain('Captured sender chat');
    expect(container.textContent).not.toContain('Source project');
    act(() => root.unmount());
  });
});
