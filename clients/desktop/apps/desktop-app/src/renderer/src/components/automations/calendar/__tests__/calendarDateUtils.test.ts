import { addMonths } from '../calendarDateUtils';

describe('calendarDateUtils', () => {
  describe('addMonths', () => {
    it('clamps forward month navigation from end-of-month anchors', () => {
      const result = addMonths(new Date(2026, 0, 31, 10, 15, 0), 1);

      expect(result.getFullYear()).toBe(2026);
      expect(result.getMonth()).toBe(1);
      expect(result.getDate()).toBe(28);
      expect(result.getHours()).toBe(10);
      expect(result.getMinutes()).toBe(15);
    });

    it('clamps backward month navigation from end-of-month anchors', () => {
      const result = addMonths(new Date(2026, 2, 31, 10, 15, 0), -1);

      expect(result.getFullYear()).toBe(2026);
      expect(result.getMonth()).toBe(1);
      expect(result.getDate()).toBe(28);
      expect(result.getHours()).toBe(10);
      expect(result.getMinutes()).toBe(15);
    });
  });
});
