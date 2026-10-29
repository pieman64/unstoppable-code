// The header PR + CI badges now live in `@canopy/ui-app` so the desktop and
// web worktree headers render the same ones (REG-3025). Re-exported here to
// keep existing `@/components/github/PrStatusBadge` import paths stable.
export {
  CiStatusBadge as CheckStatusBadge,
  PrStateBadge,
} from '@canopy/ui-app/pull-requests';
