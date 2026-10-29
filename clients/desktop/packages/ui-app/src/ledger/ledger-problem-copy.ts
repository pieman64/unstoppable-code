import type { LedgerViewProblem } from '@canopy/app-state';

export interface ProblemCopy {
  readonly message: string;
  readonly retry: boolean;
}

/** What a failed read means to the person, and whether retrying can help. */
export function problemCopy(
  problem: LedgerViewProblem,
  subject: 'list' | 'entry',
): ProblemCopy {
  if (problem.kind === 'unavailable') {
    switch (problem.reason) {
      case 'disabled':
        return { message: "The Feed isn't available.", retry: false };
      case 'no_scope':
        return {
          message: "This work doesn't have a Feed.",
          retry: false,
        };
      case 'runtime_unavailable':
        return {
          message:
            subject === 'list'
              ? "Couldn't load entries. Try again."
              : "Couldn't load this entry. Try again.",
          retry: true,
        };
    }
  }
  switch (problem.reason) {
    case 'NOT_FOUND':
      return subject === 'entry'
        ? { message: 'This entry no longer exists.', retry: false }
        : { message: "Couldn't load entries. Try again.", retry: true };
    case 'SCOPE_RETIRED':
      return { message: "This work's Feed was removed.", retry: false };
    case 'FORBIDDEN':
      return { message: "You can't read this Feed.", retry: false };
    default:
      return {
        message:
          subject === 'list'
            ? "Couldn't load entries. Try again."
            : "Couldn't load this entry. Try again.",
        retry: true,
      };
  }
}
