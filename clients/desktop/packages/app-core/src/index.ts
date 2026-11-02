/**
 * `@canopy/app-core` is the leaf contract for the shared Code-tab and
 * home-screen UI. It is environment-neutral: keep this package free of
 * Electron, Node, Prisma, Next, and Zustand imports. It may depend only on
 * `@canopy/protocol` (wire contracts) and `@canopy/ui-shared` types.
 *
 * The desktop app implements {@link CanopyClient} over its IPC bridge and the
 * web app implements it over the portal REST/long-poll layer; shared feature
 * components depend on this interface, never on a concrete transport.
 */
export * from './client';
export * from './cost';
export * from './events';
export * from './gating';
export * from './ledger';
export * from './transcripts';
export * from './navigation';
export * from './view-model';
export {
  FileSaveConflictError,
  isFileSaveConflictError,
} from '@canopy/protocol/file-save-conflict';
