import type { CanopyCapabilities } from '../../client/capabilities';
import { meetsCapabilityRequirement } from '../capability-gating';

const BASE: CanopyCapabilities = {
  localExecution: true,
  terminalPty: true,
  fileSystemAccess: 'read-write',
  voice: false,
  settingsScope: 'full',
  pipelines: 'execute',
  routing: 'in-memory',
  overviewNotifications: true,
};

it('denies grouping when an older host omits support', () => {
  const requirement = { localExecution: true, itemGrouping: true } as const;
  expect(meetsCapabilityRequirement(BASE, requirement)).toBe(false);
});

it('requires explicit true and preserves other capability requirements', () => {
  expect(
    meetsCapabilityRequirement(
      { ...BASE, itemGrouping: false },
      { itemGrouping: true },
    ),
  ).toBe(false);
  expect(
    meetsCapabilityRequirement(
      { ...BASE, itemGrouping: true },
      { itemGrouping: true },
    ),
  ).toBe(true);
  expect(
    meetsCapabilityRequirement(
      { ...BASE, itemGrouping: true, localExecution: false },
      { itemGrouping: true, localExecution: true },
    ),
  ).toBe(false);
  expect(meetsCapabilityRequirement(BASE, {})).toBe(true);
});
