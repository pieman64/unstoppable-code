import {
  agentWatcherFiredPromptText,
  buildAgentWatcherFiredMessage,
} from '@canopy/agent-actions/watchers/fired-message';
import { composeSubmittedText } from '../../memory/memory-context';

describe('shared watcher fired message', () => {
  it('reaches a cloud agent as the prompt a desktop agent receives', () => {
    const message = buildAgentWatcherFiredMessage({
      brand: { displayName: 'Canopy', toolNamespace: 'canopy' },
      label: 'Chat completed: Review',
      payload: { watcherId: 'watcher-1', followUpInstruction: 'Review it' },
      carriesFinalMessage: true,
    });
    expect(agentWatcherFiredPromptText(message)).toBe(
      composeSubmittedText(message.text, message.hiddenContextText),
    );
  });
});
