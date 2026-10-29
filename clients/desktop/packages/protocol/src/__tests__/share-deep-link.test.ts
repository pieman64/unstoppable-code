import {
  DATA_SHARING_OPT_IN_FEATURES,
  isDataSharingOptInFeature,
  isViewerDataSharingStatus,
  isMemoryParticipationMember,
} from '../canopy-server';
import { buildDesktopPrivacyOptInDeepLink } from '../share-deep-link';
import {
  DESKTOP_SHARE_DEEP_LINK_MAX_LENGTH,
  buildDesktopPrivacySettingsDeepLink,
  buildDesktopRemoteControlDeepLink,
  buildDesktopShareDeepLink,
  parseDesktopRemoteControlDeepLink,
  parseDesktopSettingsDeepLink,
  parseDesktopShareDeepLink,
  publicShareSnapshotApiPath,
} from '../share-deep-link';

const UUID = '2f0c9a1e-4b3d-4f6a-8c2e-1d5b7a9e0c4f';
const SCHEME = 'unstoppable-code';
const CONTENT_HASH = 'a'.repeat(64);
const PACKAGE_DIGEST = `pp:v1:${'A'.repeat(43)}`;
const SHARED_CONTAINER_TOKEN = 'A'.repeat(43);

describe('desktop Remote Control deep links', () => {
  it('builds and parses the exact destination', () => {
    const url = buildDesktopRemoteControlDeepLink(SCHEME);
    expect(url).toBe('unstoppable-code://remote-control');
    expect(parseDesktopRemoteControlDeepLink(url, SCHEME)).toEqual({
      destination: 'remote-control',
    });
  });

  it.each([
    'unstoppable-code://remote-control/extra',
    'unstoppable-code://remote-control?code=secret',
    'unstoppable-code://REMOTE-CONTROL',
    'canopy://remote-control',
  ])('rejects non-canonical destination URL %s', (url) => {
    expect(parseDesktopRemoteControlDeepLink(url, SCHEME)).toBeNull();
  });
});

describe('desktop Settings deep links', () => {
  it('builds and parses the exact Privacy destination', () => {
    const url = buildDesktopPrivacySettingsDeepLink(SCHEME);
    expect(url).toBe('unstoppable-code://settings/privacy');
    expect(parseDesktopSettingsDeepLink(url, SCHEME)).toEqual({
      destination: 'settings',
      section: 'privacy',
    });
  });

  it.each([
    'unstoppable-code://settings',
    'unstoppable-code://settings/accounts',
    'unstoppable-code://settings/privacy/extra',
    'unstoppable-code://settings/privacy?toggle=on',
    'unstoppable-code://SETTINGS/privacy',
    'canopy://settings/privacy',
  ])('rejects non-canonical destination URL %s', (url) => {
    expect(parseDesktopSettingsDeepLink(url, SCHEME)).toBeNull();
  });
});

