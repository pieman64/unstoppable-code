const mockQuery = jest.fn();
jest.mock('../../../canopy-runtime/desktop-runtime-access', () => ({
  getDesktopCanopyRuntime: (): object => ({ query: mockQuery }),
}));

import { createDelegateCanopyTools } from '../canopy-tools';

const actions = [
  {
    type: 'chat.transcript.page',
    target: {
      kind: 'delegation',
      chatId: 'owner',
      delegationId: 'child',
      runGeneration: 1,
    },
  },
  {
    type: 'chat.content.read',
    target: { kind: 'primary', chatId: 'owner' },
    messageId: 'row',
    blockOrdinal: 0,
    field: 'text',
    offset: 0,
  },
  {
    type: 'chat.transcript.blocks.page',
    target: { kind: 'primary', chatId: 'owner' },
    messageId: 'row',
  },
];

describe('managed delegate transcript-read isolation', () => {
  it.each([false, true])(
    'does not advertise or dispatch transcript reads (isolated=%s)',
    async (isolated) => {
      mockQuery.mockClear();
      const tools = createDelegateCanopyTools(
        {
          projectId: 'w1',
          worktreeId: 't1',
          chatId: 'owner',
          delegationId: 'child',
          provider: 'codex',
          isolated,
          parentCwd: '/work',
          executionCwd: '/work',
          codeGraphAvailable: false,
          getWindow: () => null,
          authorizeCommand: () => Promise.resolve(true),
        },
        () => Promise.resolve(true),
      );
      const search = tools.tools.find((tool) => tool.key === 'search_actions');
      const dispatch = tools.tools.find(
        (tool) => tool.key === 'dispatch_action',
      );
      if (isolated) {
        expect(search).toBeUndefined();
        expect(dispatch).toBeUndefined();
        return;
      }
      expect(search).toBeDefined();
      expect(dispatch).toBeDefined();
      if (!search || !dispatch) return;
      const result = await tools.execute(
        search,
        { query: 'transcript' },
        { callId: 'search' },
      );
      for (const action of actions) {
        expect(result.text).not.toContain(action.type);
        const rejected = await tools.execute(
          dispatch,
          { action },
          { callId: action.type },
        );
        expect(JSON.parse(rejected.text)).toMatchObject({
          ok: false,
          error: { code: 'unsupported_action' },
        });
      }
      expect(mockQuery).not.toHaveBeenCalled();
    },
  );
});
