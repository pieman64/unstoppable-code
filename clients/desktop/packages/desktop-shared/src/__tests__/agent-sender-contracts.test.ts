import type { ChatInputDeliveryState } from '@canopy/protocol/portal';
import {
  detachInputDelivery,
  inputDeliveryViews,
  isInputLedger,
  type InputLedger,
} from '../chat-input-delivery';
import type {
  AgentSenderProvenance,
  ChatAgentSentInfo,
  ClaudeTerminalScheduledPromptEvent,
  HostQueuedMessageView,
  PersistedChatTab,
  PersistedHostQueuedMessage,
} from '../types';

const sender = {
  kind: 'bot' as const,
  botId: 'app_advisor',
  taskId: 'entry-1',
  chatId: 'sender-1',
};
const agentSent: ChatAgentSentInfo = {
  sender,
  chatTitle: 'Captured sender title',
  projectLabel: 'App Advisor',
};
const provenance: AgentSenderProvenance = {
  version: 1,
  sender,
  owner: { kind: 'none' },
  capturedAt: '2026-10-15T00:00:00.000Z',
  acceptedInputId: 'accepted-1',
};
const hiddenContext = {
  kind: 'agent-sender-context' as const,
  text: '<system_instruction>private sender context</system_instruction>',
};

function ledger(state: ChatInputDeliveryState = 'pending'): InputLedger {
  return {
    version: 1,
    epoch: 3,
    rows: [
      {
        id: 'input-1',
        revision: 2,
        createdAt: 1,
        state,
        text: 'Visible body',
        settingsKey: 'settings',
        payload: {
          projectId: 'receiver-project',
          worktreeId: 'receiver-task',
          chatId: 'receiver-chat',
          userMessageId: 'user-1',
          text: 'Visible body',
          agentSent,
          agentSenderProvenance: provenance,
          hiddenContext,
        },
        attempts: [
          {
            id: 'attempt-1',
            generation: 'generation-1',
            provider: 'claude',
            createdAt: 1,
            submittedText: `${hiddenContext.text}\nVisible body`,
          },
        ],
        currentAttemptId: 'attempt-1',
      },
    ],
  };
}

function tab(inputDelivery: InputLedger): PersistedChatTab {
  return {
    id: 'receiver-chat',
    title: 'Receiver',
    createdAt: '2026-10-15T00:00:00.000Z',
    messages: [
      {
        id: 'historical-agent',
        role: 'user',
        timestamp: 1,
        blocks: [{ type: 'text', text: 'Old visible body' }],
        agentSent,
        userMessageSource: 'agent',
      },
    ],
    inputDelivery,
  };
}

