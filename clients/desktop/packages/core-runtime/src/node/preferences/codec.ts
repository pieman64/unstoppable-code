export type PreferencesReadView = 'runtime' | 'persisted';
export type PreferencesLoadErrorReason = 'read' | 'parse' | 'version';
export interface PreferencesLoadError {
  timestamp: string;
  reason: PreferencesLoadErrorReason;
  message: string;
  filePath: string;
  backupPath?: string;
  restoredFromPath?: string;
  code?: string;
  expectedVersion?: number;
  actualVersion?: unknown;
}
export interface PreferencesMergeContext {
  readonly loadError: PreferencesLoadError | null;
  migrationTimestamp(): string;
}
export interface PreferencesCodec<T extends object> {
  /** Fresh-profile value, returned by reference. */
  readonly defaults: T;
  /** Normalizes an envelope's `preferences` record for a view. */
  normalize(payload: Record<string, unknown>, view: PreferencesReadView): T;
  /** Runtime projection of a stored, fallback or default value. */
  project(value: T): T;
  /** A load-warning message for a readable payload whose records must block their own updates, else null. */
  inspect(payload: Record<string, unknown>): string | null;
  /** Merges a patch for a save. Throws to refuse it. */
  merge(existing: T, patch: Partial<T>, context: PreferencesMergeContext): T;
}
