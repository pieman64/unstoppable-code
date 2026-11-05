import type {
  AppErrorCopy,
  AppErrorDetail,
  AppErrorRecovery,
} from './primitives';
import type { AppError } from './types';

/** Hosts pass their own build facts; protocol reads no build globals. */
export interface AppErrorDisplayPolicy {
  releaseFlavor?: string | undefined;
  isDevelopment?: boolean | undefined;
}

export interface AppErrorPresentation {
  copy: AppErrorCopy;
  referenceId: string;
  recovery?: AppErrorRecovery;
  retryAt?: number;
  rawDetail?: AppErrorDetail;
}

/** Stable, missing and unrecognized flavors fail closed outside development. */
export function showsRawErrorDetail(policy: AppErrorDisplayPolicy): boolean {
  return (
    policy.isDevelopment === true ||
    policy.releaseFlavor === 'internal' ||
    policy.releaseFlavor === 'rc'
  );
}

export function presentAppError(
  error: AppError,
  policy: AppErrorDisplayPolicy,
): AppErrorPresentation {
  return {
    copy: error.copy,
    referenceId: error.referenceId,
    ...(error.recovery === undefined ? {} : { recovery: error.recovery }),
    ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
    ...(showsRawErrorDetail(policy) ? { rawDetail: error.detail } : {}),
  };
}