describe('buildDesktopShareDeepLink', () => {
  it('builds a shared-container capability link without treating its token as a UUID', () => {
    expect(
      buildDesktopShareDeepLink({
        scheme: SCHEME,
        entity: 'shared-container',
        externalId: SHARED_CONTAINER_TOKEN,
      }),
    ).toBe(`${SCHEME}://share/shared-container/${SHARED_CONTAINER_TOKEN}`);
  });
  it('builds the anonymous automation snapshot API path', (): void => {
    expect(publicShareSnapshotApiPath('desktop-app', 'automation', UUID)).toBe(
      `/api/v1/desktop-app/public-shares/automations/${UUID}`,
    );
  });

  it('builds the anonymous Agent snapshot API path', () => {
    expect(publicShareSnapshotApiPath('desktop-app', 'agent', UUID)).toBe(
      `/api/v1/desktop-app/public-shares/agents/${UUID}`,
    );
  });
  it('builds the anonymous workspace-template snapshot API path', () => {
    expect(publicShareSnapshotApiPath('desktop-app', 'workspace', UUID)).toBe(
      `/api/v1/desktop-app/public-shares/workspaces/${UUID}`,
    );
  });
  it('builds skill and pipeline links mirroring the web share paths', () => {
    expect(
      buildDesktopShareDeepLink({
        scheme: 'canopy',
        entity: 'skill',
        externalId: UUID,
      }),
    ).toBe(`canopy://share/skills/${UUID}`);
    expect(
      buildDesktopShareDeepLink({
        scheme: SCHEME,
        entity: 'pipeline',
        externalId: UUID,
      }),
    ).toBe(`${SCHEME}://share/pipelines/${UUID}`);
  });

  it('lowercases the externalId', () => {
    expect(
      buildDesktopShareDeepLink({
        scheme: 'canopy',
        entity: 'skill',
        externalId: UUID.toUpperCase(),
      }),
    ).toBe(`canopy://share/skills/${UUID}`);
  });

  it('throws on a non-scheme-safe scheme', () => {
    for (const scheme of ['', 'Canopy', '1canopy', 'can opy', 'canopy:']) {
      expect(() =>
        buildDesktopShareDeepLink({
          scheme,
          entity: 'skill',
          externalId: UUID,
        }),
      ).toThrow('Invalid desktop deep-link scheme');
    }
  });

  it('throws on a non-UUID externalId', () => {
    for (const externalId of [
      '',
      'not-a-uuid',
      `${UUID}/extra`,
      `${UUID}?q=1`,
      '2f0c9a1e4b3d4f6a8c2e1d5b7a9e0c4f',
    ]) {
      expect(() =>
        buildDesktopShareDeepLink({
          scheme: 'canopy',
          entity: 'skill',
          externalId,
        }),
      ).toThrow('Invalid share externalId');
    }
  });
});

