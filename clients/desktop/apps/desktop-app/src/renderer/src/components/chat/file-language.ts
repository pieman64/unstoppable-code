/**
 * Map a filename (basename, not full path) to a Monaco language id.
 *
 * Returns the supplied language hint for extensions we don't have a more
 * specific mapping for. Desktop file previews use the lowercase extension as
 * that hint, and many of those extensions are already valid Monaco language
 * ids. Without a hint, unknown extensions and extensionless files fall back to
 * `'plaintext'`.
 *
 * Designed to be path-free so it can be unit-tested without filesystem
 * fixtures.
 */
export function getMonacoLanguage(
  filename: string,
  languageHint?: string,
): string {
  if (typeof filename !== 'string' || filename.length === 0) {
    return languageHint ?? 'plaintext';
  }

  // Strip directory components defensively in case a caller passes a path.
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const lower = base.toLowerCase();

  // Filenames that are common to recognize without an extension.
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.')) {
    return 'plaintext';
  }
  if (lower === 'makefile' || lower.startsWith('makefile.')) {
    return 'plaintext';
  }
  if (lower === '.gitignore' || lower === '.gitattributes') {
    return 'plaintext';
  }

  const dotIndex = lower.lastIndexOf('.');
  if (dotIndex < 0) return 'plaintext';
  const ext = lower.slice(dotIndex);

  switch (ext) {
    case '.ts':
    case '.tsx':
      return 'typescript';
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    case '.json':
      return 'json';
    case '.css':
      return 'css';
    case '.scss':
      return 'scss';
    case '.less':
      return 'less';
    case '.html':
    case '.htm':
      return 'html';
    case '.md':
      return 'markdown';
    case '.mdx':
      return 'mdx';
    case '.yaml':
    case '.yml':
      return 'yaml';
    case '.py':
      return 'python';
    case '.sh':
    case '.bash':
    case '.zsh':
      return 'shell';
    case '.go':
      return 'go';
    case '.rs':
      return 'rust';
    case '.java':
      return 'java';
    case '.c':
    case '.h':
      return 'c';
    case '.cpp':
    case '.cc':
    case '.cxx':
    case '.hpp':
      return 'cpp';
    case '.cs':
      return 'csharp';
    case '.php':
      return 'php';
    case '.rb':
      return 'ruby';
    case '.swift':
      return 'swift';
    case '.kt':
    case '.kts':
      return 'kotlin';
    case '.sql':
      return 'sql';
    case '.xml':
      return 'xml';
    case '.ini':
      return 'ini';
    case '.toml':
    case '.env':
    case '.txt':
    case '.log':
      return 'plaintext';
    default:
      return languageHint ?? 'plaintext';
  }
}
