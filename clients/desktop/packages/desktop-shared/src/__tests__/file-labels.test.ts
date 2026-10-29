import {
  BUILTIN_FILE_LABELS,
  BUILTIN_FILE_LABEL_IDS,
  OTHER_FILE_LABEL_ID,
  buildFileLabelClassifier,
  isFileVisibleWithHiddenLabels,
  isValidFileLabelPattern,
  mergeFileLabelsWithBuiltins,
} from '../file-labels';
import type { FileLabelBucket } from '../types';

function bucket(overrides: Partial<FileLabelBucket>): FileLabelBucket {
  return {
    id: 'custom-bucket',
    name: 'Custom',
    enabled: true,
    stopFurtherLabels: false,
    builtin: false,
    matchers: [],
    ...overrides,
  };
}

describe('BUILTIN_FILE_LABELS', () => {
  it('has unique bucket ids and unique matcher ids', () => {
    const bucketIds = BUILTIN_FILE_LABELS.map((b) => b.id);
    expect(new Set(bucketIds).size).toBe(bucketIds.length);
    const matcherIds = BUILTIN_FILE_LABELS.flatMap((b) =>
      b.matchers.map((m) => m.id),
    );
    expect(new Set(matcherIds).size).toBe(matcherIds.length);
  });

  it('marks every seeded bucket and matcher as builtin and enabled', () => {
    for (const seeded of BUILTIN_FILE_LABELS) {
      expect(seeded.builtin).toBe(true);
      expect(seeded.enabled).toBe(true);
      expect(seeded.stopFurtherLabels).toBe(false);
      expect(seeded.matchers.length).toBeGreaterThan(0);
      for (const matcher of seeded.matchers) {
        expect(matcher.builtin).toBe(true);
        expect(matcher.enabled).toBe(true);
        expect(isValidFileLabelPattern(matcher.pattern)).toBe(true);
      }
    }
  });

  it('does not reuse the synthetic other id', () => {
    expect(BUILTIN_FILE_LABEL_IDS.has(OTHER_FILE_LABEL_ID)).toBe(false);
  });
});

