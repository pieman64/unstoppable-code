/**
 * Built-in file-label (classification) definitions shared by:
 *
 * - **backend** preference normalization (validates persisted bucket shapes),
 * - **frontend** settings UI (renders the seeded buckets and matchers), and
 * - **frontend** changed-file filtering (classifies repo-relative paths).
 *
 * Buckets are evaluated in array order — the persisted order is the priority
 * order. Within a bucket, matchers are evaluated in array order and the first
 * enabled match assigns the bucket's label. By default classification then
 * continues with the next bucket, so a file can end up with several labels; a
 * bucket's `stopFurtherLabels` or a matcher's `stopMatching` ("do not keep
 * matching") ends classification for that file. Files matching no enabled
 * bucket belong to the synthetic {@link OTHER_FILE_LABEL_ID} catch-all.
 *
 * Persistence mirrors branch display mappings: the full ordered array
 * (built-ins included) is stored in preferences, and
 * {@link mergeFileLabelsWithBuiltins} re-imposes seeded names/patterns on
 * read so shipped tweaks propagate while user state (order, enabled flags,
 * stop flags, custom buckets/matchers) survives.
 *
 * Matching uses `picomatch/posix` (browser-safe, no `node:path`), which is
 * correct because git emits `/`-separated repo-relative paths on every
 * platform. Ids are stable kebab-case strings and must never change once
 * shipped.
 */
import picomatch from 'picomatch/posix';
import type { FileLabelBucket, FileLabelMatcher } from './types';

/** Synthetic catch-all label for files no enabled bucket matched. */
export const OTHER_FILE_LABEL_ID = 'other';
export const OTHER_FILE_LABEL_NAME = 'Other';

function builtinMatcher(id: string, pattern: string): FileLabelMatcher {
  return { id, pattern, enabled: true, stopMatching: false, builtin: true };
}

function builtinBucket(
  id: string,
  name: string,
  matchers: FileLabelMatcher[],
): FileLabelBucket {
  return {
    id,
    name,
    enabled: true,
    stopFurtherLabels: false,
    builtin: true,
    matchers,
  };
}

