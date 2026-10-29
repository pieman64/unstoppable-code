/**
 * @jest-environment jsdom
 */
import {
  findComposerDensityPanel,
  resolveComposerDensity,
} from '../composer-density';

describe('resolveComposerDensity', () => {
  it('defaults to comfortable when height is unmeasured', () => {
    expect(resolveComposerDensity(null, 'minimal')).toBe('comfortable');
    expect(resolveComposerDensity(0, 'compact')).toBe('comfortable');
  });

  it('maps tall panels to comfortable regardless of current step', () => {
    expect(resolveComposerDensity(900, 'minimal')).toBe('comfortable');
    expect(resolveComposerDensity(460 + 24, 'cozy')).toBe('comfortable');
  });

  it('steps down through cozy, compact, and minimal as height shrinks', () => {
    expect(resolveComposerDensity(430, 'comfortable')).toBe('cozy');
    expect(resolveComposerDensity(320, 'comfortable')).toBe('compact');
    expect(resolveComposerDensity(220, 'comfortable')).toBe('minimal');
  });

  it('applies hysteresis when growing so a boundary does not flicker', () => {
    // Just above the 460 boundary but within the buffer — stay cozy.
    expect(resolveComposerDensity(470, 'cozy')).toBe('cozy');
    // Past the buffer — promote to comfortable.
    expect(resolveComposerDensity(485, 'cozy')).toBe('comfortable');
  });

  it('applies hysteresis when shrinking so a boundary does not flicker', () => {
    // Just below the 460 boundary but within the buffer — stay comfortable.
    expect(resolveComposerDensity(450, 'comfortable')).toBe('comfortable');
    // Past the buffer — demote to cozy.
    expect(resolveComposerDensity(435, 'comfortable')).toBe('cozy');
  });

  it('applies hysteresis at the 360 boundary when growing so it does not flicker', () => {
    // Just above the 360 boundary but within the buffer — stay compact.
    expect(resolveComposerDensity(370, 'compact')).toBe('compact');
    // Past the buffer — promote to cozy.
    expect(resolveComposerDensity(385, 'compact')).toBe('cozy');
  });

  it('does not regress when a growing panel crosses the next raw band', () => {
    expect(resolveComposerDensity(459, 'compact')).toBe('cozy');
    expect(resolveComposerDensity(460, 'compact')).toBe('comfortable');
  });

  it('applies hysteresis at the 360 boundary when shrinking so it does not flicker', () => {
    // Just below the 360 boundary but within the buffer — stay cozy.
    expect(resolveComposerDensity(350, 'cozy')).toBe('cozy');
    // Past the buffer — demote to compact.
    expect(resolveComposerDensity(335, 'cozy')).toBe('compact');
  });

  it('applies hysteresis at the 260 boundary when growing so it does not flicker', () => {
    // Just above the 260 boundary but within the buffer — stay minimal.
    expect(resolveComposerDensity(270, 'minimal')).toBe('minimal');
    // Past the buffer — promote to compact.
    expect(resolveComposerDensity(285, 'minimal')).toBe('compact');
  });

  it('applies hysteresis at the 260 boundary when shrinking so it does not flicker', () => {
    // Just below the 260 boundary but within the buffer — stay compact.
    expect(resolveComposerDensity(250, 'compact')).toBe('compact');
    // Past the buffer — demote to minimal.
    expect(resolveComposerDensity(235, 'compact')).toBe('minimal');
  });

  it('keeps the current step when height stays inside its band', () => {
    expect(resolveComposerDensity(250, 'minimal')).toBe('minimal');
    expect(resolveComposerDensity(300, 'minimal')).toBe('compact');
    expect(resolveComposerDensity(500, 'comfortable')).toBe('comfortable');
  });
});

describe('findComposerDensityPanel', () => {
  it('returns the direct parent when it generates a box', () => {
    const panel = document.createElement('div');
    const composer = document.createElement('div');
    panel.appendChild(composer);
    expect(findComposerDensityPanel(composer)).toBe(panel);
  });

  it('skips display: contents wrappers, which have no height to measure', () => {
    // jsdom loads no Tailwind, so define the `contents` utility here to cover
    // the class-driven wrapper ChatContent actually renders.
    const style = document.createElement('style');
    style.textContent = '.contents { display: contents; }';
    document.head.appendChild(style);
    const panel = document.createElement('div');
    const outer = document.createElement('div');
    outer.style.display = 'contents';
    const inner = document.createElement('div');
    inner.className = 'contents';
    const composer = document.createElement('div');
    panel.appendChild(outer);
    outer.appendChild(inner);
    inner.appendChild(composer);
    document.body.appendChild(panel);
    try {
      expect(getComputedStyle(inner).display).toBe('contents');
      expect(findComposerDensityPanel(composer)).toBe(panel);
    } finally {
      panel.remove();
      style.remove();
    }
  });

  it('returns null without a node', () => {
    expect(findComposerDensityPanel(null)).toBeNull();
    expect(findComposerDensityPanel(document.createElement('div'))).toBeNull();
  });

  it('returns null when every ancestor is a display: contents wrapper', () => {
    const outer = document.createElement('div');
    outer.style.display = 'contents';
    const inner = document.createElement('div');
    inner.style.display = 'contents';
    const composer = document.createElement('div');
    outer.appendChild(inner);
    inner.appendChild(composer);
    expect(findComposerDensityPanel(composer)).toBeNull();
  });
});
