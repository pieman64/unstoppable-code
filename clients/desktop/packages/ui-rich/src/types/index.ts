import type { BaseEditor, Descendant } from 'slate';
import type { HistoryEditor } from 'slate-history';
import type { ReactEditor } from 'slate-react';

/**
 * Paragraph block — contains plain text runs and inline file-reference pills.
 */
export type ParagraphElement = {
  type: 'paragraph';
  children: (CustomText | FileReferenceElement)[];
};

/**
 * Inline void element representing a `@`-mentioned file. Carries both the
 * user-visible label (`displayPath`) and the canonical `absolutePath` so a
 * host application can rewrite paths at submit time. `repoName` is set in
 * multi-repo workspaces where the same relative path can be ambiguous.
 */
export type FileReferenceElement = {
  type: 'file-reference';
  displayPath: string;
  absolutePath: string;
  repoName?: string;
  /**
   * Opaque host-defined mention kind (e.g. the desktop host tags note /
   * prompt / attachment mentions for send-time handling such as prompt
   * expansion). Plain string by design — `@canopy/ui-rich` never interprets
   * it (boundary-safe, same posture as {@link SlashCommandOption.data}).
   */
  kind?: string;
  children: [{ text: '' }];
};

export type CustomElement = ParagraphElement | FileReferenceElement;

export type CustomText = {
  text: string;
};

/**
 * The fully-composed Slate editor type used by `@canopy/ui-rich`. Hosts can
 * keep a stable reference to this editor across renders and call utility
 * functions (insert text, reset, serialize) on it.
 */
export type ChatEditor = BaseEditor & ReactEditor & HistoryEditor;

/**
 * Plain wire-friendly mirror of {@link FileReferenceElement}. Hosts that
 * dispatch messages to a backend keep this shape on the wire.
 */
export interface SerializedFileReference {
  displayPath: string;
  absolutePath: string;
  repoName?: string;
  /** Opaque host mention kind — see {@link FileReferenceElement.kind}. */
  kind?: string;
  /** Start offset of the pill in the accompanying serialized text. */
  textStart?: number;
}

/**
 * Result of {@link serializeEditorValue}: plain text and any inline pills.
 */
export interface SerializedEditorValue {
  text: string;
  fileReferences: SerializedFileReference[];
}

/**
 * Trigger characters accepted by the slash-command plugin. `/` is the default
 * across providers; some providers (e.g. Codex) also accept `$` to surface
 * skills.
 */
export type SlashCommandTriggerCharacter = '/' | '$';

/**
 * One row in the slash-command picker. `displayName` overrides the default
 * `/{name}` label. `insertText` overrides the default `/{name} ` insertion.
 */
export interface SlashCommandOption {
  name: string;
  description?: string;
  displayName?: string;
  insertText?: string;
  category?: string;
  /**
   * Host-provided plugin namespace for scoped browsing. Search also treats it
   * as the row's plugin identity, including when `name` is flattened.
   */
  namespace?: string;
  /**
   * Original member identity when `name` was projected for a harness, so
   * search can match it independently of the invocation text.
   */
  memberName?: string;
  /** Selecting this row enters a namespace instead of invoking a command. */
  browseNamespace?: string;
  /** Display grouping independent of enablement state. */
  menuGroup?: string;
  /**
   * Which section of the slash menu this row belongs to. `'discovered'` rows
   * (or rows with no section) are already enabled/available; `'available'` rows
   * must be enabled by the host before insertion and render under a divider.
   *
   * Boundary-safe by design: this is a plain string union so `@canopy/ui-rich`
   * stays free of any `@canopy/desktop-shared` dependency (the package is also
   * consumed by `apps/web`).
   */
  section?: 'discovered' | 'available';
  /**
   * Opaque host payload carried through the menu untouched. The desktop host
   * stores the concrete invocable-inventory entry here so it survives the
   * ui-rich layer and can be recovered in its selection handler. `@canopy/ui-rich`
   * never reads or narrows this value.
   */
  data?: unknown;
  /** Present when discovery should show the row but prevent insertion. */
  disabledReason?: string;
  /**
   * The host must resolve this row before insertion and supply the text to
   * insert; the row's own `insertText` is never used as a fallback.
   */
  requiresResolution?: boolean;
}

/**
 * Host preparation result for a selected slash row: `false` blocks insertion,
 * `true` inserts the row's own text, and `{ insertText }` inserts host text.
 */
export type SlashCommandPreparation = boolean | { insertText: string };

/**
 * One row in the `@`-mention picker.
 */
export interface FileMentionOption {
  /** Unique repo identifier for grouping inside the typeahead. */
  repoId: string;
  /** Display label for the repo group header. */
  repoName: string;
  /** Path relative to the repo root, shown to the user. */
  relativePath: string;
  /** Just the basename of the file. */
  filename: string;
  /** Canonical absolute path used to build a {@link FileReferenceElement}. */
  absolutePath: string;
  /**
   * Indices into {@link relativePath} that fuzzy-matched the typeahead query.
   * Optional; if absent the menu skips per-character highlighting.
   */
  matchedIndices?: number[];
  /** Special marker for attachments stored outside the repo. */
  isAttachment?: boolean;
  /**
   * Opaque host mention kind copied onto the inserted
   * {@link FileReferenceElement.kind}. `@canopy/ui-rich` never interprets it.
   */
  kind?: string;
}

declare module 'slate' {
  interface CustomTypes {
    Editor: ChatEditor;
    Element: CustomElement;
    Text: CustomText;
  }
}

/** Always clone before use — Slate mutates editor children in place. */
const INITIAL_VALUE: Descendant[] = [
  {
    type: 'paragraph',
    children: [{ text: '' }],
  },
];
Object.freeze(INITIAL_VALUE);

export function createEmptyValue(): Descendant[] {
  return structuredClone(INITIAL_VALUE);
}
