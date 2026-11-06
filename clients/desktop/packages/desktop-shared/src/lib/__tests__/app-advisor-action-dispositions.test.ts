import { CanopyGrantNameSchema } from '@canopy/protocol/canopy-core';
import {
  APP_ADVISOR_ACTION_DISPOSITIONS,
  APP_ADVISOR_ACTION_GRANTS,
  APP_ADVISOR_DISPATCH_ACTION_TYPES,
  APP_ADVISOR_PRESENTATION_ACTION_TYPES,
  type AppAdvisorActionDisposition,
} from '../app-advisor-action-dispositions';

const entries = Object.entries(APP_ADVISOR_ACTION_DISPOSITIONS);

function count(
  predicate: (disposition: AppAdvisorActionDisposition) => boolean,
): number {
  return entries.filter(([, disposition]) => predicate(disposition)).length;
}

function writeGrants(
  disposition: AppAdvisorActionDisposition,
): readonly string[] {
  if (disposition.kind === 'core' && disposition.access === 'write')
    return disposition.grants;
  if (disposition.kind === 'legacy' && disposition.access === 'write')
    return disposition.grants;
  return [];
}

describe('App Advisor action dispositions (CAN-4133)', () => {
  it('every App Advisor action type has exactly one disposition', () => {
    expect(Object.keys(APP_ADVISOR_ACTION_DISPOSITIONS).sort()).toEqual(
      APP_ADVISOR_DISPATCH_ACTION_TYPES,
    );
  });

  it('the totals match the specification', () => {
    expect({
      coreWrites: count((d) => d.kind === 'core' && d.access === 'write'),
      coreReads: count((d) => d.kind === 'core' && d.access === 'read'),
      hostPresentation: count((d) => d.kind === 'host_presentation'),
      presentation: count((d) => d.kind === 'presentation'),
      legacyWrites: count((d) => d.kind === 'legacy' && d.access === 'write'),
      legacyReads: count((d) => d.kind === 'legacy' && d.access === 'read'),
    }).toEqual({
      coreWrites: 78,
      coreReads: 51,
      hostPresentation: 3,
      presentation: 81,
      legacyWrites: 146,
      legacyReads: 73,
    });
  });

  it("the grant set is exactly the union of the writes' grants", () => {
    const union = [
      ...new Set(
        entries.flatMap(([, disposition]) => writeGrants(disposition)),
      ),
    ].sort();
    expect(union).toEqual([...APP_ADVISOR_ACTION_GRANTS]);
    for (const grant of APP_ADVISOR_ACTION_GRANTS)
      expect(CanopyGrantNameSchema.safeParse(grant).success).toBe(true);
  });

  it('no write names an approval, vault, client or workspace-record grant', () => {
    const forbidden = [
      'core.approval.',
      'core.vault.',
      'core.client.',
      'core.workspaceRecords.',
    ];
    const grants = entries.flatMap(([, disposition]) =>
      writeGrants(disposition),
    );
    expect(
      grants.filter((grant) =>
        forbidden.some((prefix) => grant.startsWith(prefix)),
      ),
    ).toEqual([]);
  });

  it('the presentation set equals the presentation dispositions', () => {
    expect([...APP_ADVISOR_PRESENTATION_ACTION_TYPES].sort()).toEqual(
      entries
        .filter(([, disposition]) => disposition.kind === 'presentation')
        .map(([type]) => type)
        .sort(),
    );
  });

  it('only the two composite types are composite, and only open_tab is presentation with a chatId', () => {
    const composite = entries
      .filter(
        ([, d]) => d.kind === 'core' && d.access === 'write' && d.composite,
      )
      .map(([type]) => type)
      .sort();
    const presentationWhenChatId = entries
      .filter(
        ([, d]) =>
          d.kind === 'core' && d.access === 'write' && d.presentationWhenChatId,
      )
      .map(([type]) => type);
    expect(composite).toEqual([
      'standalone-chat.create_chat',
      'worktree-chat.open_tab',
    ]);
    expect(presentationWhenChatId).toEqual(['worktree-chat.open_tab']);
  });
});
