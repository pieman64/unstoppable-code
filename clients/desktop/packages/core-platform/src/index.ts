export * from './platform-services';
export * from './endpoints';
export {
  deriveLocalAuthorityIdentity,
  LocalAuthorityIdentityError,
  type LocalAuthorityIdentity,
  type LocalAuthorityObservation,
} from './local-authority';
export {
  createOwnedChildServices,
  OWNED_CHILD_FILE,
  OwnedChildError,
  type OwnedChildErrorCode,
} from './supervision/owned-child';
export { createFileIndexingMatchPolicy } from './file-indexing';
export {
  createGitReadHost,
  type GitReadHost,
  type GitReadHostCleanupReport,
  type GitReadHostOptions,
} from './git-read/host';
export {
  captureWindowsClosureContext,
  createWindowsClosureWitness,
  type WindowsClosureReport,
} from './supervision/windows-closure';

export {
  WINDOWS_PROCESS_FILE,
  windowsPrincipalObserver,
  windowsPrincipalSid,
} from './supervision/windows-process';
