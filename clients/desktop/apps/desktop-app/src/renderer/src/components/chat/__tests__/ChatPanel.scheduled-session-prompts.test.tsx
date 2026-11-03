/**
 * @jest-environment jsdom
 */
// Static source-level coverage follows the renderer component test pattern for
// large chat surfaces whose full store graph is expensive to mount.
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import { join } from 'node:path';

const CHAT_INPUT_SOURCE = readFileSync(
  join(__dirname, '..', 'ChatInput.tsx'),
  'utf-8',
);
// The worktree chat surface is split across WorktreeChatSurface (the
// per-tab panel surface), its state hook, and the extracted ChatContent;
// source assertions cover the whole set.
const CHAT_PANEL_SOURCE = [
  'WorktreeChatSurface.tsx',
  'useWorktreeChatSurfaceState.ts',
  'ChatContent.tsx',
]
  .map((file) => readFileSync(join(__dirname, '..', file), 'utf-8'))
  .join('\n');
const CHAT_MESSAGE_LIST_SOURCE = readFileSync(
  join(__dirname, '..', 'ChatMessageList.tsx'),
  'utf-8',
);
const QUEUED_MESSAGE_BUBBLE_SOURCE = readFileSync(
  join(__dirname, '..', 'QueuedMessageBubble.tsx'),
  'utf-8',
);
const QUEUED_MESSAGE_EDITOR_SOURCE = readFileSync(
  join(__dirname, '..', 'QueuedMessageEditor.tsx'),
  'utf-8',
);
const QUEUED_MESSAGE_COMPOSER_EDITOR_SOURCE = readFileSync(
  join(__dirname, '..', 'useQueuedMessageComposerEditor.tsx'),
  'utf-8',
);
const SCHEDULED_AS_QUEUED_SOURCE = readFileSync(
  join(__dirname, '..', 'scheduledMessageAsQueuedMessage.ts'),
  'utf-8',
);
const COMPOSER_LAYOUT_SOURCE = readFileSync(
  join(__dirname, '..', 'ComposerLayout.tsx'),
  'utf-8',
);
const SCHEDULE_MODAL_SOURCE = readFileSync(
  join(__dirname, '..', 'ScheduleMessageModal.tsx'),
  'utf-8',
);
const USAGE_LIMIT_BANNER_SOURCE = readFileSync(
  join(__dirname, '..', 'AiCreditsUsageLimitBanner.tsx'),
  'utf-8',
);

