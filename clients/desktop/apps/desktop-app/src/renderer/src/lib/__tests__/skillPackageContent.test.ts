import type {
  PipelinePackageManifestV1,
  PipelinePackageResource,
} from '@canopy/protocol/pipelines';
import { skillPackageHasContent } from '../skillPackageContent';

const HASH = 'a'.repeat(64);

function skill(
  id: string,
  paths: string[],
  dependencyResourceIds: string[] = [],
  sha256: string = HASH,
): PipelinePackageResource {
  return {
    id,
    kind: 'standalone_skill',
    displayName: id,
    sourceLabel: 'custom:app',
    sourceVisibility: 'local',
    invocationKeys: [`/${id}`],
    dependencyResourceIds,
    trees: [
      {
        provider: 'claude',
        runtimeKind: 'standalone_skill',
        rootName: id,
        entries: paths.map((path) => ({
          path,
          sha256,
          size: 1,
          mode: 'read' as const,
        })),
      },
    ],
  };
}

function manifest(
  resources: PipelinePackageResource[],
  environmentRequirements: PipelinePackageManifestV1['environmentRequirements'] = [],
): PipelinePackageManifestV1 {
  return {
    version: 1,
    pipelineContentHash: HASH,
    resources,
    bindings: [{ target: 'subject', resourceIds: resources.map((r) => r.id) }],
    environmentRequirements,
    totalFiles: 1,
    totalBytes: 1,
  };
}

describe('skillPackageHasContent', () => {
  // The analysis always binds the skill itself, so this is what a single-file
  // skill produces. It must share definition-only, exactly as before packages.
  it('treats the skill alone with only its SKILL.md as nothing to carry', () => {
    expect(
      skillPackageHasContent(manifest([skill('helper', ['SKILL.md'])])),
    ).toBe(false);
  });

  // What a real single-file custom skill produces: the analysis emits one
  // resource per provider, each holding the same bare SKILL.md.
  it('treats the Claude and Codex copies of the bare skill as nothing to carry', () => {
    expect(
      skillPackageHasContent(
        manifest([
          skill('helper', ['SKILL.md']),
          skill('$helper', ['SKILL.md']),
        ]),
      ),
    ).toBe(false);
  });

  it('carries a different skill even when it is only a SKILL.md', () => {
    expect(
      skillPackageHasContent(
        manifest([
          skill('helper', ['SKILL.md']),
          skill('other', ['SKILL.md'], [], 'b'.repeat(64)),
        ]),
      ),
    ).toBe(true);
  });

  it('is false for an absent manifest', () => {
    expect(skillPackageHasContent(null)).toBe(false);
    expect(skillPackageHasContent(undefined)).toBe(false);
  });

  it('carries a supporting file beside SKILL.md', () => {
    expect(
      skillPackageHasContent(
        manifest([skill('helper', ['SKILL.md', 'references/guide.md'])]),
      ),
    ).toBe(true);
  });

  it('carries an invoked dependency', () => {
    expect(
      skillPackageHasContent(
        manifest([
          skill('helper', ['SKILL.md'], ['sibling']),
          skill('sibling', ['SKILL.md']),
        ]),
      ),
    ).toBe(true);
  });

  it('carries an environment requirement', () => {
    expect(
      skillPackageHasContent(
        manifest(
          [skill('helper', ['SKILL.md'])],
          [
            {
              id: 'mcp-slack',
              kind: 'mcp',
              displayName: 'Slack',
              required: false,
              affectedSteps: [],
              setupHint: 'Connect the Slack MCP server in Settings.',
            },
          ],
        ),
      ),
    ).toBe(true);
  });
});
