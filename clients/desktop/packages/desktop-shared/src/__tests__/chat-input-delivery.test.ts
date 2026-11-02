import type { ChatInputDeliveryState } from '@canopy/protocol/portal';
import type { ChatSendMessageRequest } from '../types';
import {
  detachInputDelivery,
  inputDeliveryViews,
  isInputLedger,
  type InputLedger,
} from '../chat-input-delivery';

const target = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
};

type RequestMarkers = Partial<
  Pick<
    ChatSendMessageRequest,
    | 'internalRow'
    | 'managedDelegationDeliveryId'
    | 'initiationSource'
    | 'automationName'
  >
>;

function request(
  userMessageId: string,
  marker: RequestMarkers = {},
): ChatSendMessageRequest {
  return {
    ...target,
    userMessageId,
    text: 'private request text',
    ...marker,
  };
}

function ledger(
  state: ChatInputDeliveryState,
  payload: ChatSendMessageRequest,
  payloadSnapshot?: ChatSendMessageRequest,
): InputLedger {
  return {
    version: 1,
    epoch: 0,
    rows: [
      {
        id: 'row-1',
        revision: 1,
        createdAt: 1,
        state,
        text: 'private delivery text',
        settingsKey: 'settings',
        payload,
        attempts: [
          ...(payloadSnapshot
            ? [
                {
                  id: 'attempt-1',
                  generation: 'generation-1',
                  provider: 'claude' as const,
                  createdAt: 1,
                  payloadSnapshot,
                },
              ]
            : []),
        ],
      },
    ],
  };
}

const states: ChatInputDeliveryState[] = [
  'sending',
  'pending',
  'cancelling',
  'editing',
  'cancelled',
  'picked-up',
  'uncertain',
  'queued',
];

const internalMarkers: Array<{
  name: string;
  marker: Pick<
    ChatSendMessageRequest,
    'internalRow' | 'managedDelegationDeliveryId'
  >;
}> = [
  {
    name: 'internal row',
    marker: {
      managedDelegationDeliveryId: 'delivery-1',
      internalRow: {
        kind: 'delegation-request',
        delegationId: 'delegate-1',
        displayLine: 'Waiting for parent input',
      },
    },
  },
  {
    name: 'legacy managed delivery',
    marker: { managedDelegationDeliveryId: 'legacy-delivery-1' },
  },
];

describe('inputDeliveryViews', () => {
  it.each(
    states.flatMap((state) =>
      internalMarkers.map((identity) => ({ ...identity, state })),
    ),
  )('hides $name delivery rows in the $state state', ({ state, marker }) => {
    expect(
      inputDeliveryViews(ledger(state, request('internal-1', marker))),
    ).toEqual([]);
  });

  it('keeps a row hidden when an attempt snapshot carries internal identity', () => {
    const copiedPayload = request('copied-normal-row', {
      initiationSource: 'automation',
    });
    const priorInternalPayload = request('internal-attempt', {
      managedDelegationDeliveryId: 'internal-attempt',
      internalRow: {
        kind: 'delegation-request',
        delegationId: 'delegate-2',
        displayLine: 'Waiting for parent input',
      },
    });

    expect(
      inputDeliveryViews(
        ledger('uncertain', copiedPayload, priorInternalPayload),
      ),
    ).toEqual([]);
  });

  it('keeps named automation delivery rows visible when they are not internal', () => {
    const automationPayload = request('automation-message', {
      initiationSource: 'automation',
      automationName: 'Nightly report',
    });

    expect(inputDeliveryViews(ledger('uncertain', automationPayload))).toEqual([
      expect.objectContaining({ id: 'row-1', state: 'uncertain' }),
    ]);
  });
});

describe('stored pipeline sender provenance (CAN-4547)', () => {
  const sender = {
    kind: 'pipeline',
    executionId: 'exec-1',
    pipelineId: 'nightly',
    stepId: 'notify',
  } as const;
  function pipelineRow(provenance: unknown): unknown {
    const stored = ledger('queued', {
      ...request('row-1'),
      agentSent: { sender, chatTitle: 'Nightly', projectLabel: '' },
      hiddenContext: { kind: 'agent-sender-context', text: 'note' },
    });
    // The guard reads stored JSON; the field is checked as data here.
    return {
      ...stored,
      rows: stored.rows.map((row) => ({
        ...row,
        payload: { ...row.payload, agentSenderProvenance: provenance },
      })),
    };
  }
  const provenance = {
    version: 1,
    capturedAt: '2026-10-26T00:00:00.000Z',
    acceptedInputId: 'row-1',
    sender,
    owner: { kind: 'personal' },
  };

  it('keeps a queued pipeline row with its owner and optional agent origin', () => {
    expect(isInputLedger(pipelineRow(provenance))).toBe(true);
    expect(
      isInputLedger(
        pipelineRow({
          ...provenance,
          owner: { kind: 'organization', organizationId: 'org-1' },
          agentOrigin: {
            projectId: 'agent-project',
            worktreeId: 'agent-task',
            chatId: 'agent-chat',
          },
        }),
      ),
    ).toBe(true);
  });

  it('refuses a pipeline row without an owner or with a partial agent origin', () => {
    expect(
      isInputLedger(pipelineRow({ ...provenance, owner: { kind: 'none' } })),
    ).toBe(false);
    expect(
      isInputLedger(
        pipelineRow({
          ...provenance,
          agentOrigin: { projectId: 'agent-project', chatId: 'agent-chat' },
        }),
      ),
    ).toBe(false);
  });
});

describe('detached pipeline rows (CAN-4547)', () => {
  it('drops the main-only turn override with the other runtime grants', () => {
    const detached = detachInputDelivery(
      {
        id: 'chat-1',
        title: 'Source',
        createdAt: '2026-10-26T00:00:00.000Z',
        messages: [],
        inputDelivery: ledger('queued', {
          ...request('row-1'),
          turnOverride: {
            version: 1,
            approvalMode: 'full-access',
            pluginSelections: {
              collectionIds: [],
              skillRefs: [],
              pluginRefs: [],
            },
          },
        }),
      },
      { projectId: 'project-2', worktreeId: 'worktree-2', chatId: 'chat-2' },
      () => 'row-copied',
    );
    const [row] = detached?.rows ?? [];
    expect(row?.payload).toMatchObject({ chatId: 'chat-2' });
    expect(row?.payload).not.toHaveProperty('turnOverride');
  });
});
