import {
  PROFILE_ROLE_OPTIONS,
  PLUGIN_CATALOG_API_VERSION,
  expandLegacyProfileRoles,
  isCuratedCatalogKey,
  isCuratedPluginContentResponse,
  isCuratedPluginEventRequest,
  isCuratedPluginEntry,
  isCuratedPluginListResponse,
  isCuratedPluginSkillContent,
  isCuratedPluginSkillManifest,
  isCuratedSkillFileContentEntry,
  isCuratedSkillFileManifestEntry,
  isCuratedSkillFilePath,
  type CuratedPluginContentResponse,
  type CuratedPluginEntry,
  type CuratedPluginListResponse,
} from '../index';

describe('profile role options', () => {
  it('offers Operations and Support independently while expanding the legacy combined answer', () => {
    const optionIds = PROFILE_ROLE_OPTIONS.map((option) => option.id);

    expect(optionIds).toContain('operations');
    expect(optionIds).toContain('support');
    expect(optionIds).not.toContain('operations-support');
    expect(expandLegacyProfileRoles(['operations-support'])).toEqual([
      'operations',
      'support',
    ]);
  });
});

describe('isCuratedCatalogKey', () => {
  it.each(['con', 'prn', 'aux', 'nul', 'com1', 'com9', 'lpt1', 'lpt9'])(
    'rejects the Windows reserved device name %s',
    (key) => {
      expect(isCuratedCatalogKey(key)).toBe(false);
    },
  );

  it('accepts portable slug keys', () => {
    expect(isCuratedCatalogKey('con-tools')).toBe(true);
    expect(isCuratedCatalogKey('team-tools')).toBe(true);
  });
});

describe('isCuratedPluginEventRequest', () => {
  const event = {
    clientEventId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    curatedPluginKey: 'acme-plugin',
    eventType: 'INSTALLED',
    occurredAt: '2026-08-13T10:00:00.000Z',
  };

  it('accepts a canonical ISO-8601 instant', () => {
    expect(isCuratedPluginEventRequest(event)).toBe(true);
  });

  it.each([
    '0',
    'Aug 13 2026',
    '2026-08-13',
    '2026-08-13T10:00:00.000',
    '2026-02-30T10:00:00.000Z',
  ])(
    'rejects a non-canonical or calendar-invalid instant: %s',
    (occurredAt) => {
      expect(isCuratedPluginEventRequest({ ...event, occurredAt })).toBe(false);
    },
  );
});

function makeFileManifestEntry(): {
  path: string;
  sha256: string;
  size: number;
} {
  return {
    path: 'SKILL.md',
    sha256: 'a'.repeat(64),
    size: 128,
  };
}

function makeSkillManifest(): {
  key: string;
  name: string;
  contentHash: string;
  files: ReturnType<typeof makeFileManifestEntry>[];
} {
  return {
    key: 'acme-skill',
    name: 'Acme Skill',
    contentHash: 'b'.repeat(64),
    files: [makeFileManifestEntry()],
  };
}

function makeEntry(
  overrides: Partial<CuratedPluginEntry> = {},
): CuratedPluginEntry {
  return {
    key: 'acme-plugin',
    name: 'Acme Plugin',
    shortDescription: 'Acme tools bundled as a plugin',
    categories: ['productivity'],
    popular: true,
    sortOrder: 0,
    contentHash: 'c'.repeat(64),
    mcpServers: ['acme-mcp'],
    skills: [makeSkillManifest()],
    updatedAt: '2026-07-14T00:00:00Z',
    ...overrides,
  };
}

function makeListResponse(): CuratedPluginListResponse {
  return {
    version: PLUGIN_CATALOG_API_VERSION,
    plugins: [makeEntry()],
  };
}

/** Wrap arbitrary `plugins` in a list-response envelope typed as `unknown`. */
function listResponseWith(plugins: unknown): unknown {
  return { version: 1, plugins };
}

function makeFileContentEntry(): {
  path: string;
  sha256: string;
  size: number;
  content: string;
} {
  return { ...makeFileManifestEntry(), content: '# Acme Skill\n' };
}

function makeSkillContent(): {
  key: string;
  contentHash: string;
  files: ReturnType<typeof makeFileContentEntry>[];
} {
  return {
    key: 'acme-skill',
    contentHash: 'b'.repeat(64),
    files: [makeFileContentEntry()],
  };
}

