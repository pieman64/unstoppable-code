/**
 * The pure tool-result readers shared by the authentication-failure pairing
 * and the chat turn's commit overlap: both must agree on which events carry
 * an errored tool result.
 */
import {
  hasErroredToolResult,
  readToolResultEntries,
} from '../lib/tool-result-entries';

describe('readToolResultEntries', () => {
  it('reads every Claude tool_result block with its error flag', () => {
    expect(
      readToolResultEntries({
        type: 'user',
        message: {
          content: [
            { type: 'text', text: 'ignored' },
            { type: 'tool_result', tool_use_id: 'a', is_error: false },
            { type: 'tool_result', tool_use_id: 'b', is_error: true },
            { type: 'tool_result', is_error: true },
          ],
        },
      }),
    ).toEqual([
      { toolUseId: 'a', isError: false },
      { toolUseId: 'b', isError: true },
    ]);
  });

  it('reads a completed Codex dynamic tool call, failed by status or success', () => {
    const item = (status: string, success: boolean | undefined): unknown => ({
      type: 'codex',
      event: {
        type: 'item.completed',
        item: {
          type: 'dynamic_tool_call',
          id: 'call',
          tool: 'tool',
          status,
          ...(success === undefined ? {} : { success }),
        },
      },
    });
    expect(readToolResultEntries(item('completed', true))).toEqual([
      { toolUseId: 'codex-call', isError: false },
    ]);
    expect(readToolResultEntries(item('failed', undefined))).toEqual([
      { toolUseId: 'codex-call', isError: true },
    ]);
    expect(readToolResultEntries(item('completed', false))).toEqual([
      { toolUseId: 'codex-call', isError: true },
    ]);
  });

  it('reads nothing from a started Codex call or an event without results', () => {
    expect(
      readToolResultEntries({
        type: 'codex',
        event: {
          type: 'item.started',
          item: { type: 'dynamic_tool_call', id: 'call', tool: 'tool' },
        },
      }),
    ).toEqual([]);
    expect(readToolResultEntries({ type: 'assistant', message: 'hi' })).toEqual(
      [],
    );
    expect(readToolResultEntries(null)).toEqual([]);
  });
});

describe('hasErroredToolResult', () => {
  it('is true only when a tool result is errored', () => {
    expect(
      hasErroredToolResult({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'a', is_error: true }],
        },
      }),
    ).toBe(true);
    expect(
      hasErroredToolResult({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'a', is_error: false }],
        },
      }),
    ).toBe(false);
    expect(hasErroredToolResult({ type: 'result', is_error: true })).toBe(
      false,
    );
  });
});
