import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  PersistedChatBlock,
  PersistedToolOutputReference,
  PersistedVisualReference,
} from '@canopy/agent-transcript/types';
import type { PersistedArtifactReference } from '@canopy/agent-transcript/lib/visual-ref';
import {
  artifactIdsOf,
  artifactRelativePath,
  storedArtifactBytesOf,
  storedArtifactDirectories,
  storedArtifactLocations,
  storedArtifactRefsOf,
} from '../lib/chat-artifact-references';
import { ChatTranscriptArtifacts } from '../lib/chat-transcript-artifacts';

const toolOutputReference: PersistedToolOutputReference = {
  version: 1,
  artifactId: `sha256-v1-${'a'.repeat(64)}`,
  byteLength: 24,
  sha256: 'a'.repeat(64),
  encoding: 'utf-8',
  mediaType: 'text/plain',
};

const visualReference: PersistedVisualReference = {
  version: 1,
  visualId: 'vis_00000000-0000-0000-0000-000000000000',
  artifactId: `sha256-v1-${'b'.repeat(64)}`,
  byteLength: 96,
  sha256: 'b'.repeat(64),
  mediaType: 'text/html',
  title: 'Preview',
  maxHeight: 600,
};

const nonToolResultBlock: PersistedChatBlock = {
  type: 'turn_timer',
  completedAt: null,
};

const toolResultWithoutReferences: PersistedChatBlock = {
  type: 'tool_result',
  toolUseId: 'tool-use-1',
  toolName: 'shell',
  output: 'tool output',
  isError: false,
};

const toolResultWithFullOutputReference: PersistedChatBlock = {
  type: 'tool_result',
  toolUseId: 'tool-use-1',
  toolName: 'shell',
  output: 'tool output',
  isError: false,
  fullOutputRef: toolOutputReference,
};

const toolResultWithVisualReference: PersistedChatBlock = {
  type: 'tool_result',
  toolUseId: 'tool-use-1',
  toolName: 'shell',
  output: 'tool output',
  isError: false,
  visualRef: visualReference,
};

const toolResultWithBothReferences: PersistedChatBlock = {
  type: 'tool_result',
  toolUseId: 'tool-use-1',
  toolName: 'shell',
  output: 'tool output',
  isError: false,
  fullOutputRef: toolOutputReference,
  visualRef: visualReference,
};