describe('parseDesktopShareDeepLink', () => {
  it('round-trips a shared-container capability token', () => {
    const url = buildDesktopShareDeepLink({
      scheme: SCHEME,
      entity: 'shared-container',
      externalId: SHARED_CONTAINER_TOKEN,
    });
    expect(parseDesktopShareDeepLink(url, SCHEME)).toEqual({
      entity: 'shared-container',
      externalId: SHARED_CONTAINER_TOKEN,
      intent: 'install',
    });
  });

  it.each([
    '',
    'short',
    `${'A'.repeat(42)}=`,
    `${'A'.repeat(43)}/extra`,
    `${'A'.repeat(42)}+`,
  ])('rejects malformed shared-container token %s', (token) => {
    expect(
      parseDesktopShareDeepLink(
        `${SCHEME}://share/shared-container/${token}`,
        SCHEME,
      ),
    ).toBeNull();
  });

  it('round-trips built links', () => {
    for (const entity of [
      'skill',
      'pipeline',
      'plugin',
      'agent',
      'workspace',
      'automation',
    ] as const) {
      const url = buildDesktopShareDeepLink({
        scheme: SCHEME,
        entity,
        externalId: UUID,
      });
      expect(parseDesktopShareDeepLink(url, SCHEME)).toEqual({
        entity,
        externalId: UUID,
        intent: 'install',
      });
    }
  });

  it('normalizes uppercase UUIDs but rejects cased scheme/host/segments', () => {
    expect(
      parseDesktopShareDeepLink(
        `${SCHEME}://share/skills/${UUID.toUpperCase()}`,
        SCHEME,
      ),
    ).toEqual({ entity: 'skill', externalId: UUID, intent: 'install' });
    // The WHATWG parser lowercases the protocol, so a cased scheme is fine…
    expect(
      parseDesktopShareDeepLink(
        `${SCHEME.toUpperCase()}://share/skills/${UUID}`,
        SCHEME,
      ),
    ).toEqual({ entity: 'skill', externalId: UUID, intent: 'install' });
    // …but opaque hosts and path segments are matched exactly.
    expect(
      parseDesktopShareDeepLink(`${SCHEME}://SHARE/skills/${UUID}`, SCHEME),
    ).toBeNull();
    expect(
      parseDesktopShareDeepLink(`${SCHEME}://share/SKILLS/${UUID}`, SCHEME),
    ).toBeNull();
  });

  it('rejects the mobile OAuth host and every other non-share host', () => {
    for (const url of [
      `${SCHEME}://auth?code=abc123`,
      `${SCHEME}://auth/done?error=two_factor_required&challenge=x`,
      `${SCHEME}://open/skills/${UUID}`,
      `${SCHEME}:///skills/${UUID}`,
      `${SCHEME}:share/skills/${UUID}`,
    ]) {
      expect(parseDesktopShareDeepLink(url, SCHEME)).toBeNull();
    }
  });

  it('rejects the wrong scheme, including https', () => {
    for (const url of [
      `canopy://share/skills/${UUID}`,
      `https://share/skills/${UUID}`,
      `${SCHEME}-evil://share/skills/${UUID}`,
      `javascript://share/skills/${UUID}`,
    ]) {
      expect(parseDesktopShareDeepLink(url, SCHEME)).toBeNull();
    }
  });

  it('rejects userinfo, port, and fragment', () => {
    for (const url of [
      `${SCHEME}://user@share/skills/${UUID}`,
      `${SCHEME}://user:pass@share/skills/${UUID}`,
      `${SCHEME}://share:8080/skills/${UUID}`,
      `${SCHEME}://share/skills/${UUID}#frag`,
    ]) {
      expect(parseDesktopShareDeepLink(url, SCHEME)).toBeNull();
    }
  });

  it('reads only the closed intent/source enums from the query', () => {
    expect(
      parseDesktopShareDeepLink(
        `${SCHEME}://share/skills/${UUID}?source=web_share_page&token=evil`,
        SCHEME,
      ),
    ).toEqual({
      entity: 'skill',
      externalId: UUID,
      intent: 'install',
      source: 'web_share_page',
    });
    expect(
      parseDesktopShareDeepLink(
        `${SCHEME}://share/pipelines/${UUID}?intent=try`,
        SCHEME,
      ),
    ).toEqual({ entity: 'pipeline', externalId: UUID, intent: 'try' });
    // Invalid enum values: intent defaults to install, source is dropped.
    expect(
      parseDesktopShareDeepLink(
        `${SCHEME}://share/skills/${UUID}?intent=manage&source=spam`,
        SCHEME,
      ),
    ).toEqual({ entity: 'skill', externalId: UUID, intent: 'install' });
  });

  it('round-trips intent and source through the builder', () => {
    expect(
      buildDesktopShareDeepLink({
        scheme: SCHEME,
        entity: 'skill',
        externalId: UUID,
        intent: 'try',
        source: 'web_share_page',
      }),
    ).toBe(`${SCHEME}://share/skills/${UUID}?intent=try&source=web_share_page`);
    // install is the default and stays off the URL.
    expect(
      buildDesktopShareDeepLink({
        scheme: SCHEME,
        entity: 'skill',
        externalId: UUID,
        intent: 'install',
      }),
    ).toBe(`${SCHEME}://share/skills/${UUID}`);
  });

  // A link lives in a chat message or a bookmark long after its client
  // version is superseded, so every version this repo has issued stays
  // parseable. Regenerating these would silently break shares in the wild.
  it.each([1, 2, 3])(
    'keeps an already-issued packageVersion=%s link installable',
    (packageVersion) => {
      const url = `${SCHEME}://share/pipelines/${UUID}?expectedDistributionMode=package&expectedPipelineContentHash=${CONTENT_HASH}&expectedPackageDigest=${PACKAGE_DIGEST}&packageVersion=${packageVersion}`;
      expect(parseDesktopShareDeepLink(url, SCHEME)).toMatchObject({
        packageVersion,
        expectedDistributionMode: 'package',
      });
    },
  );

  // A range check, not a literal list: a list has to be edited on every bump
  // and forgetting strands the links minted by the version it dropped.
  it('accepts every version up to the current client without a literal list', () => {
    for (let version = 1; version <= 3; version += 1) {
      const url = `${SCHEME}://share/pipelines/${UUID}?expectedDistributionMode=package&expectedPipelineContentHash=${CONTENT_HASH}&expectedPackageDigest=${PACKAGE_DIGEST}&packageVersion=${version}`;
      expect(parseDesktopShareDeepLink(url, SCHEME)).toMatchObject({
        packageVersion: version,
      });
    }
  });

  // Machine-built links are never normalized, so only the canonical decimal
  // form a builder emits is accepted. `Number()` coercion used to let a hand-
  // edited or mangled link through as a different spelling of a valid version.
  it.each(['0x3', '+3', '3e0', '03', '1.0', ' 3', '3 ', ''])(
    'rejects the non-canonical packageVersion spelling %p',
    (spelling) => {
      const url = `${SCHEME}://share/pipelines/${UUID}?expectedDistributionMode=package&expectedPipelineContentHash=${CONTENT_HASH}&expectedPackageDigest=${PACKAGE_DIGEST}&packageVersion=${encodeURIComponent(spelling)}`;
      expect(parseDesktopShareDeepLink(url, SCHEME)).toBeNull();
    },
  );

  it('rejects a packageVersion this build has never issued', () => {
    const url = `${SCHEME}://share/pipelines/${UUID}?expectedDistributionMode=package&expectedPipelineContentHash=${CONTENT_HASH}&expectedPackageDigest=${PACKAGE_DIGEST}&packageVersion=99`;
    expect(parseDesktopShareDeepLink(url, SCHEME)).toBeNull();
  });

  it('round-trips strict package and definition-only install pins', () => {
    const packageUrl = buildDesktopShareDeepLink({
      scheme: SCHEME,
      entity: 'pipeline',
      externalId: UUID,
      source: 'web_share_page',
      packageVersion: 2,
      expectedPipelineContentHash: CONTENT_HASH,
      expectedDistributionMode: 'package',
      expectedPackageDigest: PACKAGE_DIGEST,
    });
    expect(parseDesktopShareDeepLink(packageUrl, SCHEME)).toEqual({
      entity: 'pipeline',
      externalId: UUID,
      intent: 'install',
      source: 'web_share_page',
      packageVersion: 2,
      expectedPipelineContentHash: CONTENT_HASH,
      expectedDistributionMode: 'package',
      expectedPackageDigest: PACKAGE_DIGEST,
    });

    const definitionUrl = buildDesktopShareDeepLink({
      scheme: SCHEME,
      entity: 'pipeline',
      externalId: UUID,
      expectedPipelineContentHash: CONTENT_HASH,
      expectedDistributionMode: 'definition_only',
    });
    expect(parseDesktopShareDeepLink(definitionUrl, SCHEME)).toMatchObject({
      expectedPipelineContentHash: CONTENT_HASH,
      expectedDistributionMode: 'definition_only',
    });
  });

  it('round-trips the reviewed workspace-template content hash', () => {
    const url = buildDesktopShareDeepLink({
      scheme: SCHEME,
      entity: 'workspace',
      externalId: UUID,
      expectedWorkspaceTemplateContentHash: CONTENT_HASH,
    });
    expect(url).toBe(
      `${SCHEME}://share/project-templates/${UUID}?expectedWorkspaceTemplateContentHash=${CONTENT_HASH}`,
    );
    expect(parseDesktopShareDeepLink(url, SCHEME)).toEqual({
      entity: 'workspace',
      externalId: UUID,
      intent: 'install',
      expectedWorkspaceTemplateContentHash: CONTENT_HASH,
    });
    expect(
      parseDesktopShareDeepLink(
        `${SCHEME}://share/project-templates/${UUID}?expectedWorkspaceTemplateContentHash=not-a-hash`,
        SCHEME,
      ),
    ).toBeNull();
  });

  it('round-trips the reviewed automation content hash', () => {
    const url = buildDesktopShareDeepLink({
      scheme: SCHEME,
      entity: 'automation',
      externalId: UUID,
      expectedAutomationContentHash: CONTENT_HASH,
    });
    expect(url).toBe(
      `${SCHEME}://share/automations/${UUID}?expectedAutomationContentHash=${CONTENT_HASH}`,
    );
    expect(parseDesktopShareDeepLink(url, SCHEME)).toEqual({
      entity: 'automation',
      externalId: UUID,
      intent: 'install',
      expectedAutomationContentHash: CONTENT_HASH,
    });
    expect(
      parseDesktopShareDeepLink(
        `${SCHEME}://share/automations/${UUID}?expectedAutomationContentHash=not-a-hash`,
        SCHEME,
      ),
    ).toBeNull();
  });

  it('round-trips a curated automation catalog key without widening other share ids', () => {
    const url = buildDesktopShareDeepLink({
      scheme: SCHEME,
      entity: 'automation',
      externalId: 'daily-review',
      automationSource: 'curated',
      expectedAutomationContentHash: CONTENT_HASH,
    });
    expect(url).toBe(
      `${SCHEME}://share/automations/daily-review?automationSource=curated&expectedAutomationContentHash=${CONTENT_HASH}`,
    );
    expect(parseDesktopShareDeepLink(url, SCHEME)).toEqual({
      entity: 'automation',
      externalId: 'daily-review',
      intent: 'install',
      automationSource: 'curated',
      expectedAutomationContentHash: CONTENT_HASH,
    });
    expect(
      parseDesktopShareDeepLink(
        `${SCHEME}://share/automations/daily-review?expectedAutomationContentHash=${CONTENT_HASH}`,
        SCHEME,
      ),
    ).toBeNull();
    expect(() =>
      buildDesktopShareDeepLink({
        scheme: SCHEME,
        entity: 'skill',
        externalId: 'daily-review',
        automationSource: 'curated',
      }),
    ).toThrow('Invalid curated automation deep link');
  });

  it('rejects an automation pin on other entities but ignores unknown future params', () => {
    expect(
      parseDesktopShareDeepLink(
        `${SCHEME}://share/skills/${UUID}?expectedAutomationContentHash=${CONTENT_HASH}`,
        SCHEME,
      ),
    ).toBeNull();
    expect(
      parseDesktopShareDeepLink(
        `${SCHEME}://share/automations/${UUID}?futureInstallPin=value`,
        SCHEME,
      ),
    ).toEqual({
      entity: 'automation',
      externalId: UUID,
      intent: 'install',
    });
  });

  it.each(['blueprints', 'workspaces'])(
    'parses the legacy %s segment as a project-template compatibility alias',
    (segment) => {
      expect(
        parseDesktopShareDeepLink(
          `${SCHEME}://share/${segment}/${UUID}`,
          SCHEME,
        ),
      ).toEqual({
        entity: 'workspace',
        externalId: UUID,
        intent: 'install',
      });
    },
  );

  it('parses a project-template content hash on the canonical segment', () => {
    expect(
      parseDesktopShareDeepLink(
        `${SCHEME}://share/project-templates/${UUID}?expectedWorkspaceTemplateContentHash=${CONTENT_HASH}`,
        SCHEME,
      ),
    ).toMatchObject({
      entity: 'workspace',
      expectedWorkspaceTemplateContentHash: CONTENT_HASH,
    });
  });

  it('round-trips a scoped audience while keeping public links minimal', () => {
    const scoped = buildDesktopShareDeepLink({
      scheme: SCHEME,
      entity: 'pipeline',
      externalId: UUID,
      audience: 'ORGANIZATION',
    });
    expect(scoped).toBe(
      `${SCHEME}://share/pipelines/${UUID}?audience=ORGANIZATION`,
    );
    expect(parseDesktopShareDeepLink(scoped, SCHEME)).toEqual({
      entity: 'pipeline',
      externalId: UUID,
      intent: 'install',
      audience: 'ORGANIZATION',
    });
    expect(
      buildDesktopShareDeepLink({
        scheme: SCHEME,
        entity: 'pipeline',
        externalId: UUID,
        audience: 'PUBLIC',
      }),
    ).toBe(`${SCHEME}://share/pipelines/${UUID}`);
  });

  it('rejects partial, malformed, and non-pipeline install pins', () => {
    const invalidUrls = [
      `${SCHEME}://share/pipelines/${UUID}?expectedDistributionMode=package`,
      `${SCHEME}://share/pipelines/${UUID}?expectedDistributionMode=package&expectedPipelineContentHash=${CONTENT_HASH}&packageVersion=1`,
      `${SCHEME}://share/pipelines/${UUID}?expectedDistributionMode=definition_only&expectedPipelineContentHash=BAD`,
      `${SCHEME}://share/pipelines/${UUID}?expectedDistributionMode=definition_only&expectedPipelineContentHash=${CONTENT_HASH}&expectedPackageDigest=${encodeURIComponent(PACKAGE_DIGEST)}`,
      `${SCHEME}://share/skills/${UUID}?expectedDistributionMode=definition_only&expectedPipelineContentHash=${CONTENT_HASH}`,
    ];
    for (const url of invalidUrls) {
      expect(parseDesktopShareDeepLink(url, SCHEME)).toBeNull();
    }

    expect(() =>
      buildDesktopShareDeepLink({
        scheme: SCHEME,
        entity: 'pipeline',
        externalId: UUID,
        expectedDistributionMode: 'package',
        expectedPipelineContentHash: CONTENT_HASH,
      }),
    ).toThrow('Invalid pipeline share install pin');
  });

  it('rejects malformed paths, ids, and traversal attempts', () => {
    for (const url of [
      `${SCHEME}://share`,
      `${SCHEME}://share/`,
      `${SCHEME}://share/skills`,
      `${SCHEME}://share/skills/`,
      `${SCHEME}://share/skills/not-a-uuid`,
      `${SCHEME}://share/skills/${UUID}/extra`,
      `${SCHEME}://share/workspace/${UUID}`,
      `${SCHEME}://share/skills/../pipelines/${UUID}`,
      `${SCHEME}://share/skills/%2e%2e/${UUID}`,
      'not a url at all',
      '',
    ]) {
      expect(parseDesktopShareDeepLink(url, SCHEME)).toBeNull();
    }
  });

  it('round-trips collection share links', () => {
    const url = buildDesktopShareDeepLink({
      scheme: SCHEME,
      entity: 'collection',
      externalId: UUID,
    });
    expect(url).toBe(`${SCHEME}://share/collections/${UUID}`);
    expect(parseDesktopShareDeepLink(url, SCHEME)).toEqual({
      entity: 'collection',
      externalId: UUID,
      intent: 'install',
    });
  });

  it('round-trips a packaged collection install review', () => {
    const pin = {
      expectedCollectionContentHash: CONTENT_HASH,
      expectedDistributionMode: 'package' as const,
      expectedPackageDigest: PACKAGE_DIGEST,
      packageVersion: 3 as const,
    };
    const url = buildDesktopShareDeepLink({
      scheme: SCHEME,
      entity: 'collection',
      externalId: UUID,
      ...pin,
    });
    expect(parseDesktopShareDeepLink(url, SCHEME)).toEqual({
      entity: 'collection',
      externalId: UUID,
      intent: 'install',
      ...pin,
    });
  });

  it('round-trips a collection content pin', () => {
    const url = buildDesktopShareDeepLink({
      scheme: SCHEME,
      entity: 'collection',
      externalId: UUID,
      expectedCollectionContentHash: CONTENT_HASH,
    });
    expect(parseDesktopShareDeepLink(url, SCHEME)).toEqual({
      entity: 'collection',
      externalId: UUID,
      intent: 'install',
      expectedCollectionContentHash: CONTENT_HASH,
    });
  });

  it.each([
    `collections/${UUID}?expectedCollectionContentHash=bad`,
    `skills/${UUID}?expectedCollectionContentHash=${CONTENT_HASH}`,
    `collections/${UUID}?expectedCollectionContentHash=${CONTENT_HASH}&expectedCollectionContentHash=${CONTENT_HASH}`,
  ])('rejects invalid collection content pin %s', (suffix) => {
    expect(
      parseDesktopShareDeepLink(`${SCHEME}://share/${suffix}`, SCHEME),
    ).toBeNull();
  });

  it('rejects over-length URLs', () => {
    const padded = `${SCHEME}://share/skills/${UUID}?pad=${'a'.repeat(
      DESKTOP_SHARE_DEEP_LINK_MAX_LENGTH,
    )}`;
    expect(parseDesktopShareDeepLink(padded, SCHEME)).toBeNull();
  });

  it('rejects an invalid expected scheme instead of throwing', () => {
    expect(
      parseDesktopShareDeepLink(`canopy://share/skills/${UUID}`, 'Canopy'),
    ).toBeNull();
  });
});

