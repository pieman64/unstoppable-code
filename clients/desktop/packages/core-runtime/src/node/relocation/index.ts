export * from './transition';
export * from './git';
export * from './metadata';
export * from './receipts';
export * from './runtime';
export * from './recovery';
export * from './owned-paths';

import type { RelocationTransition } from './transition';
import { relocationTransition } from './transition';
import type { RelocationGitPlan } from './git';
import { repairRelocationGit } from './git';
import { discardRelocatedRuntime } from './runtime';
import { assertRelocationOwnedPathsSafe } from './owned-paths';
import { assertRelocationWorkingRoot } from './working-root';

/** B's transaction supplies stopped-host proof, journal durability and W5 ownership. */
export interface RelocationRepairContext {
  readonly transition: RelocationTransition;
  /** Private sibling of the final root; all injected owners write here with final-path content. */
  readonly workingRoot: string;
  readonly gitPlan: RelocationGitPlan;
  readonly replaceBacklink?: Parameters<typeof repairRelocationGit>[3];
  /** Complete frozen worker inventory of owned paths, including links and their targets. */
  readonly ownedPaths: readonly string[];
  /** Verifies the frozen ownership inventory and external-effect recovery plan. */
  admit(): Promise<void>;
  /** Persist and compare the exact mapping; may not accept another installation's mapping. */
  recordAuthority(transition: RelocationTransition): Promise<void>;
  /** One owner-authorized W5 decision using repairRelocatedWorkspace; no direct JSON writes. */
  repairMetadata(): Promise<void>;
}

/** Inactive injectable step: never imported by ordinary startup or root routing. */
export function createRelocationRepairStep(): (
  context: RelocationRepairContext,
) => Promise<void> {
  return async (context): Promise<void> => {
    const transition = relocationTransition(context.transition);
    await context.admit();
    await assertRelocationWorkingRoot(transition, context.workingRoot);
    await assertRelocationOwnedPathsSafe(
      transition,
      [
        ...context.ownedPaths,
        ...context.gitPlan.checkouts.flatMap((row) => [
          row.path,
          row.commonDirectory,
        ]),
      ],
      context.workingRoot,
    );
    await context.recordAuthority(transition);
    await repairRelocationGit(
      transition,
      context.gitPlan,
      context.workingRoot,
      context.replaceBacklink,
    );
    await context.repairMetadata();
    await discardRelocatedRuntime(transition, context.workingRoot);
  };
}
