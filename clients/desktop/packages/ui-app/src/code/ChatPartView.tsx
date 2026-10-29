'use client';
import { isClaudeAiCreditsFallbackErrorCode } from '@canopy/protocol/llm-gateway';

import {
  isAgentDelegationCardData,
  type AgentDelegationCardData,
} from '@canopy/protocol/delegation';

import {
  createContext,
  memo,
  useCallback,
  useContext,
  type ComponentProps,
  type JSX,
  type ReactNode,
} from 'react';
import {
  readTurnTimerAutoRoutedModelLabel,
  type PortalAskUserQuestionAnswer,
  type PortalAskUserQuestionState,
  type PortalChatPart,
  type PortalChatToolFamily,
} from '@canopy/protocol/portal';
import {
  Markdown,
  ClaudeAiCreditsFallbackErrorNotice,
  TRANSCRIPT_MARKDOWN_OPTIONS,
  AgentBlockCard,
  DelegatedAgentCard,
  AutoRoutedModelPill,
  AnsweredQuestionsBlock,
  AskUserQuestionCard,
  CollapsibleBlock,
  CompactionInfoBlock,
  DeferredAccountProxySwitchPart,
  compactionHeadline,
  FileDeliverableCard,
  ThinkingSpinner,
  ToolCallCard,
  TurnTimer,
  answersToDisplay,
  extractExitPlanModePlan,
  getToolDisplayInfo,
  getToolRowInput,
  getToolDisplayFamily,
  isAskUserQuestionToolName,
  markdownOptions,
  matchAskUserQuestionState,
  parseAskUserQuestionTexts,
  readToolCallResult,
  SUBAGENT_UNTITLED_LABEL,
  type AgentBlockUsage,
  type AskUserQuestionDraft,
  type ToolCallResult,
  useCleanChatLook,
} from '@canopy/ui-shared/components';
import { stripOpaqueAgentCitationMarkers } from '@canopy/ui-shared/lib';
import { DotIcon, ThinkingIcon } from '@canopy/ui-shared/icons';
import { LightbulbIcon } from '@canopy/ui-shared/icons/AppIcons';
import { ChatAssetImage } from './ChatMessageAttachments';
import { useSubagentChatActions } from './subagents/SubagentChatActionsContext';
import {
  ChatToolResultPart,
  readChatToolResultVisual,
} from './ChatToolResultPart';

/**
 * Renders one neutral {@link PortalChatPart} by dispatching on its typed `kind`
 * and reusing the write-once `@canopy/ui-shared` chat primitives. The part's
 * free-form `data` is narrowed with type-guard predicates (never `as`). This is
 * the transport-neutral counterpart to the web portal's `PartRenderer` and the
 * desktop `ChatBlockRenderer` — the single place the shared chat transcript
 * turns a part into UI.
 *
 * `appIcon` is injected (not sourced from a brand module) because `@canopy/ui-app`
 * is brand-agnostic; hosts thread their brand logo down for app-action tools.
 */
export interface ChatPartViewProps {
  readonly part: PortalChatPart;
  readonly messageId?: string;
  /**
   * Whether the owning message is still streaming. Gates the `turn_timer`
   * ticking branch (web renderer parity): a settled message whose timer never
   * received `completedAt` is an interrupted turn, not "working", so it
   * renders nothing rather than a perpetually ticking row. `undefined` (e.g.
   * agent sub-blocks, which never carry timers) preserves the ticking default.
   */
  readonly live?: boolean;
  /**
   * Another part follows this one in its message, so it is done even while
   * the message streams. The clean look's thinking row settles on it.
   */
  readonly settled?: boolean;
  /** Failed/cancelled outcomes must not render a successful completion label. */
  readonly terminalStatus?: 'failed' | 'cancelled';
  /** Optional branded app icon for app-action tool calls / agent cards. */
  readonly appIcon?: ReactNode;
  /**
   * Keeps a completed `turn_timer` row visible at rest. Set by hosts that
   * render parts outside a per-turn `group/turn` scope, where the row's
   * hover reveal could never fire (CAN-4278).
   */
  readonly turnTimerAlwaysVisible?: boolean;
  /** Always-visible control beside the owning turn's completion stamp. */
  readonly turnTimerStampAccessory?: ReactNode;
  /** The host column adds the gap between turns; see `TurnTimer`. */
  readonly turnTimerHostTurnGap?: boolean;
  /** Turn actions after the elapsed label, revealed like it on hover/focus. */
  readonly turnTimerTrailing?: ReactNode;
  /** Clean chat look: a running step already shows what the turn is doing. */
  readonly turnTimerLiveStatusShown?: boolean;
  /** The finished reply's text, for the timer row's Copy button. */
  readonly turnTimerCopyText?: string;
}