describe('privacy opt-in contract (CAN-3383)', () => {
  const org = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
  it('round trips every feature and normalizes organization ids', () => {
    for (const feature of DATA_SHARING_OPT_IN_FEATURES) {
      const url = buildDesktopPrivacyOptInDeepLink('canopy', {
        feature,
        organizationId: org,
      });
      expect(url).toBe(
        `canopy://settings/privacy?feature=${feature}&org=${org.toLowerCase()}`,
      );
      expect(parseDesktopSettingsDeepLink(url, 'canopy')).toEqual({
        destination: 'settings',
        section: 'privacy',
        optIn: { feature, organizationId: org.toLowerCase() },
      });
    }
  });
  it.each([
    'canopy://SETTINGS/privacy',
    'CANOPY://settings/privacy',
    'canopy://settings/privacy?',
    'canopy://settings/privacy#',
    'canopy://settings:0/privacy',
    'canopy://@settings/privacy',
    'canopy://settings/privacy?feature=statistics',
    `canopy://settings/privacy?feature=statistics&org=${org}&feature=statistics`,
    `canopy://settings/privacy?feature=statistics&org=${org}&%66eature=statistics`,
    `canopy://settings/privacy?feature=statistics&org=${org}&extra=1`,
    `canopy://settings/privacy?feature=unknown&org=${org}`,
    'canopy://settings/privacy?feature=statistics&org=bad',
    'canopy://settings/privacy/',
    'canopy://settings/../privacy',
    ' canopy://settings/privacy',
    'canopy://settings/privacy' + 'a'.repeat(256),
  ])('rejects malformed raw links: %s', (url) => {
    expect(parseDesktopSettingsDeepLink(url, 'canopy')).toBeNull();
  });
  it('validates builders at runtime', () => {
    expect(() =>
      buildDesktopPrivacyOptInDeepLink('bad scheme', {
        feature: 'statistics',
        organizationId: org,
      }),
    ).toThrow();
    expect(() =>
      buildDesktopPrivacyOptInDeepLink('canopy', {
        feature: 'statistics',
        organizationId: 'bad',
      }),
    ).toThrow();
    expect(isDataSharingOptInFeature('shared-projects')).toBe(true);
    expect(isDataSharingOptInFeature('shared-runs')).toBe(false);
    expect(isDataSharingOptInFeature(null)).toBe(false);
  });
});

