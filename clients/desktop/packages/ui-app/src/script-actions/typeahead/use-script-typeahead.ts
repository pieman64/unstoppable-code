'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ScriptActionsSnapshot } from '@canopy/protocol/script-actions';
import { useCanopyClient } from '@canopy/app-state';
import { useScriptActions } from '@canopy/app-state/script-actions';
import {
  TerminalComposerBlockedError,
  terminalDraftBody,
} from '../../code/composer/terminal-mode';
import { requestScriptActionsReview } from '../review-requests';
import {
  checkScriptInvocation,
  createScriptInvocation,
  scriptInvocationArguments,
  scriptInvocationContextMatches,
  scriptInvocationDraft,
  scriptInvocationHint,
  scriptInvocationStaleMessage,
  scriptInvocationSubmission,
  type ScriptInvocation,
  type ScriptInvocationContext,
  type ScriptInvocationSubmission,
} from './invocation';
import {
  buildScriptSuggestions,
  type ScriptSuggestion,
} from './script-suggestions';

export interface UseScriptTypeaheadOptions {
  /**
   * Host gate: a selected worktree in a writable composer. The client's
   * `terminalPty` and `scriptActions` capabilities are checked here as well.
   */
  readonly available: boolean;
  /** The composer is in terminal mode (an enabled `!` draft). */
  readonly terminalMode: boolean;
  readonly projectId: string | null | undefined;
  readonly worktreeId: string | null | undefined;
  /** The composer's selected repository; empty for the project's default. */
  readonly selectedRepoId: string | null | undefined;
  /** The project has more than one repository (defaults to true). */
  readonly multiRepo?: boolean;
  /** The serialized draft text. */
  readonly draftText: string;
  /** The caret is collapsed on the draft's first line. */
  readonly caretOnFirstLine: boolean;
  /** Replace the whole draft. A selection only fills the composer. */
  readonly replaceDraft: (text: string) => void;
}

/** The keyboard event fields the typeahead reads (React or DOM). */
export interface ScriptTypeaheadKeyEvent {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly isComposing?: boolean;
  readonly nativeEvent?: { readonly isComposing?: boolean };
  preventDefault: () => void;
}

/** What a terminal-mode send should run. */
export type ScriptSubmission =
  | { readonly kind: 'raw' }
  | ({ readonly kind: 'script' } & ScriptInvocationSubmission);

export interface ScriptTypeaheadController {
  /** Capable, available and targeted: the typeahead is wired in. */
  readonly enabled: boolean;
  readonly open: boolean;
  readonly suggestions: readonly ScriptSuggestion[];
  /** Pending definitions; a review row is offered when above zero. */
  readonly reviewCount: number;
  /** Highlighted row: a suggestion index, `suggestions.length` for review, -1 for none. */
  readonly activeIndex: number;
  readonly setActiveIndex: (index: number) => void;
  readonly setHoveredIndex: (index: number | null) => void;
  /** Consumes navigation and selection keys while open; true when handled. */
  readonly handleKeyDown: (event: ScriptTypeaheadKeyEvent) => boolean;
  readonly select: (suggestion: ScriptSuggestion) => void;
  readonly openReview: () => void;
  /** Close until the query changes. */
  readonly dismiss: () => void;
  /** The picked script while the draft still carries it. */
  readonly invocation: ScriptInvocation | null;
  /** `Runs in <repo>/<package>` when the picked script's target needs it. */
  readonly hint: string | null;
  /**
   * Resolve a send: a valid picked script (re-validated against a fresh
   * snapshot) or the raw first-line command. Throws a
   * `TerminalComposerBlockedError` when the picked script went stale; it
   * never falls back to running it raw.
   */
  readonly resolveSubmission: () => Promise<ScriptSubmission>;
  /** Forget the picked script and any dismissal (after a send). */
  readonly reset: () => void;
}

interface Selection {
  readonly invocation: ScriptInvocation;
  /** The draft the selection writes. */
  readonly expectedDraft: string;
  /** The draft before the selection, while the host applies the new one. */
  readonly previousDraft: string;
  /** The host's draft has matched `expectedDraft` at least once. */
  readonly observed: boolean;
}

type SelectionStatus = 'pending' | 'valid' | 'stale' | 'dropped';

