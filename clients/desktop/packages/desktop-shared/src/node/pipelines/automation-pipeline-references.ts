import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type {
  PipelinePackageAnalysisBlocker,
  PipelinePackagePromptSpan,
  PipelinePackageReferenceDismissal,
} from '@canopy/protocol/pipelines';
import {
  extractPipelineReferenceTokens,
  type PipelineReferenceToken,
} from '../../lib/invocation-tokens';

/**
 * Pipelines an automation share carries, and how the automation's prompt and
 * stored dependency list pick them. Pure: the host lists its pipelines, this
 * decides which travel; the package analyzer runs the same decision inside
 * its prompt scan, so both always agree.
 */

/** Reserved key of a `worktree_pipeline` action's own pipeline. */
export const AUTOMATION_ACTION_PIPELINE_KEY = 'action';

export type AutomationPipelineSource = 'user' | 'project';

/** One pipeline an automation prompt or dependency list may name. */
export interface AutomationPipelineInventoryEntry {
  /** Portable key, from {@link automationPipelineKey}. */
  key: string;
  /** The store's id: a UUID for user pipelines, path-derived for project ones. */
  pipelineId: string;
  name: string;
  source: AutomationPipelineSource;
  /** Absolute path of the pipeline YAML. */
  path: string;
  /** The pipeline has its own installed capability package. */
  hasInstalledPackage: boolean;
}

/** A structured dependency: the stored list, or a manual add. Always required. */
export interface AutomationPipelineRequest {
  pipelineId: string;
  source: AutomationPipelineSource;
}

export interface ResolvedAutomationPipeline extends AutomationPipelineInventoryEntry {
  /**
   * Named by a structured request or by UUID in the prompt. A pipeline found
   * only by an exact name match is optional: a suggestion the author opts in.
   */
  required: boolean;
  /** Packaged: required, or optional with its key in the selections. */
  selected: boolean;
  /** Every UUID occurrence in the prompt, in order. Names are never spans. */
  promptSpans: PipelinePackagePromptSpan[];
}

export type AutomationPipelineReferenceBlocker = Omit<
  PipelinePackageAnalysisBlocker,
  'occurrences'
>;

export interface AutomationPipelineReferenceResolution {
  /** Every pipeline resolved, selected or not, in key order. */
  pipelines: ResolvedAutomationPipeline[];
  blockers: PipelinePackageAnalysisBlocker[];
  /** Pipeline-reference dismissals that matched an ambiguous reference. */
  dismissedReferences: PipelinePackageReferenceDismissal[];
}

export interface ResolveAutomationPipelineReferencesInput {
  /**
   * The canonical prompt (`canonicalizeSharedAutomationPrompt`), untrimmed:
   * span offsets index into exactly this string.
   */
  promptText?: string;
  inventory: readonly AutomationPipelineInventoryEntry[];
  requests?: readonly AutomationPipelineRequest[];
  /** Keys of optional (name-matched) pipelines the author selected. */
  selections?: readonly string[];
  dismissedReferences?: readonly PipelinePackageReferenceDismissal[];
}

/** Where a prompt-found blocker happened, for the analyzer's occurrences. */
export interface AutomationPipelineReferenceLocation {
  jobId: string;
  stepId: string;
}

export function automationPipelineResourceId(pipelineKey: string): string {
  return `automation-pipeline-${pipelineKey}`;
}

export function fileAssetResourceId(
  pipelineKey: string,
  assetId: string,
): string {
  return `file-asset-${pipelineKey}-${assetId}`;
}

/**
 * The portable key a pipeline travels under: the author's id for a user
 * pipeline, and `project-<slug>` for a project pipeline, where the slug is
 * the file stem lower-cased with every run of other characters turned into
 * one `-`. The prefix keeps a stem from colliding with the reserved `action`.
 */
export function automationPipelineKey(input: {
  source: AutomationPipelineSource;
  pipelineId: string;
  path: string;
}): string {
  if (input.source === 'user') return input.pipelineId;
  const stem = path.basename(input.path, path.extname(input.path));
  const slug = stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug
    ? `project-${slug}`
    : `project-${createHash('sha256').update(input.path).digest('hex').slice(0, 12)}`;
}

