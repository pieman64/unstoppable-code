const MAX_NAME_BYTES = 200;

function truncateUtf8(value: string, budget: number): string {
  let result = '';
  let bytes = 0;
  for (const character of Array.from(value)) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > budget) break;
    result += character;
    bytes += size;
  }
  return result;
}

function trimTrailing(value: string): string {
  return value.replace(/[ .]+$/, '');
}

function isDeviceName(name: string): boolean {
  const dot = name.indexOf('.');
  const stem = trimTrailing(dot < 0 ? name : name.slice(0, dot));
  // Windows also recognizes superscript 1/2/3 and console device aliases.
  return /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(?:COM|LPT)[1-9¹²³])$/i.test(
    stem,
  );
}

function splitExtension(name: string): { stem: string; extension: string } {
  const dot = name.lastIndexOf('.');
  // A leading dot alone does not give a dotfile an extension.
  return dot > 0
    ? { stem: name.slice(0, dot), extension: name.slice(dot) }
    : { stem: name, extension: '' };
}

function fitName(stem: string, extension: string, suffix: string): string {
  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  // Keep at least one byte for the stem. Only an impossible-to-preserve
  // extension is shortened; ordinary extensions are retained in full.
  const fittedExtension = trimTrailing(
    truncateUtf8(extension, MAX_NAME_BYTES - suffixBytes - 1),
  );
  const stemBudget =
    MAX_NAME_BYTES - suffixBytes - Buffer.byteLength(fittedExtension, 'utf8');
  let fittedStem = truncateUtf8(stem, stemBudget);
  if (!fittedExtension && !suffix) fittedStem = trimTrailing(fittedStem);
  if (!fittedStem) fittedStem = truncateUtf8('download', stemBudget);
  // Truncation can turn a harmless stem (CONsole) into a reserved one (CON).
  if (isDeviceName(`${fittedStem}${suffix}${fittedExtension}`)) {
    fittedStem = truncateUtf8(`_${stem}`, stemBudget);
  }
  return `${fittedStem}${suffix}${fittedExtension}`;
}

/** A literal basename safe on macOS and Windows; performs no filesystem I/O. */
export function sanitizeDownloadName(input: string): string {
  const path = input.split('\0').join('').replace(/\\/g, '/');
  const basename = path.slice(path.lastIndexOf('/') + 1);
  // Explicit control ranges support the workspace's pre-ES2015 target.
  // eslint-disable-next-line no-control-regex
  let name = trimTrailing(basename.replace(/[<>:"|?*\x00-\x1f\x7f-\x9f]/g, ''));
  if (!name) name = 'download';
  if (isDeviceName(name)) name = `_${name}`;
  const { stem, extension } = splitExtension(name);
  return fitName(stem, extension, '');
}

/** `taken` adds checks the caller owns, such as the files already on disk. */
export function uniqueDownloadName(
  input: string,
  occupied: ReadonlySet<string>,
  taken: (candidate: string) => boolean = (): boolean => false,
): string {
  const name = sanitizeDownloadName(input);
  const occupiedKeys = new Set<string>();
  occupied.forEach((entry: string): void => {
    occupiedKeys.add(entry.toLowerCase());
  });
  const free = (candidate: string): boolean =>
    !occupiedKeys.has(candidate.toLowerCase()) && !taken(candidate);
  if (free(name)) return name;

  const { stem, extension } = splitExtension(name);
  for (let index = 1; ; index += 1) {
    const candidate = fitName(stem, extension, ` (${index})`);
    if (free(candidate)) return candidate;
  }
}