export const BUILTIN_FILE_LABELS: readonly FileLabelBucket[] = [
  builtinBucket('tests', 'Tests', [
    builtinMatcher('tests-dirs', '**/{__tests__,test,tests,spec,specs}/**'),
    builtinMatcher('tests-suffix', '**/*.{test,spec}.*'),
    builtinMatcher('tests-python', '**/{test_*,*_test}.py'),
    builtinMatcher('tests-go', '**/*_test.go'),
    builtinMatcher(
      'tests-jvm',
      '**/*{Test,Tests,Spec}.{java,kt,kts,scala,groovy}',
    ),
    builtinMatcher('tests-dotnet', '**/*Tests.{cs,fs,vb}'),
    builtinMatcher('tests-ruby', '**/*_spec.rb'),
  ]),
  builtinBucket('documentation', 'Documentation', [
    builtinMatcher('docs-dirs', '**/{docs,doc}/**'),
    builtinMatcher('docs-formats', '**/*.{md,mdx,markdown,rst,adoc,asciidoc}'),
    builtinMatcher(
      'docs-project-files',
      '**/{README,CHANGELOG,LICENSE,LICENCE,NOTICE,CONTRIBUTING,CODE_OF_CONDUCT,CODEOWNERS,AUTHORS,SECURITY}{,.md,.mdx,.markdown,.rst,.adoc,.asciidoc,.txt}',
    ),
  ]),
  builtinBucket('ci-cd', 'CI/CD', [
    builtinMatcher('ci-github', '.github/**'),
    builtinMatcher('ci-dirs', '**/{.circleci,.buildkite,.teamcity,.gitlab}/**'),
    builtinMatcher(
      'ci-configs',
      '**/{.gitlab-ci.yml,Jenkinsfile,azure-pipelines.yml,azure-pipelines.*.yml,bitbucket-pipelines.yml,appveyor.yml,cloudbuild.yaml,cloudbuild.yml,.drone.yml,Fastfile}',
    ),
  ]),
  builtinBucket('dependencies', 'Dependencies', [
    builtinMatcher(
      'deps-lockfiles',
      '**/{package-lock.json,npm-shrinkwrap.json,yarn.lock,pnpm-lock.yaml,bun.lockb,bun.lock,Cargo.lock,go.sum,poetry.lock,uv.lock,Pipfile.lock,requirements*.txt,Gemfile.lock,composer.lock,packages.lock.json,paket.lock,gradle.lockfile,mix.lock,pubspec.lock,Package.resolved}',
    ),
    builtinMatcher('deps-vendored', '**/{vendor,third_party,third-party}/**'),
  ]),
  builtinBucket('database', 'Database', [
    builtinMatcher('db-migrations', '**/{migrations,migrate}/**'),
    builtinMatcher('db-sql', '**/*.sql'),
    builtinMatcher('db-prisma', '**/prisma/**'),
    builtinMatcher('db-prisma-schema', '**/*.prisma'),
  ]),
  builtinBucket('generated', 'Generated', [
    builtinMatcher('generated-dirs', '**/{generated,__generated__,codegen}/**'),
    builtinMatcher('generated-suffix', '**/*.{generated,gen}.*'),
    builtinMatcher(
      'generated-lang',
      '**/{*.pb.go,*_pb2.py,*_pb2_grpc.py,*.g.cs,*.g.dart,*.freezed.dart,*.min.js,*.min.css,*.js.map,*.css.map}',
    ),
  ]),
  builtinBucket('styles', 'Styles', [
    builtinMatcher('styles-stylesheets', '**/*.{css,scss,sass,less,styl,pcss}'),
  ]),
  builtinBucket('assets', 'Assets', [
    builtinMatcher(
      'assets-images',
      '**/*.{png,jpg,jpeg,gif,svg,ico,icns,webp,avif,bmp,tiff}',
    ),
    builtinMatcher('assets-fonts', '**/*.{woff,woff2,ttf,otf,eot}'),
    builtinMatcher('assets-media', '**/*.{mp3,mp4,webm,wav,ogg,mov,avi}'),
  ]),
  builtinBucket('scripts', 'Scripts', [
    builtinMatcher('scripts-dirs', '**/{scripts,tools}/**'),
    builtinMatcher('scripts-shell', '**/*.{sh,bash,zsh,fish,ps1,psm1,bat,cmd}'),
  ]),
  builtinBucket('configuration', 'Configuration', [
    builtinMatcher(
      'config-rc-files',
      '**/.*rc{,.js,.cjs,.mjs,.ts,.json,.yml,.yaml}',
    ),
    builtinMatcher('config-suffix', '**/*.config.{js,cjs,mjs,ts,cts,mts,json}'),
    builtinMatcher('config-env', '**/.env{,.*}'),
    builtinMatcher(
      'config-formats',
      '**/*.{toml,ini,conf,cfg,properties,plist}',
    ),
    builtinMatcher('config-yaml', '**/*.{yml,yaml}'),
    builtinMatcher(
      'config-js-manifests',
      '**/{package.json,tsconfig.json,tsconfig.*.json,jsconfig.json}',
    ),
    builtinMatcher(
      'config-lang-manifests',
      '**/{pyproject.toml,setup.py,setup.cfg,Cargo.toml,go.mod,Gemfile,Rakefile,composer.json,pom.xml,build.gradle,build.gradle.kts,settings.gradle,settings.gradle.kts,*.csproj,*.fsproj,*.vbproj,*.sln,*.props,*.targets,Package.swift,pubspec.yaml,mix.exs}',
    ),
    builtinMatcher(
      'config-build-files',
      '**/{Makefile,makefile,GNUmakefile,justfile,CMakeLists.txt,meson.build,BUILD,BUILD.bazel,WORKSPACE}',
    ),
    builtinMatcher(
      'config-containers',
      '**/{Dockerfile,Dockerfile.*,*.dockerfile,docker-compose.yml,docker-compose.*.yml,compose.yml,compose.yaml,Procfile,Vagrantfile}',
    ),
  ]),
];

/** Set of every built-in bucket id. */
export const BUILTIN_FILE_LABEL_IDS: ReadonlySet<string> = new Set(
  BUILTIN_FILE_LABELS.map((bucket) => bucket.id),
);

function cloneBucket(bucket: FileLabelBucket): FileLabelBucket {
  return { ...bucket, matchers: bucket.matchers.map((m) => ({ ...m })) };
}

/**
 * Re-impose seeded definitions over a persisted bucket array. Persisted
 * built-in buckets keep their order, `enabled`, `stopFurtherLabels`, matcher
 * order/flags, and any user-added matchers, while seeded names and matcher
 * patterns come from source so shipped tweaks propagate. Built-in buckets
 * (or built-in matchers within a bucket) missing from the persisted state
 * are appended in seed order with their default state.
 */