function pipelineIdentity(entry: {
  source: AutomationPipelineSource;
  pipelineId: string;
}): string {
  // Local ids are lower-case UUIDs; a prompt may spell one in upper case.
  return `${entry.source}\0${entry.source === 'user' ? entry.pipelineId.toLowerCase() : entry.pipelineId}`;
}

export type PipelineReferenceDecision =
  | {
      kind: 'resolved';
      target: AutomationPipelineInventoryEntry;
      /** A UUID match is required; an exact name match is optional. */
      required: boolean;
    }
  | { kind: 'ambiguous'; candidates: AutomationPipelineInventoryEntry[] }
  | { kind: 'ignored'; dismissed: boolean };

/**
 * Classify one prompt token against the pipeline inventory, mirroring
 * `classifyInvocation`. Prompts are free text, so a token that matches
 * nothing is ignored, never a blocker. A token whose candidates include a
 * requested pipeline is covered by the request and ignored here.
 */
export function classifyPipelineReference(
  token: PipelineReferenceToken,
  inventory: readonly AutomationPipelineInventoryEntry[],
  options: {
    requestedIdentities?: ReadonlySet<string>;
    dismissedReferences?: readonly PipelinePackageReferenceDismissal[];
  } = {},
): PipelineReferenceDecision {
  const matches = new Map<string, AutomationPipelineInventoryEntry>();
  for (const entry of inventory) {
    const matched =
      token.kind === 'uuid'
        ? entry.pipelineId.toLowerCase() === token.text.toLowerCase()
        : entry.name === token.text;
    if (matched) matches.set(pipelineIdentity(entry), entry);
  }
  const candidates = Array.from(matches.values());
  const [only] = candidates;
  if (candidates.length === 1 && only) {
    return { kind: 'resolved', target: only, required: token.kind === 'uuid' };
  }
  if (candidates.length === 0) return { kind: 'ignored', dismissed: false };
  if (
    candidates.some((candidate) =>
      options.requestedIdentities?.has(pipelineIdentity(candidate)),
    )
  ) {
    return { kind: 'ignored', dismissed: false };
  }
  if (
    options.dismissedReferences?.some(
      (dismissal) =>
        dismissal.kind === 'pipeline_reference' &&
        dismissal.token === token.text,
    )
  ) {
    return { kind: 'ignored', dismissed: true };
  }
  return { kind: 'ambiguous', candidates };
}

interface MutableResolvedPipeline {
  entry: AutomationPipelineInventoryEntry;
  required: boolean;
  promptSpans: PipelinePackagePromptSpan[];
}

export interface AutomationPipelineReferenceCollector {
  /** Scan one prompt; spans index into `text`. */
  addPromptText(
    text: string,
    location?: AutomationPipelineReferenceLocation,
  ): void;
  finish(): {
    pipelines: ResolvedAutomationPipeline[];
    blockers: AutomationPipelineReferenceBlocker[];
    dismissedReferences: PipelinePackageReferenceDismissal[];
  };
}

/**
 * The accumulating form of {@link resolveAutomationPipelineReferences}, used
 * by the analyzer's prompt loop. Requests are applied first, so they win over
 * detection: a requested pipeline is required however the prompt names it.
 */
