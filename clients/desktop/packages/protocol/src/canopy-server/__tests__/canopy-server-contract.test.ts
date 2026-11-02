import type { OrgProjectCapabilities } from '../../org-projects';
import {
  CANOPY_SERVER_CAPABILITIES,
  ORG_ENFORCED_POLICY_KINDS,
  REQUIRED_CANOPY_SERVER_CAPABILITIES,
  type CanopyAccountResponse,
} from '../index';

describe('canopy server protocol contract', () => {
  it.each(['mcp-proxy-v1', 'mcp-connections-v1', 'ledger-global-v1'])(
    'declares %s as optional',
    (capability) => {
      expect(CANOPY_SERVER_CAPABILITIES).toContain(capability);
      expect(REQUIRED_CANOPY_SERVER_CAPABILITIES).not.toContain(capability);
    },
  );

  it('pins required server capabilities separately from optional capabilities', () => {
    expect(REQUIRED_CANOPY_SERVER_CAPABILITIES).toEqual([
      'account-v1',
      'pipelines-crud-v1',
      'organizations-v1',
      'teams-v1',
    ]);
    expect(CANOPY_SERVER_CAPABILITIES).toContain('portal-v1');
    expect(CANOPY_SERVER_CAPABILITIES).toContain('model-routing-v1');
    expect(REQUIRED_CANOPY_SERVER_CAPABILITIES).not.toContain(
      'model-routing-v1',
    );
  });

  it('advertises shared skill, plugin, and Collection capabilities as optional', () => {
    expect(CANOPY_SERVER_CAPABILITIES).toContain('skills-crud-v1');
    expect(CANOPY_SERVER_CAPABILITIES).toContain('plugins-crud-v1');
    expect(CANOPY_SERVER_CAPABILITIES).toContain('collections-crud-v1');
    // These are explicitly NOT required so older Canopy Servers that haven't
    // shipped the share APIs keep validating successfully.
    expect(REQUIRED_CANOPY_SERVER_CAPABILITIES).not.toContain('skills-crud-v1');
    expect(REQUIRED_CANOPY_SERVER_CAPABILITIES).not.toContain(
      'plugins-crud-v1',
    );
    expect(REQUIRED_CANOPY_SERVER_CAPABILITIES).not.toContain(
      'collections-crud-v1',
    );
  });

  it('advertises plans-crud-v1 as optional (not required)', () => {
    expect(CANOPY_SERVER_CAPABILITIES).toContain('plans-crud-v1');
    // Advertised-but-not-required so older Canopy Servers without the
    // shared-plan CRUD API keep validating successfully.
    expect(REQUIRED_CANOPY_SERVER_CAPABILITIES).not.toContain('plans-crud-v1');
  });

  it('advertises runs-crud-v1 as optional (not required)', () => {
    expect(CANOPY_SERVER_CAPABILITIES).toContain('runs-crud-v1');
    // Advertised-but-not-required so older Canopy Servers without the
    // shared-run CRUD API keep validating successfully.
    expect(REQUIRED_CANOPY_SERVER_CAPABILITIES).not.toContain('runs-crud-v1');
  });

  it('advertises run-comments-v1 as optional and distinct from runs-crud-v1', () => {
    expect(CANOPY_SERVER_CAPABILITIES).toContain('run-comments-v1');
    // Deliberately its own capability: reusing `runs-crud-v1` would wrongly
    // imply comment support on every already-deployed Canopy Cloud, so a
    // desktop build pointed at an older server must degrade to "no comments"
    // rather than error.
    expect(REQUIRED_CANOPY_SERVER_CAPABILITIES).not.toContain(
      'run-comments-v1',
    );
  });

  it('advertises shared-container-dismissals-v1 as optional and distinct from shared-containers-v1', () => {
    expect(CANOPY_SERVER_CAPABILITIES).toContain(
      'shared-container-dismissals-v1',
    );
    // Its own capability: a server that already advertises
    // `shared-containers-v1` still hard-deletes on dismiss, so the desktop
    // must not promise a restore against it.
    expect(
      CANOPY_SERVER_CAPABILITIES.filter((capability) =>
        capability.startsWith('shared-container'),
      ),
    ).toEqual(['shared-containers-v1', 'shared-container-dismissals-v1']);
    expect(REQUIRED_CANOPY_SERVER_CAPABILITIES).not.toContain(
      'shared-container-dismissals-v1',
    );
  });

  it('advertises private session exports as optional', () => {
    expect(CANOPY_SERVER_CAPABILITIES).toContain('session-exports-v1');
    expect(REQUIRED_CANOPY_SERVER_CAPABILITIES).not.toContain(
      'session-exports-v1',
    );
  });

  it('advertises shared-containers-v1 as optional', () => {
    expect(CANOPY_SERVER_CAPABILITIES).toContain('shared-containers-v1');
    expect(REQUIRED_CANOPY_SERVER_CAPABILITIES).not.toContain(
      'shared-containers-v1',
    );
  });

  it('keeps org project Cloud management independent of administration and use', (): void => {
    const capabilities: OrgProjectCapabilities = {
      administer: true,
      use: true,
      manageCloud: false,
    };
    expect(JSON.parse(JSON.stringify(capabilities))).toEqual({
      administer: true,
      use: true,
      manageCloud: false,
    });
  });

  it('advertises org-projects-v1 as optional (not required)', () => {
    // Organization projects (CAN-611) are flag-gated per user, so the
    // capability is minted conditionally and an older server simply omits it.
    expect(CANOPY_SERVER_CAPABILITIES).toContain('org-projects-v1');
    expect(REQUIRED_CANOPY_SERVER_CAPABILITIES).not.toContain(
      'org-projects-v1',
    );
    expect(CANOPY_SERVER_CAPABILITIES).toContain('org-member-code-projects-v1');
    expect(REQUIRED_CANOPY_SERVER_CAPABILITIES).not.toContain(
      'org-member-code-projects-v1',
    );
    expect(CANOPY_SERVER_CAPABILITIES).toContain('org-project-reclaim-v1');
    expect(REQUIRED_CANOPY_SERVER_CAPABILITIES).not.toContain(
      'org-project-reclaim-v1',
    );
  });

  it('keeps account response shape environment-neutral', () => {
    const response: CanopyAccountResponse = {
      account: {
        id: 'user-1',
        name: 'User',
        email: 'user@example.com',
        role: 'ADMIN',
      },
      capabilities: REQUIRED_CANOPY_SERVER_CAPABILITIES,
      organizations: [],
      teams: [],
    };

    expect(response.account.role).toBe('ADMIN');
  });

  it('carries every eligible memory org beside the deprecated single org', () => {
    // CAN-3457: clients search only the org that owns the work, so the
    // response must list every eligible org. The single-org field stays for
    // older desktops and always mirrors the list's first entry.
    const response: CanopyAccountResponse = {
      account: {
        id: 'user-1',
        name: 'User',
        email: 'user@example.com',
        role: 'ADMIN',
      },
      capabilities: REQUIRED_CANOPY_SERVER_CAPABILITIES,
      organizations: [],
      teams: [],
      memorySearchOrganizationExternalId: 'org-a',
      memorySearchOrganizationExternalIds: ['org-a', 'org-b'],
    };

    const roundTripped: unknown = JSON.parse(JSON.stringify(response));
    expect(roundTripped).toMatchObject({
      memorySearchOrganizationExternalId: 'org-a',
      memorySearchOrganizationExternalIds: ['org-a', 'org-b'],
    });
    expect(response.memorySearchOrganizationExternalId).toBe(
      response.memorySearchOrganizationExternalIds?.[0],
    );
  });

  it('includes model policy in the enforced-policy contract', () => {
    // Closed set, asserted in full: every kind here needs a desktop parse
    // branch, a `cloneEnforcedSettings` case, a server projection, and an
    // applier, so a silently-added member is the failure mode this guards.
    expect(ORG_ENFORCED_POLICY_KINDS).toEqual([
      'telemetry-sync',
      'model-policy',
      'model-gateway',
    ]);

    const response: CanopyAccountResponse = {
      account: {
        id: 'user-1',
        name: 'User',
        email: 'user@example.com',
        role: 'ADMIN',
      },
      capabilities: [],
      organizations: [],
      teams: [],
      enforcedSettings: [
        {
          organizationId: 'org-1',
          organizationName: 'Acme',
          policies: [
            {
              kind: 'model-policy',
              blockedModelIds: ['anthropic/claude-opus-5'],
              reviewedModelIds: ['anthropic/claude-opus-5'],
            },
          ],
        },
      ],
    };

    expect(response.enforcedSettings?.[0]?.policies[0]?.kind).toBe(
      'model-policy',
    );
  });
});
