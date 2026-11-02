import { BRAND } from '@canopy/brand/current';
import {
  mergeMultiRepoGuidance as mergeGuidance,
  type MultiRepoGuidanceHeadings,
} from '@canopy/core-runtime/node/workspace/instruction-files';

/** Heading that marks the generated multi-repo guidance block in a project's CLAUDE.md. */
export const MULTI_REPO_GUIDANCE_HEADING = `## ${BRAND.displayName} Multi-Repo Project Guidance`;

/**
 * Heading written by builds before the Workspace → Project rename (CAN-1817).
 * Existing CLAUDE.md files still carry it, so the merge must recognize it as
 * the block to replace instead of appending a second guidance block.
 */
export const LEGACY_MULTI_REPO_GUIDANCE_HEADING = `## ${BRAND.displayName} Multi-Repo Workspace Guidance`;

export const MULTI_REPO_GUIDANCE_HEADINGS: MultiRepoGuidanceHeadings = {
  current: MULTI_REPO_GUIDANCE_HEADING,
  legacy: LEGACY_MULTI_REPO_GUIDANCE_HEADING,
};

/**
 * Replace the generated guidance block (current or legacy heading) at the end
 * of an existing CLAUDE.md with the current default, or append it when absent.
 * Everything before the heading is preserved verbatim.
 */
export function mergeMultiRepoGuidance(
  existingContent: string,
  defaultContent: string,
): string {
  return mergeGuidance(
    existingContent,
    defaultContent,
    MULTI_REPO_GUIDANCE_HEADINGS,
  );
}
