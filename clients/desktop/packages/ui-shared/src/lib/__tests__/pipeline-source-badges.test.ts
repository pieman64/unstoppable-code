import {
  PIPELINE_SOURCE_BADGE_KEYS,
  pipelineSourceBadgeClassName,
} from '../pipeline-source-badges';

/**
 * Hue family of a badge's ink, after the token graph's aliases: `info` and
 * `purple` resolve to `special`, and the neutral chip has no hue at all.
 */
function inkHueFamily(tone: string): string {
  const ink = tone.split(' ').find((cls) => cls.startsWith('fg-'));
  if (ink === undefined) throw new Error(`no ink in ${tone}`);
  const role = ink.slice('fg-'.length);
  if (role === 'info' || role === 'purple') return 'special';
  if (role === 'positive') return 'success';
  if (role === 'attention') return 'warning';
  return role;
}

describe('pipelineSourceBadgeClassName', () => {
  it('gives every origin a distinct hue family after token aliasing', () => {
    const families = PIPELINE_SOURCE_BADGE_KEYS.map((key) =>
      inkHueFamily(pipelineSourceBadgeClassName(key)),
    );
    expect(new Set(families).size).toBe(families.length);
  });

  it('never uses the brand accent: it is green on Canopy and blue on Unstoppable', () => {
    for (const key of PIPELINE_SOURCE_BADGE_KEYS) {
      expect(pipelineSourceBadgeClassName(key)).not.toMatch(/\baccent\b/);
    }
  });

  it('uses semantic roles only: no raw palette, no inert border colours', () => {
    for (const key of PIPELINE_SOURCE_BADGE_KEYS) {
      const tone = pipelineSourceBadgeClassName(key);
      expect(tone).toMatch(/^bg-\S+ fg-\S+$/);
      expect(tone).not.toMatch(/-(amber|emerald|sky|slate|blue)-\d/);
      expect(tone).not.toMatch(/\bborder-/);
    }
  });
});
