import type { ChatSendMessageRequest } from '@canopy/desktop-shared/types';
import { buildTrustedUserPromptEvent } from '../lib/chat-trusted-user-prompt';

describe('Cowork trusted user prompt persistence', () => {
  it('keeps project-agent provenance in the persisted prompt payload', () => {
    const sender = {
      kind: 'project' as const,
      projectType: 'cowork' as const,
      projectId: 'orchestrator-project',
      taskId: 'orchestrator-task',
      chatId: 'orchestrator-chat',
    };
    const request: ChatSendMessageRequest = {
      projectId: 'orchestrate-cowork',
      worktreeId: 'cowork-task',
      chatId: 'cowork-chat',
      userMessageId: 'accepted-agent-input',
      text: 'Please complete the delegated task.',
      providerType: 'claude',
      interfaceMode: 'canopy',
      agentSent: {
        chatTitle: 'Orchestrator',
        projectLabel: 'Orchestrator Project',
        sender,
      },
      agentSenderProvenance: {
        version: 1,
        sender,
        owner: { kind: 'personal' },
        capturedAt: '2026-10-18T00:00:00.000Z',
        acceptedInputId: 'accepted-agent-input',
      },
      hiddenContext: {
        kind: 'agent-sender-context',
        text: 'Main-owned sender context; not visible message text.',
      },
    };

    // The Cowork native dispatcher ingests this payload after chat.send_message
    // already persisted the marked user message, replacing that same message id.
    const event = buildTrustedUserPromptEvent(request);
    expect(event.canopy_persisted_messages).toEqual([
      expect.objectContaining({
        id: request.userMessageId,
        role: 'user',
        userMessageSource: 'agent',
        agentSent: request.agentSent,
        blocks: [{ type: 'text', text: request.text }],
      }),
    ]);
  });
});

const request = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
  userMessageId: 'user-resume',
  text: 'Continue',
  providerType: 'claude' as const,
};

describe('buildTrustedUserPromptEvent', () => {
  it('marks the prompt of a send that resumes an interrupted turn', () => {
    expect(
      buildTrustedUserPromptEvent({ ...request, resumesInterruptedTurn: true }),
    ).toMatchObject({
      canopy_turn_user_message_id: 'user-resume',
      canopy_resumes_interrupted_turn: true,
    });
  });

  it('leaves any other prompt unmarked', () => {
    expect(buildTrustedUserPromptEvent(request)).not.toHaveProperty(
      'canopy_resumes_interrupted_turn',
    );
  });

  it('records the trusted external-agent sender on the persisted message', () => {
    const agentSent = {
      kind: 'external_agent' as const,
      connectionId: '0b9d2c4e-1f3a-4b5c-8d6e-7f8091a2b3c4',
      clientName: 'Cursor',
      verified: true,
      userId: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
    };
    expect(
      buildTrustedUserPromptEvent({ ...request, agentSent })
        .canopy_persisted_messages[0]?.agentSent,
    ).toEqual(agentSent);
    expect(
      buildTrustedUserPromptEvent(request).canopy_persisted_messages[0],
    ).not.toHaveProperty('agentSent');
  });
});

it('copies validated automatic-resume provenance without defaulting a nudge to typed', () => {
  const trusted: Parameters<typeof buildTrustedUserPromptEvent>[0] = {
    ...request,
    autoResume: {
      reason: 'app_shutdown',
      resumesUserMessageId: 'original',
      resendsUserMessage: false,
    },
  };
  const message =
    buildTrustedUserPromptEvent(trusted).canopy_persisted_messages[0];
  expect(message).toMatchObject({
    userMessageSource: 'auto_resume',
    autoResume: trusted.autoResume,
  });
  expect(message).not.toHaveProperty('inputMode');
});
