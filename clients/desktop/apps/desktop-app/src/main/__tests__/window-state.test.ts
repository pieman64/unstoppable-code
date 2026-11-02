import type { WindowBounds } from '@canopy/desktop-shared/types';

// Mock electron's screen module
const mockGetAllDisplays = jest.fn();
jest.mock('electron', () => ({
  screen: {
    get getAllDisplays(): typeof mockGetAllDisplays {
      return mockGetAllDisplays;
    },
  },
}));

import { validateWindowBounds } from '../lib/window-state';

describe('validateWindowBounds', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns null when bounds are null', () => {
    expect(validateWindowBounds(null)).toBeNull();
  });

  it('returns bounds when position is within a display workArea', () => {
    const bounds: WindowBounds = { x: 100, y: 100, width: 1400, height: 900 };
    mockGetAllDisplays.mockReturnValue([
      { workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
    ]);

    expect(validateWindowBounds(bounds)).toEqual(bounds);
  });

  it('returns null when position is outside all displays', () => {
    const bounds: WindowBounds = {
      x: 5000,
      y: 5000,
      width: 1400,
      height: 900,
    };
    mockGetAllDisplays.mockReturnValue([
      { workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
    ]);

    expect(validateWindowBounds(bounds)).toBeNull();
  });

  it('clamps x/y for negative coordinates so window stays within display', () => {
    const bounds: WindowBounds = {
      x: -500,
      y: 100,
      width: 1400,
      height: 900,
    };
    mockGetAllDisplays.mockReturnValue([
      { workArea: { x: -1920, y: 0, width: 1920, height: 1080 } },
      { workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
    ]);

    expect(validateWindowBounds(bounds)).toEqual({
      x: -1400,
      y: 100,
      width: 1400,
      height: 900,
    });
  });

  it('clamps width to display workArea width', () => {
    const bounds: WindowBounds = { x: 100, y: 100, width: 3000, height: 900 };
    mockGetAllDisplays.mockReturnValue([
      { workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
    ]);

    const result = validateWindowBounds(bounds);
    expect(result).toEqual({ x: 0, y: 100, width: 1920, height: 900 });
  });

  it('clamps height to display workArea height', () => {
    const bounds: WindowBounds = {
      x: 100,
      y: 100,
      width: 1400,
      height: 2000,
    };
    mockGetAllDisplays.mockReturnValue([
      { workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
    ]);

    const result = validateWindowBounds(bounds);
    expect(result).toEqual({ x: 100, y: 0, width: 1400, height: 1080 });
  });

  it('returns null when no displays are available', () => {
    const bounds: WindowBounds = { x: 100, y: 100, width: 1400, height: 900 };
    mockGetAllDisplays.mockReturnValue([]);

    expect(validateWindowBounds(bounds)).toBeNull();
  });

  it('matches against second display when first does not contain position', () => {
    const bounds: WindowBounds = {
      x: 2000,
      y: 100,
      width: 1400,
      height: 900,
    };
    mockGetAllDisplays.mockReturnValue([
      { workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
      { workArea: { x: 1920, y: 0, width: 1920, height: 1080 } },
    ]);

    expect(validateWindowBounds(bounds)).toEqual(bounds);
  });

  it('does not clamp width below minWidth', () => {
    const bounds: WindowBounds = { x: 100, y: 100, width: 1400, height: 900 };
    mockGetAllDisplays.mockReturnValue([
      { workArea: { x: 0, y: 0, width: 600, height: 1080 } },
    ]);

    const result = validateWindowBounds(bounds);
    expect(result).toEqual({ x: 0, y: 100, width: 800, height: 900 });
  });

  it('does not clamp height below minHeight', () => {
    const bounds: WindowBounds = { x: 100, y: 100, width: 1400, height: 900 };
    mockGetAllDisplays.mockReturnValue([
      { workArea: { x: 0, y: 0, width: 1920, height: 400 } },
    ]);

    const result = validateWindowBounds(bounds);
    expect(result).toEqual({ x: 100, y: 0, width: 1400, height: 500 });
  });

  it('clamps x/y so window does not extend beyond display edge', () => {
    const bounds: WindowBounds = {
      x: 1800,
      y: 1000,
      width: 1400,
      height: 900,
    };
    mockGetAllDisplays.mockReturnValue([
      { workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
    ]);

    const result = validateWindowBounds(bounds);
    expect(result).toEqual({ x: 520, y: 180, width: 1400, height: 900 });
  });
});
