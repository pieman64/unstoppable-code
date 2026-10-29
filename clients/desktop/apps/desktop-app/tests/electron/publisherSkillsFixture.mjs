import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { handleCloudRequest } from './mock-server/routes/cloud.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** Many screens of README, so whatever follows it starts below the fold. */
const LONG_README = Array.from(
  { length: 60 },
  (_, index) =>
    `\n## Section ${index + 1}\n\nGuidance for step ${index + 1} of the review.\n`,
).join('');
export const publisherSkills = [
  {
    externalId: 'eabf18fc-628c-5405-9b19-39fc36bd0c41',
    name: 'publisher-design-guide',
    /** What the Marketplace row and review title show for this skill. */
    displayName: 'Publisher Design Guide',
    publisher: 'Anthropic',
    wrapped: false,
    readme: LONG_README,
    /** A file that runs as a program, which the review names before Install. */
    script: { path: 'scripts/check.sh', body: '#!/bin/sh\necho checked\n' },
  },
  {
    externalId: '71d31180-12b9-58c4-a204-44fa0136c05f',
    name: 'publisher-data-analysis',
    displayName: 'Publisher Data Analysis',
    publisher: 'OpenAI',
    wrapped: true,
  },
].map((skill) => {
  const description = `${skill.publisher} guidance for a reviewed publisher skill.`;
  const frontmatter = `---\nname: ${skill.name}\ndescription: ${description}\n---\n`;
  const upstream = `${frontmatter}\nRead references/guide.md before answering.\n${skill.readme ?? ''}`;
  const rawSkill = skill.wrapped
    ? `${frontmatter}\nRead .upstream/skills/${skill.name}/SKILL.md and resolve paths relative to that file.\n`
    : upstream;
  const prefix = skill.wrapped ? `.upstream/skills/${skill.name}/` : '';
  const files = [
    { path: 'SKILL.md', body: rawSkill },
    ...(skill.wrapped ? [{ path: `${prefix}SKILL.md`, body: upstream }] : []),
    {
      path: `${prefix}references/guide.md`,
      body: '# Publisher guide\nVerify the result.\n',
    },
    { path: `${prefix}LICENSE`, body: 'MIT License\n' },
    ...(skill.script
      ? [
          {
            ...skill.script,
            path: `${prefix}${skill.script.path}`,
            mode: 'execute',
          },
        ]
      : []),
  ].map((file) => ({
    ...file,
    sha256: hash(file.body),
    size: Buffer.byteLength(file.body),
    mode: file.mode ?? 'read',
  }));
  const contentHash = hash(rawSkill);
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  const manifest = {
    version: 1,
    pipelineContentHash: contentHash,
    resources: [
      {
        id: 'skill',
        kind: 'standalone_skill',
        displayName: skill.name,
        sourceLabel: skill.publisher,
        sourceVisibility: 'public',
        invocationKeys: [`/${skill.name}`],
        dependencyResourceIds: [],
        trees: [
          {
            provider: 'claude',
            runtimeKind: 'standalone_skill',
            rootName: skill.name,
            entries: files
              .map(({ path, sha256, size, mode }) => ({
                path,
                sha256,
                size,
                mode,
              }))
              // Match the package verifier's locale-independent canonical order.
              .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
          },
        ],
      },
    ],
    bindings: [{ target: 'subject', resourceIds: ['skill'] }],
    environmentRequirements: [],
    totalFiles: files.length,
    totalBytes,
  };
  const digest = `pp:v1:${createHash('sha256').update(JSON.stringify(manifest)).digest('base64url')}`;
  return {
    ...skill,
    description,
    files,
    manifest,
    digest,
    snapshot: {
      entity: 'skill',
      externalId: skill.externalId,
      name: skill.name,
      description,
      rawSkill,
      contentHash,
      dependencies: [],
      authorUsername: null,
      updatedAt: '2026-09-30T00:00:00.000Z',
      distributionMode: 'package',
      publisher: {
        name: skill.publisher,
        license: 'MIT',
        pluginName: 'reviewed-skills',
        sourceUrl: `https://github.com/${skill.wrapped ? 'openai/plugins' : 'anthropics/skills'}/tree/${'a'.repeat(40)}/skills/${skill.name}`,
      },
      package: {
        version: 1,
        digest,
        resources: [
          {
            id: 'skill',
            displayName: skill.name,
            kind: 'standalone_skill',
            sourceLabel: skill.publisher,
            fileCount: files.length,
            totalBytes,
            affectedSteps: [],
            executableFiles: files
              .filter((file) => file.mode === 'execute')
              .map((file) => file.path),
          },
        ],
        environmentRequirements: [],
        totalFiles: files.length,
        totalBytes,
      },
    },
  };
});

/** Loopback HTTP fixture: real main/preload/renderer and verified package writes. */
export async function startPublisherSkillsFixture() {
  const state = {
    listFailure: false,
    packageFailure: false,
    hidden: false,
    requests: [],
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    state.requests.push(url.pathname);
    const json = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === '/api/v1/marketplace/skills') {
      json(
        state.listFailure ? 503 : 200,
        state.listFailure
          ? { error: 'Try again.' }
          : {
              skills: state.hidden
                ? []
                : publisherSkills.map(
                    ({ externalId, name, description, publisher }) => ({
                      externalId,
                      name,
                      description,
                      publisher,
                    }),
                  ),
            },
      );
      return;
    }
    const skill = publisherSkills.find((row) =>
      url.pathname.includes(row.externalId),
    );
    if (skill) {
      if (state.hidden) {
        json(404, { error: 'Share not found' });
        return;
      }
      if (url.pathname.endsWith(skill.externalId)) {
        json(200, skill.snapshot);
        return;
      }
      if (url.searchParams.get('expectedPackageDigest') !== skill.digest) {
        json(409, { error: 'Share changed' });
        return;
      }
      if (url.pathname.endsWith('/package')) {
        if (state.packageFailure) {
          json(503, { error: 'Package temporarily unavailable' });
          return;
        }
        json(200, { digest: skill.digest, manifest: skill.manifest });
        return;
      }
      const file = skill.files.find((candidate) =>
        url.pathname.endsWith(`/blobs/${candidate.sha256}`),
      );
      if (file) {
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        response.end(file.body);
        return;
      }
    }
    if (!(await handleCloudRequest(request, response, url)))
      json(404, { error: 'Not found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    state,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}