it('strictly guards viewer evidence without accepting missing scopes or invalid states', () => {
  const value = {
    viewerUserId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    scopes: {
      metadata: 'private',
      plans: 'shared',
      summaries: 'unknown',
      transcripts: 'prohibited',
    },
  };
  expect(isViewerDataSharingStatus(value)).toBe(true);
  expect(isViewerDataSharingStatus({ ...value, viewerUserId: '' })).toBe(false);
  expect(
    isViewerDataSharingStatus({
      ...value,
      scopes: { ...value.scopes, transcripts: 'withheld' },
    }),
  ).toBe(false);
  expect(
    isViewerDataSharingStatus({ ...value, scopes: { metadata: 'private' } }),
  ).toBe(false);
  expect(isViewerDataSharingStatus(null)).toBe(false);
});

it('requires the recent participation metric in the admin response guard', () => {
  const member = {
    userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    name: null,
    email: 'a@example.test',
    role: 'MEMBER',
    memoryEnabled: true,
  };
  expect(isMemoryParticipationMember(member)).toBe(false);
  expect(
    isMemoryParticipationMember({ ...member, contributingRecently: false }),
  ).toBe(true);
  expect(
    isMemoryParticipationMember({ ...member, contributingRecently: 'false' }),
  ).toBe(false);
});
