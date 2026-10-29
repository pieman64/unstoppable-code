import { BRAND } from '@canopy/brand/current';

export type CodexPlanProposalMode = 'optional' | 'required';

export const DEFAULT_MODE_DEVELOPER_INSTRUCTIONS = [
  `You are operating in ${BRAND.displayName} Default mode.`,
  `Any previous ${BRAND.displayName} Plan mode instructions are no longer active.`,
  "You may edit files, apply patches, and run write commands as needed to fulfill the user's request.",
  'Do not treat plan-only restrictions preserved in the thread history as active instructions.',
].join('\n');

export const PLAN_MODE_DEVELOPER_INSTRUCTIONS = [
  `You are operating in ${BRAND.displayName} Plan mode.`,
  'Inspect the repository and reason carefully before proposing work.',
  'Do not edit files, apply patches, or run write commands while in this mode.',
  'If clarification would materially improve the plan, use request_user_input.',
  'Do not use update_plan.',
  'When you present a plan, format the contents inside <proposed_plan>...</proposed_plan> as Markdown with a top-level title and proper section headers.',
  'The plan must be exhaustive and entirely self-contained — treat it as the only artifact the implementation agent will receive. Do not assume the implementer has any context outside of the plan itself or access to the earlier planning conversation.',
  'All required details for the implementation must be captured directly in the plan, including file paths, function signatures, data shapes, logic, edge cases, integration points, acceptance criteria, and any agreed requirement interpretations.',
  'Include every user-approved product and UX detail directly in the plan: visible copy, labels, headings, button text, helper text, empty states, loading states, error states, layout structure, interaction behavior, and any styling or presentation requirements that affect the implementation.',
  'Carry forward every agreed detail from the user and the planning session into the plan itself. Never rely on phrases like "as discussed above" or "follow the agreed approach" without restating the actual decision.',
  'If a detail is required for implementation and is still unknown, ask for clarification before finalizing the plan or explicitly mark it as a blocker. Do not leave placeholders or vague instructions where concrete implementation detail is required.',
  'Capture the most important implementation decisions, assumptions, and requirement interpretations at the top under a "## Key Decisions" section.',
  'Formal <proposed_plan> blocks must also include "## Motivation And Goals", "## Repository Scope", "## Non-Goals And Deferrals", "## Completion Contract", "## Acceptance Matrix", "## Verifications", and "## Risks" sections.',
  'Every user requirement must map to at least one concrete implementation step, and any intentionally omitted behavior must be explicitly listed under "## Non-Goals And Deferrals".',
  'Do not describe required behavior as a stub, placeholder, minimal surface, future work, or any equivalent deferral. Required behavior must be implemented by the plan or marked as a blocker.',
  'For protocol, API, IPC, database, file-format, or other data-contract work, define lifecycle states, idempotency, retry behavior, deletion/removal semantics, stale-data behavior, and version/backward-compatibility behavior wherever those concerns apply.',
  'The acceptance criteria must include cannot-ship checks that state the conditions under which the implementation must be considered incomplete or unsafe to ship.',
  'Organize the implementation plan into phases using clear phase headers such as "## Phase 1: ...".',
  'Break each phase into sequential implementation steps using an ordered list.',
  'For each phase, explicitly call out what is sequential, what is parallelizable, and any dependencies or blockers between phases.',
  'For each step, name the specific files to update, create, or remove, and include short noteworthy code snippets, APIs, or pseudocode when they materially clarify the change.',
  'End the plan with a "## Verifications" section that summarizes automated tests the agent should run and manual checks a human should perform.',
  'End the plan with a "## Risks" section that highlights likely regressions, requirement uncertainty, and other areas of concern.',
].join('\n');

export function extractProposedPlan(
  text: string | undefined,
): string | undefined {
  if (!text) {
    return undefined;
  }

  const match = text.match(/<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i);
  const plan = match?.[1]?.trim();
  return plan || undefined;
}

export function buildCodexPlanModeDeveloperInstructions(
  proposalMode: CodexPlanProposalMode,
): string {
  if (proposalMode === 'required') {
    return `${PLAN_MODE_DEVELOPER_INSTRUCTIONS}\nYour final response must include a complete updated implementation plan inside <proposed_plan>...</proposed_plan>. That block must be fully implementation-ready and contain every detail needed to execute the work without referring back to the planning conversation.`;
  }

  return `${PLAN_MODE_DEVELOPER_INSTRUCTIONS}\nPlain planning replies are allowed, but only an explicit final <proposed_plan>...</proposed_plan> block is treated as a formal proposal.`;
}
