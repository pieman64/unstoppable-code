import {
  isOverlayLayerSlot,
  overlayLayerFrameName,
  parseOverlayLayerFrameName,
} from '../overlay-layer';

describe('overlay layer frame names', () => {
  it('round-trips a slot through its frame name', () => {
    expect(
      parseOverlayLayerFrameName(overlayLayerFrameName('notifications', 'n1')),
    ).toBe('notifications');
  });

  it.each([
    '',
    'notifications:n1',
    'canopy-panel-aux:notifications:n1',
    'canopy-overlay-layer:notifications',
    'canopy-overlay-layer:notifications:',
    'canopy-overlay-layer:unknown:n1',
    'canopy-overlay-layer:notifications:n1:extra',
  ])('rejects %j', (frameName) => {
    expect(parseOverlayLayerFrameName(frameName)).toBeNull();
  });

  it('accepts only known slots', () => {
    expect(isOverlayLayerSlot('notifications')).toBe(true);
    expect(isOverlayLayerSlot('modal')).toBe(false);
    expect(isOverlayLayerSlot(undefined)).toBe(false);
  });
});
