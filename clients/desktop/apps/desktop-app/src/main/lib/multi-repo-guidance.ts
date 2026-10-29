import { BRAND } from '@canopy/brand/current';

/** Heading that marks the generated multi-repo guidance block in a project's CLAUDE.md. */
export const MULTI_REPO_GUIDANCE_HEADING = `## ${BRAND.displayName} Multi-Repo Project Guidance`;

/**
 * Heading written by builds before the Workspace → Project rename (CAN-1817).
 * Existing CLAUDE.md files still carry it, so the merge must recognize it as
 * the block to replace instead of appending a second guidance block.
 */
export const LEGACY_MULTI_REPO_GUIDANCE_HEADING = `## ${BRAND.displayName} Multi-Repo Workspace Guidance`;

/**
 * Replace the generated guidance block (current or legacy heading) at the end
 * of an existing CLAUDE.md with the current default, or append it when absent.
 * Everything before the heading is preserved verbatim.
 */
export function mergeMultiRepoGuidance(
  existingContent: string,
  defaultContent: string,
): string {
  const currentIndex = existingContent.indexOf(MULTI_REPO_GUIDANCE_HEADING);
  const headingIndex =
    currentIndex === -1
      ? existingContent.indexOf(LEGACY_MULTI_REPO_GUIDANCE_HEADING)
      : currentIndex;
  const guidanceBlock = `${MULTI_REPO_GUIDANCE_HEADING}\n\n${defaultContent.trim()}\n`;

  if (headingIndex === -1) {
    const trimmed = existingContent.trimEnd();
    return trimmed.length === 0
      ? `${guidanceBlock}\n`
      : `${trimmed}\n\n${guidanceBlock}\n`;
  }

  const before = existingContent.slice(0, headingIndex).trimEnd();
  return before.length === 0
    ? `${guidanceBlock}\n`
    : `${before}\n\n${guidanceBlock}\n`;
}
