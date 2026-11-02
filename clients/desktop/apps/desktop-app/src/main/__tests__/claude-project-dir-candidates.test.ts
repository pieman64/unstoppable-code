import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claudeProjectDirCandidates,
  findClaudeCodeSessionTranscriptInProjectsDir,
} from '../integration/claude-terminal-session-service';
import {
  findClaudeCodeSessionTranscriptCandidates,
  resolveClaudeCodeSessionTranscriptPath,
} from '../lib/claude-project-paths';

// Claude Code ≥2.1.x names ~/.claude/projects/<dir> by slugging the REAL cwd
// path with [^A-Za-z0-9-] → '-' (underscores become dashes). Older CLIs
// preserved underscores, so lookup must try both before the bounded scan.

describe('claudeProjectDirCandidates', () => {
  let root: string;

  beforeEach(async () => {
    root = realpathSync(await mkdtemp(join(tmpdir(), 'claude-slug-test-')));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('puts the modern slug (underscores → dashes) first', async () => {
    const cwd = join(root, 'my_work_tree');
    await mkdir(cwd, { recursive: true });
    const candidates = await claudeProjectDirCandidates(cwd);
    expect(candidates[0]).toBe(
      join(root, 'my-work-tree').replace(/[^A-Za-z0-9-]/g, '-'),
    );
    expect(candidates[0]).not.toContain('_');
  });

  it('keeps the legacy underscore-preserving slug as a candidate', async () => {
    const cwd = join(root, 'my_work_tree');
    await mkdir(cwd, { recursive: true });
    const candidates = await claudeProjectDirCandidates(cwd);
    const legacy = cwd.replace(/[^A-Za-z0-9_-]/g, '-');
    expect(candidates).toContain(legacy);
  });

  it('slugs the symlink-resolved real path', async () => {
    const target = join(root, 'real_dir');
    await mkdir(target, { recursive: true });
    const link = join(root, 'link-dir');
    await symlink(target, link);
    const candidates = await claudeProjectDirCandidates(link);
    expect(candidates[0]).toBe(target.replace(/[^A-Za-z0-9-]/g, '-'));
    // The unresolved link path is still a fallback candidate.
    expect(candidates).toContain(link.replace(/[^A-Za-z0-9-]/g, '-'));
  });

  it('falls back to the resolved path when the cwd does not exist', async () => {
    const cwd = join(root, 'gone_dir');
    const candidates = await claudeProjectDirCandidates(cwd);
    expect(candidates[0]).toBe(cwd.replace(/[^A-Za-z0-9-]/g, '-'));
    expect(candidates).toContain(cwd.replace(/[^A-Za-z0-9_-]/g, '-'));
  });

  it('never returns duplicate candidates', async () => {
    const cwd = join(root, 'plain-dir');
    await mkdir(cwd, { recursive: true });
    const candidates = await claudeProjectDirCandidates(cwd);
    expect(new Set(candidates).size).toBe(candidates.length);
    // realpath == resolved here, so at most the two slug rules differ.
    expect(candidates.length).toBeLessThanOrEqual(2);
  });
});

describe('findClaudeCodeSessionTranscriptInProjectsDir', () => {
  let root: string;
  let projectsDir: string;
  let cwd: string;
  const sessionId = '11111111-2222-3333-4444-555555555555';
  const fileName = `${sessionId}.jsonl`;

  beforeEach(async () => {
    root = realpathSync(await mkdtemp(join(tmpdir(), 'claude-find-test-')));
    projectsDir = join(root, 'projects');
    cwd = join(root, 'work_tree');
    await mkdir(projectsDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('finds the transcript in a modern-slug dir (underscored cwd)', async () => {
    const dir = join(projectsDir, cwd.replace(/[^A-Za-z0-9-]/g, '-'));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, fileName), '{}\n');
    await expect(
      findClaudeCodeSessionTranscriptInProjectsDir(projectsDir, fileName, cwd),
    ).resolves.toBe(join(dir, fileName));
  });

  it('finds the transcript in a legacy-slug dir', async () => {
    const dir = join(projectsDir, cwd.replace(/[^A-Za-z0-9_-]/g, '-'));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, fileName), '{}\n');
    await expect(
      findClaudeCodeSessionTranscriptInProjectsDir(projectsDir, fileName, cwd),
    ).resolves.toBe(join(dir, fileName));
  });

  it('falls back to scanning unrelated project dirs', async () => {
    const dir = join(projectsDir, 'some-other-project-dir');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, fileName), '{}\n');
    await expect(
      findClaudeCodeSessionTranscriptInProjectsDir(projectsDir, fileName, cwd),
    ).resolves.toBe(join(dir, fileName));
  });

  it('returns undefined when the transcript is nowhere', async () => {
    await expect(
      findClaudeCodeSessionTranscriptInProjectsDir(projectsDir, fileName, cwd),
    ).resolves.toBeUndefined();
  });
});

describe('resolveClaudeCodeSessionTranscriptPath', () => {
  let root: string;
  let originalClaudeConfigDir: string | undefined;

  beforeEach(async () => {
    root = realpathSync(await mkdtemp(join(tmpdir(), 'claude-config-test-')));
    originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  });

  afterEach(async () => {
    if (originalClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    }
    await rm(root, { recursive: true, force: true });
  });

  it('resolves transcripts from the configured Claude home', async () => {
    const cwd = join(root, 'worktree');
    const claudeHome = join(root, 'isolated-claude-home');
    const projectsDir = join(claudeHome, 'projects');
    const sessionId = 'configured-session';
    const projectDir = join(projectsDir, cwd.replace(/[^A-Za-z0-9-]/g, '-'));
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, `${sessionId}.jsonl`), '{}\n');
    process.env.CLAUDE_CONFIG_DIR = claudeHome;

    await expect(
      resolveClaudeCodeSessionTranscriptPath(sessionId, cwd),
    ).resolves.toBe(join(projectDir, `${sessionId}.jsonl`));
  });
});

describe('findClaudeCodeSessionTranscriptCandidates', () => {
  let root: string;

  beforeEach(async () => {
    root = realpathSync(
      await mkdtemp(join(tmpdir(), 'claude-candidates-test-')),
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns all slug and scanned transcript paths, without duplicates', async () => {
    const configDir = join(root, 'claude-home');
    const projectsDir = join(configDir, 'projects');
    const cwd = join(root, 'work_tree');
    const sessionId = 'candidate-session';
    const fileName = `${sessionId}.jsonl`;
    await mkdir(cwd, { recursive: true });
    const slugs = await claudeProjectDirCandidates(cwd);
    const firstCandidate = join(projectsDir, slugs[0] ?? 'missing');
    const otherCandidate = join(projectsDir, 'unrelated-project');
    await mkdir(firstCandidate, { recursive: true });
    await mkdir(otherCandidate, { recursive: true });
    const expected = [
      join(firstCandidate, fileName),
      join(otherCandidate, fileName),
    ];
    await Promise.all(expected.map((filePath) => writeFile(filePath, '{}\n')));

    await expect(
      findClaudeCodeSessionTranscriptCandidates(sessionId, cwd, configDir),
    ).resolves.toEqual({ paths: expected, scanExhausted: false });
  });
});
