import type { PortalChatPart } from '@canopy/protocol/portal';
import { portalPartHasVisual } from '../portal-part-visual';

const visual = {
  version: 1,
  visualId: 'vis_00000000-0000-0000-0000-000000000001',
  artifactId: `sha256-v1-${'a'.repeat(64)}`,
  byteLength: 12,
  sha256: 'a'.repeat(64),
  mediaType: 'text/html',
  title: 'Chart',
  maxHeight: 320,
};

describe('portalPartHasVisual', () => {
  it('recognizes visual metadata on a result part', () => {
    const part: PortalChatPart = { kind: 'tool_result', data: { visual } };
    expect(portalPartHasVisual(part)).toBe(true);
  });

  it.each([
    { kind: 'text', data: { visual } },
    { kind: 'tool_result', data: null },
    { kind: 'tool_result', data: { visual: 'raw HTML' } },
    {
      kind: 'tool_result',
      data: { visual: { ...visual, visualId: 'invalid' } },
    },
    { kind: 'tool_result', data: { visual: { ...visual, sha256: 'invalid' } } },
    {
      kind: 'tool_result',
      data: { visual: { visualId: visual.visualId, sha256: visual.sha256 } },
    },
  ] satisfies PortalChatPart[])(
    'rejects malformed or non-result data %#',
    (part) => {
      expect(portalPartHasVisual(part)).toBe(false);
    },
  );
});
