import type { PortalChatMessage } from '@canopy/protocol/portal';
import { collectPortalTurnFiles as collectPortalTurnFileSnapshot } from '../portal-turn-files';

function collectPortalTurnFiles(
  ...args: Parameters<typeof collectPortalTurnFileSnapshot>
): ReturnType<typeof collectPortalTurnFileSnapshot> {
  return collectPortalTurnFileSnapshot(...args)
    .filter((file) => !file.removed)
    .map(({ evidence, ...file }) => {
      void evidence;
      return file;
    });
}

const call: PortalChatMessage = {
  chatId: 'chat-1',
  messageId: 'call',
  role: 'assistant',
  status: 'complete',
  text: '',
  createdAtMs: 1,
  parts: [
    {
      kind: 'tool_use',
      data: {
        toolUseId: 'edit',
        toolName: 'Edit',
        input: { file_path: 'report.md' },
      },
    },
  ],
};
const result: PortalChatMessage = {
  chatId: 'chat-1',
  messageId: 'result',
  role: 'system',
  status: 'complete',
  text: '',
  createdAtMs: 2,
  parts: [
    {
      kind: 'tool_result',
      data: { toolUseId: 'edit', output: 'Done', isError: false },
    },
  ],
};

it('derives updates from separate cloud/Portal results without final-response links', () => {
  expect(collectPortalTurnFiles([call, result])).toEqual([
    { path: 'report.md', state: 'ready', change: 'updated' },
  ]);
  expect(collectPortalTurnFiles([call])).toEqual([
    { path: 'report.md', state: 'creating', change: 'updated' },
  ]);
  expect(
    collectPortalTurnFiles([
      call,
      {
        ...result,
        parts: [
          {
            kind: 'tool_result',
            data: { toolUseId: 'edit', output: 'Denied', isError: true },
          },
        ],
      },
    ]),
  ).toEqual([{ path: 'report.md', state: 'failed', change: 'updated' }]);
});

it('accepts folded string inputs, patch aliases and retained historical evidence', () => {
  const patch: PortalChatMessage = {
    ...call,
    parts: [
      {
        kind: 'tool_use',
        data: {
          toolName: 'functions.apply_patch',
          input: '*** Update File: a file.md\n@@\n-old\n+new',
          result: { output: 'Done', isError: false },
        },
      },
    ],
  };
  expect(
    collectPortalTurnFiles(
      [patch],
      [{ path: 'report.md', state: 'ready', change: 'updated' }],
    ),
  ).toEqual([
    { path: 'report.md', state: 'ready', change: 'updated' },
    { path: 'a file.md', state: 'ready', change: 'updated' },
  ]);
  expect(collectPortalTurnFiles([{ ...call, role: 'user' }, result])).toEqual(
    [],
  );
});

it('accepts the cloud edit/write vocabulary and filePath field', () => {
  const cloud: PortalChatMessage = {
    ...call,
    parts: [
      {
        kind: 'tool_use',
        data: {
          toolName: 'edit',
          input: '{"filePath":"report.md","oldText":"old","newText":"new"}',
          result: { output: 'Done', isError: false },
        },
      },
    ],
  };
  expect(collectPortalTurnFiles([cloud])).toEqual([
    { path: 'report.md', state: 'ready', change: 'updated' },
  ]);
});
