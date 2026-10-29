import { windowCornerRadiusPoints } from '../windowCornerRadius';

describe('windowCornerRadiusPoints', () => {
  it('uses the larger Tahoe-era radius on macOS 26 and later', () => {
    expect(
      windowCornerRadiusPoints({
        platform: 'macOS',
        platformVersion: '26.0.0',
      }),
    ).toBe(16);
    expect(
      windowCornerRadiusPoints({
        platform: 'macOS',
        platformVersion: '27.2.0',
      }),
    ).toBe(16);
  });

  it('uses 10pt on macOS 11 through 15', () => {
    expect(
      windowCornerRadiusPoints({
        platform: 'macOS',
        platformVersion: '15.6.1',
      }),
    ).toBe(10);
    expect(
      windowCornerRadiusPoints({
        platform: 'macOS',
        platformVersion: '11.0.0',
      }),
    ).toBe(10);
  });

  it('rounds Windows 11 windows and keeps Windows 10 square', () => {
    expect(
      windowCornerRadiusPoints({
        platform: 'Windows',
        platformVersion: '15.0.0',
      }),
    ).toBe(8);
    expect(
      windowCornerRadiusPoints({
        platform: 'Windows',
        platformVersion: '10.0.0',
      }),
    ).toBe(0);
  });

  it('is unknown elsewhere or without a version', () => {
    expect(
      windowCornerRadiusPoints({ platform: 'Linux', platformVersion: '6.8.0' }),
    ).toBeNull();
    expect(
      windowCornerRadiusPoints({ platform: 'macOS', platformVersion: '' }),
    ).toBeNull();
  });
});
