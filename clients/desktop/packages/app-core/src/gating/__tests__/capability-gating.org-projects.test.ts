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

describe('orgProjects capability gating (CAN-2944)', () => {
  it('is default-deny: an unset or false capability fails the requirement', () => {
    expect(meetsCapabilityRequirement(BASE, { orgProjects: true })).toBe(false);
    expect(
      meetsCapabilityRequirement(
        { ...BASE, orgProjects: false },
        { orgProjects: true },
      ),
    ).toBe(false);
  });

  it('passes only when the host reports orgProjects: true', () => {
    expect(
      meetsCapabilityRequirement(
        { ...BASE, orgProjects: true },
        { orgProjects: true },
      ),
    ).toBe(true);
  });

  it('does not affect surfaces that do not demand it', () => {
    expect(meetsCapabilityRequirement(BASE, {})).toBe(true);
  });
});