describe('chat scheduled Worktree Session prompt UI coverage', () => {
  it('hydrates automations from the chat surface for banner idempotency and scheduled rows', () => {
    expect(CHAT_INPUT_SOURCE).toContain('useAutomationsStore.getState();');
    expect(CHAT_INPUT_SOURCE).toContain('store.subscribeBridge();');
    expect(CHAT_INPUT_SOURCE).toContain('void store.hydrate();');
    expect(CHAT_INPUT_SOURCE).toContain('automationsActivities');
    expect(CHAT_PANEL_SOURCE).toContain('useAutomationsStore');
    expect(CHAT_PANEL_SOURCE).toContain('getScheduledMessagesForChat');
  });

  it('renders a non-readonly usage-limit banner with Schedule Resume and terminal scoped hiding', () => {
    // The banner markup lives in the shared AiCreditsUsageLimitBanner so every
    // chat surface renders it; ChatInput wires session scheduling independently
    // from the still-code-worktree-only "just this time" affordance (CAN-838).
    expect(USAGE_LIMIT_BANNER_SOURCE).toContain('<UsageLimitNotice');
    expect(USAGE_LIMIT_BANNER_SOURCE).toContain(
      'Do you want to use ${creditsNoun} to keep going?',
    );
    // Schedule Resume remains available alongside immediate AI Credits
    // recovery options when the persisted chat surface supports scheduling.
    expect(USAGE_LIMIT_BANNER_SOURCE).toContain(
      'const showScheduleResume = Boolean(scheduleResume) && scheduledFor === null;',
    );
    expect(USAGE_LIMIT_BANNER_SOURCE).toContain(
      'data-testid="chat-input-usage-limit-schedule-resume"',
    );
    expect(USAGE_LIMIT_BANNER_SOURCE).toContain(
      'dismissTestId="chat-input-usage-limit-dismiss"',
    );
    // Short text-only labels that answer the message's question.
    expect(USAGE_LIMIT_BANNER_SOURCE).toContain('Just this chat');
    expect(USAGE_LIMIT_BANNER_SOURCE).toContain('Always');
    expect(USAGE_LIMIT_BANNER_SOURCE).not.toMatch(
      /<(TimeFlies|Autoplay|Schedule)Icon\b/,
    );
    // Answers to the question, the switch to the credits model (CAN-4900),
    // and three or more actions drop to their own row under the message.
    expect(USAGE_LIMIT_BANNER_SOURCE).toMatch(
      /asksToUseCredits\s*\|\|\s*showModelSwitch\s*\|\|\s*visibleHandoff !== null\s*\|\|\s*actionCount >= 3/,
    );
    // The live-region role and surface come from the shared `Notice`.
    expect(USAGE_LIMIT_BANNER_SOURCE).toMatch(/<UsageLimitNotice\s+provider=/);
    // Provider and interface-mode decisions: composer-workflow-gates.test.ts.
    expect(CHAT_INPUT_SOURCE).toContain(
      'const supportsScheduledSends = workflowGates.scheduledSends;',
    );
    expect(CHAT_INPUT_SOURCE).toContain(
      "interfaceMode: tab?.interfaceMode ?? 'canopy',",
    );
    expect(CHAT_INPUT_SOURCE).toContain('usageLimitBanner !== null &&');
    expect(CHAT_INPUT_SOURCE).toContain('sessionChatTarget !== null &&');
    expect(CHAT_INPUT_SOURCE).toContain('supportsScheduledSends;');
    expect(CHAT_INPUT_SOURCE).toContain('tab?.llmProviderUsageLimitBanner');
    expect(CHAT_INPUT_SOURCE).toContain('setUsageLimitBanner(bannerTarget');
    expect(CHAT_INPUT_SOURCE).toContain('selectProviderUsageLimitResumeAt(');
    // The immediate (no reset time) resume goes through the trusted resume
    // entry, which derives the prompt and records it as sent automatically
    // (CAN-4897); the composer send path never carries resume provenance.
    expect(CHAT_INPUT_SOURCE).toContain(
      'await window.api.resumeUsageLimitedChats({',
    );
    expect(CHAT_INPUT_SOURCE).toContain(
      'clearResumedChatUsageLimitBanner(target);',
    );
    // A scheduled resume still stores the computed prompt; main revalidates
    // the interruption and re-derives it when the job runs.
    expect(CHAT_INPUT_SOURCE).toContain('computeUsageLimitResumePrompt(');
    expect(CHAT_INPUT_SOURCE).toContain('prompt: resumePrompt.text,');
    expect(CHAT_INPUT_SOURCE).toContain(
      "inputMode: resumePrompt.inputMode ?? 'typed',",
    );
    expect(CHAT_INPUT_SOURCE).toContain('resumePrompt.attachmentPaths');
    expect(CHAT_INPUT_SOURCE).toContain(
      'resumePrompt.attachmentPromptContexts',
    );
    expect(CHAT_INPUT_SOURCE).toContain(
      'existingResumeAutomation !== undefined',
    );
  });

  it('normalizes the composer interface mode with the Claude TUI chat flag', () => {
    expect(CHAT_PANEL_SOURCE).toContain(
      'interfaceMode: getEffectiveClaudeChatInterfaceMode(',
    );
    expect(CHAT_PANEL_SOURCE).toContain(
      'tab.interfaceMode,\n          claudeTuiChatsEnabled,',
    );
  });

  it('opts Code, Cowork, and App Advisor persisted sessions into scheduling while embedded mirrors stay out', () => {
    // WorktreeChatSurface serves the Code and Cowork panel grids AND the App
    // Advisor popout workspace (entry-keyed app-advisor chats render through
    // the same standard chat panels since the workspace rework).
    expect(CHAT_PANEL_SOURCE).toContain('nativeSessionComposer');
    expect(CHAT_INPUT_SOURCE).toContain(
      'if (targetOverride && !nativeSessionComposer) return null;',
    );
    expect(CHAT_INPUT_SOURCE).toContain(
      'if (onSendMessage && !nativeSessionComposer) return null;',
    );
    expect(CHAT_INPUT_SOURCE).toContain('const sessionChatTarget = useMemo');
    expect(CHAT_INPUT_SOURCE).toContain(
      'return isCoworkChatTarget(sessionChatTarget.projectId)',
    );
  });

  it('mounts approval prompts from the target shared by embedded chat surfaces', () => {
    expect(CHAT_INPUT_SOURCE).toContain(
      '{!isEditingQueued && bannerTarget && (',
    );
    expect(CHAT_INPUT_SOURCE).toContain('projectId={bannerTarget.projectId}');
    expect(CHAT_INPUT_SOURCE).toContain('worktreeId={bannerTarget.worktreeId}');
    expect(CHAT_INPUT_SOURCE).toContain('chatId={bannerTarget.chatId}');
    expect(CHAT_INPUT_SOURCE).not.toContain(
      '{!isEditingQueued && sessionChatTarget && (\n        <ToolApprovalDock',
    );
  });

  it('stages generic scheduled sends through the composer without immediate send and preserves full payload parity', () => {
    // Scheduling is a + menu item built by the shared composer layout.
    expect(COMPOSER_LAYOUT_SOURCE).toContain(
      "dataTestId: 'chat-input-schedule-button'",
    );
    expect(COMPOSER_LAYOUT_SOURCE).toContain("label: 'Schedule message'");
    expect(CHAT_INPUT_SOURCE).toContain(
      '{ onSchedule: (): void => setScheduleModalOpen(true) }',
    );
    expect(CHAT_INPUT_SOURCE).toContain('ScheduleMessageModal');
    expect(CHAT_INPUT_SOURCE).toContain('rewriteFileReferencesForCwd');
    expect(CHAT_INPUT_SOURCE).toContain('pendingRevertAttachmentPath');
    expect(CHAT_INPUT_SOURCE).toContain(
      'const combinedAttachmentPaths = revertAttachmentPath',
    );
    expect(CHAT_INPUT_SOURCE).toContain("purpose: 'scheduled_send'");
    expect(CHAT_INPUT_SOURCE).toContain(
      'clearScheduledSendComposerState(sessionChatTarget)',
    );
    expect(CHAT_INPUT_SOURCE).toContain('Could not schedule message.');
  });

  it('reserves editor selections before queued dispatch and restores rejected inputs', () => {
    const snapshotIndex = CHAT_INPUT_SOURCE.indexOf(
      '// Snapshot selections before prompt expansion',
    );
    const stagedSelectionIdsIndex = CHAT_INPUT_SOURCE.indexOf(
      'const stagedSelectionIds =',
      snapshotIndex,
    );
    const queuedPreparationIndex = CHAT_INPUT_SOURCE.indexOf(
      'const submission = pendingSendRef.current.then(async (): Promise<void> => {',
      stagedSelectionIdsIndex,
    );
    const reserveInputsIndex = CHAT_INPUT_SOURCE.indexOf(
      'if (reserveComposerInputs) {',
      stagedSelectionIdsIndex,
    );

    expect(snapshotIndex).toBeGreaterThan(-1);
    expect(stagedSelectionIdsIndex).toBeGreaterThan(snapshotIndex);
    expect(reserveInputsIndex).toBeGreaterThan(stagedSelectionIdsIndex);
    expect(queuedPreparationIndex).toBeGreaterThan(reserveInputsIndex);
    expect(CHAT_INPUT_SOURCE).toContain(
      'chatStore.removePendingEditorSelection(',
    );
    expect(CHAT_INPUT_SOURCE).toContain('await onSendMessage(');
    // The native callbacks wrap these to settle composer recovery (CAN-5348).
    expect(CHAT_INPUT_SOURCE).toContain(
      'onDispatchRejected: rejectNativeDispatch',
    );
    const dispatchRejection = CHAT_INPUT_SOURCE.slice(
      CHAT_INPUT_SOURCE.indexOf('const rejectNativeDispatch'),
    );
    expect(
      dispatchRejection.slice(0, dispatchRejection.indexOf('};')),
    ).toContain('restoreReservedInputs();');
    expect(CHAT_INPUT_SOURCE).toContain(
      'onPreDispatchRejected: rejectNativePreDispatch',
    );
    expect(CHAT_INPUT_SOURCE).not.toContain(
      'clearPendingEditorSelections(tabId)',
    );
  });

  it("captures the target worktree's active plan at submit, before the send yields, and passes it with the message", () => {
    const handleSendIndex = CHAT_INPUT_SOURCE.indexOf(
      'const handleSend = useCallback(() => {',
    );
    const captureMatch = CHAT_INPUT_SOURCE.slice(handleSendIndex).match(
      /const activePlan = captureActivePlanContext\(\s*targetOverride \?\? selectedWorktree,?\s*\);/,
    );
    const captureIndex =
      captureMatch?.index === undefined
        ? -1
        : handleSendIndex + captureMatch.index;
    const submissionIndex = CHAT_INPUT_SOURCE.indexOf(
      'const submission = pendingSendRef.current.then(async (): Promise<void> => {',
      handleSendIndex,
    );
    const sendMatch = CHAT_INPUT_SOURCE.slice(submissionIndex).match(
      /await sendMessage\(\s*rewritten\.text/,
    );
    const sendIndex =
      sendMatch?.index === undefined ? -1 : submissionIndex + sendMatch.index;
    const sendOptionsSource = CHAT_INPUT_SOURCE.slice(
      sendIndex,
      CHAT_INPUT_SOURCE.indexOf(
        'pendingSendRef.current = submission',
        sendIndex,
      ),
    );

    expect(handleSendIndex).toBeGreaterThan(-1);
    // Read synchronously in the submit handler: nothing awaits before it, so
    // a plan focused while this send waits cannot retarget the message.
    expect(captureIndex).toBeGreaterThan(handleSendIndex);
    expect(submissionIndex).toBeGreaterThan(captureIndex);
    expect(sendIndex).toBeGreaterThan(submissionIndex);
    // Both option shapes (with and without attachments) carry it.
    expect(
      sendOptionsSource.split('...(activePlan ? { activePlan } : {}),').length -
        1,
    ).toBe(2);
  });

  it('holds the composer send lock through dispatch and restores only pre-dispatch rejections', () => {
    expect(CHAT_INPUT_SOURCE).not.toMatch(
      /void sendMessage\(\s*rewritten\.text/,
    );
    expect(CHAT_INPUT_SOURCE).toMatch(/await sendMessage\(\s*rewritten\.text/);
    expect(CHAT_INPUT_SOURCE).toContain(
      'onPreDispatchRejected: rejectNativePreDispatch',
    );
    const preDispatch = CHAT_INPUT_SOURCE.slice(
      CHAT_INPUT_SOURCE.indexOf('const rejectNativePreDispatch'),
    );
    expect(preDispatch.slice(0, preDispatch.indexOf('};'))).toContain(
      'restoreRejectedDraft();',
    );
    const dispatch = CHAT_INPUT_SOURCE.slice(
      CHAT_INPUT_SOURCE.indexOf('const rejectNativeDispatch'),
    );
    expect(dispatch.slice(0, dispatch.indexOf('};'))).not.toContain(
      'restoreRejectedDraft',
    );
    expect(CHAT_INPUT_SOURCE).not.toContain(
      'onDispatchRejected: restoreRejectedDraft',
    );
  });

  it('reports only accepted new turns to onboarding tips (CAN-5005)', () => {
    const handleSend = CHAT_INPUT_SOURCE.slice(
      CHAT_INPUT_SOURCE.indexOf('const handleSend = useCallback'),
    );
    const acceptSend = handleSend.slice(
      handleSend.indexOf('const acceptSend = (): void => {'),
      handleSend.indexOf('};', handleSend.indexOf('const acceptSend')),
    );
    // Reported once, from the acceptance callback both send paths share.
    expect(acceptSend).toContain(
      'noteOnboardingTurnSent({ worktreeChat: worktreeChatTarget !== null });',
    );
    expect(CHAT_INPUT_SOURCE.split('noteOnboardingTurnSent(').length - 1).toBe(
      1,
    );
    expect(handleSend).toContain('onDispatchAccepted: acceptNativeSend');
    // Question answers, queued-message saves, terminal commands and
    // scheduled sends return before a turn is accepted.
    const reported = handleSend.indexOf('noteOnboardingTurnSent(');
    for (const earlyReturn of [
      'questionPrompt.prompt.send(text);',
      'editingState.onSave(',
      'void handleSendTerminalCommand();',
      'await handleScheduledSend(',
    ]) {
      expect(handleSend.indexOf(earlyReturn)).toBeGreaterThan(-1);
      expect(handleSend.indexOf(earlyReturn)).toBeLessThan(reported);
    }
  });

  it('keeps schedule controls ordered and validates the one-time schedule modal defaults', () => {
    // Attachments lead the box above the text; the scheduled send is a chip
    // beside +, after Plan and before the watchers.
    const attachmentsIndex = CHAT_INPUT_SOURCE.indexOf(
      '<AttachmentPillCarousel',
    );
    const editorIndex = CHAT_INPUT_SOURCE.indexOf('<ComposerEditor');
    // The box places the editor (built once, above) after the attachments;
    // the prompts' text row, also built above, holds the first reference.
    const boxEditorIndex = CHAT_INPUT_SOURCE.lastIndexOf('{composerEditor}');
    const chipIndex = CHAT_INPUT_SOURCE.indexOf('<ScheduledSendChip');
    const planChipIndex = CHAT_INPUT_SOURCE.indexOf('buildPlanModeChip({');
    const watchersIndex = CHAT_INPUT_SOURCE.indexOf('watchersSlot={');
    // The schedule item lives in the + menu, which precedes the send button.
    const scheduleButtonIndex = CHAT_INPUT_SOURCE.indexOf(
      'additionalItems={buildChatComposerPlusItems({',
    );
    const sendButtonIndex = CHAT_INPUT_SOURCE.indexOf('<ComposerSendButton');
    expect(attachmentsIndex).toBeGreaterThan(-1);
    expect(attachmentsIndex).toBeLessThan(boxEditorIndex);
    expect(chipIndex).toBeGreaterThan(editorIndex);
    expect(chipIndex).toBeGreaterThan(planChipIndex);
    expect(chipIndex).toBeLessThan(watchersIndex);
    expect(CHAT_INPUT_SOURCE).not.toContain(
      'data-testid="chat-input-scheduled-send-error"',
    );
    expect(scheduleButtonIndex).toBeGreaterThan(-1);
    expect(sendButtonIndex).toBeGreaterThan(-1);
    expect(scheduleButtonIndex).toBeLessThan(sendButtonIndex);

    expect(SCHEDULE_MODAL_SOURCE).toContain('Schedule message');
    expect(SCHEDULE_MODAL_SOURCE).toContain('Date');
    expect(SCHEDULE_MODAL_SOURCE).toContain('Time');
    expect(SCHEDULE_MODAL_SOURCE).toContain('Date.now() + 5 * 60 * 1000');
    expect(SCHEDULE_MODAL_SOURCE).toContain('Choose a future time.');
    expect(SCHEDULE_MODAL_SOURCE).toContain('Set schedule');
    // The shared dialog draws the centered card and its scrim.
    expect(SCHEDULE_MODAL_SOURCE).toContain('<DialogModal');
    expect(SCHEDULE_MODAL_SOURCE).not.toContain('pt-[12vh]');
  });

  it('renders scheduled rows after normal queued rows and wires automation-backed edit, clear, and interrupt semantics', () => {
    const queuedIndex = CHAT_MESSAGE_LIST_SOURCE.indexOf(
      'queuedMessages.map((message, i)',
    );
    const scheduledIndex = CHAT_MESSAGE_LIST_SOURCE.indexOf(
      'oneTimeScheduledMessages.map((scheduled)',
    );
    expect(queuedIndex).toBeGreaterThan(-1);
    expect(scheduledIndex).toBeGreaterThan(-1);
    expect(queuedIndex).toBeLessThan(scheduledIndex);

    // Only one-time sends render as transcript bubbles; recurring (cron)
    // automations move to the composer notice so they never pin under the
    // conversation or reach the one-time Clear/inline-edit paths.
    expect(CHAT_MESSAGE_LIST_SOURCE).not.toContain(
      'scheduledMessages.map((scheduled)',
    );
    expect(CHAT_MESSAGE_LIST_SOURCE).toMatch(
      /scheduledMessages\.filter\(\s*\(scheduled\) => scheduled\.scheduleKind === 'one_time',?\s*\)/,
    );
    expect(CHAT_PANEL_SOURCE).toContain(
      "(scheduled) => scheduled.scheduleKind === 'one_time'",
    );
    expect(CHAT_INPUT_SOURCE).toContain(
      '<ScheduledAutomationsNotice target={sessionChatTarget} />',
    );
    // ChatContent's empty state and the surface's `transcriptEmpty` (which
    // gates the onboarding center and suggestion chips inside it) must agree:
    // a chat whose only scheduled content is recurring counts as empty.
    const emptyRule =
      /transcript\.queuedMessages\.length === 0 &&\s*!scheduledMessages\.some\(\s*\(scheduled\) => scheduled\.scheduleKind === 'one_time',?\s*\)/;
    for (const file of ['WorktreeChatSurface.tsx', 'ChatContent.tsx']) {
      expect(readFileSync(join(__dirname, '..', file), 'utf-8')).toMatch(
        emptyRule,
      );
    }

    expect(QUEUED_MESSAGE_BUBBLE_SOURCE).not.toContain('Scheduled Message');
    expect(QUEUED_MESSAGE_BUBBLE_SOURCE).not.toContain('Scheduled for');
    expect(QUEUED_MESSAGE_BUBBLE_SOURCE).toContain('`Sends ${scheduledLabel}`');
    expect(QUEUED_MESSAGE_BUBBLE_SOURCE).toContain(
      '<CollapsibleUserMessageContent>',
    );
    expect(QUEUED_MESSAGE_BUBBLE_SOURCE).toContain(
      "isScheduled ? 'Edit scheduled message'",
    );
    expect(CHAT_MESSAGE_LIST_SOURCE).toContain(
      'editingScheduledMessageId === scheduled.automationId',
    );
    // The scheduled message being edited opens in the composer's place.
    expect(QUEUED_MESSAGE_COMPOSER_EDITOR_SOURCE).toMatch(
      /<QueuedMessageEditor\s+key=\{`scheduled-editor-\$\{scheduled\.automationId\}`\}/,
    );
    expect(CHAT_INPUT_SOURCE).toContain('editingScheduledSendDraft');
    expect(CHAT_INPUT_SOURCE).toContain('editingState.scheduleEnabled');
    expect(CHAT_PANEL_SOURCE).not.toContain('AutomationActivityModal');
    expect(CHAT_PANEL_SOURCE).toContain(
      'const runResponse = await runAutomationNow(automationId);',
    );
    expect(CHAT_PANEL_SOURCE).toContain('if (!runResponse.ok)');
    expect(CHAT_PANEL_SOURCE).toContain(
      "if (activity && activity.schedule.kind === 'one_time')",
    );
    expect(CHAT_PANEL_SOURCE).toContain('setRunningScheduledId(automationId)');
    expect(CHAT_PANEL_SOURCE).toContain('setScheduledMessageError(');
  });

  it('bridges inline queued schedule edits to automation create/update and removal to normal queue send', () => {
    expect(CHAT_PANEL_SOURCE).toContain('handleSaveQueuedMessage');
    expect(CHAT_PANEL_SOURCE).toContain('createAutomationActivity({');
    expect(CHAT_PANEL_SOURCE).toContain("name: 'Scheduled message'");
    expect(CHAT_PANEL_SOURCE).toContain('handleClearQueuedMessage(index)');
    expect(CHAT_PANEL_SOURCE).toContain('chat-scheduled-message-error');
    expect(CHAT_PANEL_SOURCE).toContain('handleSaveScheduledMessage');
    expect(CHAT_PANEL_SOURCE).toContain('setEditingScheduledId(null)');
    expect(CHAT_PANEL_SOURCE).toContain('void sendMessage(');
    expect(CHAT_PANEL_SOURCE).toContain('queuedMessageSchedulingEnabled');
    expect(QUEUED_MESSAGE_EDITOR_SOURCE).toContain(
      'scheduledSendDraft: message.scheduledSendDraft',
    );
    expect(SCHEDULED_AS_QUEUED_SOURCE).toContain(
      'scheduledSendDraft: { runAt: scheduled.scheduledAt }',
    );
  });

  it('projects and manages scheduled rows in App Advisor chats with the shared session handlers', () => {
    // App Advisor entry chats render through the standard WorktreeChatSurface
    // (the legacy AppAdvisorDialog was retired with the workspace rework), so
    // the shared session handlers below cover App Advisor too.
    expect(CHAT_PANEL_SOURCE).toContain('useWorktreeChatTabSurfaceState(');
    expect(CHAT_PANEL_SOURCE).toContain(
      'resolvedWorktree && resolvedChatTabId',
    );
    expect(CHAT_PANEL_SOURCE).toContain(
      'scheduledMessages={scheduledMessages}',
    );
    expect(CHAT_PANEL_SOURCE).toContain(
      'onSaveEditScheduledMessage: handleSaveScheduledMessage',
    );
    expect(CHAT_PANEL_SOURCE).toContain('queuedMessageSchedulingEnabled');
  });

  it('reports sanitized App Advisor chat state for schedule modal and automation edit modal ownership', () => {
    expect(CHAT_PANEL_SOURCE).toContain('usageLimitBannerVisible');
    expect(CHAT_PANEL_SOURCE).toContain('usageResumeScheduled');
    expect(CHAT_PANEL_SOURCE).toContain('scheduledMessageCount');
    expect(CHAT_PANEL_SOURCE).toContain('scheduleModalOpen');
    expect(CHAT_PANEL_SOURCE).toContain('scheduledMessageInlineEditOpen');
    expect(CHAT_PANEL_SOURCE).toContain('scheduledMessageEditId');
    expect(CHAT_PANEL_SOURCE).not.toContain('promptText');
    expect(CHAT_PANEL_SOURCE).not.toContain('attachmentContents');
  });
});
