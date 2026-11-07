import { CANOPY_INSTRUCTION_DEFINITIONS } from '..';
import { CORE_INSTRUCTION_DEFINITIONS } from '../core';
import {
  CORE_CHAT_TRANSFER_INSTRUCTION_DEFINITIONS,
  CORE_CHAT_TRANSFER_QUERY_DEFINITIONS,
} from '../core/chat/transfer';

const INSTRUCTION_NAMES = [
  'core.chat.transfer.delete',
  'core.chat.transfer.export',
  'core.chat.transfer.import',
  'core.chat.transfer.import.discard',
  'core.chat.transfer.import.inspect',
];

describe('chat transfer contract (CAN-4113)', () => {
  it('defines six desktop transfer operations with their grants', () => {
    expect(
      Object.keys(CORE_CHAT_TRANSFER_INSTRUCTION_DEFINITIONS).sort(),
    ).toEqual(INSTRUCTION_NAMES);
    expect(Object.keys(CORE_CHAT_TRANSFER_QUERY_DEFINITIONS)).toEqual([
      'core.chat.transfer.list',
    ]);
    for (const [name, definition] of Object.entries(
      CORE_CHAT_TRANSFER_INSTRUCTION_DEFINITIONS,
    )) {
      expect(definition.requiredGrants).toEqual(['core.chat.write']);
      expect(definition.idempotency).toBe(
        name === 'core.chat.transfer.import.inspect' ? 'inherent' : 'keyed',
      );
    }
    const list =
      CORE_CHAT_TRANSFER_QUERY_DEFINITIONS['core.chat.transfer.list'];
    expect(list.requiredGrants).toEqual(['core.chat.read']);
    expect(list.idempotency).toBe('inherent');
  });

  it('never accepts a local bundle path', () => {
    const key = { _meta: { idempotencyKey: 'k1' } };
    const validParams: Record<string, Record<string, unknown>> = {
      'core.chat.transfer.list': { query: 'abc' },
      'core.chat.transfer.export': {
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'c1',
        ...key,
      },
      'core.chat.transfer.delete': { transferId: 'exp-1', ...key },
      'core.chat.transfer.import.inspect': {
        transferId: 'exp-1',
        workspaceId: 'ws-1',
      },
      'core.chat.transfer.import': {
        transferId: 'exp-1',
        workspaceId: 'ws-1',
        ...key,
      },
      'core.chat.transfer.import.discard': { transferId: 'exp-1', ...key },
    };
    const definitions = Object.entries({
      ...CORE_CHAT_TRANSFER_QUERY_DEFINITIONS,
      ...CORE_CHAT_TRANSFER_INSTRUCTION_DEFINITIONS,
    });
    expect(definitions.map(([name]) => name).sort()).toEqual(
      Object.keys(validParams).sort(),
    );
    for (const [name, { params }] of definitions) {
      const valid = validParams[name];
      expect(params.safeParse(valid).success).toBe(true);
      expect(
        params.safeParse({ ...valid, sourcePath: '/tmp/bundle' }).success,
      ).toBe(false);
      expect(
        Object.keys(params.shape).filter((field) => /(Path|Dir)$/.test(field)),
      ).toEqual([]);
    }
  });

  it('keeps the instructions out of the composed core registry', () => {
    for (const name of INSTRUCTION_NAMES) {
      expect(Object.keys(CORE_INSTRUCTION_DEFINITIONS)).not.toContain(name);
      expect(Object.keys(CANOPY_INSTRUCTION_DEFINITIONS)).not.toContain(name);
    }
  });
});