/** Per-request in-flight/error status for an interactive AskUserQuestion. */
export interface AskUserQuestionRequestStatus {
  /** The in-flight action (drives button labels + `aria-busy`). */
  busy?: 'answer' | 'dismiss' | null;
  /** Which action last failed, so the matching retry copy renders. */
  errorKind?: 'submit' | 'dismiss' | null;
}

/**
 * Optional, browser-safe interaction surface for AskUserQuestion tool_use
 * blocks. A host (the web portal) provides the projected question states plus
 * answer/dismiss callbacks; the transcript then renders the interactive card /
 * read-only answer bubbles instead of raw tool JSON. The default is `null`,
 * which preserves every non-portal host (desktop transcript, shared-run viewer)
 * — those keep the generic tool-call rendering. This type carries NO web,
 * desktop, store, IPC, or fetch dependencies.
 */
export interface AskUserQuestionInteraction {
  /** Projected question states for the chat currently being rendered. */
  readonly states: readonly PortalAskUserQuestionState[];
  /** Render read-only with the reconnect helper (relay disconnected). */
  readonly disconnected?: boolean;
  /** Hard-disable the controls (e.g. commands unavailable). */
  readonly disabled?: boolean;
  /** Per-request in-flight/error state. */
  readonly getRequestStatus?: (
    requestId: string,
  ) => AskUserQuestionRequestStatus | undefined;
  /** Host markdown renderer for question/header text. */
  readonly renderMarkdown?: (markdown: string) => ReactNode;
  /** Submit the structured answers for a request. */
  readonly onAnswer: (
    requestId: string,
    answers: PortalAskUserQuestionAnswer[],
  ) => void;
  /** Dismiss a request without answering. */
  readonly onDismiss: (requestId: string) => void;
  /**
   * In-progress answers the host kept for a request, restored when its card
   * mounts (for example after a panel switch). Hosts keep drafts in memory
   * only, because they can hold secret answers.
   */
  readonly getDraft?: (requestId: string) => AskUserQuestionDraft | undefined;
  /** Keep a request's in-progress answers each time the person changes them. */
  readonly onDraftChange?: (
    requestId: string,
    draft: AskUserQuestionDraft,
  ) => void;
}

const AskUserQuestionInteractionContext =
  createContext<AskUserQuestionInteraction | null>(null);

/**
 * Provide interactive AskUserQuestion behavior to the shared transcript. The
 * value flows to every {@link ChatPartView} below it — including nested agent
 * sub-blocks — so Codex/agent-nested ask-user calls stay interactive. Absent
 * (or `null`) leaves the transcript on the generic tool-call fallback.
 */
export function AskUserQuestionInteractionProvider({
  value,
  children,
}: {
  value: AskUserQuestionInteraction | null;
  children: ReactNode;
}): JSX.Element {
  return (
    <AskUserQuestionInteractionContext.Provider value={value}>
      {children}
    </AskUserQuestionInteractionContext.Provider>
  );
}

/** Read the optional ask-user interaction surface (null when unprovided). */
export function useAskUserQuestionInteraction(): AskUserQuestionInteraction | null {
  return useContext(AskUserQuestionInteractionContext);
}

export interface DeliverableRef {
  readonly deliverableId: string;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly mediaType: string;
  readonly contentSha256: string;
}