describe('buildFileLabelClassifier', () => {
  const classify = buildFileLabelClassifier(BUILTIN_FILE_LABELS);

  it.each([
    ['apps/desktop-app/src/main/__tests__/git.test.ts', 'tests'],
    ['tests/integration/test_login.py', 'tests'],
    ['pkg/server/handler_test.go', 'tests'],
    ['src/main/java/com/acme/FooTest.java', 'tests'],
    ['Acme.Api.Tests/OrderTests.cs', 'tests'],
    ['spec/models/user_spec.rb', 'tests'],
    ['docs/desktop-app-performance.md', 'documentation'],
    ['README.md', 'documentation'],
    ['SECURITY', 'documentation'],
    ['NOTICE.txt', 'documentation'],
    ['AUTHORS.rst', 'documentation'],
    ['.github/workflows/release.yml', 'ci-cd'],
    ['.gitlab-ci.yml', 'ci-cd'],
    ['package-lock.json', 'dependencies'],
    ['Cargo.lock', 'dependencies'],
    ['go.sum', 'dependencies'],
    ['apps/web/prisma/schema.prisma', 'database'],
    ['apps/web/manual-migrations/20260101_add_foo.sql', 'database'],
    // A .prisma schema outside a prisma/ directory still classifies.
    ['packages/db/schema.prisma', 'database'],
    ['src/proto/service.pb.go', 'generated'],
    ['src/renderer/styles/globals.css', 'styles'],
    ['assets/logo.svg', 'assets'],
    ['fonts/Inter.woff2', 'assets'],
    ['scripts/build-cli.mjs', 'scripts'],
    ['bin/deploy.sh', 'scripts'],
    ['.eslintrc.json', 'configuration'],
    ['electron.vite.config.ts', 'configuration'],
    ['pyproject.toml', 'configuration'],
    ['Dockerfile', 'configuration'],
    ['pom.xml', 'configuration'],
  ])('classifies %s as %s', (path, expected) => {
    expect(classify(path)).toContain(expected);
  });

  it('returns an empty list for unmatched files (Other catch-all)', () => {
    expect(classify('apps/desktop-app/src/main/index.ts')).toEqual([]);
  });

  it.each([
    'src/lib/security-headers.ts',
    'src/components/NoticeBanner.tsx',
    'src/lib/licenseChecker.ts',
    'src/models/authors.ts',
  ])('does not classify project-doc basename prefixes: %s', (path) => {
    expect(classify(path)).toEqual([]);
  });

  it('assigns multiple labels in bucket priority order by default', () => {
    expect(classify('.github/workflows/ci.yml')).toEqual([
      'ci-cd',
      'configuration',
    ]);
    expect(classify('docs/examples/setup.sh')).toEqual([
      'documentation',
      'scripts',
    ]);
  });

  it('stops after a bucket with stopFurtherLabels', () => {
    const buckets = mergeFileLabelsWithBuiltins([]).map((b) =>
      b.id === 'ci-cd' ? { ...b, stopFurtherLabels: true } : b,
    );
    const classifyStopped = buildFileLabelClassifier(buckets);
    expect(classifyStopped('.github/workflows/ci.yml')).toEqual(['ci-cd']);
  });

  it('stops after a matcher with stopMatching', () => {
    const buckets = mergeFileLabelsWithBuiltins([]).map((b) =>
      b.id === 'documentation'
        ? {
            ...b,
            matchers: b.matchers.map((m) =>
              m.id === 'docs-dirs' ? { ...m, stopMatching: true } : m,
            ),
          }
        : b,
    );
    const classifyStopped = buildFileLabelClassifier(buckets);
    // docs-dirs stops the whole classification...
    expect(classifyStopped('docs/examples/setup.sh')).toEqual([
      'documentation',
    ]);
    // ...but other documentation matchers still allow later buckets.
    expect(classifyStopped('README.sh.md')).toContain('documentation');
  });

  it('ignores disabled buckets and disabled matchers', () => {
    const buckets = mergeFileLabelsWithBuiltins([]).map((b) => {
      if (b.id === 'documentation') return { ...b, enabled: false };
      if (b.id === 'scripts') {
        return {
          ...b,
          matchers: b.matchers.map((m) =>
            m.id === 'scripts-shell' ? { ...m, enabled: false } : m,
          ),
        };
      }
      return b;
    });
    const classifyToggled = buildFileLabelClassifier(buckets);
    expect(classifyToggled('README.md')).toEqual([]);
    expect(classifyToggled('deploy.sh')).toEqual([]);
    expect(classifyToggled('scripts/deploy.mjs')).toEqual(['scripts']);
  });

  it('skips invalid patterns without failing the classifier', () => {
    const buckets: FileLabelBucket[] = [
      bucket({
        id: 'broken',
        matchers: [
          {
            id: 'bad',
            pattern: '   ',
            enabled: true,
            stopMatching: false,
            builtin: false,
          },
          {
            id: 'good',
            pattern: '**/*.zig',
            enabled: true,
            stopMatching: false,
            builtin: false,
          },
        ],
      }),
    ];
    expect(buildFileLabelClassifier(buckets)('src/main.zig')).toEqual([
      'broken',
    ]);
  });

  it('normalizes backslashes and leading slashes before matching', () => {
    expect(classify('docs\\guide.md')).toContain('documentation');
    expect(classify('/docs/guide.md')).toContain('documentation');
  });
});

