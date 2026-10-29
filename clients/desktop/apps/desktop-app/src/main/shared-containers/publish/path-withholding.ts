const CREDENTIAL_BASENAMES = ['.npmrc', '.netrc', '.pgpass'] as const;
const CREDENTIAL_SEGMENTS = new Set(['.ssh', '.gnupg', '.aws', '.kube']);

export function isCredentialShapedSharedContainerPath(path: string): boolean {
  const segments = path.toLowerCase().split('/');
  const name = segments[segments.length - 1] ?? '';
  return (
    segments.some((segment) => CREDENTIAL_SEGMENTS.has(segment)) ||
    CREDENTIAL_BASENAMES.includes(
      name as (typeof CREDENTIAL_BASENAMES)[number],
    ) ||
    name.startsWith('.env') ||
    /\.(?:pem|key|p12|pfx)$/.test(name) ||
    /^id_(?:rsa|ed25519)/.test(name)
  );
}