export interface DeliverableInteraction {
  readonly onDownload: (deliverable: DeliverableRef) => void;
  readonly onOpen: (deliverable: DeliverableRef) => void;
}

const DeliverableInteractionContext =
  createContext<DeliverableInteraction | null>(null);

export function DeliverableInteractionProvider({
  value,
  children,
}: {
  value: DeliverableInteraction | null;
  children: ReactNode;
}): JSX.Element {
  return (
    <DeliverableInteractionContext.Provider value={value}>
      {children}
    </DeliverableInteractionContext.Provider>
  );
}

const TurnWorkingStatusContext = createContext<string | null>(null);

/**
 * Provide the label the live turn timer shows in place of `Working...` while
 * the host knows what the in-flight turn is doing (e.g. `Compacting
 * context…`). `null` keeps the default label.
 */
export function TurnWorkingStatusProvider({
  value,
  children,
}: {
  value: string | null;
  children: ReactNode;
}): JSX.Element {
  return (
    <TurnWorkingStatusContext.Provider value={value}>
      {children}
    </TurnWorkingStatusContext.Provider>
  );
}

/** Read the optional working-status label (null when unprovided). */
export function useTurnWorkingStatus(): string | null {
  return useContext(TurnWorkingStatusContext);
}

function readDeliverable(data: Record<string, unknown>): DeliverableRef | null {
  const raw = data['deliverable'];
  if (!isRecord(raw)) return null;
  const deliverableId = readString(raw, 'deliverableId');
  const filename = readString(raw, 'filename');
  const sizeBytes = readNumber(raw, 'sizeBytes');
  const mediaType = readString(raw, 'mediaType');
  const contentSha256 = readString(raw, 'contentSha256');
  if (
    deliverableId === undefined ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      deliverableId,
    ) ||
    filename === undefined ||
    filename.length === 0 ||
    sizeBytes === undefined ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes < 0 ||
    mediaType === undefined ||
    mediaType.length === 0 ||
    contentSha256 === undefined ||
    !/^[a-f0-9]{64}$/.test(contentSha256)
  ) {
    return null;
  }
  return { deliverableId, filename, sizeBytes, mediaType, contentSha256 };
}

// A Record over the union forces every `PortalChatPart` kind to be listed —
// adding a new kind to the protocol fails to compile here (rather than silently
// dropping coerced sub-blocks of the new kind). The Set is derived from it.
const PART_KIND_FLAGS: Record<PortalChatPart['kind'], true> = {
  mcp_activation: true,
  text: true,
  tool_use: true,
  tool_result: true,
  thinking: true,
  attachment: true,
  image: true,
  agent: true,
  turn_timer: true,
  steering: true,
  prompt_source: true,
  compaction: true,
  account_switch: true,
};
const PART_KINDS: ReadonlySet<string> = new Set(Object.keys(PART_KIND_FLAGS));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function readNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === 'number' ? value : undefined;
}

function partData(part: PortalChatPart): Record<string, unknown> {
  return isRecord(part.data) ? part.data : {};
}

/** First non-empty string among the common text-carrying fields. */
function readPartText(data: Record<string, unknown>): string {
  return (
    readString(data, 'text') ??
    readString(data, 'content') ??
    readString(data, 'output') ??
    readString(data, 'summary') ??
    ''
  );
}

/** Fold a `{ output|content|text, isError }` result into the shared card shape. */
function readToolResult(data: Record<string, unknown>): ToolCallResult | null {
  return readToolCallResult(data['result']);
}

const PLAN_PROSE_CLASSES =
  'prose prose-sm [--tw-prose-body:var(--fg-primary)] dark:prose-invert max-w-none break-words prose-p:my-0.5 prose-pre:my-1.5 prose-pre:overflow-x-auto prose-pre:bg-fg-primary/[0.06] prose-pre:fg-primary/80 prose-code:fg-accent prose-code:before:content-none prose-code:after:content-none prose-headings:fg-primary prose-a:fg-accent prose-strong:fg-primary prose-li:my-0.5';
const PLAN_MARKDOWN_OPTIONS = markdownOptions();