describe('trusted sender input contracts', () => {
  it.each<ChatInputDeliveryState>([
    'sending',
    'pending',
    'cancelling',
    'editing',
    'cancelled',
    'picked-up',
    'uncertain',
    'queued',
  ])(
    'projects public attribution, never private context, in %s views',
    (state) => {
      const [view] = inputDeliveryViews(ledger(state));
      expect(view.agentSent).toEqual(agentSent);
      expect(view.text).toBe('Visible body');
      const json = JSON.stringify(view);
      expect(json).not.toContain('system_instruction');
      expect(json).not.toContain('agentSenderProvenance');
      expect(json).not.toContain('accepted-1');
      expect(json).not.toContain('owner');
    },
  );

  it('round-trips main-owned request provenance through durable queue and attempt snapshots', () => {
    const value = ledger();
    value.rows[0].attempts[0].payloadSnapshot = structuredClone(
      value.rows[0].payload,
    );
    const queued: PersistedHostQueuedMessage = {
      id: 'queue-1',
      request: value.rows[0].payload,
      origin: 'desktop',
      enqueuedAtMs: 1,
    };
    const restored: unknown = JSON.parse(JSON.stringify(value));
    expect(isInputLedger(restored)).toBe(true);
    expect(restored).toEqual(value);
    expect(JSON.parse(JSON.stringify(queued))).toEqual(queued);
  });

  it('keeps old inputs without sender attribution valid and unmarked', () => {
    const value = ledger();
    delete value.rows[0].payload.agentSent;
    delete value.rows[0].payload.agentSenderProvenance;
    delete value.rows[0].payload.hiddenContext;
    expect(isInputLedger(value)).toBe(true);
    expect(inputDeliveryViews(value)[0].agentSent).toBeUndefined();
    expect(inputDeliveryViews(value)[0]).not.toHaveProperty('agentSent');
  });

  it.each(['personal', 'organization'] as const)(
    'retains a captured project sender with a %s saved owner',
    (kind) => {
      const value = ledger();
      const projectSender = {
        kind: 'project' as const,
        projectType: 'cowork' as const,
        projectId: 'sender-project',
        taskId: 'sender-task',
        chatId: 'sender-chat',
      };
      const projectProvenance: AgentSenderProvenance = {
        version: 1,
        sender: projectSender,
        capturedAt: provenance.capturedAt,
        acceptedInputId: 'project-input',
        owner:
          kind === 'personal' ? { kind } : { kind, organizationId: 'org-1' },
      };
      value.rows[0].payload.agentSenderProvenance = projectProvenance;
      value.rows[0].payload.agentSent = {
        sender: projectSender,
        chatTitle: 'Saved title',
        projectLabel: 'Saved project',
      };
      expect(isInputLedger(value)).toBe(true);
      expect(inputDeliveryViews(value)[0].agentSent?.sender).toEqual(
        projectSender,
      );
      const malformed = {
        ...value,
        rows: [
          {
            ...value.rows[0],
            payload: {
              ...value.rows[0].payload,
              agentSenderProvenance: {
                ...projectProvenance,
                owner: { kind: 'organization' },
              },
            },
          },
        ],
      };
      expect(isInputLedger(malformed)).toBe(false);
    },
  );

  it('validates provenance in attempt snapshots as well as current payloads', () => {
    const value = ledger();
    const invalid = {
      ...value,
      rows: [
        {
          ...value.rows[0],
          attempts: [
            {
              ...value.rows[0].attempts[0],
              payloadSnapshot: {
                ...value.rows[0].payload,
                agentSenderProvenance: { ...provenance, version: 99 },
              },
            },
          ],
        },
      ],
    };
    expect(isInputLedger(invalid)).toBe(false);
  });

  it('rejects malformed sender hidden text instead of delivering it', () => {
    const value = ledger();
    const invalid = {
      ...value,
      rows: [
        {
          ...value.rows[0],
          payload: {
            ...value.rows[0].payload,
            hiddenContext: { kind: 'agent-sender-context', text: 123 },
          },
        },
      ],
    };
    expect(isInputLedger(invalid)).toBe(false);
  });

  it('ignores malformed display metadata without losing the accepted input', () => {
    const value = ledger();
    const malformed = {
      ...value,
      rows: [
        {
          ...value.rows[0],
          payload: {
            ...value.rows[0].payload,
            agentSent: {
              ...agentSent,
              sender: { kind: 'bot', taskId: 'missing-bot', chatId: 'sender' },
            },
          },
        },
      ],
    };
    expect(isInputLedger(malformed)).toBe(true);
    expect(inputDeliveryViews(malformed)[0].agentSent).toBeUndefined();
    expect(inputDeliveryViews(malformed)[0]).not.toHaveProperty('agentSent');
    expect(inputDeliveryViews(malformed)[0].text).toBe('Visible body');
  });

  it('sanitizes nested display metadata rather than leaking hidden sender fields', () => {
    const value = ledger();
    const extra = {
      ...value,
      rows: [
        {
          ...value.rows[0],
          payload: {
            ...value.rows[0].payload,
            agentSent: {
              ...agentSent,
              sender: { ...sender, hiddenInstruction: 'private nested field' },
              hiddenContext: hiddenContext.text,
              owner: provenance.owner,
            },
          },
        },
      ],
    };
    const [view] = inputDeliveryViews(extra);
    expect(view.agentSent).toEqual(agentSent);
    expect(JSON.stringify(view)).not.toContain('private');
    expect(JSON.stringify(view)).not.toContain('system_instruction');
    expect(JSON.stringify(view)).not.toContain('owner');
  });

  it.each([
    { ...provenance, version: 2 },
    { ...provenance, capturedAt: 'invalid' },
    { ...provenance, acceptedInputId: '' },
    { ...provenance, owner: { kind: 'unknown' } },
    { ...provenance, owner: { kind: 'organization', organizationId: 'org-1' } },
    {
      ...provenance,
      sender: {
        kind: 'project',
        projectType: 'code',
        projectId: 'project-1',
        taskId: 'task-1',
        chatId: 'chat-1',
      },
    },
  ])(
    'keeps malformed or mismatched internal provenance inert: %j',
    (invalid) => {
      const value = ledger();
      const malformed = {
        ...value,
        rows: [
          {
            ...value.rows[0],
            payload: {
              ...value.rows[0].payload,
              agentSenderProvenance: invalid,
            },
          },
        ],
      };
      expect(isInputLedger(malformed)).toBe(false);
      expect(inputDeliveryViews(malformed)).toEqual([]);
    },
  );

  it('carries terminal sender context separately from visible text and automation identity', () => {
    const event: ClaudeTerminalScheduledPromptEvent = {
      projectId: 'receiver-project',
      worktreeId: 'receiver-task',
      chatId: 'receiver-chat',
      userMessageId: 'user-1',
      text: 'Visible body',
      acceptedInputId: provenance.acceptedInputId,
      hiddenContext,
      agentSent,
    };
    expect(event.text).toBe('Visible body');
    expect(event.hiddenContext?.text).toBe(hiddenContext.text);
    expect(event.acceptedInputId).toBe('accepted-1');
    expect(event.automationName).toBeUndefined();
    const view: HostQueuedMessageView = {
      id: 'queue-1',
      text: event.text,
      origin: 'desktop',
      enqueuedAtMs: 1,
      agentSent,
    };
    expect(JSON.stringify(view)).not.toContain('private sender context');
  });

  it.each<ChatInputDeliveryState>([
    'sending',
    'pending',
    'cancelling',
    'editing',
    'cancelled',
    'uncertain',
    'queued',
  ])(
    'strips attribution only from detached %s inputs that need a new user resubmission',
    (state) => {
      const source = tab(ledger(state));
      const original = structuredClone(source);
      const detached = detachInputDelivery(
        source,
        {
          projectId: 'fork-project',
          worktreeId: 'fork-task',
          chatId: 'fork-chat',
        },
        () => 'fork-input',
      );
      const row = detached?.rows[0];
      expect(row?.payload.agentSent).toBeUndefined();
      expect(row?.payload.agentSenderProvenance).toBeUndefined();
      expect(row?.payload.hiddenContext).toBeUndefined();
      expect(row?.payload.userMessageId).toBe('fork-input');
      expect(row?.attempts[0].id).toBe('attempt-1');
      expect(row?.attempts[0].submittedText).toBeUndefined();
      if (['sending', 'pending', 'cancelling', 'uncertain'].includes(state)) {
        expect(row?.state).toBe('uncertain');
        expect(row?.reason).toContain('not confirmed');
      }
      expect(source).toEqual(original);
      expect(source.messages[0].agentSent).toEqual(agentSent);
    },
  );

  it('retains attribution on picked-up historical rows and never mutates the transcript', () => {
    const source = tab(ledger('picked-up'));
    const detached = detachInputDelivery(
      source,
      {
        projectId: 'fork-project',
        worktreeId: 'fork-task',
        chatId: 'fork-chat',
      },
      () => 'fork-input',
    );
    expect(detached?.rows[0].state).toBe('picked-up');
    expect(detached?.rows[0].payload.agentSent).toEqual(agentSent);
    expect(detached?.rows[0].payload.agentSenderProvenance).toEqual(provenance);
    expect(source.messages[0].agentSent).toEqual(agentSent);
    expect(source.messages[0].userMessageSource).toBe('agent');
  });
});
