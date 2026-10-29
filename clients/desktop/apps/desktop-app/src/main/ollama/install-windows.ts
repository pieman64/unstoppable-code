import { execFileBounded } from './installation';

const WINDOWS_INSTALL_TIMEOUT_MS = 10 * 60_000;
const OLLAMA_WINDOWS_SIGNER_ORGANIZATION = 'Ollama Inc.';

function powershellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether the PowerShell signature report describes a valid Authenticode
 * signature from Ollama. The report is one JSON line whose `subject` holds one
 * certificate attribute per line; Windows separates those lines with CRLF.
 */
export function isOllamaWindowsSignature(report: string): boolean {
  const lines = report
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const json = lines[lines.length - 1];
  if (!json) {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return false;
  }
  return (
    isRecord(parsed) &&
    parsed.status === 'Valid' &&
    typeof parsed.subject === 'string' &&
    parsed.subject
      .split(/\r?\n/)
      .includes(`O=${OLLAMA_WINDOWS_SIGNER_ORGANIZATION}`)
  );
}

export async function installWindowsOllamaPackage(
  installerPath: string,
  onVerified?: () => void,
): Promise<void> {
  const signature = await execFileBounded(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      [
        `$sig = Get-AuthenticodeSignature -LiteralPath ${powershellQuote(installerPath)}`,
        'if ($null -eq $sig.SignerCertificate) { Write-Error "Missing Authenticode signer"; exit 1 }',
        '$subject = $sig.SignerCertificate.SubjectName.Decode([System.Security.Cryptography.X509Certificates.X500DistinguishedNameFlags]::UseNewLines)',
        '[pscustomobject]@{ status = [string]$sig.Status; subject = $subject } | ConvertTo-Json -Compress',
      ].join('; '),
    ],
    { timeoutMs: 60_000 },
  );
  if (!isOllamaWindowsSignature(signature.stdout)) {
    throw new Error(
      'The Ollama installer does not have a valid Authenticode signature from Ollama Inc.',
    );
  }
  onVerified?.();

  await execFileBounded(
    installerPath,
    ['/VERYSILENT', '/NORESTART', '/SUPPRESSMSGBOXES'],
    {
      timeoutMs: WINDOWS_INSTALL_TIMEOUT_MS,
      windowsHide: true,
    },
  );
}
