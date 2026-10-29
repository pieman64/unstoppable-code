import type { RepoFileIndex } from '@canopy/desktop-shared/types';
import { searchFileMentions } from '../lib/fileMentionSearch';

const gitRepo: RepoFileIndex = {
  repoId: 'app',
  repoName: 'app',
  absolutePath: '/repo',
  rootKind: 'git-repo',
  files: [
    {
      relativePath: 'src/components/ChatInput.tsx',
      filename: 'ChatInput.tsx',
      absolutePath: '/repo/src/components/ChatInput.tsx',
      isIgnored: false,
    },
    {
      relativePath: 'src/components/ChatPanel.tsx',
      filename: 'ChatPanel.tsx',
      absolutePath: '/repo/src/components/ChatPanel.tsx',
      isIgnored: false,
    },
  ],
};

const attachmentsRepo: RepoFileIndex = {
  repoId: 'attachments',
  repoName: 'Attachments',
  absolutePath: '/attachments',
  rootKind: 'attachments',
  files: [
    {
      relativePath: 'diagram.png',
      filename: 'diagram.png',
      absolutePath: '/attachments/diagram.png',
      isIgnored: false,
    },
  ],
};

describe('searchFileMentions', () => {
  it('maps fuzzy hits into the FileMentionOption contract', () => {
    const results = searchFileMentions('chatinput', [gitRepo], 50);
    expect(results.length).toBeGreaterThan(0);
    const top = results[0];
    expect(top).toBeDefined();
    if (!top) throw new Error('expected a match');
    expect(top).toMatchObject({
      repoId: 'app',
      repoName: 'app',
      relativePath: 'src/components/ChatInput.tsx',
      filename: 'ChatInput.tsx',
      absolutePath: '/repo/src/components/ChatInput.tsx',
    });
    // Non-attachment rows must not carry the attachment marker.
    expect(top.isAttachment).toBeUndefined();
  });

  it('flags attachment-root files with isAttachment', () => {
    const results = searchFileMentions('diagram', [attachmentsRepo], 50);
    const hit = results.find((r) => r.filename === 'diagram.png');
    expect(hit).toBeDefined();
    expect(hit?.isAttachment).toBe(true);
  });

  it('respects the result limit', () => {
    const results = searchFileMentions('chat', [gitRepo], 1);
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it('returns an empty list when nothing matches', () => {
    expect(searchFileMentions('zzzznomatch', [gitRepo], 50)).toEqual([]);
  });

  it('searches across multiple repos and preserves per-repo identity', () => {
    const results = searchFileMentions(
      'diagram',
      [gitRepo, attachmentsRepo],
      50,
    );
    const hit = results.find((r) => r.filename === 'diagram.png');
    expect(hit).toBeDefined();
    expect(hit?.repoId).toBe('attachments');
    expect(hit?.isAttachment).toBe(true);
  });
});