/**
 * Read a tool's `input`. Runtime frames carry a stringified input, but the
 * persisted-transcript projector keeps it as a (truncated) object — stringify
 * that so the input panel and the rich `getToolDisplayInfo` label are not empty.
 */
function readToolInput(data: Record<string, unknown>): string {
  const raw = data['input'];
  if (typeof raw === 'string') {
    return raw;
  }
  if (raw === undefined || raw === null) {
    return '';
  }
  try {
    return JSON.stringify(raw);
  } catch {
    return '';
  }
}

function readAgentUsage(
  data: Record<string, unknown>,
): AgentBlockUsage | undefined {
  const raw = data['usage'];
  if (!isRecord(raw)) {
    return undefined;
  }
  const usage: AgentBlockUsage = {
    inputTokens: readNumber(raw, 'inputTokens'),
    outputTokens: readNumber(raw, 'outputTokens'),
    cacheReadInputTokens: readNumber(raw, 'cacheReadInputTokens'),
    cacheCreationInputTokens: readNumber(raw, 'cacheCreationInputTokens'),
    toolUses: readNumber(raw, 'toolUses'),
    apiCalls: readNumber(raw, 'apiCalls'),
    durationMs: readNumber(raw, 'durationMs'),
    contextTokens: readNumber(raw, 'contextTokens'),
    contextWindow: readNumber(raw, 'contextWindow'),
    totalCostUsd: readNumber(raw, 'totalCostUsd'),
    model: readString(raw, 'model'),
  };
  return Object.values(usage).some((value) => value !== undefined)
    ? usage
    : undefined;
}

function isPartKind(kind: string): kind is PortalChatPart['kind'] {
  return PART_KINDS.has(kind);
}

/** Narrow an untyped sub-block into a {@link PortalChatPart}, or `null`. */
function coercePart(value: unknown): PortalChatPart | null {
  if (!isRecord(value)) {
    return null;
  }
  const kind = value['kind'];
  if (typeof kind !== 'string' || !isPartKind(kind)) {
    return null;
  }
  const toolFamily = value['toolFamily'];
  return {
    kind,
    data: value['data'],
    ...(typeof toolFamily === 'string' && isToolFamily(toolFamily)
      ? { toolFamily }
      : {}),
  };
}

// Record over the union → every tool family must be listed (a new family fails
// to compile here). The Set is derived from it.
const TOOL_FAMILY_FLAGS: Record<PortalChatToolFamily, true> = {
  read: true,
  edit: true,
  write: true,
  plan: true,
  bash: true,
  grep: true,
  glob: true,
  todo: true,
  web: true,
  agent: true,
  'ask-user': true,
  'script-output': true,
  skill: true,
  monitor: true,
  claude: true,
  watcher: true,
  canopy: true,
  graph: true,
  'app-advisor': true,
  'pipeline-editor': true,
  'computer-use': true,
  unknown: true,
};
const TOOL_FAMILIES: ReadonlySet<string> = new Set(
  Object.keys(TOOL_FAMILY_FLAGS),
);

function isToolFamily(value: string): value is PortalChatToolFamily {
  return TOOL_FAMILIES.has(value);
}

function ManagedAgentPart({
  delegation,
  children,
}: {
  readonly delegation: AgentDelegationCardData;
  readonly children?: ReactNode;
}): JSX.Element {
  const { onOpenSubagentChat } = useSubagentChatActions();
  const onOpenChat = useCallback((): void => {
    onOpenSubagentChat?.({
      kind: 'managed',
      id: delegation.delegationId,
      title: delegation.description || SUBAGENT_UNTITLED_LABEL,
    });
  }, [delegation.delegationId, delegation.description, onOpenSubagentChat]);

  return (
    <DelegatedAgentCard
      snapshot={delegation}
      parentHarnessId={delegation.parentHarnessId}
      description={delegation.description}
      prompt={delegation.prompt}
      executionMode={delegation.executionMode}
      {...(onOpenSubagentChat ? { onOpenChat } : {})}
    >
      {children}
    </DelegatedAgentCard>
  );
}

