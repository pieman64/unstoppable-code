import { BRAND } from '@canopy/brand/current';

function normalizeSuffix(suffix: string): string {
  return suffix.replace(/^_+/, '').toUpperCase();
}

export function brandEnvName(suffix: string): string {
  return `${BRAND.environment.prefixes[0]}_${normalizeSuffix(suffix)}`;
}

export function brandEnvCandidates(suffix: string): string[] {
  const normalized = normalizeSuffix(suffix);
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const prefix of BRAND.environment.prefixes) {
    const name = `${prefix}_${normalized}`;
    if (seen.has(name)) continue;
    seen.add(name);
    candidates.push(name);
  }
  return candidates;
}

export function getBrandEnv(
  env: Record<string, string | undefined>,
  suffix: string,
): string | undefined {
  for (const name of brandEnvCandidates(suffix)) {
    const value = env[name];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

export function setBrandEnv(
  target: Record<string, string | undefined>,
  suffix: string,
  value: string,
): void {
  brandEnvCandidates(suffix).forEach((name, index) => {
    if (index === 0) {
      target[name] = value;
      return;
    }
    if (!(name in target) || (target[name]?.trim().length ?? 0) === 0) {
      target[name] = value;
    }
  });
}
