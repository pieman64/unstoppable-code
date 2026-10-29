import { shouldShowProjectsPin } from '../sidebar/projects-pin';

describe('shouldShowProjectsPin', () => {
  const band = { controlsTop: 600, controlsHeight: 40, hostBottom: 500 };

  it('shows the stand-in while the band sits below the viewport', () => {
    expect(shouldShowProjectsPin({ ...band, scrollDelta: 0 })).toBe(true);
  });

  it('hides it while the band is on screen', () => {
    expect(
      shouldShowProjectsPin({ ...band, controlsTop: 300, scrollDelta: 0 }),
    ).toBe(false);
  });

  it('never pins a band that is not laid out', () => {
    // A zero-height band means Projects is collapsed or unmounted, not that it
    // scrolled away — revealing a stand-in for it would be a lie.
    expect(
      shouldShowProjectsPin({ ...band, controlsHeight: 0, scrollDelta: 0 }),
    ).toBe(false);
  });

  it('hides it when the pending scroll is about to bring the band in', () => {
    // The rects say the band is 100px below the fold, but the caller is
    // committing a 160px downward scroll in this same frame. Judging on the
    // measured rect alone would leave the stand-in up over a visible band
    // until some later scroll happened to re-sync.
    expect(shouldShowProjectsPin({ ...band, scrollDelta: 160 })).toBe(false);
  });

  it('shows it when the pending scroll is about to push the band out', () => {
    // The inverse, and the one that matters: scrolling up past the band with
    // the stand-in still hidden leaves Projects unreachable, which is the
    // exact bug the stand-in exists to fix.
    expect(
      shouldShowProjectsPin({
        ...band,
        controlsTop: 460,
        scrollDelta: -120,
      }),
    ).toBe(true);
  });

  it('treats the viewport edge as showing, within a pixel', () => {
    expect(
      shouldShowProjectsPin({ ...band, controlsTop: 499, scrollDelta: 0 }),
    ).toBe(true);
  });
});