type NativeAgentPartProps = Omit<
  ComponentProps<typeof AgentBlockCard>,
  'onOpenChat'
> & {
  readonly toolUseId: string | undefined;
};

/**
 * A provider-native agent card. A Claude agent with a spawn tool-use id
 * offers Open chat when the host supplies the action.
 */
function NativeAgentPart({
  toolUseId,
  ...cardProps
}: NativeAgentPartProps): JSX.Element {
  const { onOpenSubagentChat } = useSubagentChatActions();
  const title = cardProps.description || SUBAGENT_UNTITLED_LABEL;
  const onOpenChat = useCallback((): void => {
    if (toolUseId === undefined) return;
    onOpenSubagentChat?.({ kind: 'claude-native', id: toolUseId, title });
  }, [onOpenSubagentChat, title, toolUseId]);

  return (
    <AgentBlockCard
      {...cardProps}
      {...(onOpenSubagentChat && toolUseId !== undefined ? { onOpenChat } : {})}
    />
  );
}

function ChatPartViewImpl({
  part,
  messageId,
  appIcon,
  live,
  settled = false,
  terminalStatus,
  turnTimerAlwaysVisible = false,
  turnTimerStampAccessory,
  turnTimerHostTurnGap = false,
  turnTimerTrailing,
  turnTimerLiveStatusShown = false,
  turnTimerCopyText,
}: ChatPartViewProps): JSX.Element | null {
  const deliverableInteraction = useContext(DeliverableInteractionContext);
  const workingStatus = useContext(TurnWorkingStatusContext);
  const data = partData(part);
  const askUserInteraction = useAskUserQuestionInteraction();
  const clean = useCleanChatLook();

  switch (part.kind) {
    case 'mcp_activation':
      return null;
    case 'thinking':
      return (
        <CollapsibleBlock
          label="Thinking"
          doneLabel="Thought"
          // Clean chat look: only the message's last part can still be
          // thinking; the classic row never shows it running.
          running={clean && live === true && !settled}
          content={readPartText(data)}
          icon={clean ? <LightbulbIcon /> : <ThinkingIcon />}
        />
      );

    case 'tool_use': {
      const toolName =
        readString(data, 'toolName') ?? readString(data, 'name') ?? 'tool';
      const input = readToolInput(data);
      const family = getToolDisplayFamily(toolName, input, part.toolFamily);
      const { label } = getToolDisplayInfo(toolName, input);
      const result = readToolResult(data);

      // Plan mode (CAN-3019). Canopy answers `ExitPlanMode` with `behavior:
      // 'deny'` on purpose so the plan routes into its own review UI, so the
      // transcript renders the plan and drops the result entirely — exactly
      // what desktop's `ChatBlockRenderer` does. Without this the turn reads as
      // a rejected tool call and the user is told they refused a plan they
      // wrote.
      //
      // The body may already end in a `[truncated N chars]` marker: the portal
      // wire caps tool input at 4,000 characters. Render what arrived; the
      // Plans card beside the transcript holds the full text.
      if (toolName === 'EnterPlanMode') return null;
      if (toolName === 'ExitPlanMode') {
        const plan = extractExitPlanModePlan(input);
        // Unlike desktop (which returns null), fall through to the tool card
        // when the input carries no plan: an unreadable plan block beats a
        // silently missing turn, and the card no longer implies a rejection now
        // that the tool resolves to the `plan` family.
        if (plan) {
          return (
            <div className={PLAN_PROSE_CLASSES} data-testid="chat-part-plan">
              <Markdown options={PLAN_MARKDOWN_OPTIONS} streaming={live}>
                {plan}
              </Markdown>
            </div>
          );
        }
      }

      // Interactive AskUserQuestion: when a host provides the projection +
      // callbacks, render the same choices desktop shows (or the read-only
      // answer bubbles) instead of raw tool JSON. Absent interaction (every
      // non-portal host) falls through to the generic tool row below.
      if (
        askUserInteraction &&
        family === 'ask-user' &&
        isAskUserQuestionToolName(toolName)
      ) {
        const toolUseId =
          readString(data, 'toolUseId') ?? readString(data, 'tool_use_id');
        const questionTexts = parseAskUserQuestionTexts(input);
        const resolved = result !== null;

        if (!resolved) {
          const pending = matchAskUserQuestionState(
            askUserInteraction.states,
            { toolUseId, questionTexts },
            { answered: false },
          );
          if (pending) {
            const status = askUserInteraction.getRequestStatus?.(
              pending.requestId,
            );
            const { onDraftChange } = askUserInteraction;
            return (
              <AskUserQuestionCard
                state={pending}
                draft={askUserInteraction.getDraft?.(pending.requestId)}
                onDraftChange={
                  onDraftChange
                    ? (draft): void => onDraftChange(pending.requestId, draft)
                    : undefined
                }
                renderMarkdown={askUserInteraction.renderMarkdown}
                disconnected={askUserInteraction.disconnected}
                disabled={askUserInteraction.disabled}
                busy={status?.busy ?? null}
                errorKind={status?.errorKind ?? null}
                onSubmit={(answers): void =>
                  askUserInteraction.onAnswer(pending.requestId, answers)
                }
                onDismiss={(): void =>
                  askUserInteraction.onDismiss(pending.requestId)
                }
              />
            );
          }
          // The portal transcript may project the tool_use and tool_result as
          // separate messages. In that shape this part has no embedded
          // `result`, but the durable projection has already become answered.
          // Treat that authoritative state as resolved so the card converges
          // to read-only bubbles instead of "Preparing question".
          const answered = matchAskUserQuestionState(
            askUserInteraction.states,
            { toolUseId, questionTexts },
            { answered: true },
          );
          if (answered) {
            return (
              <>
                <ToolCallCard
                  toolFamily={family}
                  toolName={toolName}
                  appIcon={appIcon}
                  label={label}
                  input={input}
                  result={result}
                  // `result` is null in the separate-message shape; without an
                  // explicit status the card would infer `pending` and show a
                  // spinner next to an already-answered question.
                  status="success"
                  pendingSpinner={<ThinkingSpinner />}
                  dataTestId="chat-tool-call"
                />
                <AnsweredQuestionsBlock
                  answers={answersToDisplay(
                    answered.answers ?? [],
                    answered.questions,
                  )}
                />
              </>
            );
          }
          // Unresolved, but the projection has not arrived yet.
          return (
            <div
              className="rounded-lg border border-line-accent/20 bg-accent/[0.04] px-4 py-3 text-xs fg-secondary"
              data-testid="ask-user-question-preparing"
            >
              Preparing question…
            </div>
          );
        }

        // Resolved: an answered match keeps the normal collapsed tool row and
        // appends the read-only answer bubbles; error/dismiss results fall
        // through to the generic tool row.
        const answered =
          result.kind !== 'error'
            ? matchAskUserQuestionState(
                askUserInteraction.states,
                { toolUseId, questionTexts },
                { answered: true },
              )
            : undefined;
        if (answered) {
          return (
            <>
              <ToolCallCard
                toolFamily={family}
                toolName={toolName}
                appIcon={appIcon}
                label={label}
                input={input}
                result={result}
                pendingSpinner={<ThinkingSpinner />}
                dataTestId="chat-tool-call"
              />
              <AnsweredQuestionsBlock
                answers={answersToDisplay(
                  answered.answers ?? [],
                  answered.questions,
                )}
              />
            </>
          );
        }
      }

      return (
        <ToolCallCard
          toolFamily={family}
          toolName={toolName}
          appIcon={appIcon}
          label={label}
          input={getToolRowInput(toolName, input)}
          result={result}
          pendingSpinner={<ThinkingSpinner />}
          dataTestId="chat-tool-call"
        />
      );
    }

    case 'tool_result':
      return (
        <ChatToolResultPart
          content={readPartText(data)}
          visual={readChatToolResultVisual(part.data, messageId)}
        />
      );

    case 'text':
      if (isClaudeAiCreditsFallbackErrorCode(data.errorCode)) {
        return <ClaudeAiCreditsFallbackErrorNotice />;
      }
      return (
        <div className="prose prose-sm dark:prose-invert max-w-none">
          <Markdown options={TRANSCRIPT_MARKDOWN_OPTIONS}>
            {stripOpaqueAgentCitationMarkers(readPartText(data))}
          </Markdown>
        </div>
      );
    case 'agent': {
      const rawSubBlocks = Array.isArray(data['subBlocks'])
        ? data['subBlocks']
        : [];
      const subParts = rawSubBlocks
        .map((sub) => coercePart(sub))
        .filter((sub): sub is PortalChatPart => sub !== null);
      const subBlocks =
        subParts.length > 0
          ? subParts
              .filter(
                (part) =>
                  !(
                    isAgentDelegationCardData(data.delegation) &&
                    part.kind === 'text' &&
                    typeof part.data === 'object' &&
                    part.data !== null &&
                    'text' in part.data &&
                    typeof part.data.text === 'string' &&
                    part.data.text.trim() === data.delegation.finalText?.trim()
                  ),
              )
              .map((sub, i) => (
                <ChatPartViewImpl
                  key={`${sub.kind}-${i}`}
                  part={sub}
                  appIcon={appIcon}
                  turnTimerAlwaysVisible={turnTimerAlwaysVisible}
                />
              ))
          : undefined;
      if (isAgentDelegationCardData(data.delegation)) {
        return (
          <ManagedAgentPart delegation={data.delegation}>
            {subBlocks}
          </ManagedAgentPart>
        );
      }
      const omittedSubBlocks = readNumber(data, 'omittedSubBlocks') ?? 0;
      const truncatedNotice =
        data['subBlocksTruncated'] === true ? (
          <div
            key="subblocks-truncated"
            className="text-3xs fg-secondary"
            data-testid="chat-agent-subblocks-truncated"
          >
            {omittedSubBlocks === 0
              ? "Earlier items aren't available here"
              : omittedSubBlocks === 1
                ? "1 earlier item isn't available here"
                : `${omittedSubBlocks} earlier items aren't available here`}
          </div>
        ) : null;
      const provider = data['provider'];
      const toolUseId = readString(data, 'toolUseId');
      return (
        <NativeAgentPart
          toolUseId={
            (provider === undefined || provider === 'claude') && toolUseId
              ? toolUseId
              : undefined
          }
          subagentType={readString(data, 'subagentType') ?? 'agent'}
          description={readString(data, 'description')}
          runInBackground={data['runInBackground'] === true}
          prompt={readString(data, 'prompt')}
          result={readString(data, 'result')}
          usage={readAgentUsage(data)}
          subBlocks={
            truncatedNotice === null
              ? subBlocks
              : [truncatedNotice, ...(subBlocks ?? [])]
          }
          isRunning={data['isRunning'] === true}
          isError={data['isError'] === true}
          model={readString(data, 'model')}
          reasoningEffort={readString(data, 'reasoningEffort')}
          pendingSpinner={<ThinkingSpinner />}
          dataTestId="chat-agent-block"
        />
      );
    }

    case 'turn_timer': {
      const startedAt = readNumber(data, 'startedAt');
      const completedAt = readNumber(data, 'completedAt') ?? null;
      const pausedAt = readNumber(data, 'pausedAt') ?? null;
      const resumedAt = readNumber(data, 'resumedAt') ?? null;
      const accumulatedPausedDurationMs = readNumber(
        data,
        'accumulatedPausedDurationMs',
      );
      const autoRoutedModelLabel = readTurnTimerAutoRoutedModelLabel(data);
      const endReason = readString(data, 'endReason');
      // The clean look names the model in the time's tooltip instead.
      const autoRoutedModelPill =
        autoRoutedModelLabel === undefined || clean ? undefined : (
          <AutoRoutedModelPill label={autoRoutedModelLabel} />
        );
      const timerTrailing =
        autoRoutedModelPill === undefined &&
        turnTimerTrailing == null ? undefined : (
          <>
            {autoRoutedModelPill}
            {turnTimerTrailing}
          </>
        );
      if (completedAt == null && live === false) {
        // A settled message with an uncompleted timer is an interrupted turn,
        // not "working" (web renderer parity): render nothing. This keeps the
        // ticking branch the exact complement of `hasLiveTurnTimer`, so the
        // transcript fallback spinner and this row can never show together.
        return null;
      }
      return completedAt == null ? (
        <TurnTimer
          startedAt={startedAt}
          pausedAt={pausedAt}
          resumedAt={resumedAt}
          accumulatedPausedDurationMs={accumulatedPausedDurationMs}
          spinner={<ThinkingSpinner tone="accent" />}
          isStreaming={true}
          hostTurnGap={turnTimerHostTurnGap}
          trailing={timerTrailing}
          liveStatusShown={turnTimerLiveStatusShown}
          {...(workingStatus === null ? {} : { workingLabel: workingStatus })}
        />
      ) : (
        <TurnTimer
          startedAt={startedAt}
          pausedAt={pausedAt}
          resumedAt={resumedAt}
          accumulatedPausedDurationMs={accumulatedPausedDurationMs}
          finishedAt={completedAt}
          stampAccessory={turnTimerStampAccessory}
          {...(turnTimerCopyText !== undefined
            ? { copyText: turnTimerCopyText }
            : {})}
          {...(clean && autoRoutedModelLabel !== undefined
            ? { modelLabel: autoRoutedModelLabel }
            : {})}
          hostTurnGap={turnTimerHostTurnGap}
          completionStatus={terminalStatus}
          isStreaming={false}
          alwaysVisible={
            turnTimerAlwaysVisible ||
            endReason === 'failed' ||
            endReason === 'cancelled'
          }
          trailing={timerTrailing}
        />
      );
    }

    // Presentation-only marker consumed by the user bubble's title row.
    case 'steering':
    case 'prompt_source':
      return null;

    case 'attachment': {
      const deliverable = readDeliverable(data);
      if (deliverable !== null && deliverableInteraction !== null) {
        return (
          <FileDeliverableCard
            filename={deliverable.filename}
            sizeBytes={deliverable.sizeBytes}
            onDownload={(): void =>
              deliverableInteraction.onDownload(deliverable)
            }
            onOpen={(): void => deliverableInteraction.onOpen(deliverable)}
          />
        );
      }
      const text = readPartText(data);
      return text ? (
        <CollapsibleBlock label={part.kind} content={text} icon={<DotIcon />} />
      ) : null;
    }
    case 'image': {
      const assetId = readString(data, 'assetId');
      if (assetId) {
        return (
          <ChatAssetImage
            reference={{
              assetId,
              mediaType: readString(data, 'mediaType'),
              filename: readString(data, 'filename'),
            }}
          />
        );
      }
      const text = readPartText(data);
      return text ? (
        <CollapsibleBlock label={part.kind} content={text} icon={<DotIcon />} />
      ) : null;
    }

    case 'compaction': {
      const occurredAt = readNumber(data, 'occurredAt');
      if (occurredAt === undefined) return null;
      return (
        <CompactionInfoBlock
          // Same rule as the desktop transcript: the projection carries the
          // provider and interface mode, so a Codex or Claude Code compaction
          // is named as such instead of every banner reading as Claude's. A
          // part with no provider is a cloud chat, which runs on the Claude
          // harness, so it keeps the Claude headline.
          headline={compactionHeadline(
            readString(data, 'provider') ?? 'claude',
            readString(data, 'interfaceMode'),
          )}
          timestamp={occurredAt}
          summary={readString(data, 'summary')}
        />
      );
    }

    case 'account_switch':
      return <DeferredAccountProxySwitchPart data={data} />;

    default: {
      // Exhaustiveness guard: a new part kind must be handled explicitly here
      // AND added to `PART_KIND_FLAGS` (which `coercePart` uses for sub-blocks).
      part.kind satisfies never;
      return null;
    }
  }
}

/**
 * Memoized so a streaming frame that appends a new part does not re-render the
 * already-settled parts (CLAUDE.md message-list `React.memo` requirement).
 */
export const ChatPartView = memo(ChatPartViewImpl);
