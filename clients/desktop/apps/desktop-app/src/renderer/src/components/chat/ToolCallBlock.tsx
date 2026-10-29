import { TranscriptSearchRevealContext } from './transcript-search-reveal';
import { DeferredToolOutput } from './DeferredToolOutput';
import { useContext, memo, useMemo, type JSX } from 'react';
import { ChatVisualSourceButton, type ChatVisualOwner } from '@canopy/ui-app';
import { SHOW_VISUAL_TOOL_ALIASES } from '@/lib/canopy-tool-aliases';
import { readAuthDependencyFailures } from '@canopy/protocol/auth-recovery';
import { getCanonicalCanopyToolKey } from '@canopy/desktop-shared/lib/canopy-injected-tools';
import {
  getToolRowInput,
  parseMcpToolName,
  ToolCallCard,
} from '@canopy/ui-shared/components';
import { CanopyLogo } from '@/components/CanopyLogo';
import { brand } from '@/lib/brand';
import { ThinkingSpinner } from '../shared/loading/spinners/ThinkingSpinner';
import type { ToolResult } from './types';
import {
  getToolDisplayInfo,
  getSendMessageDisplayInfo,
  getToolFamilyFromName,
  isAppActionToolName,
  isCodeGraphToolName,
} from './ToolDisplayInfo';
import { AuthRecoveryCard } from './AuthRecoveryCard';
import {
  isMcpConnectionError,
  legacyMcpAuthFailure,
} from './chatConnectionErrors';

function toUnknown(value: unknown): unknown {
  return value;
}

