/**
 * @jest-environment jsdom
 */
// Workspace-item mention plumbing: pseudo-repo candidate groups with mention
// kinds, per-kind display paths, and send-time prompt expansion (body
// inlined, ref dropped; unreadable prompts keep their pill).

import type { SerializedFileReference } from '@canopy/ui-rich/types';
import {
  ATTACHMENT_MENTION_KIND,
  NOTE_MENTION_KIND,
  PROMPT_MENTION_KIND,
  buildFileReferenceDisplayPath,
  searchWorkspaceItemMentions,
} from '../fileMentionSearch';
import {
  expandPromptMentions,
  mergePromptAwareFileReferences,
} from '../promptMentionExpansion';

const readPromptByPath = jest.fn<
  Promise<{ content: string }>,
  [{ projectId: string; absolutePath: string }]
>();

beforeAll(() => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { workspaceItems: { readPromptByPath } },
  });
});

beforeEach(() => {
  readPromptByPath.mockReset();
});

const SOURCES = {
  notes: [
    {
      id: 'release-checklist',
      title: 'Release checklist',
      absolutePath: '/data/ws/notes/release-checklist.md',
      createdAt: '2026-07-14T00:00:00.000Z',
      updatedAt: '2026-07-14T00:00:00.000Z',
    },
  ],
  prompts: [
    {
      id: 'review-helper',
      title: 'Review Helper',
      absolutePath: '/data/ws/prompts/review-helper.md',
      createdAt: '2026-07-14T00:00:00.000Z',
      updatedAt: '2026-07-14T00:00:00.000Z',
    },
  ],
  attachments: [
    {
      filename: 'design.png',
      absolutePath: '/data/ws/attachments/wt/design.png',
      sizeBytes: 10,
      createdAt: '2026-07-14T00:00:00.000Z',
    },
  ],
};

describe('searchWorkspaceItemMentions', () => {
  it('groups items into pseudo-repos with mention kinds', () => {
    const options = searchWorkspaceItemMentions('', SOURCES);
    expect(options.map((o) => [o.repoName, o.kind])).toEqual([
      ['Notes', NOTE_MENTION_KIND],
      ['Prompts', PROMPT_MENTION_KIND],
      ['Attachments', ATTACHMENT_MENTION_KIND],
    ]);
    expect(options[2].isAttachment).toBe(true);
  });

  it('filters by fuzzy token match on the title/filename', () => {
    expect(
      searchWorkspaceItemMentions('review', SOURCES).map((o) => o.filename),
    ).toEqual(['Review Helper']);
    expect(searchWorkspaceItemMentions('zzz', SOURCES)).toEqual([]);
  });

  it('uses stable item IDs when display titles are duplicated', () => {
    const options = searchWorkspaceItemMentions('', {
      notes: [
        SOURCES.notes[0],
        { ...SOURCES.notes[0], id: 'release-checklist-copy' },
      ],
      prompts: [
        SOURCES.prompts[0],
        { ...SOURCES.prompts[0], id: 'review-helper-copy' },
      ],
      attachments: [],
    });

    expect(options.map((option) => option.relativePath)).toEqual([
      'release-checklist',
      'release-checklist-copy',
      'review-helper',
      'review-helper-copy',
    ]);
    expect(options.map((option) => option.filename)).toEqual([
      'Release checklist',
      'Release checklist',
      'Review Helper',
      'Review Helper',
    ]);
  });
});

describe('buildFileReferenceDisplayPath (project items)', () => {
  it('labels prompt mentions and uses absolute paths for notes/attachments', () => {
    expect(
      buildFileReferenceDisplayPath(
        {
          relativePath: 'Review Helper',
          filename: 'Review Helper',
          absolutePath: '/data/ws/prompts/review-helper.md',
          kind: PROMPT_MENTION_KIND,
        },
        1,
      ),
    ).toBe('Prompt: Review Helper');
    expect(
      buildFileReferenceDisplayPath(
        {
          relativePath: 'Release checklist',
          absolutePath: '/data/ws/notes/release-checklist.md',
          kind: NOTE_MENTION_KIND,
        },
        1,
      ),
    ).toBe('/data/ws/notes/release-checklist.md');
  });
});

