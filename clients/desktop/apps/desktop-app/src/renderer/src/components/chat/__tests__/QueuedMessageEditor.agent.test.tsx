import { renderToStaticMarkup } from 'react-dom/server';
import { AgentSentReceivingContextProvider } from '@canopy/ui-shared';
import { QueuedMessageEditor } from '../QueuedMessageEditor';

jest.mock('../ChatInput', () => ({ ChatInput: (): null => null }));

it('keeps captured agent identity when editing a queued prompt', () => {
  const html = renderToStaticMarkup(
    <AgentSentReceivingContextProvider
      receivingContext={{ kind: 'bot', botId: 'app_advisor' }}
    >
      <QueuedMessageEditor
        message={{
          text: 'Visible body',
          agentSent: {
            sender: {
              kind: 'bot',
              botId: 'app_advisor',
              taskId: 'task',
              chatId: 'chat',
            },
            chatTitle: 'Captured sender',
            projectLabel: 'App Advisor',
          },
        }}
        index={0}
        composerTab={null}
        onCancel={() => {}}
        onSave={() => {}}
      />
    </AgentSentReceivingContextProvider>,
  );
  expect(html).toContain('data-testid="agent-sent-title"');
  expect(html).toContain('Captured sender');
  expect(html).not.toContain('App Advisor');
});
