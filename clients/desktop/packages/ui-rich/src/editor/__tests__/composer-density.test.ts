import {
  COMPOSER_DENSITY_CLASS_NAMES,
  type ComposerDensity,
} from '../composer-density';

describe('COMPOSER_DENSITY_CLASS_NAMES', () => {
  it('comfortable step uses the roomy default spacing', () => {
    expect(COMPOSER_DENSITY_CLASS_NAMES.comfortable.container).toBe(
      'min-h-26 max-h-50 cursor-text overflow-y-auto px-4 pt-3.5 pb-2',
    );
    expect(COMPOSER_DENSITY_CLASS_NAMES.comfortable.editable).toBe(
      'min-h-20 whitespace-pre-wrap break-words bg-transparent text-s leading-5 fg-primary outline-none',
    );
  });

  it('shrinks the editable min-height monotonically across steps', () => {
    const order: ComposerDensity[] = [
      'comfortable',
      'cozy',
      'compact',
      'minimal',
    ];
    // Spacing-scale steps are 4px each, so `min-h-5` is the 20px floor.
    const mins = order.map((density) => {
      const match = /\bmin-h-(\d+(?:\.\d+)?)\b/.exec(
        COMPOSER_DENSITY_CLASS_NAMES[density].editable,
      );
      return Number(match?.[1]) * 4;
    });
    for (let i = 1; i < mins.length; i += 1) {
      expect(mins[i]).toBeLessThan(mins[i - 1]);
    }
    expect(mins[mins.length - 1]).toBe(20);
  });

  it('keeps the comfortable top inset at every density', () => {
    for (const { container } of Object.values(COMPOSER_DENSITY_CLASS_NAMES)) {
      expect(container).toContain('pt-3.5');
    }
  });

  it('reserves twice the top inset between minimal text and controls', () => {
    expect(COMPOSER_DENSITY_CLASS_NAMES.minimal.container).toContain('pb-5');
  });

  it('every container is a scroll container with a max-height', () => {
    for (const { container } of Object.values(COMPOSER_DENSITY_CLASS_NAMES)) {
      expect(container).toContain('overflow-y-auto');
      expect(container).toMatch(/\bmax-h-\d+(?:\.\d+)?\b/);
    }
  });
});