async function withArtifacts(
  run: (root: string, artifacts: ChatTranscriptArtifacts) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'chat-artifact-references-'));
  try {
    await run(root, new ChatTranscriptArtifacts(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('chat artifact references', (): void => {
  it('returns stored artifact references from tool-result blocks', (): void => {
    expect(storedArtifactRefsOf(nonToolResultBlock)).toEqual([]);
    expect(storedArtifactRefsOf(toolResultWithoutReferences)).toEqual([]);
    expect(storedArtifactRefsOf(toolResultWithFullOutputReference)).toEqual([
      { family: 'tool-output', reference: toolOutputReference },
    ]);
    expect(storedArtifactRefsOf(toolResultWithVisualReference)).toEqual([
      { family: 'visual', reference: visualReference },
    ]);
    expect(storedArtifactRefsOf(toolResultWithBothReferences)).toEqual([
      { family: 'tool-output', reference: toolOutputReference },
      { family: 'visual', reference: visualReference },
    ]);
  });

  it('returns artifact ids for the requested stored family', (): void => {
    expect(artifactIdsOf(toolResultWithBothReferences, 'tool-output')).toEqual([
      toolOutputReference.artifactId,
    ]);
    expect(artifactIdsOf(toolResultWithBothReferences, 'visual')).toEqual([
      visualReference.artifactId,
    ]);
  });

  it('counts only the bytes of stored artifacts on a block', (): void => {
    expect(storedArtifactBytesOf(toolResultWithoutReferences)).toBe(0);
    expect(storedArtifactBytesOf(toolResultWithFullOutputReference)).toBe(
      toolOutputReference.byteLength,
    );
    expect(storedArtifactBytesOf(toolResultWithVisualReference)).toBe(
      visualReference.byteLength,
    );
    expect(storedArtifactBytesOf(toolResultWithBothReferences)).toBe(
      toolOutputReference.byteLength + visualReference.byteLength,
    );
  });

  it('lists the directories used by stored artifact families', (): void => {
    expect(storedArtifactDirectories()).toEqual(['tool-output', 'visuals']);
    expect(Array.from(storedArtifactLocations())).toEqual([
      { family: 'tool-output', directory: 'tool-output', extension: '.txt' },
      { family: 'visual', directory: 'visuals', extension: '.html' },
    ]);
  });

  it('builds relative paths for tool-output and visual artifact families', (): void => {
    const toolOutputArtifact: PersistedArtifactReference = {
      family: 'tool-output',
      reference: toolOutputReference,
    };
    const visualArtifact: PersistedArtifactReference = {
      family: 'visual',
      reference: visualReference,
    };

    expect(artifactRelativePath('chat-1', toolOutputArtifact)).toBe(
      join(
        'transcripts',
        'tool-output',
        'chat-1',
        `${toolOutputReference.artifactId}.txt`,
      ),
    );
    expect(artifactRelativePath('chat-1', visualArtifact)).toBe(
      join(
        'transcripts',
        'visuals',
        'chat-1',
        `${visualReference.artifactId}.html`,
      ),
    );
  });

  it('verifies tool-output artifacts and reports tampering like verify', async (): Promise<void> => {
    await withArtifacts(async (root, artifacts): Promise<void> => {
      const reference = await artifacts.put('source', 'original artifact');
      const storedReference: PersistedArtifactReference = {
        family: 'tool-output',
        reference,
      };

      await artifacts.verify('source', reference);
      await artifacts.verifyArtifact('source', storedReference);

      // Replace the inode: an equal-size in-place write can keep the verified
      // dev/ino/size/mtime/ctime signature when timestamps share a tick.
      const artifactPath = join(
        root,
        'tool-output',
        'source',
        `${reference.artifactId}.txt`,
      );
      await writeFile(`${artifactPath}.tampered`, 'tampered artifact');
      await rename(`${artifactPath}.tampered`, artifactPath);
      await expect(artifacts.verify('source', reference)).rejects.toThrow(
        'Tool output artifact failed integrity validation',
      );
      await expect(
        artifacts.verifyArtifact('source', storedReference),
      ).rejects.toThrow('Tool output artifact failed integrity validation');
    });
  });

  it('copies tool-output artifacts to another chat exactly like copyToChat', async (): Promise<void> => {
    await withArtifacts(async (root, artifacts): Promise<void> => {
      const output = 'artifact payload';
      const reference = await artifacts.put('source', output);
      const storedReference: PersistedArtifactReference = {
        family: 'tool-output',
        reference,
      };

      await artifacts.copyToChat('source', 'direct-target', reference);
      await artifacts.copyArtifactToChat('source', 'target', storedReference);

      const directBytes = await readFile(
        join(
          root,
          'tool-output',
          'direct-target',
          `${reference.artifactId}.txt`,
        ),
      );
      const copiedBytes = await readFile(
        join(root, 'tool-output', 'target', `${reference.artifactId}.txt`),
      );
      expect(copiedBytes).toEqual(directBytes);
      expect(copiedBytes).toEqual(Buffer.from(output, 'utf8'));
    });
  });

  it('verifies and copies visual references using their stored family', async (): Promise<void> => {
    await withArtifacts(async (_root, artifacts): Promise<void> => {
      const artifact = await artifacts.putVisual('source', '<h1>Preview</h1>');
      const storedReference: PersistedArtifactReference = {
        family: 'visual',
        reference: {
          ...visualReference,
          artifactId: artifact.artifactId,
          byteLength: artifact.byteLength,
          sha256: artifact.sha256,
        },
      };

      await artifacts.verifyArtifact('source', storedReference);
      await artifacts.copyArtifactToChat('source', 'target', storedReference);
      await artifacts.verifyArtifact('target', storedReference);
    });
  });
});
