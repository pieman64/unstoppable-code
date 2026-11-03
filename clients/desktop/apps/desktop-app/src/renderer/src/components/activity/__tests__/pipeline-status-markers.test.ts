import { pipelineStatusBadge, pipelineStatusGlyphState } from '../utils';

describe('pipelineStatusBadge', () => {
  it('maps run states onto the shared status-badge tones', () => {
    expect(pipelineStatusBadge('running')).toEqual({
      tone: 'info',
      muted: false,
    });
    expect(pipelineStatusBadge('restarting')).toEqual({
      tone: 'info',
      muted: false,
    });
    expect(pipelineStatusBadge('success')).toEqual({
      tone: 'success',
      muted: false,
    });
    expect(pipelineStatusBadge('failure')).toEqual({
      tone: 'danger',
      muted: false,
    });
    expect(pipelineStatusBadge('paused')).toEqual({
      tone: 'neutral',
      muted: false,
    });
    expect(pipelineStatusBadge('cancelled')).toEqual({
      tone: 'neutral',
      muted: false,
    });
  });

  it('quiets work that has not started or never ran', () => {
    for (const status of ['pending', 'queued', 'skipped'] as const) {
      expect(pipelineStatusBadge(status)).toEqual({
        tone: 'neutral',
        muted: true,
      });
    }
  });
});

describe('pipelineStatusGlyphState', () => {
  it('maps every pipeline status onto one StatusGlyph state', () => {
    expect(pipelineStatusGlyphState('pending')).toBe('queued');
    expect(pipelineStatusGlyphState('running')).toBe('running');
    expect(pipelineStatusGlyphState('paused')).toBe('paused');
    expect(pipelineStatusGlyphState('success')).toBe('done');
    expect(pipelineStatusGlyphState('failure')).toBe('failed');
    expect(pipelineStatusGlyphState('cancelled')).toBe('cancelled');
    expect(pipelineStatusGlyphState('skipped')).toBe('cancelled');
  });
});