export function mergeFileLabelsWithBuiltins(
  persisted: FileLabelBucket[],
): FileLabelBucket[] {
  const builtinById = new Map(BUILTIN_FILE_LABELS.map((b) => [b.id, b]));
  const seenBucketIds = new Set<string>();

  const result: FileLabelBucket[] = [];
  for (const bucket of persisted) {
    if (seenBucketIds.has(bucket.id)) continue;
    seenBucketIds.add(bucket.id);
    const builtin = builtinById.get(bucket.id);
    if (!builtin) {
      result.push({
        ...cloneBucket(bucket),
        builtin: false,
        matchers: bucket.matchers.map((matcher) => ({
          ...matcher,
          builtin: false,
        })),
      });
      continue;
    }
    const builtinMatchersById = new Map(builtin.matchers.map((m) => [m.id, m]));
    const seenMatcherIds = new Set<string>();
    const matchers: FileLabelMatcher[] = [];
    for (const matcher of bucket.matchers) {
      if (seenMatcherIds.has(matcher.id)) continue;
      seenMatcherIds.add(matcher.id);
      const builtinSource = builtinMatchersById.get(matcher.id);
      if (builtinSource) {
        matchers.push({
          ...builtinSource,
          enabled: matcher.enabled,
          stopMatching: matcher.stopMatching,
        });
      } else {
        matchers.push({ ...matcher, builtin: false });
      }
    }
    for (const seeded of builtin.matchers) {
      if (!seenMatcherIds.has(seeded.id)) {
        matchers.push({ ...seeded });
      }
    }
    result.push({
      ...builtin,
      enabled: bucket.enabled,
      stopFurtherLabels: bucket.stopFurtherLabels,
      matchers,
    });
  }

  for (const builtin of BUILTIN_FILE_LABELS) {
    if (!seenBucketIds.has(builtin.id)) {
      result.push(cloneBucket(builtin));
    }
  }

  return result;
}

/** True when a glob pattern is non-empty and compiles. */
export function isValidFileLabelPattern(pattern: string): boolean {
  const trimmed = pattern.trim();
  if (!trimmed) return false;
  try {
    picomatch(trimmed, { dot: true, nocase: true });
    return true;
  } catch {
    return false;
  }
}

export type FileLabelClassifier = (path: string) => string[];

interface CompiledMatcher {
  isMatch: (path: string) => boolean;
  stop: boolean;
}

interface CompiledBucket {
  id: string;
  matchers: CompiledMatcher[];
}

function normalizeMatchPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '');
}

/**
 * Compile enabled buckets into a classifier over repo-relative paths.
 * Returns the matching bucket ids in bucket priority order; an empty array
 * means the file belongs to the {@link OTHER_FILE_LABEL_ID} catch-all.
 * Invalid patterns are skipped rather than failing the whole classifier.
 */
export function buildFileLabelClassifier(
  buckets: readonly FileLabelBucket[],
): FileLabelClassifier {
  const compiled: CompiledBucket[] = [];
  for (const bucket of buckets) {
    if (!bucket.enabled) continue;
    const matchers: CompiledMatcher[] = [];
    for (const matcher of bucket.matchers) {
      const pattern = matcher.pattern.trim();
      if (!matcher.enabled || !pattern) continue;
      try {
        matchers.push({
          isMatch: picomatch(pattern, { dot: true, nocase: true }),
          stop: matcher.stopMatching || bucket.stopFurtherLabels,
        });
      } catch {
        // Skip patterns that fail to compile; the settings UI validates new
        // patterns, but persisted state may predate validation.
      }
    }
    if (matchers.length > 0) {
      compiled.push({ id: bucket.id, matchers });
    }
  }

  return (path: string): string[] => {
    const normalized = normalizeMatchPath(path);
    const labels: string[] = [];
    outer: for (const bucket of compiled) {
      for (const matcher of bucket.matchers) {
        if (matcher.isMatch(normalized)) {
          labels.push(bucket.id);
          if (matcher.stop) break outer;
          break;
        }
      }
    }
    return labels;
  };
}

/**
 * Multi-select filter semantics for the changed-file surfaces: a file stays
 * visible while at least one of its labels is not hidden; unlabeled files
 * follow the synthetic {@link OTHER_FILE_LABEL_ID} entry.
 */
export function isFileVisibleWithHiddenLabels(
  labelIds: readonly string[],
  hiddenLabelIds: ReadonlySet<string>,
): boolean {
  if (hiddenLabelIds.size === 0) return true;
  if (labelIds.length === 0) return !hiddenLabelIds.has(OTHER_FILE_LABEL_ID);
  return labelIds.some((id) => !hiddenLabelIds.has(id));
}