function selectionStatus(
  selection: Selection,
  draftText: string,
  context: ScriptInvocationContext | null,
  snapshot: ScriptActionsSnapshot | null,
): SelectionStatus {
  if (
    context === null ||
    !scriptInvocationContextMatches(selection.invocation, context)
  )
    return 'dropped';
  if (!selection.observed && draftText !== selection.expectedDraft)
    return draftText === selection.previousDraft ? 'pending' : 'dropped';
  if (scriptInvocationArguments(selection.invocation, draftText) === null)
    return 'dropped';
  if (
    snapshot !== null &&
    !checkScriptInvocation(selection.invocation, snapshot).ok
  )
    return 'stale';
  return 'valid';
}

function typeaheadQuery(draftText: string): string {
  return (terminalDraftBody(draftText).split(/\r?\n/, 1)[0] ?? '').trim();
}

function hasModifier(event: ScriptTypeaheadKeyEvent): boolean {
  return event.shiftKey || event.metaKey || event.ctrlKey || event.altKey;
}

/**
 * The `!` typeahead: suggests approved script actions while the caret is on
 * a terminal-mode draft's first line, fills the composer on selection and
 * keeps the picked script's invocation state beside the draft text.
 */
export function useScriptTypeahead({
  available,
  terminalMode,
  projectId,
  worktreeId,
  selectedRepoId,
  multiRepo = true,
  draftText,
  caretOnFirstLine,
  replaceDraft,
}: UseScriptTypeaheadOptions): ScriptTypeaheadController {
  const client = useCanopyClient();
  const capable =
    client.capabilities.terminalPty === true &&
    client.capabilities.scriptActions === true;
  const enabled =
    available &&
    capable &&
    typeof projectId === 'string' &&
    projectId !== '' &&
    typeof worktreeId === 'string' &&
    worktreeId !== '';
  // Load on the first `!` rather than with every composer.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (enabled && terminalMode && !armed) setArmed(true);
  }, [armed, enabled, terminalMode]);
  const scripts = useScriptActions({
    projectId,
    worktreeId,
    enabled: enabled && armed,
  });
  const snapshot = scripts.supported ? scripts.snapshot : null;

  const context = useMemo<ScriptInvocationContext | null>(
    () =>
      enabled && projectId && worktreeId
        ? {
            projectId,
            worktreeId,
            selectedRepoId: selectedRepoId ? selectedRepoId : null,
          }
        : null,
    [enabled, projectId, worktreeId, selectedRepoId],
  );

  const [selection, setSelection] = useState<Selection | null>(null);
  const status =
    selection === null
      ? null
      : selectionStatus(selection, draftText, context, snapshot);
  useEffect(() => {
    if (selection === null) return;
    if (status === 'dropped') setSelection(null);
    else if (!selection.observed && draftText === selection.expectedDraft)
      setSelection({ ...selection, observed: true });
  }, [draftText, selection, status]);

  const query = terminalMode ? typeaheadQuery(draftText) : '';
  const [dismissedQuery, setDismissedQuery] = useState<string | null>(null);
  useEffect(() => {
    // Editing starts a new query lifecycle, including returning to the text
    // that was dismissed before the edit.
    setDismissedQuery(null);
  }, [query, terminalMode]);

  const actions = snapshot?.actions;
  const suggestions = useMemo(
    () => (actions ? buildScriptSuggestions(actions, query) : []),
    [actions, query],
  );
  const reviewCount = snapshot?.pendingCount ?? 0;
  const rowCount = suggestions.length + (reviewCount > 0 ? 1 : 0);
  const open =
    enabled &&
    terminalMode &&
    caretOnFirstLine &&
    snapshot !== null &&
    status !== 'pending' &&
    status !== 'valid' &&
    dismissedQuery !== query &&
    rowCount > 0;

  // The highlight belongs to one query; a new query starts on its first match.
  const [highlight, setHighlight] = useState<{
    readonly query: string;
    readonly index: number;
  } | null>(null);
  const defaultIndex = suggestions.length > 0 ? 0 : -1;
  const activeIndex =
    highlight !== null &&
    highlight.query === query &&
    highlight.index >= -1 &&
    highlight.index < rowCount
      ? highlight.index
      : defaultIndex;
  const hoveredRef = useRef<number | null>(null);

  const draftRef = useRef(draftText);
  draftRef.current = draftText;
  const contextRef = useRef(context);
  contextRef.current = context;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const rescanRef = useRef(scripts.rescan);
  rescanRef.current = scripts.rescan;
  const replaceRef = useRef(replaceDraft);
  replaceRef.current = replaceDraft;
  const queryRef = useRef(query);
  queryRef.current = query;

  const setActiveIndex = useCallback((index: number): void => {
    setHighlight({ query: queryRef.current, index });
  }, []);
  const setHoveredIndex = useCallback((index: number | null): void => {
    hoveredRef.current = index;
  }, []);
  const dismiss = useCallback((): void => {
    setDismissedQuery(queryRef.current);
  }, []);

  const select = useCallback((suggestion: ScriptSuggestion): void => {
    const current = contextRef.current;
    if (current === null) return;
    const invocation = createScriptInvocation(suggestion.action, current);
    const text = scriptInvocationDraft(invocation);
    setSelection({
      invocation,
      expectedDraft: text,
      previousDraft: draftRef.current,
      observed: draftRef.current === text,
    });
    setHighlight(null);
    replaceRef.current(text);
  }, []);

  const openReview = useCallback((): void => {
    const current = contextRef.current;
    if (current === null) return;
    setDismissedQuery(queryRef.current);
    requestScriptActionsReview({
      projectId: current.projectId,
      worktreeId: current.worktreeId,
      source: 'composer',
    });
  }, []);

  const handleKeyDown = (event: ScriptTypeaheadKeyEvent): boolean => {
    if (!open) return false;
    if (event.isComposing === true || event.nativeEvent?.isComposing === true)
      return false;
    if (event.key === 'Escape' && !hasModifier(event)) {
      event.preventDefault();
      dismiss();
      return true;
    }
    if (
      (event.key === 'ArrowDown' || event.key === 'ArrowUp') &&
      !hasModifier(event)
    ) {
      event.preventDefault();
      const forward = event.key === 'ArrowDown';
      const next =
        activeIndex < 0
          ? forward
            ? 0
            : rowCount - 1
          : (activeIndex + (forward ? 1 : -1) + rowCount) % rowCount;
      setActiveIndex(next);
      return true;
    }
    if ((event.key === 'Enter' || event.key === 'Tab') && !hasModifier(event)) {
      if (reviewCount > 0 && activeIndex === suggestions.length) {
        event.preventDefault();
        openReview();
        return true;
      }
      if (suggestions.length === 0) return false;
      const hovered = hoveredRef.current;
      const pick =
        suggestions[activeIndex] ??
        (hovered === null ? undefined : suggestions[hovered]) ??
        suggestions[0];
      if (pick === undefined) return false;
      event.preventDefault();
      select(pick);
      return true;
    }
    return false;
  };

  const resolveSubmission = useCallback(async (): Promise<ScriptSubmission> => {
    const current = selectionRef.current;
    const draft = draftRef.current;
    const target = contextRef.current;
    if (current === null) return { kind: 'raw' };
    const before = selectionStatus(current, draft, target, null);
    if (before === 'dropped' || before === 'pending') return { kind: 'raw' };
    const fresh = await rescanRef.current();
    if (fresh === null)
      throw new TerminalComposerBlockedError(
        scriptInvocationStaleMessage('unverified'),
      );
    const check = checkScriptInvocation(current.invocation, fresh);
    if (!check.ok)
      throw new TerminalComposerBlockedError(
        scriptInvocationStaleMessage(check.reason),
      );
    const submission = scriptInvocationSubmission(current.invocation, draft);
    if (submission === null)
      throw new TerminalComposerBlockedError(
        scriptInvocationStaleMessage('changed'),
      );
    return { kind: 'script', ...submission };
  }, []);

  const reset = useCallback((): void => {
    setSelection(null);
    setDismissedQuery(null);
    setHighlight(null);
  }, []);

  const invocation =
    selection !== null && status === 'valid' ? selection.invocation : null;
  return {
    enabled,
    open,
    suggestions,
    reviewCount,
    activeIndex: open ? activeIndex : -1,
    setActiveIndex,
    setHoveredIndex,
    handleKeyDown,
    select,
    openReview,
    dismiss,
    invocation,
    hint: invocation ? scriptInvocationHint(invocation, multiRepo) : null,
    resolveSubmission,
    reset,
  };
}
