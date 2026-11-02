import { assertUntrustedChatInput } from '../untrusted-input';

describe('assertUntrustedChatInput delegation notice provenance', () => {
  it.each([
    {
      location: 'a direct request',
      value: { delegationNoticeBatchId: 'notice-1' },
    },
    {
      location: 'a nested seeded message',
      value: {
        command: {
          type: 'chat.create_tab',
          tabId: 'chat-1',
          seedTab: {
            id: 'chat-1',
            messages: [
              { id: 'message-1', delegationNoticeBatchId: 'notice-1' },
            ],
          },
        },
      },
    },
    {
      location: 'a persisted queued request payload',
      value: {
        id: 'chat-1',
        messages: [],
        inputDelivery: {
          version: 1,
          epoch: 0,
          rows: [
            {
              id: 'notice-1',
              payload: { delegationNoticeBatchId: 'notice-1' },
              attempts: [],
            },
          ],
        },
      },
    },
  ])('rejects a forged batch id in $location', ({ value }) => {
    expect(() => assertUntrustedChatInput(value)).toThrow(
      'delegationNoticeBatchId',
    );
  });

  it('preserves the same property name inside arbitrary user JSON', () => {
    expect(() =>
      assertUntrustedChatInput({
        id: 'chat-1',
        messages: [
          {
            id: 'message-1',
            blocks: [
              {
                type: 'tool_result',
                content: { delegationNoticeBatchId: 'user-owned-content' },
              },
            ],
          },
        ],
        arbitraryBody: { delegationNoticeBatchId: 'user-owned-content' },
      }),
    ).not.toThrow();
  });
});

it('rejects snapshots at request, transcript and ledger boundaries', () => {
  for (const input of [
    { watcherPartSnapshots: [] },
    { payload: { watcherPartSnapshots: [] } },
    { id: 'chat', messages: [{ watcherPartSnapshots: [] }] },
    {
      inputDelivery: {
        rows: [
          {
            payload: {},
            attempts: [{ payloadSnapshot: { watcherPartSnapshots: [] } }],
          },
        ],
      },
    },
  ]) {
    expect(() => assertUntrustedChatInput(input)).toThrow(
      'watcherPartSnapshots',
    );
  }
});
