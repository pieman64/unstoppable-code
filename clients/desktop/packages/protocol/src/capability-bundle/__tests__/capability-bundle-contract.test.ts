import { createHash } from 'node:crypto';
import goldenVectors from './capability-bundle-golden-vectors.json';
import {
  CAPABILITY_BUNDLE_API_VERSION,
  CAPABILITY_BUNDLE_CATALOG_BRAND_MAX_LENGTH,
  CAPABILITY_BUNDLE_DIGEST_PREFIX,
  CAPABILITY_BUNDLE_MAX_FILE_TREE_ENTRIES,
  CAPABILITY_BUNDLE_MAX_MCP_SERVERS,
  CAPABILITY_BUNDLE_RESERVED_MCP_SERVER_NAME,
  formatCapabilityBundleDigest,
  isCapabilityBundleAppliedEvent,
  isCapabilityBundleDigest,
  isCapabilityBundleFileTree,
  isCapabilityBundleMcpServer,
  isCapabilityBundleProvenance,
  isCapabilityBundleRef,
  isCapabilityBundleSessionState,
  isCapabilityBundleSkill,
  isCapabilityBundleV1,
  capabilityUnavailableDisposition,
  isCapabilityUnavailable,
  isLegacyCapabilityBundleProvenance,
  projectMcpServersForClaudeCode,
  projectMcpServersForCodex,
  serializeCanonicalCapabilityBundle,
  validateCapabilityBundle,
  type CapabilityBundleMcpServer,
  type CapabilityBundleSkill,
  type CapabilityBundleV1,
  type CapabilityUnavailable,
} from '../index';

function makeSkill(
  overrides: Partial<CapabilityBundleSkill> = {},
): CapabilityBundleSkill {
  return {
    name: 'acme-review',
    description: 'Review changes the Acme way',
    content: 'Always review twice.',
    ...overrides,
  };
}

function makeServer(
  overrides: Partial<CapabilityBundleMcpServer> = {},
): CapabilityBundleMcpServer {
  return {
    name: 'acme-tools',
    url: 'https://proxy.canopy.example/mcp/acme',
    ...overrides,
  };
}

function makeBundle(
  overrides: Partial<CapabilityBundleV1> = {},
): CapabilityBundleV1 {
  return {
    version: 1,
    instructions: ['Prefer small diffs.'],
    skills: [makeSkill()],
    mcpServers: [makeServer()],
    provenance: {
      collectionIds: ['collection-1'],
      skillRefs: [{ sourceId: 'source-1', skillName: 'acme-review' }],
      pluginRefs: [{ marketplaceId: 'market-1', pluginName: 'acme' }],
      mcpServerRefs: [{ serverId: 'server-1', configId: 'config-1' }],
      resolved: [
        { kind: 'skill', ref: 'source-1/acme-review', contentHash: 'abc' },
        { kind: 'mcp', ref: 'server-1/config-1' },
      ],
    },
    warnings: [],
    ...overrides,
  };
}