export function createAutomationPipelineReferenceCollector(
  input: Omit<ResolveAutomationPipelineReferencesInput, 'promptText'>,
): AutomationPipelineReferenceCollector {
  const byIdentity = new Map<string, MutableResolvedPipeline>();
  const blockers: AutomationPipelineReferenceBlocker[] = [];
  const blockerKeys = new Set<string>();
  const pushBlocker = (blocker: AutomationPipelineReferenceBlocker): void => {
    const key = `${blocker.code}\0${blocker.subject ?? blocker.message}`;
    if (blockerKeys.has(key)) return;
    blockerKeys.add(key);
    blockers.push(blocker);
  };
  const matchedDismissals = new Map<
    string,
    PipelinePackageReferenceDismissal
  >();
  const requestedIdentities = new Set<string>();
  const add = (
    entry: AutomationPipelineInventoryEntry,
    required: boolean,
  ): MutableResolvedPipeline => {
    const identity = pipelineIdentity(entry);
    const existing = byIdentity.get(identity) ?? {
      entry,
      required: false,
      promptSpans: [],
    };
    existing.required ||= required;
    byIdentity.set(identity, existing);
    return existing;
  };
  for (const request of input.requests ?? []) {
    const identity = pipelineIdentity(request);
    const entry = input.inventory.find(
      (candidate) => pipelineIdentity(candidate) === identity,
    );
    if (!entry) {
      pushBlocker({
        code: 'MISSING_DEPENDENCY_SOURCE',
        subject: request.pipelineId,
        message: `A ${request.source} pipeline this automation depends on (${request.pipelineId}) no longer exists. Remove it from the automation's pipelines or restore it.`,
      });
      continue;
    }
    requestedIdentities.add(identity);
    add(entry, true);
  }
  const names = Array.from(new Set(input.inventory.map(({ name }) => name)));
  return {
    addPromptText(text, location): void {
      for (const token of extractPipelineReferenceTokens(text, names)) {
        const decision = classifyPipelineReference(token, input.inventory, {
          requestedIdentities,
          dismissedReferences: input.dismissedReferences,
        });
        if (decision.kind === 'ignored') {
          if (decision.dismissed) {
            matchedDismissals.set(token.text, {
              kind: 'pipeline_reference',
              token: token.text,
            });
          }
          continue;
        }
        if (decision.kind === 'ambiguous') {
          pushBlocker({
            code: 'AMBIGUOUS_PIPELINE_REFERENCE',
            subject: token.text,
            origin: 'direct',
            message: `The prompt mentions "${token.text}", which matches ${decision.candidates.length} pipelines. Add the one it means to the automation's pipelines, or dismiss this to share without them.`,
            ...location,
            referenceDismissal: {
              kind: 'pipeline_reference',
              token: token.text,
            },
          });
          continue;
        }
        const resolved = add(decision.target, decision.required);
        if (token.kind === 'uuid') {
          resolved.promptSpans.push({
            textStart: token.start,
            text: token.text,
          });
        }
      }
    },
    finish(): ReturnType<AutomationPipelineReferenceCollector['finish']> {
      const selections = new Set(input.selections ?? []);
      const pipelines = Array.from(byIdentity.values())
        .map(
          ({ entry, required, promptSpans }): ResolvedAutomationPipeline => ({
            ...entry,
            required,
            selected: required || selections.has(entry.key),
            promptSpans: [...promptSpans].sort(
              (left, right) => left.textStart - right.textStart,
            ),
          }),
        )
        .sort((left, right) =>
          left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
        );
      for (const pipeline of pipelines) {
        if (!pipeline.selected) continue;
        const sharingKey = input.inventory.filter(
          (entry) =>
            entry.key === pipeline.key &&
            pipelineIdentity(entry) !== pipelineIdentity(pipeline),
        );
        if (sharingKey.length > 0) {
          pushBlocker({
            code: 'DUPLICATE_PIPELINE_KEY',
            subject: pipeline.key,
            message: `"${pipeline.name}" and ${sharingKey
              .map(({ name }) => `"${name}"`)
              .join(
                ', ',
              )} would travel under the same key, ${pipeline.key}. Rename one of the pipeline files.`,
          });
        }
        if (pipeline.hasInstalledPackage) {
          pushBlocker({
            code: 'DEPENDENCY_HAS_INSTALLED_PACKAGE',
            subject: pipeline.name,
            message: `"${pipeline.name}" was installed with its own included files, which can't be shared again from here. Share it from its original author, or remove it from this automation.`,
          });
        }
      }
      return {
        pipelines,
        blockers,
        dismissedReferences: Array.from(matchedDismissals.values()),
      };
    },
  };
}

/**
 * Decide which pipelines an automation share carries. Run it before building
 * portable resources: read the YAML of every returned pipeline, package the
 * `selected` ones, and pass the same input to the analyzer, which repeats
 * this decision in its prompt scan and owns the reported blockers.
 */
export function resolveAutomationPipelineReferences(
  input: ResolveAutomationPipelineReferencesInput,
  location?: AutomationPipelineReferenceLocation,
): AutomationPipelineReferenceResolution {
  const collector = createAutomationPipelineReferenceCollector(input);
  if (input.promptText) collector.addPromptText(input.promptText, location);
  const result = collector.finish();
  return {
    ...result,
    blockers: result.blockers.map((blocker) => ({
      ...blocker,
      occurrences:
        blocker.jobId && blocker.stepId
          ? [{ jobId: blocker.jobId, stepId: blocker.stepId }]
          : [],
    })),
  };
}
