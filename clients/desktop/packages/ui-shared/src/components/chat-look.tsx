import { createContext, useContext, type JSX, type ReactNode } from 'react';
import type { ChatDetail } from '@canopy/protocol/chat-detail';
import { buttonClassName } from './Button';

/**
 * How transcript parts draw. `clean` is the one chat look; it reads like the
 * Codex, ChatGPT and Claude Code transcripts:
 * - a turn opens with "Working for 28s", then "Worked for 3m 24s", which
 *   folds the steps away once the turn is done;
 * - every step (tool call, group, thinking, helper agent, changed files) is
 *   the same quiet `StepRow`: an icon at the text's size and color and plain
 *   past-tense words ("Ran git status", "Read file.ts", "Couldn't run …");
 * - runs of steps read as words ("Ran commands, read files");
 * - work in progress shimmers its words instead of showing a spinner, and
 *   the only colors left are a diff's added and removed line counts.
 * `classic` is the retired look from before Clean chat graduated (it was a
 * Labs experiment until then). No host chooses it any more; its parts stay
 * until they are removed.
 */
export type ChatLook = 'classic' | 'clean';

const ChatLookContext = createContext<ChatLook>('clean');

export function ChatLookProvider({
  value,
  children,
}: {
  readonly value: ChatLook;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <ChatLookContext.Provider value={value}>
      {children}
    </ChatLookContext.Provider>
  );
}

export function useChatLook(): ChatLook {
  return useContext(ChatLookContext);
}

const ChatAppNameContext = createContext<string | undefined>(undefined);

/**
 * The product name transcript markers use ("… closed · resumed 9:41 AM",
 * "Interrupted when … closed"). This shared package cannot know the active
 * brand, so each host provides it once at its root.
 */
export function ChatAppNameProvider({
  value,
  children,
}: {
  readonly value: string | undefined;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <ChatAppNameContext.Provider value={value}>
      {children}
    </ChatAppNameContext.Provider>
  );
}

export function useChatAppName(): string | undefined {
  return useContext(ChatAppNameContext);
}

// Without a host choice every step keeps its own row.
const ChatDetailContext = createContext<ChatDetail>('detailed');

/**
 * How much of an agent's work the transcript shows (Appearance → "Chat
 * detail", see `ChatDetail`). Hosts provide the saved choice (or
 * `DEFAULT_CHAT_DETAIL`) once at their root; parts read it with
 * `useChatDetail`.
 */
export function ChatDetailProvider({
  value,
  children,
}: {
  readonly value: ChatDetail;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <ChatDetailContext.Provider value={value}>
      {children}
    </ChatDetailContext.Provider>
  );
}

export function useChatDetail(): ChatDetail {
  return useContext(ChatDetailContext);
}

/**
 * Whether the transcript folds the work between two replies into one line:
 * every chat detail but `detailed`.
 */
export function useGroupToolCalls(): boolean {
  return useContext(ChatDetailContext) !== 'detailed';
}

/**
 * Whether step rows lay out as badge lines: the clean look at chat detail
 * `detailed`. Recent and Compact keep plain words.
 */
export function useStepBadgeRows(): boolean {
  const clean = useContext(ChatLookContext) === 'clean';
  const detail = useContext(ChatDetailContext);
  return clean && detail === 'detailed';
}

/** Set by a step row around the words of its badge line. */
const StepBadgeLineContext = createContext(false);

/** Marks a step row's badge line, where code badges can shrink. */
export function StepBadgeLine({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <StepBadgeLineContext.Provider value>
      {children}
    </StepBadgeLineContext.Provider>
  );
}

/**
 * Whether a step's file, search target or command goes in a code badge:
 * inside a step row's badge line only. The same label in a tooltip or a
 * tray row stays plain text that truncates with its line.
 */
export function useStepBadges(): boolean {
  const rows = useStepBadgeRows();
  const inLine = useContext(StepBadgeLineContext);
  return rows && inLine;
}

/** True under the `clean` chat look. */
export function useCleanChatLook(): boolean {
  return useContext(ChatLookContext) === 'clean';
}

/**
 * A turn's icon button under the clean look (copy, fork, "•••", thumbs,
 * watch): the shared quiet ghost `Button`'s 28px capsule, its 14px icon in
 * tertiary ink at a 1.5px stroke, full ink on hover, focus, open and
 * pressed. Prefer `<Button variant={CLEAN_ICON_BUTTON_VARIANT} size="sm"
 * iconOnly>`; this is the same recipe for a control that must stay a plain
 * `<button>`.
 */
export const CLEAN_ICON_BUTTON_VARIANT = 'ghost-quiet';
export const CLEAN_FOOTER_ICON_BUTTON_CLASS = buttonClassName({
  variant: CLEAN_ICON_BUTTON_VARIANT,
  size: 'sm',
  iconOnly: true,
});

/**
 * A turn footer's icon button under the classic look (thumbs, copy): no
 * border or background at rest, the timestamp's muted tone, and a subtle
 * hover/active tint. The hit area and focus ring stay.
 */
export const CLASSIC_FOOTER_ICON_BUTTON_CLASS =
  'focus-ring flex h-6 w-6 pointer-coarse:h-11 pointer-coarse:w-11 items-center justify-center rounded-md fg-quaternary transition-colors hover:bg-fg-primary/[0.04] hover:fg-secondary active:bg-fg-primary/[0.08]';

/**
 * Whether a step is done, still running, failed, was blocked before it ran,
 * was interrupted with no recorded outcome, or is waiting for the person to
 * approve it. Clean step labels pick their verb from it: "Ran", "Running",
 * "Couldn't run", "Didn't run", "Run", "Waiting to run".
 */
export type StepTense =
  | 'done'
  | 'running'
  | 'failed'
  | 'blocked'
  | 'interrupted'
  | 'waiting';

const StepTenseContext = createContext<StepTense>('done');

export function StepTenseProvider({
  value,
  children,
}: {
  readonly value: StepTense;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <StepTenseContext.Provider value={value}>
      {children}
    </StepTenseContext.Provider>
  );
}

export function useStepTense(): StepTense {
  return useContext(StepTenseContext);
}
