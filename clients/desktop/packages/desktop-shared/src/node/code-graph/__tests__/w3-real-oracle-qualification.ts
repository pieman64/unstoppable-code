import { z } from 'zod';
import type { W3DriverObservation } from './w3-real-oracle-driver';

// Validate persisted diagnostics at the test boundary; never assert a JSON cast.
const closureSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('incremental'),
    resetSourceFileIds: z.array(z.string()),
    dependencyReplacementFileIds: z.array(z.string()),
    fallbackReason: z.null(),
  }),
  z.object({
    mode: z.literal('full'),
    fallbackReason: z.enum([
      'capture-missing',
      'capture-invalid',
      'capture-incomplete',
      'schema-version-mismatch',
      'capture-version-mismatch',
      'root-path-mismatch',
      'algorithm-version-mismatch',
      'source-file-cap',
      'dependency-key-cap',
      'changed-symbol-cap',
      'repository-global-input',
      'unsupported-capture',
    ]),
    resetSourceFileIds: z.undefined(),
    dependencyReplacementFileIds: z.undefined(),
  }),
]);
export const w3DiagnosticsSchema = z.object({
  mode: z.enum(['full-reset', 'full-diff', 'incremental']),
  fullRepositoryRetries: z.number().int().nonnegative(),
  resetScopeReason: z.enum([
    'incremental-union',
    'whole-build-full',
    'unlocalizable-repository',
  ]),
  repositories: z.array(
    z.object({
      repoId: z.string(),
      closure: closureSchema.nullable(),
      fallbackReasons: z.array(z.string()),
      capture: z.object({ metadata: z.object({ complete: z.boolean() }) }),
    }),
  ),
});
export type W3QualifiedDiagnostics = z.infer<typeof w3DiagnosticsSchema>;

