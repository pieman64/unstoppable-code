import type {
  CanopyCloudAccountPublicState,
  WorkspaceContext,
} from '@canopy/desktop-shared/types';
import { resolveTelemetryLocks } from '../telemetryLocks';

const ACME = 'acacacac-1111-4111-8111-acacacacacac';
const GLOBEX = '22222222-2222-4222-8222-222222222222';
const PERSONAL: WorkspaceContext = { kind: 'personal' };

function org(organizationId: string): WorkspaceContext {
  return { kind: 'organization', organizationId };
}

/**
 * Pure resolution coverage for the lock map + tooltip attribution. The
 * component-level wiring (which surfaces hand these locks to
 * `TelemetrySharingControls`) is pinned by
 * `CanopyCloudAccountSection.telemetryLocks.test.tsx`; what needs pinning here
 * is that locks follow the SELECTED context only (CAN-3459): one org's policy
 * never locks another org's rows, and Personal is never locked.
 */
function account(
  ...orgs: {
    organizationId: string;
    organizationName: string;
    requires?: readonly ('transcripts' | 'plans' | 'metadata' | 'summaries')[];
    prohibits?: readonly ('transcripts' | 'plans' | 'metadata' | 'summaries')[];
  }[]
): CanopyCloudAccountPublicState {
  return {
    hasApiKey: true,
    credentialSource: 'manual',
    capabilities: [],
    storageAvailable: true,
    enforcedSettings: orgs.map((org) => ({
      organizationId: org.organizationId,
      organizationName: org.organizationName,
      policies: [
        {
          kind: 'telemetry-sync',
          scopes: {
            transcripts: org.requires?.includes('transcripts') ?? false,
            plans: org.requires?.includes('plans') ?? false,
            metadata: org.requires?.includes('metadata') ?? false,
            summaries: org.requires?.includes('summaries') ?? false,
          },
          prohibitedScopes: {
            transcripts: org.prohibits?.includes('transcripts') ?? false,
            plans: org.prohibits?.includes('plans') ?? false,
            metadata: org.prohibits?.includes('metadata') ?? false,
            summaries: org.prohibits?.includes('summaries') ?? false,
          },
        },
      ],
    })),
  };
}

describe('resolveTelemetryLocks', () => {
  const NO_LOCK_MAP = {
    transcripts: null,
    plans: null,
    metadata: null,
    summaries: null,
  };

  it('locks nothing for an unlinked account', () => {
    const locks = resolveTelemetryLocks(null, org(ACME));
    expect(locks.locked).toEqual(NO_LOCK_MAP);
    expect(locks.lockTooltip).toBeUndefined();
    expect(locks.blockedTooltip).toBeUndefined();
  });

  it('locks nothing in Personal, whatever any org enforces', () => {
    const locks = resolveTelemetryLocks(
      account(
        {
          organizationId: ACME,
          organizationName: 'Acme',
          requires: ['metadata'],
        },
        {
          organizationId: GLOBEX,
          organizationName: 'Globex',
          prohibits: ['transcripts'],
        },
      ),
      PERSONAL,
    );
    expect(locks.locked).toEqual(NO_LOCK_MAP);
    expect(locks.lockTooltip).toBeUndefined();
    expect(locks.blockedTooltip).toBeUndefined();
  });

  it('names the selected requiring org and pins the scope up to organization', () => {
    const locks = resolveTelemetryLocks(
      account({
        organizationId: ACME,
        organizationName: 'Acme',
        requires: ['metadata'],
      }),
      org(ACME),
    );
    expect(locks.locked.metadata).toBe('organization');
    expect(locks.lockTooltip).toBe(
      'Managed by Acme. Contact an admin to change.',
    );
    expect(locks.blockedTooltip).toBeUndefined();
  });

  it('names the selected prohibiting org and pins the scope down to off', () => {
    const locks = resolveTelemetryLocks(
      account({
        organizationId: ACME,
        organizationName: 'Acme',
        prohibits: ['transcripts'],
      }),
      org(ACME),
    );
    expect(locks.locked.transcripts).toBe('off');
    expect(locks.blockedTooltip).toBe(
      'Blocked by Acme. Its work stays on your machine.',
    );
    expect(locks.lockTooltip).toBeUndefined();
  });

  // The regression CAN-3459 exists for: another org's prohibition no longer
  // overrides the selected org's requirement, and is not named.
  it("ignores another org's policy entirely", () => {
    const both = account(
      {
        organizationId: ACME,
        organizationName: 'Acme',
        requires: ['transcripts'],
      },
      {
        organizationId: GLOBEX,
        organizationName: 'Globex',
        prohibits: ['transcripts', 'plans'],
      },
    );

    const acme = resolveTelemetryLocks(both, org(ACME));
    expect(acme.locked).toEqual({
      ...NO_LOCK_MAP,
      transcripts: 'organization',
    });
    expect(acme.lockTooltip).toContain('Acme');
    expect(acme.blockedTooltip).toBeUndefined();

    const globex = resolveTelemetryLocks(both, org(GLOBEX));
    expect(globex.locked).toEqual({
      ...NO_LOCK_MAP,
      transcripts: 'off',
      plans: 'off',
    });
    expect(globex.blockedTooltip).toContain('Globex');
    expect(globex.blockedTooltip).not.toContain('Acme');
    expect(globex.lockTooltip).toBeUndefined();
  });

  it('lets a prohibition beat a requirement within the selected org', () => {
    const locks = resolveTelemetryLocks(
      account({
        organizationId: ACME,
        organizationName: 'Acme',
        requires: ['transcripts', 'metadata'],
        prohibits: ['transcripts'],
      }),
      org(ACME),
    );
    expect(locks.locked.transcripts).toBe('off');
    expect(locks.locked.metadata).toBe('organization');
    expect(locks.lockTooltip).toContain('Acme');
    expect(locks.blockedTooltip).toContain('Acme');
  });

  it('matches an upper-case enforced-settings id to the lower-case context', () => {
    const locks = resolveTelemetryLocks(
      account({
        organizationId: ACME.toUpperCase(),
        organizationName: 'Acme',
        requires: ['plans'],
      }),
      org(ACME),
    );
    expect(locks.locked.plans).toBe('organization');
  });

  it('locks nothing for a selected org with no policy', () => {
    const locks = resolveTelemetryLocks(
      account({
        organizationId: ACME,
        organizationName: 'Acme',
        requires: ['plans'],
      }),
      org(GLOBEX),
    );
    expect(locks.locked).toEqual(NO_LOCK_MAP);
  });
});
