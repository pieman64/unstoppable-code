export const REPEAT_TASK_MIN_TOKENS = 3;
export const REPEAT_TASK_SIMILARITY_THRESHOLD = 0.8;
export const REPEAT_TASK_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const REPEAT_TASK_HISTORY_LIMIT = 50;
export const REPEAT_TASK_MAX_PROMPT_CHARS = 4000;

export const REPEAT_TASK_STOPWORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'to',
  'of',
  'for',
  'in',
  'on',
  'at',
  'by',
  'with',
  'from',
  'as',
  'is',
  'are',
  'be',
  'it',
  'its',
  'this',
  'that',
  'these',
  'those',
  'my',
  'me',
  'i',
  'we',
  'our',
  'you',
  'your',
  'please',
  'can',
  'could',
  'would',
  'will',
  'do',
  'so',
  'then',
  'any',
  'all',
  'some',
  'may',
]);

export const REPEAT_TASK_MONTH_WORDS: ReadonlySet<string> = new Set([
  'january',
  'february',
  'march',
  'april',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
  'jan',
  'feb',
  'mar',
  'apr',
  'jun',
  'jul',
  'aug',
  'sep',
  'sept',
  'oct',
  'nov',
  'dec',
]);

export const REPEAT_TASK_WEEKDAY_WORDS: ReadonlySet<string> = new Set([
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
  'mon',
  'tue',
  'tues',
  'wed',
  'thu',
  'thur',
  'thurs',
  'fri',
  'sat',
  'sun',
]);

export const REPEAT_TASK_RELATIVE_DATE_WORDS: ReadonlySet<string> = new Set([
  'today',
  'tomorrow',
  'yesterday',
  'tonight',
]);

// Constructed so the renderer's TS target accepts the `u` flag (TS1501).
const TOKEN_SEPARATOR = new RegExp('[^\\p{L}\\p{N}]+', 'u');
const CONTAINS_DIGIT = new RegExp('\\p{N}', 'u');

export function taskSignature(text: string): string[] {
  const normalized = text
    .slice(0, REPEAT_TASK_MAX_PROMPT_CHARS)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ');
  const tokens: string[] = [];
  for (const token of normalized.split(TOKEN_SEPARATOR)) {
    if (
      token.length >= 2 &&
      !CONTAINS_DIGIT.test(token) &&
      !REPEAT_TASK_STOPWORDS.has(token) &&
      !REPEAT_TASK_MONTH_WORDS.has(token) &&
      !REPEAT_TASK_WEEKDAY_WORDS.has(token) &&
      !REPEAT_TASK_RELATIVE_DATE_WORDS.has(token)
    ) {
      tokens.push(token);
    }
  }

  return Array.from(new Set<string>(tokens)).sort();
}

export function signatureSimilarity(
  a: readonly string[],
  b: readonly string[],
): number {
  const tokensA = new Set<string>(a);
  const tokensB = new Set<string>(b);
  if (
    tokensA.size < REPEAT_TASK_MIN_TOKENS ||
    tokensB.size < REPEAT_TASK_MIN_TOKENS
  ) {
    return 0;
  }

  let intersectionSize = 0;
  const seenTokens = new Set<string>();
  a.forEach((token: string) => {
    if (seenTokens.has(token)) return;
    seenTokens.add(token);
    if (tokensB.has(token)) intersectionSize += 1;
  });

  const unionSize = tokensA.size + tokensB.size - intersectionSize;
  return intersectionSize / unionSize;
}

export function taskSimilarity(a: string, b: string): number {
  return signatureSimilarity(taskSignature(a), taskSignature(b));
}

export function isSimilarSignature(
  a: readonly string[],
  b: readonly string[],
): boolean {
  return signatureSimilarity(a, b) >= REPEAT_TASK_SIMILARITY_THRESHOLD;
}
