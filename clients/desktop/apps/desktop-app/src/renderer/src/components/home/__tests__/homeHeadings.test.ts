import { HOME_HEADINGS, pickHomeHeading } from '../homeHeadings';

describe('homeHeadings', () => {
  it('has exactly 6 entries', () => {
    expect(HOME_HEADINGS).toHaveLength(6);
  });

  it('has all unique entries', () => {
    expect(new Set(HOME_HEADINGS).size).toBe(HOME_HEADINGS.length);
  });

  it('has all non-empty entries', () => {
    for (const heading of HOME_HEADINGS) {
      expect(heading.trim().length).toBeGreaterThan(0);
    }
  });

  it('has "Say what you\'d like to get done" first', () => {
    expect(HOME_HEADINGS[0]).toBe("Say what you'd like to get done");
  });

  it('has no developer-frame words (CAN-2697)', () => {
    for (const heading of HOME_HEADINGS) {
      expect(heading).not.toMatch(
        /\b(build|building|ship|shipping|refactor|debug|bug|feature|prototype|hack|launch|deploy|code|repo|milestone|docket)\b/i,
      );
    }
  });

  it('has no headings ending with a period, exclamation mark, or question mark', () => {
    for (const heading of HOME_HEADINGS) {
      expect(heading).not.toMatch(/[.!?]$/);
    }
  });

  it('has no task or chat words', () => {
    for (const heading of HOME_HEADINGS) {
      expect(heading).not.toMatch(/\b(task|chat)\b/i);
    }
  });

  describe('pickHomeHeading', () => {
    let randomSpy: jest.SpiedFunction<typeof Math.random>;

    afterEach(() => {
      globalThis.__CANOPY_E2E_HOME_HEADING_INDEX__ = undefined;
      randomSpy.mockRestore();
    });

    it.each([0, 0.9999999999])(
      'uses E2E index 2 regardless of Math.random returning %s',
      (random) => {
        randomSpy = jest.spyOn(Math, 'random').mockReturnValue(random);
        globalThis.__CANOPY_E2E_HOME_HEADING_INDEX__ = 2;
        expect(pickHomeHeading()).toBe(HOME_HEADINGS[2]);
        expect(randomSpy).not.toHaveBeenCalled();
      },
    );

    it.each([undefined, 99, -1, 1.5, NaN, Infinity, -Infinity])(
      'falls back to Math.random for E2E index %s',
      (index) => {
        randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.9999999999);
        globalThis.__CANOPY_E2E_HOME_HEADING_INDEX__ = index;
        expect(pickHomeHeading()).toBe(HOME_HEADINGS[HOME_HEADINGS.length - 1]);
        expect(randomSpy).toHaveBeenCalledTimes(1);
      },
    );

    it('returns a member of HOME_HEADINGS', () => {
      randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.42);
      expect(HOME_HEADINGS).toContain(pickHomeHeading());
    });

    it('picks the first entry when Math.random returns 0', () => {
      randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0);
      expect(pickHomeHeading()).toBe(HOME_HEADINGS[0]);
    });

    it('picks the last entry when Math.random returns just under 1', () => {
      randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.9999999999);
      expect(pickHomeHeading()).toBe(HOME_HEADINGS[HOME_HEADINGS.length - 1]);
    });
  });
});
