import {
  LEGACY_MULTI_REPO_GUIDANCE_HEADING,
  MULTI_REPO_GUIDANCE_HEADING,
  mergeMultiRepoGuidance,
} from '../multi-repo-guidance';

const DEFAULT_GUIDANCE = 'Use `repos/` for child repositories.\n';

describe('mergeMultiRepoGuidance', () => {
  it('appends the guidance block when a CLAUDE.md has none', () => {
    const merged = mergeMultiRepoGuidance(
      '# Notes\n\nKeep me.\n',
      DEFAULT_GUIDANCE,
    );
    expect(merged).toBe(
      `# Notes\n\nKeep me.\n\n${MULTI_REPO_GUIDANCE_HEADING}\n\n${DEFAULT_GUIDANCE.trim()}\n\n`,
    );
  });

  it('replaces an existing block under the current heading', () => {
    const existing = `# Notes\n\n${MULTI_REPO_GUIDANCE_HEADING}\n\nold guidance\n`;
    const merged = mergeMultiRepoGuidance(existing, DEFAULT_GUIDANCE);
    expect(merged).toBe(
      `# Notes\n\n${MULTI_REPO_GUIDANCE_HEADING}\n\n${DEFAULT_GUIDANCE.trim()}\n\n`,
    );
    expect(merged).not.toContain('old guidance');
  });

  it('migrates a block written under the pre-rename Workspace heading (CAN-1817)', () => {
    const existing = `# Notes\n\n${LEGACY_MULTI_REPO_GUIDANCE_HEADING}\n\nold guidance\n`;
    const merged = mergeMultiRepoGuidance(existing, DEFAULT_GUIDANCE);
    expect(merged).toBe(
      `# Notes\n\n${MULTI_REPO_GUIDANCE_HEADING}\n\n${DEFAULT_GUIDANCE.trim()}\n\n`,
    );
    expect(merged).not.toContain(LEGACY_MULTI_REPO_GUIDANCE_HEADING);
    expect(merged.match(/Multi-Repo/g)).toHaveLength(1);
  });

  it('prefers the current heading when both headings are present', () => {
    const existing = `${LEGACY_MULTI_REPO_GUIDANCE_HEADING}\n\nlegacy\n\n${MULTI_REPO_GUIDANCE_HEADING}\n\ncurrent\n`;
    const merged = mergeMultiRepoGuidance(existing, DEFAULT_GUIDANCE);
    expect(
      merged.startsWith(`${LEGACY_MULTI_REPO_GUIDANCE_HEADING}\n\nlegacy\n\n`),
    ).toBe(true);
    expect(merged).not.toContain('current\n');
  });
});