describe('mergeFileLabelsWithBuiltins', () => {
  it('returns the seeded defaults for an empty persisted array', () => {
    const merged = mergeFileLabelsWithBuiltins([]);
    expect(merged.map((b) => b.id)).toEqual(
      BUILTIN_FILE_LABELS.map((b) => b.id),
    );
    // Deep copies — mutating the merge result must not touch the seeds.
    merged[0].matchers[0].enabled = false;
    expect(BUILTIN_FILE_LABELS[0].matchers[0].enabled).toBe(true);
  });

  it('keeps persisted order, toggles, and stop flags for builtin buckets', () => {
    const seeded = mergeFileLabelsWithBuiltins([]);
    const reordered = [...seeded]
      .reverse()
      .map((b) =>
        b.id === 'tests'
          ? { ...b, enabled: false, stopFurtherLabels: true, name: 'Renamed' }
          : b,
      );
    const merged = mergeFileLabelsWithBuiltins(reordered);
    expect(merged.map((b) => b.id)).toEqual(reordered.map((b) => b.id));
    const tests = merged.find((b) => b.id === 'tests');
    expect(tests?.enabled).toBe(false);
    expect(tests?.stopFurtherLabels).toBe(true);
    // Seeded name is re-imposed.
    expect(tests?.name).toBe('Tests');
  });

  it('re-imposes builtin matcher patterns but keeps user flags, order, and custom matchers', () => {
    const seeded = mergeFileLabelsWithBuiltins([]);
    const styles = seeded.find((b) => b.id === 'styles');
    if (!styles) throw new Error('styles bucket missing');
    const persisted = seeded.map((b) =>
      b.id === 'styles'
        ? {
            ...b,
            matchers: [
              {
                id: 'custom-tailwind',
                pattern: '**/tailwind/**',
                enabled: true,
                stopMatching: true,
                builtin: true, // hostile flag — must be corrected to false
              },
              {
                ...styles.matchers[0],
                pattern: 'tampered',
                enabled: false,
                stopMatching: true,
              },
            ],
          }
        : b,
    );
    const merged = mergeFileLabelsWithBuiltins(persisted);
    const mergedStyles = merged.find((b) => b.id === 'styles');
    expect(mergedStyles?.matchers.map((m) => m.id)).toEqual([
      'custom-tailwind',
      styles.matchers[0].id,
    ]);
    expect(mergedStyles?.matchers[0].builtin).toBe(false);
    expect(mergedStyles?.matchers[1].pattern).toBe(styles.matchers[0].pattern);
    expect(mergedStyles?.matchers[1].enabled).toBe(false);
    expect(mergedStyles?.matchers[1].stopMatching).toBe(true);
  });

  it('clears hostile builtin flags from matchers in custom buckets', () => {
    const merged = mergeFileLabelsWithBuiltins([
      bucket({
        id: 'custom-hostile',
        matchers: [
          {
            id: 'custom-hostile-matcher',
            pattern: '**/*.hostile',
            enabled: true,
            stopMatching: false,
            builtin: true,
          },
        ],
      }),
    ]);

    expect(merged[0].builtin).toBe(false);
    expect(merged[0].matchers[0].builtin).toBe(false);
  });

  it('appends unseen builtin buckets and matchers at the end', () => {
    const seeded = mergeFileLabelsWithBuiltins([]);
    const withoutTests = seeded.filter((b) => b.id !== 'tests');
    const strippedDocs = withoutTests.map((b) =>
      b.id === 'documentation' ? { ...b, matchers: b.matchers.slice(1) } : b,
    );
    const merged = mergeFileLabelsWithBuiltins(strippedDocs);
    expect(merged[merged.length - 1].id).toBe('tests');
    const docs = merged.find((b) => b.id === 'documentation');
    const seededDocs = BUILTIN_FILE_LABELS.find(
      (b) => b.id === 'documentation',
    );
    expect(docs?.matchers[docs.matchers.length - 1].id).toBe(
      seededDocs?.matchers[0].id,
    );
  });

  it('keeps custom buckets as-is and dedupes bucket ids', () => {
    const custom = bucket({
      id: 'infra',
      name: 'Infra',
      matchers: [
        {
          id: 'tf',
          pattern: '**/*.tf',
          enabled: true,
          stopMatching: false,
          builtin: false,
        },
      ],
    });
    const merged = mergeFileLabelsWithBuiltins([custom, { ...custom }]);
    expect(merged.filter((b) => b.id === 'infra')).toHaveLength(1);
    expect(merged[0]).toEqual(custom);
  });
});

describe('isFileVisibleWithHiddenLabels', () => {
  it('shows everything when nothing is hidden', () => {
    expect(isFileVisibleWithHiddenLabels([], new Set())).toBe(true);
    expect(isFileVisibleWithHiddenLabels(['tests'], new Set())).toBe(true);
  });

  it('hides unlabeled files only via the other id', () => {
    expect(
      isFileVisibleWithHiddenLabels([], new Set([OTHER_FILE_LABEL_ID])),
    ).toBe(false);
    expect(isFileVisibleWithHiddenLabels([], new Set(['tests']))).toBe(true);
  });

  it('keeps a file visible while any of its labels is visible', () => {
    const hidden = new Set(['tests']);
    expect(isFileVisibleWithHiddenLabels(['tests'], hidden)).toBe(false);
    expect(
      isFileVisibleWithHiddenLabels(['tests', 'documentation'], hidden),
    ).toBe(true);
  });
});

describe('isValidFileLabelPattern', () => {
  it('rejects empty and whitespace-only patterns', () => {
    expect(isValidFileLabelPattern('')).toBe(false);
    expect(isValidFileLabelPattern('   ')).toBe(false);
  });

  it('accepts common globs', () => {
    expect(isValidFileLabelPattern('**/*.test.ts')).toBe(true);
    expect(isValidFileLabelPattern('**/{a,b}/**')).toBe(true);
  });
});
