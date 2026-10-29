import type { DisplayMessage } from '../../types/message-display';
import {
  displayMessageHasVisual,
  visualOnlyDisplayMessage,
} from '../display-message-visual';

const visualRef = {
  version: 1,
  visualId: 'vis_00000000-0000-0000-0000-000000000001',
  artifactId: `sha256-v1-${'a'.repeat(64)}`,
  sha256: 'a'.repeat(64),
  byteLength: 1,
  mediaType: 'text/html',
  title: 'Chart',
  maxHeight: 400,
} as const;

describe('display message visuals', () => {
  it('finds a non-error visual result and caches the visual-only projection', () => {
    const message: DisplayMessage = {
      id: 'message-1',
      role: 'assistant',
      timestamp: 1,
      blocks: [
        { type: 'text', text: 'An answer' },
        {
          type: 'tool_use',
          toolUseId: 'tool-1',
          toolName: 'ShowVisual',
          input: '{}',
          result: { output: '', isError: false, visualRef },
        },
      ],
    };
    expect(displayMessageHasVisual(message)).toBe(true);
    const projection = visualOnlyDisplayMessage(message);
    expect(projection).toBe(visualOnlyDisplayMessage(message));
    expect(projection).not.toBe(message);
    expect(projection.blocks).toEqual([message.blocks[1]]);
    expect(projection.blocks[0]).toBe(message.blocks[1]);
  });

  it('rejects token text, missing references and errored results', () => {
    const message: DisplayMessage = {
      id: 'message-2',
      role: 'assistant',
      timestamp: 2,
      blocks: [
        { type: 'text', text: visualRef.visualId },
        {
          type: 'tool_use',
          toolUseId: 'tool-2',
          toolName: 'ShowVisual',
          input: '{}',
          result: { output: '', isError: true, visualRef },
        },
      ],
    };
    expect(displayMessageHasVisual(message)).toBe(false);
    expect(visualOnlyDisplayMessage(message).blocks).toEqual([]);
    expect(visualOnlyDisplayMessage(message)).toBe(
      visualOnlyDisplayMessage(message),
    );
  });
});
