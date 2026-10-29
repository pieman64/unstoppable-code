export function formatVersionLabel(version: string): string {
  return /^internal-[1-9]\d*$/i.test(version) ? version : `v${version}`;
}