function parseJsonObject(input: string): object | null {
  try {
    const parsed = toUnknown(JSON.parse(input));
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function getJsonStringField(input: string, field: string): string | undefined {
  const parsed = parseJsonObject(input);
  if (!parsed) {
    return undefined;
  }
  const value = toUnknown(Reflect.get(parsed, field));
  return typeof value === 'string' ? value : undefined;
}

/**
 * Desktop wrapper that composes the shared `ToolCallCard` primitive. The
 * shared card owns the visual chrome (icon dispatch, expand/collapse,
 * pending spinner shell), while this wrapper supplies the desktop's
 * existing rich label from `getToolDisplayInfo` and the runtime pending
 * spinner. `WebFetch` continues to render its parsed `prompt` block via an
 * `expandedSlot` override so the desktop-only behaviour stays here.
 */
export const ToolCallBlock = memo(function ToolCallBlock({
  toolName,
  originChatTabId,
  originMessageId,
  input,
  result,
  resolvedRecipient,
  isCodeReviewChat,
}: {
  toolName: string;
  originChatTabId?: string;
  originMessageId?: string;
  input: string;
  result?: ToolResult;
  resolvedRecipient?: string;
  /** True inside a Code Review sidecar chat — lets the shared plan/review
   * comment tools (see `ToolDisplayScope`) pick up the code-flavored icon
   * even for `RespondToComment`, whose raw name is identical in Plan
   * Explore chats. */
  isCodeReviewChat?: boolean;
}): JSX.Element {
  const forceExpanded = useContext(TranscriptSearchRevealContext);
  const toolDisplayScope = {
    isCodeReview: isCodeReviewChat,
    trustedMcpNamespace: brand.tools.namespace,
  };
  const visualOwner = useMemo((): ChatVisualOwner | null => {
    if (
      !SHOW_VISUAL_TOOL_ALIASES.includes(toolName) ||
      !result ||
      result.isError ||
      !result.visualRef ||
      !result.messageId ||
      !result.toolUseId
    ) {
      return null;
    }
    return {
      messageId: result.messageId,
      toolUseId: result.toolUseId,
      reference: result.visualRef,
    };
  }, [result, toolName]);
  const { icon, label: displayLabel } =
    toolName === 'SendMessage'
      ? getSendMessageDisplayInfo(input, resolvedRecipient)
      : getToolDisplayInfo(
          toolName,
          // A visual row names the title its promoted reference owns, through
          // the same shared renderer the Portal uses.
          visualOwner
            ? JSON.stringify({ title: visualOwner.reference.title })
            : input,
          toolDisplayScope,
        );
  const family = getToolFamilyFromName(toolName, toolDisplayScope, input);
  // Code-graph tools keep their dedicated GraphIcon (from `getToolDisplayInfo`)
  // rather than folding into the neutral branded app logo like other
  // app-action tools.
  const displayIcon =
    isAppActionToolName(toolName, toolDisplayScope) &&
    !isCodeGraphToolName(toolName, toolDisplayScope) ? (
      <CanopyLogo width={14} height={14} aria-hidden="true" />
    ) : (
      icon
    );
  const appIcon = <CanopyLogo width={14} height={14} aria-hidden="true" />;

  const toolResult = result
    ? {
        kind: result.isError ? ('error' as const) : ('text' as const),
        content: result.output,
      }
    : null;
  // Structured data wins when present (CAN-1814), but only after it is
  // re-validated here. Both write paths enforce `isValidAuthDependencyFailure`;
  // the READ path does not — `chat-tabs-reader.ts`'s `isPersistedChatBlock`
  // checks only toolUseId/toolName/output/isError and passes `authFailure`
  // through untouched. So a persisted block can pair a non-recoverable
  // `failureClass` with an `mcp_oauth` recovery, and without this guard it
  // would render "Connect MCP server" for a failure logging in cannot fix.
  // Reads BOTH the singular `authFailure` written before the multi-blocker
  // checklist and the `authFailures` array written since (CAN-1814 PR 2), and
  // reports separately whether main reached any readable verdict — which is
  // what the two fall-through rules below turn on.
  const authFailureRead = readAuthDependencyFailures(result ?? {});
  const structuredAuthFailures = authFailureRead.failures;
  // A present-but-unusable value is split by WHY it is unusable, because the
  // two cases mean opposite things (CAN-1814 follow-up):
  //
  //   - Shape-valid but semantically invalid (e.g. `quota_exceeded` paired
  //     with an `mcp_oauth` recovery): main DID reach a verdict, and it says
  //     this is not something reconnecting fixes. Fail closed — the text
  //     heuristic must not overrule a readable verdict.
  //   - Not shape-valid at all (truncated / hand-edited / garbage): there is
  //     no verdict to defer to. Failing closed here removed the user's only
  //     recovery path over a corrupt cache entry, while the tool output is
  //     independent evidence of a real auth failure. Fall through to the
  //     heuristic instead.
  const hasUnusableAuthFailure =
    structuredAuthFailures.length === 0 && authFailureRead.hasVerdict;
  // The card is driven by the failure itself, not by a boolean: it names the
  // dependency and derives its action from `recovery.kind`. Gating on
  // `dependencyClass` alone would render a login CTA for an HTTP 403, which
  // `classifyMcpAuthFailure` deliberately maps to `insufficient_scope` +
  // `recovery: { kind: 'none' }` — the token authenticated fine and was
  // refused on scope, so re-running OAuth cannot fix it. `AuthRecoveryCard`
  // owns that distinction now, which is why a non-recoverable structured
  // failure still renders here: it explains the real problem instead of the
  // nothing-at-all this branch used to show (CAN-1814 PR 2).
  //
  // The structured and legacy branches are deliberately ASYMMETRIC on
  // `result.isError`, and that is not an oversight (raised in CAN-1814 review
  // round 3). `isError` is a premise of the legacy branch — it has nothing but
  // the tool name and the output text to go on, so it may only guess from a
  // result that actually failed. The structured branch is main's verdict,
  // already reached from the errored `tool_result` (`pairPendingAuthFailures`
  // selects only from results with `is_error === true`), so re-deriving it
  // here adds nothing and makes the feature's ONLY user-visible surface
  // disappear the moment a producer attaches a failure to a result whose
  // `isError` did not survive projection — Codex signals `status: 'failed'`
  // rather than `is_error`. Pinned by the `isError false` test in
  // `__tests__/ToolCallBlock.test.tsx`.
  //
  // Canopy's OWN injected tools are excluded (CAN-1814 PR 4). Claude reaches
  // them over a branded MCP HTTP server, so under a brand whose namespace is
  // not the legacy `canopy` one `parseMcpToolName` accepts their names — and a
  // `WatchGitHubItems` error body mentioning a 401 then rendered a bogus
  // "Connect Watch git hub items" MCP card. They are not third-party servers,
  // and when one of them really does hit an auth wall main publishes a
  // structured failure for it, which the branch above already handles.
  const legacyAuthFailure =
    structuredAuthFailures.length === 0 &&
    !hasUnusableAuthFailure &&
    result?.isError === true &&
    parseMcpToolName(toolName) !== null &&
    getCanonicalCanopyToolKey(toolName) === null &&
    isMcpConnectionError(result.output)
      ? legacyMcpAuthFailure(toolName)
      : null;
  const authRecoveryFailures =
    structuredAuthFailures.length > 0
      ? structuredAuthFailures
      : legacyAuthFailure
        ? [legacyAuthFailure]
        : [];

  const displayInput = getToolRowInput(toolName, input);

  if (result?.fullOutputRef) {
    return (
      <ToolCallCard
        forceExpanded={forceExpanded}
        dataTestId="chat-tool-call"
        toolFamily={family}
        toolName={toolName}
        icon={displayIcon}
        appIcon={appIcon}
        label={displayLabel}
        result={toolResult}
        expandedSlot={
          <>
            <pre className="max-h-50 overflow-auto whitespace-pre-wrap break-all px-2.5 py-2 text-xs fg-secondary">
              {displayInput}
            </pre>
            {authRecoveryFailures.length > 0 && (
              <AuthRecoveryCard
                failures={authRecoveryFailures}
                originChatTabId={originChatTabId}
                sourceMessageId={result?.messageId ?? originMessageId}
              />
            )}
            {result.messageId && result.toolUseId ? (
              <DeferredToolOutput
                reference={result.fullOutputRef}
                preview={result.output}
                messageId={result.messageId}
                toolUseId={result.toolUseId}
              />
            ) : (
              <pre className="max-h-50 overflow-auto whitespace-pre-wrap break-all px-2.5 py-2 text-xs fg-secondary">
                {result.output}
              </pre>
            )}
          </>
        }
      />
    );
  }

  if (toolName === 'ClaudeModelChange') {
    return (
      <ToolCallCard
        forceExpanded={forceExpanded}
        dataTestId="chat-tool-call"
        toolFamily={family}
        toolName={toolName}
        icon={displayIcon}
        appIcon={appIcon}
        label={displayLabel}
        result={toolResult}
        pendingSpinner={<ThinkingSpinner />}
      />
    );
  }

  // WebFetch keeps its "Prompt" pre-section so the call body shows the parsed
  // prompt rather than the raw stringified input. Composed through the
  // expanded slot so the shared card's expand/collapse state still drives
  // visibility.
  if (toolName === 'WebFetch') {
    const prompt = getJsonStringField(input, 'prompt') ?? input;
    return (
      <ToolCallCard
        forceExpanded={forceExpanded}
        dataTestId="chat-tool-call"
        toolFamily={family}
        toolName={toolName}
        icon={displayIcon}
        appIcon={appIcon}
        label={displayLabel}
        result={toolResult}
        pendingSpinner={<ThinkingSpinner />}
        expandedSlot={
          <>
            <div className="px-2.5 py-1 text-3xs font-medium fg-secondary">
              Prompt
            </div>
            <pre className="max-h-50 overflow-auto whitespace-pre-wrap break-all px-2.5 py-2 text-xs fg-secondary">
              {prompt}
            </pre>
            {toolResult && (
              <>
                <div className="border-t px-2.5 py-1 text-3xs font-medium fg-secondary">
                  {toolResult.kind === 'error' ? 'Error' : 'Result'}
                </div>
                <pre
                  className={`max-h-75 overflow-auto whitespace-pre-wrap break-all px-2.5 py-2 text-xs ${
                    toolResult.kind === 'error'
                      ? 'fg-destructive/80'
                      : 'fg-secondary'
                  }`}
                >
                  {toolResult.content}
                </pre>
              </>
            )}
          </>
        }
      />
    );
  }

  // SendMessage surfaces the parsed `message` body (the payload delivered to
  // the recipient agent) rather than the raw `{ to, summary, message }` JSON,
  // mirroring the WebFetch "Prompt" treatment above.
  if (toolName === 'SendMessage') {
    const message = getJsonStringField(input, 'message') ?? input;
    return (
      <ToolCallCard
        forceExpanded={forceExpanded}
        dataTestId="chat-tool-call"
        toolFamily={family}
        toolName={toolName}
        icon={displayIcon}
        appIcon={appIcon}
        label={displayLabel}
        result={toolResult}
        pendingSpinner={<ThinkingSpinner />}
        expandedSlot={
          <>
            <div className="px-2.5 py-1 text-3xs font-medium fg-secondary">
              Message
            </div>
            <pre className="max-h-75 overflow-auto whitespace-pre-wrap break-all px-2.5 py-2 text-xs fg-secondary">
              {message}
            </pre>
            {toolResult && (
              <>
                <div className="border-t px-2.5 py-1 text-3xs font-medium fg-secondary">
                  {toolResult.kind === 'error' ? 'Error' : 'Result'}
                </div>
                <pre
                  className={`max-h-75 overflow-auto whitespace-pre-wrap break-all px-2.5 py-2 text-xs ${
                    toolResult.kind === 'error'
                      ? 'fg-destructive/80'
                      : 'fg-secondary'
                  }`}
                >
                  {toolResult.content}
                </pre>
              </>
            )}
          </>
        }
      />
    );
  }

  return (
    <>
      <ToolCallCard
        forceExpanded={forceExpanded}
        dataTestId="chat-tool-call"
        toolFamily={family}
        toolName={toolName}
        icon={displayIcon}
        appIcon={appIcon}
        label={displayLabel}
        input={displayInput}
        result={toolResult}
        pendingSpinner={<ThinkingSpinner />}
        // A visual row offers its source in place of the raw input.
        expandedSlot={
          visualOwner ? (
            <ChatVisualSourceButton owner={visualOwner} className="m-2" />
          ) : undefined
        }
      />
      {authRecoveryFailures.length > 0 ? (
        <AuthRecoveryCard
          failures={authRecoveryFailures}
          originChatTabId={originChatTabId}
          sourceMessageId={result?.messageId ?? originMessageId}
        />
      ) : null}
    </>
  );
});
