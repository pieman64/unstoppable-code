import { localAgentEntryId, type UnifiedEntryRef } from '../index';

describe('local agent entry identity', () => {
  it.each(['agent_model_reviewer', 'shared:123', 'iOS Reviewer'])(
    'keeps %s separate from a shared agent with the same id',
    (agentId) => {
      const ref: UnifiedEntryRef = { type: 'local-agent', agentId };
      expect(localAgentEntryId(ref.agentId)).toBe(`agent:local:${agentId}`);
      expect(localAgentEntryId(ref.agentId)).not.toBe(
        `agent:shared:${agentId}`,
      );
    },
  );

  it('keeps multiple local copies of a shared agent distinct', () => {
    expect(localAgentEntryId('agent_model_copy_1')).not.toBe(
      localAgentEntryId('agent_model_copy_2'),
    );
  });
});
