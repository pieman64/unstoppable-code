/**
 * Plan body out of an `ExitPlanMode` tool input (CAN-3019).
 *
 * Canopy deliberately answers `ExitPlanMode` with `behavior: 'deny'` so the plan
 * routes into Canopy's own review UI instead of the provider's. Every renderer
 * therefore has to recognize the call and draw the plan itself, or the denial
 * surfaces as a failed/rejected tool call and the user is told they rejected a
 * plan they never saw. Desktop's `ChatBlockRenderer` and both web transcript
 * renderers hold the input as a JSON string, so one extractor serves all three.
 *
 * Never throws: a malformed or non-plan input returns `null` and the caller
 * falls back to its ordinary tool rendering.
 *
 * Note the returned body may already carry a `[truncated N chars]` marker: the
 * portal wire caps every tool input at 4,000 characters before a renderer sees
 * it. Render what arrived; the marker is the honest signal.
 */
const PORTAL_TRUNCATION_SUFFIX = /\n\n\[truncated \d+ chars\]$/;
const TRUNCATED_PLAN_PREFIX = /^\s*\{\s*"plan"\s*:\s*"/;

function decodeTruncatedJsonStringPrefix(value: string): string | null {
  let decoded = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '"') {
      // A closed plan string means some later field was truncated. Do not
      // reinterpret unrelated malformed JSON as a plan.
      return null;
    }
    if (char !== '\\') {
      if (char !== undefined && char < ' ') return null;
      decoded += char;
      continue;
    }

    const escaped = value[index + 1];
    if (escaped === undefined) break;
    index += 1;
    if (escaped === 'u') {
      const hex = value.slice(index + 1, index + 5);
      if (hex.length < 4) break;
      if (!/^[0-9a-f]{4}$/i.test(hex)) return null;
      decoded += String.fromCharCode(Number.parseInt(hex, 16));
      index += 4;
      continue;
    }
    const escapedCharacters: Record<string, string> = {
      '"': '"',
      '\\': '\\',
      '/': '/',
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
    };
    const decodedEscape = escapedCharacters[escaped];
    if (decodedEscape === undefined) return null;
    decoded += decodedEscape;
  }
  return decoded;
}

function extractWireTruncatedPlan(input: string): string | null {
  const suffix = PORTAL_TRUNCATION_SUFFIX.exec(input)?.[0];
  if (!suffix) return null;
  const serializedPrefix = input.slice(0, -suffix.length);
  const planPrefix = TRUNCATED_PLAN_PREFIX.exec(serializedPrefix)?.[0];
  if (!planPrefix) return null;
  const plan = decodeTruncatedJsonStringPrefix(
    serializedPrefix.slice(planPrefix.length),
  );
  if (!plan?.trim()) return null;
  return `${plan}${suffix}`;
}

export function extractExitPlanModePlan(input: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    // Live portal events historically truncate the serialized input object,
    // not the plan field, leaving a long plan as incomplete JSON followed by
    // the standard wire marker. Recover only that narrow, recognizable shape.
    return extractWireTruncatedPlan(input);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record: Record<string, unknown> = { ...parsed };
  const plan = record['plan'];
  if (typeof plan !== 'string' || plan.trim().length === 0) return null;
  return plan;
}