const selectiveOwners: Readonly<Record<number, readonly string[]>> = {
  2: ['src/lib.ts', 'src/alternate.ts'],
  3: ['src/lib.ts'],
  13: ['src/broken.ts'],
};
const directoryFallbackSteps = new Set([1, 4, 5, 9, 12]);
const configFallbackSteps = new Set([6, 7, 10]);
const fullFallbackSteps = new Set([1, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

function requireQualification(condition: boolean, context: string): void {
  if (!condition) throw new Error(`W3 qualification: ${context}`);
}

/** Shared positive/control assertion over observations from the real engine. */
export function qualifyW3Observation(observation: W3DriverObservation): void {
  if (observation.mode !== 'incremental') return;
  const context = `${observation.step}:${observation.edit}`;
  const diagnostics = observation.diagnostics;
  if (diagnostics === null)
    throw new Error(`W3 qualification: ${context}: missing diagnostics`);
  requireQualification(diagnostics.mode === 'incremental', `${context}: mode`);
  requireQualification(
    diagnostics.fullRepositoryRetries === 0,
    `${context}: unexpected incomplete-capture retry`,
  );
  requireQualification(
    diagnostics.resetScopeReason === 'incremental-union',
    `${context}: unexpected whole-build reset`,
  );
  requireQualification(
    observation.repositories.length === 2 &&
      diagnostics.repositories.length === 2,
    `${context}: missing/extra repository observations`,
  );
  for (const repoId of ['fixture', 'secondary']) {
    const facts = observation.repositories.find(
      (repo) => repo.repoId === repoId,
    );
    const result = diagnostics.repositories.find(
      (repo) => repo.repoId === repoId,
    );
    if (facts === undefined || result === undefined || result.closure === null)
      throw new Error(`W3 qualification: ${context}:${repoId}: missing scope`);
    const repoContext = `${context}:${repoId}`;
    requireQualification(
      facts.compatibleCapture && result.capture.metadata.complete,
      `${repoContext}: capture is not complete and compatible`,
    );
    if (observation.step === 0) {
      requireQualification(
        result.closure.mode === 'full' &&
          result.closure.fallbackReason === 'capture-missing',
        `${repoContext}: expected initial capture-missing full admission`,
      );
      continue;
    }
    if (repoId === 'fixture') {
      const changedPaths = selectiveOwners[observation.step];
      if (changedPaths !== undefined) {
        // Deliberately before secondary checks: the real always-full control
        // must be rejected here at supported step 2, not by its top-level mode.
        if (result.closure.mode !== 'incremental')
          throw new Error(
            `W3 qualification: ${repoContext}: expected incremental strict-subset closure; got ${result.closure.mode}`,
          );
        const reset = new Set(result.closure.resetSourceFileIds);
        const indexed = new Set(facts.indexedFiles.map((file) => file.id));
        requireQualification(
          reset.size > 0 &&
            reset.size < indexed.size &&
            Array.from(reset).every((id) => indexed.has(id)),
          `${repoContext}: reset is not a nonempty actual indexed-file strict subset`,
        );
        for (const relativePath of changedPaths) {
          const file = facts.indexedFiles.find(
            (candidate) => candidate.relativePath === relativePath,
          );
          requireQualification(
            file !== undefined && reset.has(file.id),
            `${repoContext}: changed owner omitted: ${relativePath}`,
          );
        }
        const sentinel = facts.indexedFiles.find(
          (file) => file.relativePath === 'src/路径.ts',
        );
        requireQualification(
          sentinel !== undefined && !reset.has(sentinel.id),
          `${repoContext}: unrelated Unicode owner was reset`,
        );
        requireQualification(
          facts.changedResolutionInputs.length === 0 &&
            result.fallbackReasons.length === 0,
          `${repoContext}: supported local edit unexpectedly invalidated inputs`,
        );
      } else if (fullFallbackSteps.has(observation.step)) {
        requireQualification(
          result.closure.mode === 'full' &&
            result.closure.fallbackReason === 'repository-global-input' &&
            result.fallbackReasons.length === 1 &&
            result.fallbackReasons[0] === 'external-resolution-input',
          `${repoContext}: expected exact external-input full fallback`,
        );
        requireQualification(
          facts.changedResolutionInputs.length > 0,
          `${repoContext}: full fallback has no observed input change`,
        );
        if (directoryFallbackSteps.has(observation.step))
          requireQualification(
            facts.changedResolutionInputs.some(
              (input) => input.kind === 'host-read-directory',
            ),
            `${repoContext}: membership edit did not change captured TS directory listing`,
          );
        if (configFallbackSteps.has(observation.step))
          requireQualification(
            facts.changedResolutionInputs.some(
              (input) =>
                input.kind === 'file-content' && input.key === 'tsconfig.json',
            ),
            `${repoContext}: rewritten config was not an observed input`,
          );
        if (observation.step === 8)
          requireQualification(
            facts.changedResolutionInputs.some((input) =>
              input.key.endsWith('base.json'),
            ),
            `${repoContext}: missing inherited config creation was not observed`,
          );
        if (observation.step === 11)
          requireQualification(
            facts.changedResolutionInputs.some((input) =>
              input.key.includes('node_modules/local-package/'),
            ),
            `${repoContext}: removed package input was not observed`,
          );
      } else {
        throw new Error(
          `W3 qualification: ${context}: no bounded edit expectation`,
        );
      }
      if (observation.step === 12) {
        const broken = facts.indexedFiles.find(
          (file) => file.relativePath === 'src/broken.ts',
        );
        requireQualification(
          broken !== undefined &&
            broken.parseStatus === 'parsed' &&
            broken.hasErrors,
          `${repoContext}: malformed-syntax case is not parsed-with-errors`,
        );
      }
    } else {
      requireQualification(
        result.closure.mode === 'incremental' &&
          result.closure.resetSourceFileIds.length === 0 &&
          result.closure.dependencyReplacementFileIds.length === 0 &&
          result.fallbackReasons.length === 0 &&
          facts.changedResolutionInputs.length === 0,
        `${repoContext}: untouched repository did not retain empty selective scope`,
      );
    }
  }
}