function makeContentResponse(): CuratedPluginContentResponse {
  return {
    version: PLUGIN_CATALOG_API_VERSION,
    key: 'acme-plugin',
    contentHash: 'c'.repeat(64),
    skills: [makeSkillContent()],
  };
}

/** Wrap arbitrary `skills` in a content-response envelope typed as `unknown`. */
function contentResponseWith(skills: unknown): unknown {
  return {
    version: 1,
    key: 'acme-plugin',
    contentHash: 'c'.repeat(64),
    skills,
  };
}

describe('curated plugin catalog contract', () => {
  it('pins the API version', () => {
    expect(PLUGIN_CATALOG_API_VERSION).toBe(1);
  });

  describe('isCuratedSkillFilePath', () => {
    it('accepts safe relative paths', () => {
      expect(isCuratedSkillFilePath('SKILL.md')).toBe(true);
      expect(isCuratedSkillFilePath('references/api.md')).toBe(true);
    });

    it('rejects unsafe or malformed paths', () => {
      expect(isCuratedSkillFilePath('')).toBe(false);
      expect(isCuratedSkillFilePath('/abs.md')).toBe(false);
      expect(isCuratedSkillFilePath('a\\b.md')).toBe(false);
      expect(isCuratedSkillFilePath('../x.md')).toBe(false);
      expect(isCuratedSkillFilePath('a/../b.md')).toBe(false);
      expect(isCuratedSkillFilePath('./x.md')).toBe(false);
      expect(isCuratedSkillFilePath('a//b.md')).toBe(false);
      expect(isCuratedSkillFilePath('references/api:v1.md')).toBe(false);
      expect(isCuratedSkillFilePath('references/CON.md')).toBe(false);
      expect(isCuratedSkillFilePath('references/com1.txt')).toBe(false);
      expect(isCuratedSkillFilePath('references/trailing.')).toBe(false);
      expect(isCuratedSkillFilePath('references/trailing ')).toBe(false);
      expect(isCuratedSkillFilePath('references/control\u0001.md')).toBe(false);
      expect(isCuratedSkillFilePath('a'.repeat(257))).toBe(false);
      expect(isCuratedSkillFilePath(undefined)).toBe(false);
      expect(isCuratedSkillFilePath(null)).toBe(false);
      expect(isCuratedSkillFilePath(42)).toBe(false);
    });

    it('enforces filesystem byte limits per path segment', () => {
      expect(isCuratedSkillFilePath('a'.repeat(255))).toBe(true);
      expect(isCuratedSkillFilePath('a'.repeat(256))).toBe(false);
      expect(isCuratedSkillFilePath('\u00e9'.repeat(128))).toBe(false);
      expect(
        isCuratedSkillFilePath(`${'a'.repeat(127)}/${'b'.repeat(128)}`),
      ).toBe(true);
    });
  });

  describe('isCuratedSkillFileManifestEntry', () => {
    it('accepts a valid entry', () => {
      expect(isCuratedSkillFileManifestEntry(makeFileManifestEntry())).toBe(
        true,
      );
    });

    it('rejects non-objects and malformed fields', () => {
      expect(isCuratedSkillFileManifestEntry(null)).toBe(false);
      expect(isCuratedSkillFileManifestEntry('nope')).toBe(false);
      expect(
        isCuratedSkillFileManifestEntry({
          ...makeFileManifestEntry(),
          path: '../x.md',
        }),
      ).toBe(false);
      expect(
        isCuratedSkillFileManifestEntry({
          ...makeFileManifestEntry(),
          sha256: '',
        }),
      ).toBe(false);
      expect(
        isCuratedSkillFileManifestEntry({
          ...makeFileManifestEntry(),
          size: '128',
        }),
      ).toBe(false);
      expect(
        isCuratedSkillFileManifestEntry({
          ...makeFileManifestEntry(),
          size: Number.NaN,
        }),
      ).toBe(false);
    });
  });

  describe('isCuratedSkillFileContentEntry', () => {
    it('accepts a valid entry', () => {
      expect(isCuratedSkillFileContentEntry(makeFileContentEntry())).toBe(true);
    });

    it('rejects a manifest entry missing content', () => {
      expect(isCuratedSkillFileContentEntry(makeFileManifestEntry())).toBe(
        false,
      );
    });

    it('rejects a wrong-typed content field', () => {
      expect(
        isCuratedSkillFileContentEntry({
          ...makeFileContentEntry(),
          content: 42,
        }),
      ).toBe(false);
    });
  });

  describe('isCuratedPluginSkillManifest', () => {
    it('accepts a valid manifest', () => {
      expect(isCuratedPluginSkillManifest(makeSkillManifest())).toBe(true);
    });

    it('rejects non-objects, missing fields, and a malformed file element', () => {
      expect(isCuratedPluginSkillManifest(null)).toBe(false);
      expect(
        isCuratedPluginSkillManifest({ ...makeSkillManifest(), key: '' }),
      ).toBe(false);
      expect(
        isCuratedPluginSkillManifest({
          ...makeSkillManifest(),
          files: [{ ...makeFileManifestEntry(), path: '' }],
        }),
      ).toBe(false);
      expect(
        isCuratedPluginSkillManifest({
          ...makeSkillManifest(),
          files: 'not-an-array',
        }),
      ).toBe(false);
    });
  });

  describe('isCuratedPluginEntry', () => {
    it('round-trips a fully-populated entry through JSON', () => {
      const entry = makeEntry({
        longDescription: 'A longer description',
        logoUrl: 'https://cdn.acme.example/logo.svg',
        version: '1.2.3',
        authorName: 'Acme, Inc.',
        authorUrl: 'https://acme.example',
        docsUrl: 'https://acme.example/docs',
        categories: ['productivity', 'dev-tools'],
        mcpServers: ['acme-mcp', 'other-mcp'],
      });

      expect(JSON.parse(JSON.stringify(entry))).toEqual(entry);
      expect(isCuratedPluginEntry(entry)).toBe(true);
    });

    it('round-trips a minimal entry (no optionals) through JSON', () => {
      const entry = makeEntry({ mcpServers: [], skills: [] });

      expect(JSON.parse(JSON.stringify(entry))).toEqual(entry);
      expect(isCuratedPluginEntry(entry)).toBe(true);
    });

    it('rejects non-objects and missing required fields', () => {
      expect(isCuratedPluginEntry(null)).toBe(false);
      expect(isCuratedPluginEntry(undefined)).toBe(false);
      expect(isCuratedPluginEntry([])).toBe(false);
      expect(isCuratedPluginEntry('nope')).toBe(false);
      const withoutKey: Record<string, unknown> = { ...makeEntry() };
      delete withoutKey.key;
      expect(isCuratedPluginEntry(withoutKey)).toBe(false);
    });

    it('rejects wrong-typed fields', () => {
      expect(isCuratedPluginEntry({ ...makeEntry(), key: '' })).toBe(false);
      expect(
        isCuratedPluginEntry({ ...makeEntry(), categories: 'productivity' }),
      ).toBe(false);
      expect(isCuratedPluginEntry({ ...makeEntry(), popular: 'yes' })).toBe(
        false,
      );
      expect(
        isCuratedPluginEntry({ ...makeEntry(), sortOrder: Number.NaN }),
      ).toBe(false);
      expect(isCuratedPluginEntry({ ...makeEntry(), mcpServers: [1, 2] })).toBe(
        false,
      );
      expect(isCuratedPluginEntry({ ...makeEntry(), updatedAt: 1234 })).toBe(
        false,
      );
    });

    it('rejects an entry containing a malformed skill manifest element', () => {
      expect(
        isCuratedPluginEntry({
          ...makeEntry(),
          skills: [{ ...makeSkillManifest(), contentHash: '' }],
        }),
      ).toBe(false);
    });
  });

  describe('isCuratedPluginListResponse', () => {
    it('accepts a valid list response and round-trips it', () => {
      const response = makeListResponse();
      expect(isCuratedPluginListResponse(response)).toBe(true);
      expect(JSON.parse(JSON.stringify(response))).toEqual(response);
    });

    it('accepts an empty catalog', () => {
      expect(isCuratedPluginListResponse({ version: 1, plugins: [] })).toBe(
        true,
      );
    });

    it('rejects non-objects and missing fields', () => {
      expect(isCuratedPluginListResponse(null)).toBe(false);
      expect(isCuratedPluginListResponse(undefined)).toBe(false);
      expect(isCuratedPluginListResponse([])).toBe(false);
      expect(isCuratedPluginListResponse('nope')).toBe(false);
      expect(isCuratedPluginListResponse({ plugins: [] })).toBe(false);
      expect(isCuratedPluginListResponse({ version: 1 })).toBe(false);
    });

    it('does not pin the version VALUE, only its type', () => {
      expect(isCuratedPluginListResponse({ version: 1, plugins: [] })).toBe(
        true,
      );
      expect(isCuratedPluginListResponse({ version: 999, plugins: [] })).toBe(
        true,
      );
      expect(isCuratedPluginListResponse({ version: '1', plugins: [] })).toBe(
        false,
      );
    });

    it('rejects a response containing a malformed plugin element', () => {
      const emptyKey = listResponseWith([{ ...makeEntry(), key: '' }]);
      const badCategories = listResponseWith([
        { ...makeEntry(), categories: 'productivity' },
      ]);
      const nanSortOrder = listResponseWith([
        { ...makeEntry(), sortOrder: Number.NaN },
      ]);

      expect(isCuratedPluginListResponse(emptyKey)).toBe(false);
      expect(isCuratedPluginListResponse(badCategories)).toBe(false);
      expect(isCuratedPluginListResponse(nanSortOrder)).toBe(false);
    });
  });

  describe('isCuratedPluginSkillContent', () => {
    it('accepts a valid content payload', () => {
      expect(isCuratedPluginSkillContent(makeSkillContent())).toBe(true);
    });

    it('rejects non-objects, missing fields, and a malformed file element', () => {
      expect(isCuratedPluginSkillContent(null)).toBe(false);
      expect(
        isCuratedPluginSkillContent({ ...makeSkillContent(), key: '' }),
      ).toBe(false);
      expect(
        isCuratedPluginSkillContent({
          ...makeSkillContent(),
          files: [makeFileManifestEntry()],
        }),
      ).toBe(false);
    });
  });

  describe('isCuratedPluginContentResponse', () => {
    it('accepts a valid content response and round-trips it', () => {
      const response = makeContentResponse();
      expect(isCuratedPluginContentResponse(response)).toBe(true);
      expect(JSON.parse(JSON.stringify(response))).toEqual(response);
    });

    it('accepts a plugin with no skills', () => {
      expect(
        isCuratedPluginContentResponse({
          ...makeContentResponse(),
          skills: [],
        }),
      ).toBe(true);
    });

    it('rejects non-objects and missing fields', () => {
      expect(isCuratedPluginContentResponse(null)).toBe(false);
      expect(isCuratedPluginContentResponse(undefined)).toBe(false);
      expect(isCuratedPluginContentResponse([])).toBe(false);
      expect(isCuratedPluginContentResponse('nope')).toBe(false);
      expect(
        isCuratedPluginContentResponse({
          key: 'acme-plugin',
          contentHash: 'c'.repeat(64),
          skills: [],
        }),
      ).toBe(false);
    });

    it('does not pin the version VALUE, only its type', () => {
      expect(
        isCuratedPluginContentResponse({
          ...makeContentResponse(),
          version: 999,
        }),
      ).toBe(true);
      expect(
        isCuratedPluginContentResponse({
          ...makeContentResponse(),
          version: '1',
        }),
      ).toBe(false);
    });

    it('rejects a response containing a malformed skill content element', () => {
      const badSkill = contentResponseWith([
        { ...makeSkillContent(), contentHash: '' },
      ]);
      expect(isCuratedPluginContentResponse(badSkill)).toBe(false);
    });
  });
});

it('accepts optional Try it prompt metadata and rejects malformed wire values', () => {
  expect(
    isCuratedPluginEntry({ ...makeEntry(), tryNowPrompt: 'An example' }),
  ).toBe(true);
  for (const tryNowPrompt of [null, 42, {}])
    expect(isCuratedPluginEntry({ ...makeEntry(), tryNowPrompt })).toBe(false);
  expect(isCuratedPluginEntry(makeEntry())).toBe(true);
});
