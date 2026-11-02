/**
 * Source-level guard: `ChatInput.tsx` is too store/IPC-bound to mount in
 * jsdom, so this checks that the composer box comes from the shared
 * `ChatComposerShell` recipe in ui-shared rather than a private class string.
 * Web wraps its composer in the same recipe, so the two boxes cannot drift.
 */
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import { join } from 'node:path';
import { COMPACT_CHIPS_BREAKPOINT_REM } from '../ComposerLayout';

const source = readFileSync(join(__dirname, '..', 'ChatInput.tsx'), 'utf8');
const layoutSource = readFileSync(
  join(
    __dirname,
    '../../../../../../../../packages/ui-shared/src/components/ComposerLayout.tsx',
  ),
  'utf8',
);
// Terminal mode's shell edge, label and run button are shared with every
// composer host, so they live in ui-shared.
const sendButtonSource = readFileSync(
  join(
    __dirname,
    '../../../../../../../../packages/ui-shared/src/components/ComposerSendButton.tsx',
  ),
  'utf8',
);
const terminalModeSource = readFileSync(
  join(
    __dirname,
    '../../../../../../../../packages/ui-shared/src/components/TerminalComposerMode.tsx',
  ),
  'utf8',
);

describe('ChatInput composer shell', () => {
  it('mounts exactly one lifetime notice in the shared composer notice column', () => {
    const column = source.match(
      /data-testid="chat-input-notices"[\s\S]*?<\/ComposerNoticeStack>/,
    )?.[0];
    expect(column?.match(/<LifetimeLimitNotice\b/g)).toHaveLength(1);
    expect(source.match(/<LifetimeLimitNotice\b/g)).toHaveLength(1);
    expect(column).toMatch(/placement="chat"/);
    expect(column).toMatch(/projectId=\{slashCommandTarget\.projectId\}/);
    expect(column).toMatch(/worktreeId=\{slashCommandTarget\.worktreeId\}/);
    expect(column).toMatch(/chatId=\{tabId\}/);
  });

  it('guards the lifetime composer mount against Home, cowork, App Advisor and missing chats', () => {
    const column = source.match(
      /data-testid="chat-input-notices"[\s\S]*?<\/ComposerNoticeStack>/,
    )?.[0];
    expect(column).toMatch(
      /\{slashCommandTarget &&\s*!isCoworkChatTarget\(slashCommandTarget\.projectId\) &&\s*tabId \? \(\s*<LifetimeLimitNotice/,
    );
    // This existing target resolver honors split-panel overrides, not the selected worktree.
    expect(source).toMatch(
      /const slashCommandTarget = useMemo\([\s\S]{0,350}projectId: targetOverride\.projectId,[\s\S]{0,100}worktreeId: targetOverride\.worktreeId/,
    );
  });

  it('takes the composer box from the shared shell recipe', () => {
    // Anchored to the assignment, so a stray import elsewhere cannot satisfy it.
    expect(source).toContain('<ChatComposerShell');
    expect(source).not.toContain(
      "'relative rounded-2xl bg-[var(--bg-composer,var(--bg-tertiary))] shadow-lg transition-colors'",
    );
  });

  it('records the archived composer banners in session replay', () => {
    // The read-only composer renders only banners (static copy and the
    // `handoffError` detail), none of them conversation or output content.
    const readOnlyBranch = source.match(
      /if \(readOnly\) \{[\s\S]*?\n {2}\}/,
    )?.[0];
    expect(readOnlyBranch).not.toContain('POSTHOG_REPLAY_BLOCK_CLASS');
    expect(readOnlyBranch?.match(/detail: handoffError/g)).toHaveLength(2);
  });

  it('keeps the default box in terminal mode, with a dashed edge: warning, red on failure', () => {
    expect(source).toContain('const shellDecoration = isTerminalMode');
    expect(source).toContain('TERMINAL_MODE_SHELL_CLASS');
    expect(source).toContain('TERMINAL_MODE_ERROR_SHELL_CLASS');
    expect(source).not.toContain('bg-fg-primary/[0.04]');
    expect(source).not.toContain('dashed var(--line-destructive)');
    expect(terminalModeSource).toMatch(
      /TERMINAL_MODE_SHELL_CLASS =\s*'outline-1 -outline-offset-1 outline-dashed outline-line-attention'/,
    );
    expect(terminalModeSource).toMatch(
      /TERMINAL_MODE_ERROR_SHELL_CLASS =\s*'outline-1 -outline-offset-1 outline-dashed outline-line-destructive'/,
    );
    expect(layoutSource).toContain("from './TerminalComposerMode'");
    expect(source).toMatch(
      /kind="terminal"[\s\S]{0,200}failed=\{terminalModeError !== null\}/,
    );
  });

  it('names terminal mode in the row label style and drops the microphone', () => {
    expect(source).toMatch(
      /terminalLabelSlot=\{\s*isTerminalMode \? \(?\s*<TerminalModeLabel\s+error=\{terminalModeError\}\s+hint=\{scriptTypeahead\.hint\}\s*\/>/,
    );
    expect(terminalModeSource).toMatch(
      /className="mr-1 select-none whitespace-nowrap text-s fg-warning"\s*>\s*Terminal mode\s*</,
    );
    // The terminal branch holds only the run button.
    const terminalBranch = source.match(
      /\) : isTerminalMode \? \(([\s\S]*?)\) : (?:questionPromptOpen|isStreaming)/,
    )?.[1];
    expect(terminalBranch).toContain('kind="terminal"');
    expect(terminalBranch).not.toContain('renderVoiceButton');
  });

  it("runs a terminal command from a warning button in send's recipe", () => {
    expect(sendButtonSource).toMatch(
      /props\.kind === 'terminal'[\s\S]*?<TerminalRunButton/,
    );
    const runButton = terminalModeSource.match(
      /export function TerminalRunButton[\s\S]*?<\/button>/,
    )?.[0];
    expect(runButton).toContain("'bg-warning enabled:hover:bg-warning/90'");
    expect(runButton).toContain(
      "'bg-destructive enabled:hover:bg-destructive-hover'",
    );
    expect(runButton).toContain('disabled:bg-muted disabled:fg-tertiary');
    expect(runButton).not.toContain('bg-quaternary');
  });

  it('keeps one line for chips and errors until the chips crowd the text', () => {
    const oneLine = source.match(
      /const composerInline = useOneLineComposer\(\{[\s\S]*?\}\);/,
    )?.[0];
    // Only chips can crowd the text: with none beside it the one line never
    // drops to two rows on width alone (a panel still widening as it opens
    // would otherwise flip the layout under the first keystrokes).
    expect(oneLine).toMatch(
      /minTextWidth: composerHasSideChips\s*\?\s*CHAT_COMPOSER_MIN_TEXT_WIDTH_PX\s*:\s*undefined/,
    );
    const chips = source.match(/const composerHasSideChips =[\s\S]*?;/)?.[0];
    expect(chips).toContain('planMode');
    expect(chips).toContain('scheduledSendDraft');
    expect(chips).toContain('chatInputWatchers.length > 0');
    expect(chips).toContain('isTerminalMode');
    expect(oneLine).toContain('sideContentKey: composerSideContentKey');
    // Errors take a label's or chip's place instead of a line of their own.
    expect(oneLine).not.toContain('terminalModeError');
    expect(oneLine).not.toContain('scheduleSendError');
    expect(source).toMatch(
      /const composerSideContentKey = \[[\s\S]{0,700}chipsCompact \? 'compact' : ''/,
    );
    expect(source).toMatch(
      /<TerminalModeLabel\s+error=\{terminalModeError\}\s+hint=\{scriptTypeahead\.hint\}\s*\/>/,
    );
  });

  it('draws the chips small in a narrow box', () => {
    expect(COMPACT_CHIPS_BREAKPOINT_REM).toBe(30);
    expect(source).toContain('COMPACT_CHIPS_BREAKPOINT_REM * rootFontSize');
    expect(source).toMatch(
      /buildPlanModeChip\(\{[\s\S]{0,120}compact: chipsCompact/,
    );
    expect(source).toMatch(
      /<ScheduledSendChip[\s\S]{0,300}compact=\{chipsCompact\}/,
    );
  });

  it('edits a queued message with the shared Cancel and Save, where send sits', () => {
    // The shared actions draw the 32px capsules at send's height, the same
    // pair the web queued-message editor uses.
    expect(source).toMatch(
      /trailingSlot=\{[\s\S]*?isEditingQueued && editingState \? \(\s*<MessageEditCancelSave\s+onCancel=\{editingState\.onCancel\}\s+onSave=\{handleSend\}/,
    );
    // No row of its own under the box any more.
    expect(source).not.toMatch(/\{editingState && \(/);
  });

  it('turns the box into the plan prompt while a plan waits', () => {
    // No bar of buttons above the box any more.
    expect(source).not.toContain('PlanActionControls');
    expect(source).toMatch(
      /const planCardOpen =\s*planWaiting && closedPlanRequestKey !== planRequestKey;/,
    );
    // The editor and its controls move into the prompt's text row.
    expect(source).toMatch(
      /const promptTextRow = voiceRecording \?[\s\S]{0,200}\{composerEditor\}\s*\{composerControls\}/,
    );
    expect(source).toMatch(
      /: planCardOpen \? \(\s*<PlanApprovalPromptWithComments[\s\S]{0,400}\{promptTextRow\}\s*<\/PlanApprovalPromptWithComments>/,
    );
    expect(source).toMatch(
      /label: planImplementationAllowed\s*\? 'Yes, implement this plan'\s*: 'Implementation unavailable',\s*onSelect: handleApprove,\s*disabled: planReviewClosed \|\| !planImplementationAllowed,/,
    );
    expect(source).toMatch(
      /label: 'Run it as a workflow',\s*onSelect: \(\): void => setPipelineModalOpen\(true\),/,
    );
    expect(source).toMatch(
      /planCardOpen\s*\?\s*'No, explain what to do differently'/,
    );
    // The text row keeps the composer's own controls: the microphone by
    // default, send once there is a note (no Skip of its own).
    expect(source).not.toContain('PlanApprovalSkipButton');
    expect(source).not.toMatch(
      /trailingSlot=\{[\s\S]{0,800}planCardOpen \? \(/,
    );
    // A prompt lays out its own rows, not the one line.
    expect(source).toMatch(
      /\/\/ A prompt lays out its own rows\.\s*!promptOpen &&/,
    );
    expect(source).toContain(
      'const promptOpen = questionPromptOpen || planCardOpen;',
    );
  });

  it('keeps the composer menu in the plan prompt, with + out of view', () => {
    // @, / and $ open the + menu's popup over the box; unmounting + in the
    // prompt left them opening an invisible menu that swallowed Escape.
    expect(source).toMatch(
      /leadingSlot=\{\s*<div[\s\S]{0,200}className=\{\s*promptOpen\s*\?\s*'sr-only'/,
    );
    expect(source).toMatch(/inert=\{promptOpen\}/);
    expect(source).not.toMatch(/leadingSlot=\{\s*planCardOpen \? null/);
  });

  it('keeps the plan waiting behind a Plan ready chip once closed', () => {
    expect(source).toMatch(
      /: planReady\s*\?\s*buildPlanReadyChip\(\{\s*compact: chipsCompact,\s*onOpen: reopenPlanCard,/,
    );
    expect(source).toContain('const planReady = planWaiting && !planCardOpen;');
  });

  it('asks a waiting question in the box, ahead of a plan', () => {
    // The old dock above the composer is gone.
    expect(source).not.toContain('chat-question-dock');
    expect(source).not.toContain('AskUserQuestionCard');
    expect(source).toMatch(
      /\{questionPromptOpen \? \(\s*<QuestionPrompt[\s\S]{0,500}\{promptTextRow\}\s*<\/QuestionPrompt>\s*\) : planCardOpen \? \(/,
    );
    expect(source).toMatch(
      /const questionPromptOpen =\s*activeQuestion !== undefined &&\s*closedQuestionRequestId !== activeQuestion\.requestId;/,
    );
    // Closing keeps it waiting behind the Question chip beside +.
    expect(source).toMatch(
      /promptOpen\s*\?\s*undefined\s*:\s*questionReady\s*\?\s*buildQuestionReadyChip\(\{\s*compact: chipsCompact,\s*onOpen: reopenQuestionPrompt,/,
    );
    // Send answers the question when its current step takes the send.
    expect(source).toMatch(
      /questionPromptOpen &&\s*!editingState &&\s*questionPrompt\.prompt\.sendAnswers\(text\)/,
    );
  });
});
