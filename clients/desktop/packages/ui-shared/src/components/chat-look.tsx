import { createContext, useContext, type JSX, type ReactNode } from 'react';

/**
 * How transcript parts draw. `classic` is the standard look. `clean` (the
 * desktop "Clean chat" Labs experiment) reads like the Codex, ChatGPT and
 * Claude Code transcripts:
 * - a turn opens with "Working for 28s", then "Worked for 3m 24s", which
 *   folds the steps away once the turn is done;
 * - every step (tool call, group, thinking, helper agent, changed files) is
 *   the same quiet `StepRow`: an icon at the text's size and color and plain
 *   past-tense words ("Ran git status", "Read file.ts", "Couldn't run …");
 * - runs of steps read as words ("Ran commands, read files");
 * - work in progress shimmers its words instead of showing a spinner, and
 *   the only colors left are a diff's added and removed line counts.
 * Hosts choose it once at their root; parts read it with `useChatLook`.
 */
export type ChatLook = 'classic' | 'clean';

const ChatLookContext = createContext<ChatLook>('classic');

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

/** True under the `clean` chat look. */
export function useCleanChatLook(): boolean {
  return useContext(ChatLookContext) === 'clean';
}

/**
 * A turn footer's icon button under the clean look (thumbs, fork, branch):
 * no box, its 14px icon in the footer text's ink, like the step icons.
 */
export const CLEAN_FOOTER_ICON_BUTTON_CLASS =
  'focus-ring flex h-6 w-6 items-center justify-center rounded-md fg-secondary transition-colors hover:bg-fg-primary/[0.06] hover:fg-primary active:bg-fg-primary/[0.08] disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:size-3.5';

/**
 * A turn footer's icon button under the classic look (thumbs, copy): no
 * border or background at rest, the timestamp's muted tone, and a subtle
 * hover/active tint. The hit area and focus ring stay.
 */
export const CLASSIC_FOOTER_ICON_BUTTON_CLASS =
  'focus-ring flex h-6 w-6 pointer-coarse:h-11 pointer-coarse:w-11 items-center justify-center rounded-md fg-quaternary transition-colors hover:bg-fg-primary/[0.04] hover:fg-secondary active:bg-fg-primary/[0.08]';

/**
 * Whether a step is done, still running or failed. Clean step labels pick
 * their verb from it: "Ran", "Running", "Couldn't run".
 */
export type StepTense = 'done' | 'running' | 'failed';

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