describe('capability bundle contract', () => {
  it('pins the API version', () => {
    expect(CAPABILITY_BUNDLE_API_VERSION).toBe(1);
  });

  it('accepts a valid bundle and round-trips it through JSON', () => {
    const bundle = makeBundle({
      skills: [
        makeSkill({
          files: [{ path: 'references/style.md', content: '# Style' }],
        }),
      ],
      mcpServers: [
        makeServer({ headers: { 'x-canopy-session': 'proxy-session' } }),
      ],
      fileTrees: [
        {
          root: 'plugins/acme',
          entries: [
            { path: 'hooks/hook.sh', sha256: 'a'.repeat(64), size: 42 },
          ],
        },
      ],
    });
    expect(isCapabilityBundleV1(bundle)).toBe(true);
    expect(JSON.parse(JSON.stringify(bundle))).toEqual(bundle);
  });

  it('rejects non-objects, wrong versions, and missing fields', () => {
    expect(isCapabilityBundleV1(null)).toBe(false);
    expect(isCapabilityBundleV1([])).toBe(false);
    expect(isCapabilityBundleV1('bundle')).toBe(false);
    expect(isCapabilityBundleV1({ ...makeBundle(), version: 2 })).toBe(false);
    expect(isCapabilityBundleV1({ ...makeBundle(), warnings: undefined })).toBe(
      false,
    );
    expect(
      isCapabilityBundleV1({ ...makeBundle(), provenance: undefined }),
    ).toBe(false);
  });

  it('rejects malformed nested shapes', () => {
    expect(isCapabilityBundleSkill({ name: 'a', description: 'b' })).toBe(
      false,
    );
    expect(isCapabilityBundleSkill(makeSkill({ files: [] }))).toBe(true);
    expect(
      isCapabilityBundleSkill(
        makeSkill({ files: [{ path: '', content: 'x' }] }),
      ),
    ).toBe(false);
    expect(isCapabilityBundleMcpServer({ name: 'a', url: '' })).toBe(false);
    const numericHeaderValue: unknown = {
      ...makeServer(),
      headers: { a: 1 },
    };
    expect(isCapabilityBundleMcpServer(numericHeaderValue)).toBe(false);
    expect(
      isCapabilityBundleFileTree({ root: 'r', entries: [{ path: 'p' }] }),
    ).toBe(false);
    expect(
      isCapabilityBundleProvenance({
        ...makeBundle().provenance,
        resolved: [{ kind: 'agent', ref: 'x' }],
      }),
    ).toBe(false);
  });

  it('rejects malformed file-tree sha256 hashes structurally', () => {
    const badHashes = [
      'x',
      'a'.repeat(63),
      'a'.repeat(65),
      'A'.repeat(64),
      'g'.repeat(64),
    ];
    for (const sha256 of badHashes) {
      expect(
        isCapabilityBundleFileTree({
          root: 'plugins/acme',
          entries: [{ path: 'hooks/hook.sh', sha256, size: 1 }],
        }),
      ).toBe(false);
    }
    expect(
      isCapabilityBundleFileTree({
        root: 'plugins/acme',
        entries: [
          { path: 'hooks/hook.sh', sha256: 'a1b2'.repeat(16), size: 1 },
        ],
      }),
    ).toBe(true);
  });

  describe('validateCapabilityBundle', () => {
    it('returns no errors for a valid bundle', () => {
      expect(validateCapabilityBundle(makeBundle())).toEqual([]);
    });

    it('rejects skill names the harness SDK rejects', () => {
      const slash = makeBundle({
        skills: [makeSkill({ name: 'acme/review' })],
      });
      const dot = makeBundle({ skills: [makeSkill({ name: '.' })] });
      const dotdot = makeBundle({ skills: [makeSkill({ name: '..' })] });
      const space = makeBundle({ skills: [makeSkill({ name: 'a b' })] });

      expect(validateCapabilityBundle(slash)).toHaveLength(1);
      expect(validateCapabilityBundle(slash)[0]).toContain('acme/review');
      expect(validateCapabilityBundle(dot)).toHaveLength(1);
      expect(validateCapabilityBundle(dotdot)).toHaveLength(1);
      expect(validateCapabilityBundle(space)).toHaveLength(1);
    });

    it('rejects the runner digest sentinel name', () => {
      // The name matches CAPABILITY_BUNDLE_SKILL_NAME_PATTERN, so without an
      // explicit rejection it reaches the runner and shadows the sentinel path
      // it writes next to the materialized skills.
      const sentinel = makeBundle({
        skills: [makeSkill({ name: '.capability-bundle-digest' })],
      });
      const upper = makeBundle({
        skills: [makeSkill({ name: '.Capability-Bundle-Digest' })],
      });

      expect(validateCapabilityBundle(sentinel)).toHaveLength(1);
      expect(validateCapabilityBundle(sentinel)[0]).toContain('reserved');
      expect(validateCapabilityBundle(upper)).toHaveLength(1);
    });

    it('rejects duplicate skill names', () => {
      const bundle = makeBundle({ skills: [makeSkill(), makeSkill()] });
      expect(validateCapabilityBundle(bundle)).toEqual([
        'duplicate skill name "acme-review"',
      ]);
    });

    it('rejects unsafe skill file paths', () => {
      const paths = [
        '../escape.md',
        'a/../b.md',
        '/abs.md',
        'a\\b.md',
        // Windows drive-absolute: resolves outside the sandbox root on Windows.
        'C:/evil.md',
        // Normalize away at materialization time: collisions / directory
        // targets rather than the file the path spells.
        '.',
        './a.md',
        'a/./b.md',
        'a//b.md',
        'a/b/',
      ];
      for (const path of paths) {
        const bundle = makeBundle({
          skills: [makeSkill({ files: [{ path, content: '' }] })],
        });
        expect(validateCapabilityBundle(bundle)).toHaveLength(1);
      }
      const ok = makeBundle({
        skills: [
          makeSkill({ files: [{ path: 'nested/dir/file.md', content: '' }] }),
        ],
      });
      expect(validateCapabilityBundle(ok)).toEqual([]);
    });

    it('rejects unsafe file tree roots and entry paths', () => {
      const unsafe = [
        '../../../.ssh',
        '/abs',
        'a\\b',
        'C:/evil',
        'a/../b',
        './a',
        'a//b',
      ];
      for (const root of unsafe) {
        const bundle = makeBundle({
          fileTrees: [
            {
              root,
              entries: [{ path: 'ok.txt', sha256: 'a'.repeat(64), size: 1 }],
            },
          ],
        });
        const errors = validateCapabilityBundle(bundle);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain(root);
      }
      for (const path of unsafe) {
        const bundle = makeBundle({
          fileTrees: [
            {
              root: 'plugins/acme',
              entries: [{ path, sha256: 'a'.repeat(64), size: 1 }],
            },
          ],
        });
        const errors = validateCapabilityBundle(bundle);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain(path);
      }
      const ok = makeBundle({
        fileTrees: [
          {
            root: 'plugins/acme',
            entries: [
              { path: 'hooks/hook.sh', sha256: 'a'.repeat(64), size: 1 },
            ],
          },
        ],
      });
      expect(validateCapabilityBundle(ok)).toEqual([]);
    });

    it('rejects Windows-hostile path segments in roots and entry paths', () => {
      const hostile = [
        'CON',
        'con',
        'con.txt',
        'prn.log',
        'AUX',
        'NUL',
        'nul.txt',
        'COM1',
        'com9.dat',
        'LPT1',
        'lpt9.log',
        'file:stream',
        'a\u0000b',
        // Full Windows-invalid character set beyond ":" and NUL.
        'a<b',
        'a>b',
        'a"b',
        'a|b',
        'run?.cmd',
        'star*.txt',
        'tab\tname',
        'a\u001fb',
        'name.',
        'name ',
        'nested/CON/file',
      ];
      for (const root of hostile) {
        const bundle = makeBundle({
          fileTrees: [
            {
              root,
              entries: [{ path: 'ok.txt', sha256: 'a'.repeat(64), size: 1 }],
            },
          ],
        });
        const errors = validateCapabilityBundle(bundle);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain(root);
      }
      for (const path of hostile) {
        const bundle = makeBundle({
          fileTrees: [
            {
              root: 'plugins/acme',
              entries: [{ path, sha256: 'a'.repeat(64), size: 1 }],
            },
          ],
        });
        const errors = validateCapabilityBundle(bundle);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain(path);
      }
      const portable = [
        'COM10',
        'com0',
        'console.txt',
        'connect',
        'null',
        'a b/c.d',
        'lpt10.log',
        "quote'd.txt",
        'round (1).txt',
        'plus+and-and_.md',
        'semi;colon.txt',
      ];
      for (const path of portable) {
        const bundle = makeBundle({
          fileTrees: [
            {
              root: 'plugins/acme',
              entries: [{ path, sha256: 'a'.repeat(64), size: 1 }],
            },
          ],
        });
        expect(validateCapabilityBundle(bundle)).toEqual([]);
      }
    });

    it('rejects duplicate file tree destinations', () => {
      const dupSameTree = makeBundle({
        fileTrees: [
          {
            root: 'plugins/acme',
            entries: [
              { path: 'a.txt', sha256: 'a'.repeat(64), size: 1 },
              { path: 'a.txt', sha256: 'b'.repeat(64), size: 2 },
            ],
          },
        ],
      });
      const dupErrors = validateCapabilityBundle(dupSameTree);
      expect(dupErrors).toHaveLength(1);
      expect(dupErrors[0]).toContain('duplicate file tree destination');
      expect(dupErrors[0]).toContain('plugins/acme/a.txt');

      const dupAcrossTrees = makeBundle({
        fileTrees: [
          {
            root: 'plugins/acme',
            entries: [{ path: 'a.txt', sha256: 'a'.repeat(64), size: 1 }],
          },
          {
            root: 'plugins/acme',
            entries: [{ path: 'a.txt', sha256: 'b'.repeat(64), size: 2 }],
          },
        ],
      });
      expect(validateCapabilityBundle(dupAcrossTrees)).toHaveLength(1);
    });

    it('rejects bundles above the aggregate file-tree entry cap', () => {
      const entries = Array.from(
        { length: CAPABILITY_BUNDLE_MAX_FILE_TREE_ENTRIES + 1 },
        (_, index) => ({
          path: `file-${String(index)}.txt`,
          sha256: index.toString(16).padStart(64, '0'),
          size: 0,
        }),
      );

      expect(
        validateCapabilityBundle(
          makeBundle({ fileTrees: [{ root: 'plugins/acme', entries }] }),
        ),
      ).toEqual([
        `file trees exceed ${String(CAPABILITY_BUNDLE_MAX_FILE_TREE_ENTRIES)} aggregate entries`,
      ]);
    });

    it('rejects destinations where one is a directory prefix of another', () => {
      const fileThenNested = makeBundle({
        fileTrees: [
          {
            root: 'plugins/acme',
            entries: [
              { path: 'a', sha256: 'a'.repeat(64), size: 1 },
              { path: 'a/b', sha256: 'b'.repeat(64), size: 1 },
            ],
          },
        ],
      });
      const fileThenNestedErrors = validateCapabilityBundle(fileThenNested);
      expect(fileThenNestedErrors).toHaveLength(1);
      expect(fileThenNestedErrors[0]).toContain(
        'nested under file destination',
      );

      const nestedThenFile = makeBundle({
        fileTrees: [
          {
            root: 'plugins/acme',
            entries: [
              { path: 'a/b', sha256: 'a'.repeat(64), size: 1 },
              { path: 'a', sha256: 'b'.repeat(64), size: 1 },
            ],
          },
        ],
      });
      const nestedThenFileErrors = validateCapabilityBundle(nestedThenFile);
      expect(nestedThenFileErrors).toHaveLength(1);
      expect(nestedThenFileErrors[0]).toContain('is a directory prefix of');

      // Trees sharing a root prefix collide as materialized, across trees.
      const acrossTrees = makeBundle({
        fileTrees: [
          {
            root: 'plugins/acme',
            entries: [{ path: 'a', sha256: 'a'.repeat(64), size: 1 }],
          },
          {
            root: 'plugins/acme/a',
            entries: [{ path: 'x', sha256: 'b'.repeat(64), size: 1 }],
          },
        ],
      });
      expect(validateCapabilityBundle(acrossTrees)).toHaveLength(1);

      const ok = makeBundle({
        fileTrees: [
          {
            root: 'plugins/acme',
            entries: [
              { path: 'a/b', sha256: 'a'.repeat(64), size: 1 },
              { path: 'a/c', sha256: 'b'.repeat(64), size: 1 },
              { path: 'b', sha256: 'c'.repeat(64), size: 1 },
            ],
          },
          {
            root: 'plugins/other',
            entries: [{ path: 'a/b', sha256: 'd'.repeat(64), size: 1 }],
          },
        ],
      });
      expect(validateCapabilityBundle(ok)).toEqual([]);
    });

    it('rejects skill files colliding with the generated SKILL.md entrypoint', () => {
      // Adapters materialize supporting files next to the generated SKILL.md,
      // and case-only variants alias it on case-insensitive filesystems.
      const collisions = [
        'SKILL.md',
        'skill.md',
        'Skill.MD',
        'SKILL.md/nested.txt',
        'skill.MD/nested.txt',
      ];
      for (const path of collisions) {
        const bundle = makeBundle({
          skills: [makeSkill({ files: [{ path, content: '' }] })],
        });
        const errors = validateCapabilityBundle(bundle);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain(path);
        expect(errors[0]).toContain('SKILL.md entrypoint');
      }
      // A SKILL.md inside a subdirectory is a different destination.
      const ok = makeBundle({
        skills: [
          makeSkill({ files: [{ path: 'references/SKILL.md', content: '' }] }),
        ],
      });
      expect(validateCapabilityBundle(ok)).toEqual([]);
    });

    it('rejects duplicate and prefix-conflicting skill file paths', () => {
      const dup = makeBundle({
        skills: [
          makeSkill({
            files: [
              { path: 'docs/a.md', content: '1' },
              { path: 'docs/a.md', content: '2' },
            ],
          }),
        ],
      });
      const dupErrors = validateCapabilityBundle(dup);
      expect(dupErrors).toHaveLength(1);
      expect(dupErrors[0]).toContain('duplicate file path');

      // Case-only variants alias on case-insensitive filesystems.
      const caseDup = makeBundle({
        skills: [
          makeSkill({
            files: [
              { path: 'docs/A.md', content: '1' },
              { path: 'DOCS/a.md', content: '2' },
            ],
          }),
        ],
      });
      const caseDupErrors = validateCapabilityBundle(caseDup);
      expect(caseDupErrors).toHaveLength(1);
      expect(caseDupErrors[0]).toContain('case-insensitive');

      const fileThenNested = makeBundle({
        skills: [
          makeSkill({
            files: [
              { path: 'a', content: '' },
              { path: 'a/b', content: '' },
            ],
          }),
        ],
      });
      const fileThenNestedErrors = validateCapabilityBundle(fileThenNested);
      expect(fileThenNestedErrors).toHaveLength(1);
      expect(fileThenNestedErrors[0]).toContain('nested under file path');

      const nestedThenFile = makeBundle({
        skills: [
          makeSkill({
            files: [
              { path: 'a/b', content: '' },
              { path: 'a', content: '' },
            ],
          }),
        ],
      });
      const nestedThenFileErrors = validateCapabilityBundle(nestedThenFile);
      expect(nestedThenFileErrors).toHaveLength(1);
      expect(nestedThenFileErrors[0]).toContain('is a directory prefix of');

      // Each skill materializes into its own directory, so the same path in
      // two different skills does not collide.
      const acrossSkills = makeBundle({
        skills: [
          makeSkill({ files: [{ path: 'docs/a.md', content: '1' }] }),
          makeSkill({
            name: 'other-skill',
            files: [{ path: 'docs/a.md', content: '2' }],
          }),
        ],
      });
      expect(validateCapabilityBundle(acrossSkills)).toEqual([]);
    });

    it('rejects case-only file tree destination collisions', () => {
      // Case-preserving storage, casefolded comparison: `A/b` and `a/B` alias
      // the same on-disk path on case-insensitive filesystems (default macOS,
      // Windows).
      const caseDup = makeBundle({
        fileTrees: [
          {
            root: 'plugins/acme',
            entries: [
              { path: 'A.txt', sha256: 'a'.repeat(64), size: 1 },
              { path: 'a.txt', sha256: 'b'.repeat(64), size: 2 },
            ],
          },
        ],
      });
      const caseDupErrors = validateCapabilityBundle(caseDup);
      expect(caseDupErrors).toHaveLength(1);
      expect(caseDupErrors[0]).toContain('duplicate file tree destination');
      expect(caseDupErrors[0]).toContain('case-insensitive');

      const caseAcrossRoots = makeBundle({
        fileTrees: [
          {
            root: 'Plugins/Acme',
            entries: [{ path: 'a.txt', sha256: 'a'.repeat(64), size: 1 }],
          },
          {
            root: 'plugins/acme',
            entries: [{ path: 'A.txt', sha256: 'b'.repeat(64), size: 2 }],
          },
        ],
      });
      expect(validateCapabilityBundle(caseAcrossRoots)).toHaveLength(1);

      const casePrefix = makeBundle({
        fileTrees: [
          {
            root: 'plugins/acme',
            entries: [
              { path: 'A', sha256: 'a'.repeat(64), size: 1 },
              { path: 'a/b', sha256: 'b'.repeat(64), size: 1 },
            ],
          },
        ],
      });
      const casePrefixErrors = validateCapabilityBundle(casePrefix);
      expect(casePrefixErrors).toHaveLength(1);
      expect(casePrefixErrors[0]).toContain('nested under file destination');
    });

    it('rejects credential-bearing mcp headers', () => {
      const credentialHeaders = [
        'Authorization',
        'authorization',
        'Proxy-Authorization',
        'Cookie',
        'Set-Cookie',
        'X-Api-Key',
        'api-key',
        'apikey',
        'x-goog-api-key',
        // Token/secret suffixes and auth components — the secret-free
        // contract covers every credential spelling, not just authorization
        // and api-key shapes.
        'X-Auth-Token',
        'X-Access-Token',
        'X-Vault-Token',
        'Private-Token',
        'X-Client-Secret',
        'auth-token',
        'x-auth',
        'token',
        'secret',
        'x_refresh_token',
      ];
      for (const header of credentialHeaders) {
        const bundle = makeBundle({
          mcpServers: [makeServer({ headers: { [header]: 'top-secret' } })],
        });
        const errors = validateCapabilityBundle(bundle);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain(header);
        expect(errors[0]).toContain('credential-bearing');
      }
      const ok = makeBundle({
        mcpServers: [
          makeServer({
            headers: {
              'x-canopy-session': 'proxy-session',
              'content-type': 'application/json',
            },
          }),
        ],
      });
      expect(validateCapabilityBundle(ok)).toEqual([]);
    });

    it('keeps benign non-credential header names valid', () => {
      // Names that contain credential-adjacent letters but are not
      // credential spellings: `auth` only as part of a longer word,
      // `token`/`secret` only as a non-final or embedded component.
      const benignHeaders = [
        'content-type',
        'x-request-id',
        'user-agent',
        'accept-language',
        'x-author-id',
        'x-tokenizer-mode',
        'x-secrets-scanner-version',
        'x-canopy-session',
      ];
      for (const header of benignHeaders) {
        const bundle = makeBundle({
          mcpServers: [makeServer({ headers: { [header]: 'benign' } })],
        });
        expect(validateCapabilityBundle(bundle)).toEqual([]);
      }
    });

    it('enforces the allowed mcp origin policy when provided', () => {
      const vendor = makeBundle({
        mcpServers: [makeServer({ url: 'https://api.vendor.test/mcp' })],
      });
      const errors = validateCapabilityBundle(vendor, {
        allowedMcpOrigins: ['https://proxy.canopy.example'],
      });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('api.vendor.test');
      expect(errors[0]).toContain('allowed MCP proxy origin');

      // Matching proxy origin passes, including when the policy entry needs
      // URL normalization (trailing slash / path stripped to origin).
      expect(
        validateCapabilityBundle(makeBundle(), {
          allowedMcpOrigins: ['https://proxy.canopy.example/'],
        }),
      ).toEqual([]);

      // An empty policy is an explicit "no MCP origins" stance.
      expect(
        validateCapabilityBundle(makeBundle(), { allowedMcpOrigins: [] }),
      ).toHaveLength(1);

      // Without a policy, no origin restriction applies (producers MUST pass
      // their proxy origin policy to get proxy-only enforcement).
      expect(validateCapabilityBundle(vendor)).toEqual([]);
    });

    it('rejects the reserved harness-tools server name', () => {
      const bundle = makeBundle({
        mcpServers: [
          makeServer({ name: CAPABILITY_BUNDLE_RESERVED_MCP_SERVER_NAME }),
        ],
      });
      const errors = validateCapabilityBundle(bundle);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('harness-tools');
      expect(errors[0]).toContain('reserved');
    });

    it('rejects duplicate mcp server names', () => {
      const bundle = makeBundle({ mcpServers: [makeServer(), makeServer()] });
      expect(validateCapabilityBundle(bundle)).toEqual([
        'duplicate mcp server name "acme-tools"',
      ]);
    });

    it('rejects non-http(s) or hostless mcp urls', () => {
      const bad = [
        'wss://a.example',
        'ftp://a.example',
        'https://',
        'http:///path',
        'acme.example',
        'http://a b.example',
        'https://user:pw@a.example/mcp',
      ];
      for (const url of bad) {
        const bundle = makeBundle({ mcpServers: [makeServer({ url })] });
        expect(validateCapabilityBundle(bundle)).toHaveLength(1);
      }
      const good = makeBundle({
        mcpServers: [makeServer({ url: 'http://localhost:3118/mcp?x=1' })],
      });
      expect(validateCapabilityBundle(good)).toEqual([]);
    });

    it('accumulates every error so consumers can reject atomically', () => {
      const bundle = makeBundle({
        skills: [makeSkill({ name: 'a/b' }), makeSkill({ name: 'a/b' })],
        mcpServers: [makeServer({ name: 'harness-tools', url: 'nope' })],
      });
      expect(validateCapabilityBundle(bundle).length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('serializeCanonicalCapabilityBundle', () => {
    it('is stable across key insertion order', () => {
      const bundle = makeBundle({
        mcpServers: [makeServer({ headers: { b: '2', a: '1' } })],
      });
      const reordered = structuredClone(bundle);
      // Rebuild with reversed key insertion order at every object level.
      const shuffled: CapabilityBundleV1 = {
        warnings: reordered.warnings,
        provenance: reordered.provenance,
        mcpServers: [
          {
            headers: { a: '1', b: '2' },
            url: reordered.mcpServers[0].url,
            name: reordered.mcpServers[0].name,
          },
        ],
        skills: reordered.skills.map((s) => ({
          content: s.content,
          description: s.description,
          name: s.name,
        })),
        instructions: reordered.instructions,
        version: reordered.version,
      };

      expect(serializeCanonicalCapabilityBundle(shuffled)).toBe(
        serializeCanonicalCapabilityBundle(bundle),
      );
    });

    it('sorts provenance.resolved by (kind, ref) but keeps other arrays', () => {
      const base = makeBundle();
      const swapped = makeBundle({
        provenance: {
          ...base.provenance,
          resolved: [...base.provenance.resolved].reverse(),
        },
      });
      expect(serializeCanonicalCapabilityBundle(swapped)).toBe(
        serializeCanonicalCapabilityBundle(base),
      );

      const reorderedInstructions = makeBundle({
        instructions: ['b', 'a'],
      });
      const producerOrder = makeBundle({ instructions: ['a', 'b'] });
      expect(
        serializeCanonicalCapabilityBundle(reorderedInstructions),
      ).not.toBe(serializeCanonicalCapabilityBundle(producerOrder));
    });

    it('keeps a "__proto__" header key so it cannot collide with a digest', () => {
      // `JSON.parse` on wire data makes `__proto__` a real own property that
      // the structural guard accepts, so it reaches the canonicalizer;
      // `Object.fromEntries` reproduces that shape without an `any` parse
      // result. It must survive into the canonical string: dropping it would
      // give a bundle carrying the header and one without it the same digest.
      const headerEntries: [string, string][] = [
        ['__proto__', 'x'],
        ['a', '1'],
      ];
      const headers: Record<string, string> = Object.fromEntries(headerEntries);
      const withProto = makeBundle({
        mcpServers: [makeServer({ headers })],
      });
      expect(isCapabilityBundleMcpServer(withProto.mcpServers[0])).toBe(true);
      const withoutProto = makeBundle({
        mcpServers: [makeServer({ headers: { a: '1' } })],
      });

      const serialized = serializeCanonicalCapabilityBundle(withProto);
      expect(serialized).toContain('"__proto__":"x"');
      expect(serialized).not.toBe(
        serializeCanonicalCapabilityBundle(withoutProto),
      );
    });

    it('omits absent optional fields so digests stay stable', () => {
      const serialized = serializeCanonicalCapabilityBundle(makeBundle());
      expect(serialized).not.toContain('fileTrees');
      expect(serialized).not.toContain('"files"');
      expect(serialized).not.toContain('"headers"');
      expect(JSON.parse(serialized)).toBeTruthy();
    });
  });

  describe('digest helpers', () => {
    it('formats and recognizes digests', () => {
      const digest = formatCapabilityBundleDigest('abc123_-XYZ');
      expect(digest).toBe(`${CAPABILITY_BUNDLE_DIGEST_PREFIX}abc123_-XYZ`);
      expect(isCapabilityBundleDigest(digest)).toBe(true);
    });

    it('rejects malformed digests', () => {
      expect(isCapabilityBundleDigest('cb:v1:')).toBe(false);
      expect(isCapabilityBundleDigest('cb:v2:abc')).toBe(false);
      expect(isCapabilityBundleDigest('abc')).toBe(false);
      expect(isCapabilityBundleDigest('cb:v1:has space')).toBe(false);
      expect(isCapabilityBundleDigest('cb:v1:has+plus')).toBe(false);
      expect(isCapabilityBundleDigest('cb:v1:has=pad')).toBe(false);
    });
  });

  describe('per-harness projections', () => {
    it('emits the Claude Agent SDK http server map', () => {
      const bundle = makeBundle({
        mcpServers: [
          makeServer(),
          makeServer({
            name: 'other',
            url: 'https://proxy.canopy.example/mcp/other',
            headers: { 'x-session': 's' },
          }),
        ],
      });
      expect(projectMcpServersForClaudeCode(bundle)).toEqual({
        'acme-tools': {
          type: 'http',
          url: 'https://proxy.canopy.example/mcp/acme',
        },
        other: {
          type: 'http',
          url: 'https://proxy.canopy.example/mcp/other',
          headers: { 'x-session': 's' },
        },
      });
    });

    it('emits the Codex config.toml mcp_servers map', () => {
      const bundle = makeBundle({
        mcpServers: [
          makeServer(),
          makeServer({
            name: 'other',
            url: 'https://proxy.canopy.example/mcp/other',
            headers: { 'x-session': 's' },
          }),
        ],
      });
      expect(projectMcpServersForCodex(bundle)).toEqual({
        'acme-tools': { url: 'https://proxy.canopy.example/mcp/acme' },
        other: {
          url: 'https://proxy.canopy.example/mcp/other',
          http_headers: { 'x-session': 's' },
        },
      });
    });

    it('materializes a server named "__proto__" as an own entry', () => {
      // A `__proto__` server name is a fully valid bundle, so the projections
      // must not let it reassign the map's prototype and vanish — a validated
      // bundle would then be applied only partially.
      const bundle = makeBundle({
        mcpServers: [makeServer({ name: '__proto__' })],
      });

      const claude = projectMcpServersForClaudeCode(bundle);
      expect(Object.keys(claude)).toEqual(['__proto__']);
      expect(Object.getPrototypeOf(claude)).toBe(Object.prototype);
      expect(
        Object.getOwnPropertyDescriptor(claude, '__proto__')?.value,
      ).toEqual({ type: 'http', url: 'https://proxy.canopy.example/mcp/acme' });

      const codex = projectMcpServersForCodex(bundle);
      expect(Object.keys(codex)).toEqual(['__proto__']);
      expect(Object.getPrototypeOf(codex)).toBe(Object.prototype);
      expect(
        Object.getOwnPropertyDescriptor(codex, '__proto__')?.value,
      ).toEqual({ url: 'https://proxy.canopy.example/mcp/acme' });
    });
  });

  describe('hot-swap wire types', () => {
    const ref = { version: 1, digest: 'cb:v1:abc123' };

    it('validates bundle refs', () => {
      expect(isCapabilityBundleRef(ref)).toBe(true);
      expect(isCapabilityBundleRef({ version: 1 })).toBe(false);
      expect(isCapabilityBundleRef({ version: '1', digest: 'cb:v1:a' })).toBe(
        false,
      );
      expect(isCapabilityBundleRef({ version: 1, digest: '' })).toBe(false);
      expect(isCapabilityBundleRef(null)).toBe(false);
    });

    it('rejects refs whose version is not a positive integer', () => {
      expect(isCapabilityBundleRef({ ...ref, version: 0 })).toBe(false);
      expect(isCapabilityBundleRef({ ...ref, version: -1 })).toBe(false);
      expect(isCapabilityBundleRef({ ...ref, version: 1.5 })).toBe(false);
      expect(isCapabilityBundleRef({ ...ref, version: Number.NaN })).toBe(
        false,
      );
    });

    it('rejects refs whose digest is not a formatted bundle digest', () => {
      expect(isCapabilityBundleRef({ version: 1, digest: 'abc123' })).toBe(
        false,
      );
      expect(
        isCapabilityBundleRef({ version: 1, digest: 'sha256:abc123' }),
      ).toBe(false);
      expect(
        isCapabilityBundleRef({ version: 1, digest: 'cb:v1:not+valid/=' }),
      ).toBe(false);
      expect(isCapabilityBundleRef({ version: 1, digest: 'cb:v1:' })).toBe(
        false,
      );
    });

    it('validates session state with optional active/pending refs', () => {
      expect(isCapabilityBundleSessionState({})).toBe(true);
      expect(isCapabilityBundleSessionState({ activeBundle: ref })).toBe(true);
      expect(
        isCapabilityBundleSessionState({
          activeBundle: ref,
          pendingBundle: ref,
        }),
      ).toBe(true);
      expect(
        isCapabilityBundleSessionState({ pendingBundle: { digest: 'x' } }),
      ).toBe(false);
      expect(isCapabilityBundleSessionState(null)).toBe(false);
    });

    it('validates applied events', () => {
      const event = {
        sessionId: 'session-1',
        digest: 'cb:v1:abc123',
        appliedAtTurn: 3,
      };
      expect(isCapabilityBundleAppliedEvent(event)).toBe(true);
      expect(
        isCapabilityBundleAppliedEvent({
          ...event,
          previousDigest: 'cb:v1:old',
        }),
      ).toBe(true);
      expect(JSON.parse(JSON.stringify(event))).toEqual(event);
      expect(isCapabilityBundleAppliedEvent({ ...event, sessionId: '' })).toBe(
        false,
      );
      expect(
        isCapabilityBundleAppliedEvent({ ...event, appliedAtTurn: -1 }),
      ).toBe(false);
      expect(
        isCapabilityBundleAppliedEvent({ ...event, appliedAtTurn: 1.5 }),
      ).toBe(false);
      expect(
        isCapabilityBundleAppliedEvent({ ...event, previousDigest: 7 }),
      ).toBe(false);
      expect(
        isCapabilityBundleAppliedEvent({ ...event, previousDigest: '' }),
      ).toBe(false);
      expect(
        isCapabilityBundleAppliedEvent({ ...event, digest: 'abc123' }),
      ).toBe(false);
      expect(
        isCapabilityBundleAppliedEvent({
          ...event,
          digest: 'cb:v1:not+valid/=',
        }),
      ).toBe(false);
      expect(
        isCapabilityBundleAppliedEvent({ ...event, previousDigest: 'old' }),
      ).toBe(false);
      expect(isCapabilityBundleAppliedEvent(null)).toBe(false);
    });
  });
});

describe('account MCP bundle metadata', () => {
  function digest(bundle: CapabilityBundleV1): string {
    return formatCapabilityBundleDigest(
      createHash('sha256')
        .update(serializeCanonicalCapabilityBundle(bundle))
        .digest('base64url'),
    );
  }

  it('preserves every pre-account golden digest and canonical wire bytes', () => {
    for (const vector of goldenVectors.vectors) {
      const payload = vector.bundle.payload;
      if (!isCapabilityBundleV1(payload))
        throw new Error('Invalid golden vector');
      expect(digest(payload)).toBe(vector.bundle.digest);
      if (vector.name === 'populated-canonical-wire') {
        expect(serializeCanonicalCapabilityBundle(payload)).toBe(
          JSON.stringify(payload),
        );
      }
    }
  });

  it('checks optional metadata structurally', () => {
    expect(
      isCapabilityBundleMcpServer(
        makeServer({ displayName: 'Linear', enabledTools: ['search'] }),
      ),
    ).toBe(true);
    expect(
      isCapabilityBundleMcpServer(
        makeServer({ displayName: '', enabledTools: [] }),
      ),
    ).toBe(true);
    for (const metadata of [
      { displayName: 12 },
      { displayName: null },
      { enabledTools: 'search' },
      { enabledTools: null },
      { enabledTools: [12] },
      { enabledTools: [''] },
    ]) {
      expect(
        isCapabilityBundleMcpServer({ ...makeServer(), ...metadata }),
      ).toBe(false);
    }
  });

  it('serializes metadata in fixed order and sorts/deduplicates tools without mutation', () => {
    const server = makeServer({
      displayName: 'Linear',
      enabledTools: ['z', 'a', 'z'],
    });
    const canonical = serializeCanonicalCapabilityBundle(
      makeBundle({ mcpServers: [server] }),
    );
    expect(canonical).toContain(
      '"mcpServers":[{"name":"acme-tools","url":"https://proxy.canopy.example/mcp/acme","displayName":"Linear","enabledTools":["a","z"]}]',
    );
    expect(server.enabledTools).toEqual(['z', 'a', 'z']);
    expect(canonical).toBe(
      serializeCanonicalCapabilityBundle(
        makeBundle({
          mcpServers: [
            makeServer({ enabledTools: ['a', 'z'], displayName: 'Linear' }),
          ],
        }),
      ),
    );
  });

  it('changes the digest with tool selection, presence, or display name', () => {
    const original = digest(makeBundle());
    const selected = digest(
      makeBundle({ mcpServers: [makeServer({ enabledTools: ['search'] })] }),
    );
    expect(selected).not.toBe(original);
    expect(selected).not.toBe(
      digest(
        makeBundle({ mcpServers: [makeServer({ enabledTools: ['fetch'] })] }),
      ),
    );
    expect(original).not.toBe(
      digest(makeBundle({ mcpServers: [makeServer({ enabledTools: [] })] })),
    );
    expect(original).not.toBe(
      digest(
        makeBundle({ mcpServers: [makeServer({ displayName: 'Linear' })] }),
      ),
    );
  });

  it('keeps Claude SDK keys valid and projects the Codex allow-list', () => {
    const bundle = makeBundle({
      mcpServers: [
        makeServer({
          displayName: 'Linear',
          enabledTools: ['search'],
          headers: { 'x-session': 'session' },
        }),
      ],
    });
    expect(projectMcpServersForClaudeCode(bundle)).toEqual({
      'acme-tools': {
        type: 'http',
        url: bundle.mcpServers[0].url,
        headers: { 'x-session': 'session' },
      },
    });
    expect(projectMcpServersForCodex(bundle)).toEqual({
      'acme-tools': {
        url: bundle.mcpServers[0].url,
        http_headers: { 'x-session': 'session' },
        enabled_tools: ['search'],
      },
    });
    expect(
      projectMcpServersForCodex(
        makeBundle({ mcpServers: [makeServer({ enabledTools: [] })] }),
      )['acme-tools'],
    ).toHaveProperty('enabled_tools', []);
    expect(
      projectMcpServersForCodex(makeBundle())['acme-tools'],
    ).not.toHaveProperty('enabled_tools');
  });

  it('caps MCP servers at 16', () => {
    expect(CAPABILITY_BUNDLE_MAX_MCP_SERVERS).toBe(16);
    const servers = Array.from({ length: 17 }, (_, index) =>
      makeServer({ name: `server-${String(index)}` }),
    );
    expect(
      validateCapabilityBundle(
        makeBundle({ mcpServers: servers.slice(0, 16) }),
      ),
    ).toEqual([]);
    expect(
      validateCapabilityBundle(makeBundle({ mcpServers: servers })),
    ).toEqual(['mcp servers exceed 16 entries']);
  });

  it('rejects empty/duplicate tools and labels longer than 120 characters', () => {
    expect(
      validateCapabilityBundle(
        makeBundle({
          mcpServers: [
            makeServer({
              displayName: 'x'.repeat(120),
              enabledTools: ['search', 'fetch'],
            }),
          ],
        }),
      ),
    ).toEqual([]);
    expect(
      validateCapabilityBundle(
        makeBundle({
          mcpServers: [makeServer({ displayName: 'x'.repeat(121) })],
        }),
      ),
    ).toEqual([expect.stringContaining('displayName exceeds 120 characters')]);
    expect(
      validateCapabilityBundle(
        makeBundle({ mcpServers: [makeServer({ enabledTools: [''] })] }),
      ),
    ).toEqual([
      expect.stringContaining('enabledTools contains an empty string'),
    ]);
    expect(
      validateCapabilityBundle(
        makeBundle({
          mcpServers: [makeServer({ enabledTools: ['search', 'search'] })],
        }),
      ),
    ).toEqual([
      expect.stringContaining('duplicate enabledTools entry "search"'),
    ]);
  });
});

describe('skipped account MCP servers (REG-3030)', () => {
  const skipped = [
    {
      serverId: 'linear',
      configId: 'default',
      via: {
        kind: 'plugin' as const,
        marketplaceId: 'cloud-curated',
        pluginName: 'linear',
      },
      reason: 'not_connected' as const,
    },
    {
      serverId: 'custom:abc',
      configId: 'work',
      via: { kind: 'direct' as const },
      reason: 'needs_reconnect' as const,
    },
  ];

  it('keeps the canonical bytes of a bundle that skipped nothing', () => {
    const bundle = makeBundle();
    expect(serializeCanonicalCapabilityBundle(bundle)).not.toContain(
      'skippedMcpServers',
    );
  });

  it('serializes skipped servers in producer order after the resolved entries', () => {
    const bundle = makeBundle({
      provenance: { ...makeBundle().provenance, skippedMcpServers: skipped },
    });
    const canonical: unknown = JSON.parse(
      serializeCanonicalCapabilityBundle(bundle),
    );
    if (!isCapabilityBundleV1(canonical))
      throw new Error('canonical bundle is not a v1 bundle');
    expect(Object.keys(canonical.provenance)).toEqual([
      'collectionIds',
      'skillRefs',
      'pluginRefs',
      'mcpServerRefs',
      'resolved',
      'skippedMcpServers',
    ]);
    expect(canonical.provenance.skippedMcpServers).toEqual(skipped);
    expect(serializeCanonicalCapabilityBundle(bundle)).not.toBe(
      serializeCanonicalCapabilityBundle(makeBundle()),
    );
  });

  it('checks skipped servers structurally', () => {
    const provenance = makeBundle().provenance;
    expect(
      isCapabilityBundleProvenance({ ...provenance, skippedMcpServers: [] }),
    ).toBe(true);
    expect(
      isCapabilityBundleProvenance({
        ...provenance,
        skippedMcpServers: skipped,
      }),
    ).toBe(true);
    for (const entry of [
      { ...skipped[0], serverId: '' },
      { ...skipped[0], configId: 3 },
      { ...skipped[0], reason: 'gone' },
      { ...skipped[0], via: { kind: 'plugin', marketplaceId: 'm' } },
      { ...skipped[0], via: { kind: 'elsewhere' } },
    ]) {
      expect(
        isCapabilityBundleProvenance({
          ...provenance,
          skippedMcpServers: [entry],
        }),
      ).toBe(false);
    }
    expect(
      isCapabilityBundleProvenance({ ...provenance, skippedMcpServers: {} }),
    ).toBe(false);
  });
});

describe('unavailable capabilities (REG-3042)', () => {
  const records: CapabilityUnavailable[] = [
    {
      ref: {
        kind: 'mcpServer',
        serverId: 'server-1',
        configId: 'config-1',
        via: { kind: 'direct' },
      },
      displayName: 'Dropbox',
      reason: 'removed_from_catalog',
      disposition: 'gone',
    },
    {
      ref: {
        kind: 'mcpServer',
        serverId: 'linear',
        configId: 'default',
        via: { kind: 'plugin', marketplaceId: 'market-1', pluginName: 'acme' },
      },
      reason: 'not_connected',
      disposition: 'unavailable',
    },
    {
      ref: {
        kind: 'skill',
        sourceId: 'source-1',
        skillName: 'acme-review',
        via: { kind: 'direct' },
      },
      reason: 'invalid_skill',
      disposition: 'unavailable',
    },
    {
      ref: {
        kind: 'plugin',
        marketplaceId: 'market-1',
        pluginName: 'acme',
        via: { kind: 'direct' },
      },
      reason: 'awaiting_rematerialization',
      disposition: 'degraded',
    },
  ];

  function withRecords(
    unavailable: CapabilityUnavailable[] | undefined,
    warnings: string[] = ['skipped'],
  ): CapabilityBundleV1 {
    return makeBundle({
      provenance: {
        ...makeBundle().provenance,
        ...(unavailable === undefined ? {} : { unavailable }),
      },
      warnings,
    });
  }

  it('carries a recheck marker in the digest, and only when present', () => {
    const marked = records.map((record, index) =>
      index === 2
        ? { ...record, recheck: 'custom:2026-10-06T00:00:00.000Z' }
        : record,
    );
    expect(validateCapabilityBundle(withRecords(marked))).toEqual([]);
    const plain = serializeCanonicalCapabilityBundle(withRecords(records));
    const withMarker = serializeCanonicalCapabilityBundle(withRecords(marked));
    expect(plain).not.toContain('recheck');
    expect(withMarker).toContain('"recheck":"custom:2026-10-06T00:00:00.000Z"');
    expect(isCapabilityUnavailable(marked[2])).toBe(true);
    expect(isCapabilityUnavailable({ ...records[2], recheck: 7 })).toBe(false);
    expect(
      validateCapabilityBundle(
        withRecords([{ ...records[2], recheck: 'x'.repeat(201) }]),
      ).join('\n'),
    ).toContain('recheck marker over 200 characters');
  });

  it('keeps every golden digest and the canonical bytes of a bundle without records', () => {
    for (const vector of goldenVectors.vectors) {
      expect(JSON.stringify(vector.bundle.payload)).not.toContain(
        'unavailable',
      );
    }
    expect(serializeCanonicalCapabilityBundle(makeBundle())).not.toContain(
      'unavailable',
    );
  });

  it('serializes records in producer order after the skipped servers', () => {
    const bundle = makeBundle({
      provenance: {
        ...makeBundle().provenance,
        skippedMcpServers: [
          {
            serverId: 'linear',
            configId: 'default',
            via: {
              kind: 'plugin',
              marketplaceId: 'market-1',
              pluginName: 'acme',
            },
            reason: 'not_connected',
          },
        ],
        unavailable: [...records].reverse(),
      },
      warnings: ['skipped'],
    });
    const canonical: unknown = JSON.parse(
      serializeCanonicalCapabilityBundle(bundle),
    );
    if (!isCapabilityBundleV1(canonical))
      throw new Error('canonical bundle is not a v1 bundle');
    expect(Object.keys(canonical.provenance)).toEqual([
      'collectionIds',
      'skillRefs',
      'pluginRefs',
      'mcpServerRefs',
      'resolved',
      'skippedMcpServers',
      'unavailable',
    ]);
    expect(canonical.provenance.unavailable).toEqual([...records].reverse());
    expect(Object.keys(canonical.provenance.unavailable?.[3] ?? {})).toEqual([
      'ref',
      'displayName',
      'reason',
      'disposition',
    ]);
    expect(
      Object.keys(canonical.provenance.unavailable?.[2]?.ref ?? {}),
    ).toEqual(['kind', 'serverId', 'configId', 'via']);
  });

  it('is key-order independent and digests an empty record list apart from none', () => {
    const reordered: CapabilityUnavailable = {
      disposition: 'gone',
      reason: 'removed_from_catalog',
      displayName: 'Dropbox',
      ref: {
        via: { kind: 'direct' },
        configId: 'config-1',
        serverId: 'server-1',
        kind: 'mcpServer',
      },
    };
    expect(serializeCanonicalCapabilityBundle(withRecords([reordered]))).toBe(
      serializeCanonicalCapabilityBundle(withRecords([records[0]])),
    );
    expect(serializeCanonicalCapabilityBundle(withRecords([]))).not.toBe(
      serializeCanonicalCapabilityBundle(withRecords(undefined)),
    );
  });

  it('checks records structurally', () => {
    for (const record of records)
      expect(isCapabilityUnavailable(record)).toBe(true);
    const provenance = makeBundle().provenance;
    expect(
      isCapabilityBundleProvenance({ ...provenance, unavailable: records }),
    ).toBe(true);
    expect(
      isCapabilityBundleProvenance({ ...provenance, unavailable: [] }),
    ).toBe(true);
    for (const entry of [
      { ...records[0], reason: '' },
      { ...records[0], disposition: 3 },
      { ...records[0], displayName: 7 },
      { ...records[0], ref: { ...records[0].ref, kind: 'collection' } },
      {
        ...records[0],
        ref: { kind: 'skill', sourceId: 's', via: { kind: 'direct' } },
      },
      {
        ...records[0],
        ref: { ...records[0].ref, via: { kind: 'plugin', marketplaceId: 'm' } },
      },
      { ...records[0], ref: { ...records[0].ref, via: undefined } },
    ]) {
      expect(isCapabilityUnavailable(entry)).toBe(false);
      expect(
        isCapabilityBundleProvenance({ ...provenance, unavailable: [entry] }),
      ).toBe(false);
    }
    expect(
      isCapabilityBundleProvenance({ ...provenance, unavailable: {} }),
    ).toBe(false);
  });

  // A newer producer may record a reason or disposition this reader does
  // not know. That must never invalidate the provenance or the bundle, and
  // must never prune: the record reads as degraded (kept).
  it('reads a reason or disposition from a newer producer as degraded', () => {
    const futureReason = { ...records[0], reason: 'quarantined' };
    const futureDisposition = { ...records[0], disposition: 'retired' };
    const bundle = makeBundle({
      provenance: {
        ...makeBundle().provenance,
        unavailable: [futureReason, futureDisposition],
      },
      warnings: ['skipped'],
    });
    expect(isCapabilityUnavailable(futureReason)).toBe(true);
    expect(isCapabilityBundleV1(JSON.parse(JSON.stringify(bundle)))).toBe(true);
    expect(capabilityUnavailableDisposition(futureReason)).toBe('degraded');
    expect(capabilityUnavailableDisposition(futureDisposition)).toBe(
      'degraded',
    );
    expect(capabilityUnavailableDisposition(records[0])).toBe('gone');
    expect(capabilityUnavailableDisposition(records[1])).toBe('unavailable');
  });

  it('keeps the producer strict about what it emits', () => {
    expect(
      validateCapabilityBundle(
        withRecords([{ ...records[0], reason: 'quarantined' }]),
      ),
    ).toEqual([
      'provenance.unavailable record for mcpServer "server-1/config-1" has an unknown reason "quarantined"',
    ]);
    expect(
      validateCapabilityBundle(
        withRecords([{ ...records[0], disposition: 'retired' }]),
      ),
    ).toEqual([
      'provenance.unavailable record for mcpServer "server-1/config-1" has an unknown disposition "retired"',
    ]);
  });

  it('tells a legacy bundle from one that recorded its skips as data', () => {
    expect(isLegacyCapabilityBundleProvenance(withRecords(undefined, []))).toBe(
      false,
    );
    expect(isLegacyCapabilityBundleProvenance(withRecords(undefined))).toBe(
      true,
    );
    expect(isLegacyCapabilityBundleProvenance(withRecords([]))).toBe(false);
    expect(isLegacyCapabilityBundleProvenance(withRecords(records))).toBe(
      false,
    );
  });

  it('validates record invariants', () => {
    expect(validateCapabilityBundle(withRecords(records))).toEqual([]);
    expect(validateCapabilityBundle(withRecords([], []))).toEqual([
      'provenance.unavailable is present but the bundle has no warnings',
    ]);
    expect(
      validateCapabilityBundle(withRecords([records[0], records[0]])),
    ).toEqual([
      'provenance.unavailable has a duplicate record for mcpServer "server-1/config-1"',
    ]);
    expect(
      validateCapabilityBundle(
        withRecords([{ ...records[0], displayName: 'x'.repeat(121) }]),
      ),
    ).toEqual([
      'provenance.unavailable record for mcpServer "server-1/config-1" has a displayName over 120 characters',
    ]);
    expect(
      validateCapabilityBundle(
        withRecords([
          {
            ...records[2],
            ref: { ...records[2].ref, kind: 'skill', skillName: 'other' },
          },
        ]),
      ),
    ).toEqual([
      'provenance.unavailable record for skill "source-1/other" names a ref the selection does not',
    ]);
    expect(
      validateCapabilityBundle(
        withRecords([
          {
            ...records[1],
            ref: {
              ...records[1].ref,
              via: {
                kind: 'plugin',
                marketplaceId: 'market-1',
                pluginName: 'other',
              },
            },
          },
        ]),
      ),
    ).toEqual([
      'provenance.unavailable record for mcpServer "linear/default" names a plugin the selection does not',
    ]);
  });
});

describe('catalog brand (REG-3042)', () => {
  function withBrand(catalogBrand: string | undefined): CapabilityBundleV1 {
    return makeBundle({
      provenance: {
        ...makeBundle().provenance,
        ...(catalogBrand === undefined ? {} : { catalogBrand }),
      },
    });
  }

  it('keeps every golden digest and the canonical bytes of a bundle without it', () => {
    for (const vector of goldenVectors.vectors) {
      expect(JSON.stringify(vector.bundle.payload)).not.toContain(
        'catalogBrand',
      );
    }
    expect(serializeCanonicalCapabilityBundle(withBrand(undefined))).toBe(
      serializeCanonicalCapabilityBundle(makeBundle()),
    );
    expect(serializeCanonicalCapabilityBundle(makeBundle())).not.toContain(
      'catalogBrand',
    );
  });

  it('digests the brand a bundle was built with, after the unavailable records', () => {
    const bundle = makeBundle({
      provenance: {
        ...makeBundle().provenance,
        unavailable: [],
        catalogBrand: 'canopy',
      },
      warnings: ['skipped'],
    });
    const canonical: unknown = JSON.parse(
      serializeCanonicalCapabilityBundle(bundle),
    );
    if (!isCapabilityBundleV1(canonical))
      throw new Error('canonical bundle is not a v1 bundle');
    expect(Object.keys(canonical.provenance)).toEqual([
      'collectionIds',
      'skillRefs',
      'pluginRefs',
      'mcpServerRefs',
      'resolved',
      'unavailable',
      'catalogBrand',
    ]);
    expect(canonical.provenance.catalogBrand).toBe('canopy');
    expect(serializeCanonicalCapabilityBundle(withBrand('canopy'))).not.toBe(
      serializeCanonicalCapabilityBundle(withBrand('unstoppable-code')),
    );
  });

  it('checks the brand structurally and keeps the producer strict about it', () => {
    const provenance = makeBundle().provenance;
    expect(
      isCapabilityBundleProvenance({ ...provenance, catalogBrand: 'canopy' }),
    ).toBe(true);
    expect(
      isCapabilityBundleProvenance({ ...provenance, catalogBrand: 7 }),
    ).toBe(false);
    expect(validateCapabilityBundle(withBrand('canopy'))).toEqual([]);
    expect(validateCapabilityBundle(withBrand(''))).toEqual([
      'provenance.catalogBrand is empty',
    ]);
    expect(
      validateCapabilityBundle(
        withBrand('x'.repeat(CAPABILITY_BUNDLE_CATALOG_BRAND_MAX_LENGTH + 1)),
      ),
    ).toEqual([
      `provenance.catalogBrand is over ${String(CAPABILITY_BUNDLE_CATALOG_BRAND_MAX_LENGTH)} characters`,
    ]);
    expect(CAPABILITY_BUNDLE_CATALOG_BRAND_MAX_LENGTH).toBe(64);
  });
});
