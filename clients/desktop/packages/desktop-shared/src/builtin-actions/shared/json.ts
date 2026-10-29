function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonObject(
  raw: string | undefined,
  label: string,
): Record<string, unknown> {
  if (!raw?.trim()) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }

  if (!isRecord(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }

  return parsed;
}

export function parseStringRecord(
  raw: string | undefined,
  label: string,
): Record<string, string> {
  const parsed = parseJsonObject(raw, label);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') {
      throw new Error(`${label} values must be strings`);
    }
    result[key] = value;
  }
  return result;
}

export function stringifySingleLine(value: unknown): string {
  return JSON.stringify(value);
}
