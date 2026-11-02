import {
  initialChatTurnState,
  serializeChatTurnState,
} from '@canopy/agent-transcript/turn';
import type { ChatTurnStateChange } from '../../services/chat-turn-state-handoff';
import { installTurnStateAudit } from '../turn-state-audit';
import { ObservabilityService } from '../service';

const SCOPE = { projectId: 'proj', worktreeId: 'wt', chatId: 'chat' };

function change(cause: ChatTurnStateChange['cause']): ChatTurnStateChange {
  return {
    scope: SCOPE,
    state: serializeChatTurnState(initialChatTurnState()),
    effects: [],
    generation: 1,
    cause,
  };
}

describe('turn state audit', () => {
  let service: ObservabilityService;

  beforeEach(() => {
    service = new ObservabilityService();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await service.dispose();
  });

  it('forwards only lifecycle receipt changes', () => {
    const observe = jest
      .spyOn(service, 'observeTurnState')
      .mockImplementation(() => undefined);
    let listener: ((next: ChatTurnStateChange) => void) | undefined;
    installTurnStateAudit(service, {
      onTurnStateChange: (next): (() => void) => {
        listener = next;
        return (): void => undefined;
      },
    });
    listener?.(change('hydrate'));
    listener?.(change('lifecycle'));
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledWith(SCOPE, change('lifecycle').state);
  });
});