describe('expandPromptMentions', () => {
  const promptRef: SerializedFileReference = {
    displayPath: 'Prompt: Review Helper',
    absolutePath: '/data/ws/prompts/review-helper.md',
    kind: PROMPT_MENTION_KIND,
  };
  const noteRef: SerializedFileReference = {
    displayPath: '/data/ws/notes/release-checklist.md',
    absolutePath: '/data/ws/notes/release-checklist.md',
    kind: NOTE_MENTION_KIND,
  };

  it('inlines the prompt body and drops the ref; notes pass through', async () => {
    readPromptByPath.mockResolvedValue({
      content: 'Review the diff carefully.',
    });
    const result = await expandPromptMentions(
      'ws-1',
      'Prompt: Review Helper and also /data/ws/notes/release-checklist.md',
      [promptRef, noteRef],
    );
    expect(result.text).toBe(
      'Review the diff carefully. and also /data/ws/notes/release-checklist.md',
    );
    expect(result.fileReferences).toEqual([noteRef]);
    expect(readPromptByPath).toHaveBeenCalledWith({
      projectId: 'ws-1',
      absolutePath: promptRef.absolutePath,
    });
  });

  it('expands duplicate prompt mentions once per reference', async () => {
    readPromptByPath.mockResolvedValue({ content: 'BODY' });
    const result = await expandPromptMentions(
      'ws-1',
      'Prompt: Review Helper then Prompt: Review Helper',
      [promptRef, promptRef],
    );
    expect(result.text).toBe('BODY then BODY');
    expect(result.fileReferences).toEqual([]);
  });

  it('preserves repeated prompt references while deduplicating other files', () => {
    expect(
      mergePromptAwareFileReferences(
        [promptRef, promptRef, noteRef],
        [noteRef],
      ),
    ).toEqual([noteRef, promptRef, promptRef]);
  });

  it('replaces the exact prompt pill instead of earlier matching text', async () => {
    readPromptByPath.mockResolvedValue({ content: 'BODY' });
    const text = 'Prompt: Review Helper then Prompt: Review Helper';
    const result = await expandPromptMentions('ws-1', text, [
      { ...promptRef, textStart: text.lastIndexOf(promptRef.displayPath) },
    ]);
    expect(result.text).toBe('Prompt: Review Helper then BODY');
  });

  it('keeps exact offsets stable when a preceding legacy pill changes length', async () => {
    readPromptByPath
      .mockResolvedValueOnce({ content: 'A much longer legacy body' })
      .mockResolvedValueOnce({ content: 'CURRENT' });
    const currentDisplayPath = 'Prompt: Current Helper';
    const text = `${promptRef.displayPath} then ${currentDisplayPath}`;
    const result = await expandPromptMentions('ws-1', text, [
      promptRef,
      {
        ...promptRef,
        displayPath: currentDisplayPath,
        absolutePath: '/data/ws/prompts/current-helper.md',
        textStart: text.indexOf(currentDisplayPath),
      },
    ]);

    expect(result.text).toBe('A much longer legacy body then CURRENT');
  });

  it('keeps the pill when the prompt body cannot be read', async () => {
    readPromptByPath.mockRejectedValue(new Error('gone'));
    const result = await expandPromptMentions('ws-1', 'Prompt: Review Helper', [
      promptRef,
    ]);
    expect(result.text).toBe('Prompt: Review Helper');
    expect(result.fileReferences).toEqual([promptRef]);
  });

  it('is a pass-through when no prompt refs are present', async () => {
    const result = await expandPromptMentions('ws-1', 'hello', [noteRef]);
    expect(result.text).toBe('hello');
    expect(result.fileReferences).toEqual([noteRef]);
    expect(readPromptByPath).not.toHaveBeenCalled();
  });
});
