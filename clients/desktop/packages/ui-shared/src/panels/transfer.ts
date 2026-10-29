/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Adapted from VS Code OSS: src/vs/platform/dnd/browser/dnd.ts
// (LocalSelectionTransfer). Upstream commit c4632cac (2026-06-30).
//
// VS Code keys the singleton's single payload slot by a class *prototype*
// (`DraggedEditorIdentifier.prototype`) and casts the shared instance per
// call site. This port keys the slot by a `TransferIdentifier<T>` instance
// instead, which carries the payload type parameter so `getData` is
// type-safe without any casts.

/**
 * Typed identity key for {@link LocalSelectionTransfer}. Create one
 * module-level identifier per dragged-thing kind (editor, group, view, ...)
 * and share it between drag sources and drop targets:
 *
 * ```ts
 * export const draggedPanelTransfer = new TransferIdentifier<DraggedPanel>();
 * ```
 *
 * The identifier owns the typed payload slot; the singleton only tracks which
 * identifier (if any) is active, preserving VS Code's "exactly one drag
 * payload in flight" semantics.
 */
export class TransferIdentifier<T> {
  private payload: T[] | undefined;

  constructor(
    /** Optional label for debugging; not used for identity. */
    public readonly description?: string,
  ) {}

  /** Internal — use {@link LocalSelectionTransfer.setData} instead. */
  writePayload(data: T[]): void {
    this.payload = data;
  }

  /** Internal — use {@link LocalSelectionTransfer.getData} instead. */
  readPayload(): T[] | undefined {
    return this.payload;
  }

  /** Internal — use {@link LocalSelectionTransfer.clearData} instead. */
  clearPayload(): void {
    this.payload = undefined;
  }
}

/**
 * A singleton to store transfer data during drag & drop operations that are
 * only valid within the application.
 *
 * Native `dataTransfer` cannot carry live in-process objects (and cannot be
 * read during `dragover` at all); this singleton carries the identity of the
 * dragged in-process objects instead. There is exactly one payload slot:
 * starting a new drag (`setData`) evicts whatever the previous drag stored.
 * Callers must `clearData` their identifier after handling a drop, otherwise
 * the previous drag's identity leaks into the next drop.
 */
export class LocalSelectionTransfer {
  private static readonly INSTANCE = new LocalSelectionTransfer();

  private active: TransferIdentifier<unknown> | undefined;

  private constructor() {
    // protect against external instantiation
  }

  static getInstance(): LocalSelectionTransfer {
    return LocalSelectionTransfer.INSTANCE;
  }

  hasData<T>(identifier: TransferIdentifier<T>): boolean {
    return identifier === this.active;
  }

  clearData<T>(identifier: TransferIdentifier<T>): void {
    if (this.hasData(identifier)) {
      identifier.clearPayload();
      this.active = undefined;
    }
  }

  getData<T>(identifier: TransferIdentifier<T>): T[] | undefined {
    if (this.hasData(identifier)) {
      return identifier.readPayload();
    }

    return undefined;
  }

  setData<T>(data: T[], identifier: TransferIdentifier<T>): void {
    // Exactly one payload is in flight at a time: evict the previous one.
    this.active?.clearPayload();

    identifier.writePayload(data);
    this.active = identifier;
  }
}
