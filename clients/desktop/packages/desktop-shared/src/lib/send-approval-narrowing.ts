import {
  APPROVAL_MODES,
  type ApprovalMode,
  type ApprovalRule,
} from '@canopy/execution-engine/types/approvals';
import { stableStringify } from './stable-hash';

/*
 * A chat's approval authority comes from its saved tab. The approval fields a
 * send carries can only narrow it: a stricter mode, or extra deny rules. A
 * send's allow rules carry no authority.
 */

/** Whether `mode` grants less than `than`. */
export function isStricterApprovalMode(
  mode: ApprovalMode,
  than: ApprovalMode,
): boolean {
  return APPROVAL_MODES.indexOf(mode) < APPROVAL_MODES.indexOf(than);
}

/** The chat's mode, or the mode a send asks for when that is stricter. */
export function narrowApprovalMode(
  saved: ApprovalMode,
  requested: ApprovalMode | undefined,
): ApprovalMode {
  return requested !== undefined && isStricterApprovalMode(requested, saved)
    ? requested
    : saved;
}

/** Rules with the same behavior and target, whatever their ids or key order. */
function approvalRuleEffect(rule: ApprovalRule): string {
  return stableStringify([rule.behavior, rule.target]);
}

/** The deny rules a send asks for that the chat does not already hold. */
export function sendDenyRulesBeyond(
  saved: readonly ApprovalRule[],
  requested: readonly ApprovalRule[] | undefined,
): ApprovalRule[] {
  const held = new Set(saved.map(approvalRuleEffect));
  const added = new Set<string>();
  return (requested ?? []).filter((rule) => {
    if (rule.behavior !== 'deny') return false;
    const effect = approvalRuleEffect(rule);
    if (held.has(effect) || added.has(effect)) return false;
    added.add(effect);
    return true;
  });
}

/** The chat's session rules plus the deny rules a send adds to them. */
export function narrowSessionApprovalRules(
  saved: readonly ApprovalRule[],
  requested: readonly ApprovalRule[] | undefined,
): ApprovalRule[] {
  return [...saved, ...sendDenyRulesBeyond(saved, requested)];
}

/** `rules` without the allow rules `limit` does not also hold. */
export function limitAllowRules(
  rules: readonly ApprovalRule[],
  limit: readonly ApprovalRule[],
): ApprovalRule[] {
  const allowed = new Set(
    limit.filter((rule) => rule.behavior === 'allow').map(approvalRuleEffect),
  );
  return rules.filter(
    (rule) =>
      rule.behavior !== 'allow' || allowed.has(approvalRuleEffect(rule)),
  );
}

/**
 * The session rules a turn starts with: the chat's rules plus the send's deny
 * rules. What an agent send was admitted against (`admitted`) bounds their
 * allow rules, and its deny rules still apply.
 */
export function turnSessionApprovalRules(
  saved: readonly ApprovalRule[],
  requested: readonly ApprovalRule[] | undefined,
  admitted: readonly ApprovalRule[] | undefined,
): ApprovalRule[] {
  const rules = narrowSessionApprovalRules(saved, requested);
  return admitted
    ? narrowSessionApprovalRules(limitAllowRules(rules, admitted), admitted)
    : rules;
}

/**
 * Whether session rules `held` grant nothing `rules` does not: each of their
 * allow rules is in `rules`, and each deny rule in `rules` is in them.
 */
export function sessionApprovalRulesWithin(
  held: readonly ApprovalRule[],
  rules: readonly ApprovalRule[],
): boolean {
  return (
    limitAllowRules(held, rules).length === held.length &&
    sendDenyRulesBeyond(held, rules).length === 0
  );
}

/** The approval a turn starts with. */
export interface TurnApproval {
  approvalMode: ApprovalMode;
  sessionApprovalRules: readonly ApprovalRule[];
}

/**
 * Whether a session that applied `mode` and `rules` holds no more authority
 * than `turn`: its mode is not wider, and its rules are within the turn's. An
 * unknown mode counts as Full Access. Unknown rules are presumed to be the
 * tab's (`tabRules`) and must then equal the turn's.
 */
export function sessionApprovalWithinTurn(
  mode: ApprovalMode | undefined,
  rules: readonly ApprovalRule[] | undefined,
  turn: TurnApproval,
  tabRules: readonly ApprovalRule[],
): boolean {
  const rulesWithin = rules
    ? sessionApprovalRulesWithin(rules, turn.sessionApprovalRules)
    : sessionApprovalRulesWithin(tabRules, turn.sessionApprovalRules) &&
      sessionApprovalRulesWithin(turn.sessionApprovalRules, tabRules);
  return (
    !isStricterApprovalMode(turn.approvalMode, mode ?? 'full-access') &&
    rulesWithin
  );
}
