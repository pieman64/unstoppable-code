import { extractPrismaFacts } from './prisma-extractor';
import type { CodeGraphFileFacts } from '../../../types/code-graph';
import type { CodeGraphParserRuntime } from '../parser/runtime';
import { extractMarkdownFacts } from './markdown-extractor';
import {
  extractMcpConfigFacts,
  extractPackageJsonFacts,
  extractTsconfigFacts,
} from './manifest-extractors';
import {
  extractActionManifestFacts,
  extractWorkflowFacts,
} from './workflow-extractor';

// Input shape handed to every non-code extractor. Unlike the grammar-backed
// `extractFileFacts` path, most non-code extractors never touch
// web-tree-sitter — `source` is the already-read UTF-8 file text and
// `contentHash` is already computed by the engine's shared hash fastpath. The
// markdown extractor (Task 4) is the exception: it needs the shared
// `CodeGraphParserRuntime` to run the block+inline grammar dual-parse, so the
// engine now threads its own `runtime` instance through to every non-code
// extractor call. The other minimal extractors (package-json, tsconfig,
// mcp-config) simply ignore this field.
export interface NonCodeExtractorInput {
  repoId: string;
  relativePath: string;
  absolutePath: string;
  source: string;
  sizeBytes: number;
  mtimeNs: string;
  contentHash: string;
  runtime: CodeGraphParserRuntime;
}

export type NonCodeExtractor = (
  input: NonCodeExtractorInput,
) => Promise<CodeGraphFileFacts> | CodeGraphFileFacts;

export interface NonCodeExtractorDefinition {
  id: string;
  matches(relativePath: string): boolean;
  extract: NonCodeExtractor;
}

function basenameOf(relativePath: string): string {
  return relativePath.split('/').pop() ?? relativePath;
}

const TSCONFIG_BASENAME_PATTERN = /^tsconfig(\..+)?\.json$/;

// Matches `.github/workflows/<name>.yml` or `.yaml` anywhere in the tree
// (the `(^|/)` anchor covers both a repo-root workflow and one nested under
// a child repo path in a multi-repo workspace). Lowercased before testing,
// mirroring the markdown matcher's `relativePath.toLowerCase()` normalization
// above -- the pattern itself is already all-lowercase, so this just makes
// the match case-insensitive end to end.
const GITHUB_WORKFLOW_PATH_PATTERN = /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/;

// Matches `action.yml`/`action.yaml` by BASENAME anywhere in the tree --
// unlike the workflow pattern above, GitHub does not require a fixed
// directory for a local action's manifest (conventionally
// `.github/actions/<name>/action.yml`, but `uses: ./` even points at a
// repository-root manifest). Lowercased before testing, same
// case-insensitivity convention as the other matchers here. Listed AFTER the
// github-workflow entry below so the (pathological) case of a real workflow
// file literally named `action.yml` under `.github/workflows/` still resolves
// as a workflow -- `nonCodeExtractorForPath` is documented first-match-wins.
const ACTION_MANIFEST_BASENAME_PATTERN = /^action\.ya?ml$/;

// Markdown extractor: `.mdx` is deliberately matched here too and parsed as
// plain markdown (headings/links extraction) — Canopy does not special-case
// JSX-in-MDX content.
const extractMarkdown: NonCodeExtractor = (input) =>
  extractMarkdownFacts(input);

const extractPackageJson: NonCodeExtractor = (input) =>
  extractPackageJsonFacts(input);

const extractTsconfig: NonCodeExtractor = (input) =>
  extractTsconfigFacts(input);

const extractMcpConfig: NonCodeExtractor = (input) =>
  extractMcpConfigFacts(input);

const extractGithubWorkflow: NonCodeExtractor = (input) =>
  extractWorkflowFacts(input);

const extractGithubActionManifest: NonCodeExtractor = (input) =>
  extractActionManifestFacts(input);

// Ordered registry: `nonCodeExtractorForPath` returns the first match. Every
// matcher here targets a basename or extension disjoint from
// `CODE_GRAPH_SOURCE_EXTENSIONS` (see the scanner/registry disjointness test),
// so today a path can never match more than one definition — but the
// first-match contract is still the documented tie-break rule. The one
// exception is `github-workflow` vs. `github-action-manifest`: a workflow
// file that happens to be literally named `action.yml` under
// `.github/workflows/` matches both, so `github-workflow` is listed first to
// keep that (pathological, real-world-unlikely) case classified as a
// workflow.
export const CODE_GRAPH_NON_CODE_EXTRACTORS: readonly NonCodeExtractorDefinition[] =
  [
    {
      id: 'markdown',
      matches: (relativePath: string): boolean => {
        const lower = relativePath.toLowerCase();
        return lower.endsWith('.md') || lower.endsWith('.mdx');
      },
      extract: extractMarkdown,
    },
    {
      id: 'prisma',
      matches: (relativePath: string): boolean =>
        relativePath.toLowerCase().endsWith('.prisma'),
      extract: extractPrismaFacts,
    },
    {
      id: 'package-json',
      matches: (relativePath: string): boolean =>
        basenameOf(relativePath) === 'package.json',
      extract: extractPackageJson,
    },
    {
      id: 'tsconfig',
      matches: (relativePath: string): boolean =>
        TSCONFIG_BASENAME_PATTERN.test(basenameOf(relativePath)),
      extract: extractTsconfig,
    },
    {
      id: 'mcp-config',
      matches: (relativePath: string): boolean => {
        const basename = basenameOf(relativePath);
        return basename === '.mcp.json' || basename === 'mcp.json';
      },
      extract: extractMcpConfig,
    },
    {
      id: 'github-workflow',
      matches: (relativePath: string): boolean =>
        GITHUB_WORKFLOW_PATH_PATTERN.test(relativePath.toLowerCase()),
      extract: extractGithubWorkflow,
    },
    {
      id: 'github-action-manifest',
      matches: (relativePath: string): boolean =>
        ACTION_MANIFEST_BASENAME_PATTERN.test(
          basenameOf(relativePath).toLowerCase(),
        ),
      extract: extractGithubActionManifest,
    },
  ];

export function nonCodeExtractorForPath(
  relativePath: string,
): NonCodeExtractorDefinition | undefined {
  return CODE_GRAPH_NON_CODE_EXTRACTORS.find((extractor) =>
    extractor.matches(relativePath),
  );
}
