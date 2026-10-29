import { TELEMETRY_TOOL_CATEGORIES } from '@canopy/protocol/telemetry';
import {
  getTelemetryToolCategoryLabel,
  TELEMETRY_TOOL_CATEGORY_LABELS,
} from '../telemetry-tool-category';

describe('telemetry tool category labels', () => {
  it('defines a display label for every wire category', () => {
    expect(Object.keys(TELEMETRY_TOOL_CATEGORY_LABELS).sort()).toEqual(
      [...TELEMETRY_TOOL_CATEGORIES].sort(),
    );
  });

  it('uses a brand-neutral label for first-party built-in tools', () => {
    expect(getTelemetryToolCategoryLabel('canopy')).toBe('Built-in');
    expect(getTelemetryToolCategoryLabel('CANOPY')).toBe('Built-in');
  });

  it('humanizes unknown categories from newer clients', () => {
    expect(getTelemetryToolCategoryLabel('future_tool')).toBe('Future tool');
    expect(getTelemetryToolCategoryLabel('FUTURE_TOOL')).toBe('Future Tool');
  });
});
