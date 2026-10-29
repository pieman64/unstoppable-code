import {
  DEFAULT_COWORK_WORKSPACE_ID,
  defaultCoworkWorkspaceIdForContext,
  isDefaultCoworkWorkspaceId,
  isOrgDefaultCoworkWorkspaceId,
  orgDefaultCoworkWorkspaceId,
} from '../ui-labels';

const ORG_ID = '0f2c5a4e-9b1d-4c3e-8a7f-1234567890ab';

describe('default Cowork workspace ids', () => {
  it('derives a lower-case, validateId-safe id per organization', () => {
    const id = orgDefaultCoworkWorkspaceId(ORG_ID.toUpperCase());
    expect(id).toBe(`cowork-org-${ORG_ID}`);
    expect(id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });

  it('recognizes Personal and well-formed organization defaults only', () => {
    expect(isDefaultCoworkWorkspaceId(DEFAULT_COWORK_WORKSPACE_ID)).toBe(true);
    expect(isDefaultCoworkWorkspaceId(`cowork-org-${ORG_ID}`)).toBe(true);
    expect(isOrgDefaultCoworkWorkspaceId(DEFAULT_COWORK_WORKSPACE_ID)).toBe(
      false,
    );
    expect(isDefaultCoworkWorkspaceId('cowork-org-acme')).toBe(false);
    expect(isDefaultCoworkWorkspaceId('cowork-abc')).toBe(false);
    expect(isDefaultCoworkWorkspaceId(`cowork-org-${ORG_ID}-x`)).toBe(false);
  });

  it('resolves the default for a context', () => {
    expect(defaultCoworkWorkspaceIdForContext(undefined)).toBe(
      DEFAULT_COWORK_WORKSPACE_ID,
    );
    expect(defaultCoworkWorkspaceIdForContext({ kind: 'personal' })).toBe(
      DEFAULT_COWORK_WORKSPACE_ID,
    );
    expect(
      defaultCoworkWorkspaceIdForContext({
        kind: 'organization',
        organizationId: ORG_ID,
      }),
    ).toBe(`cowork-org-${ORG_ID}`);
  });
});
