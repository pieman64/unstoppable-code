/**
 * Plain-English description of the common shapes of the locked five-field
 * cron grammar used by automations (minute hour day-of-month month
 * day-of-week; numeric tokens only). Returns `null` for anything it cannot
 * describe confidently so callers show the raw expression instead of a
 * wrong sentence. Pure; safe for web and desktop.
 */
const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function parseNumber(token: string, max: number): number | null {
  if (!/^\d{1,2}$/.test(token)) return null;
  const value = Number(token);
  return value <= max ? value : null;
}

function parseDayList(token: string): number[] | null {
  if (token === '1-5') return [1, 2, 3, 4, 5];
  const days: number[] = [];
  for (const part of token.split(',')) {
    const day = parseNumber(part, 7);
    if (day === null) return null;
    days.push(day === 7 ? 0 : day);
  }
  return days;
}

function joinNames(names: readonly string[]): string {
  if (names.length === 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''}`;
}

export function describeFiveFieldCron(expression: string): string | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  if (
    minute === undefined ||
    hour === undefined ||
    dayOfMonth === undefined ||
    month === undefined ||
    dayOfWeek === undefined ||
    month !== '*'
  ) {
    return null;
  }

  if (
    minute === '*' &&
    hour === '*' &&
    dayOfMonth === '*' &&
    dayOfWeek === '*'
  ) {
    return 'Every minute';
  }
  const everyMinutes = /^\*\/(\d{1,2})$/.exec(minute);
  if (everyMinutes && hour === '*' && dayOfMonth === '*' && dayOfWeek === '*') {
    const step = Number(everyMinutes[1]);
    // Cron steps restart each hour; only divisors give a fixed interval.
    if (step < 1 || 60 % step !== 0) return null;
    return step === 1 ? 'Every minute' : `Every ${step} minutes`;
  }
  if (
    minute === '0' &&
    hour === '*' &&
    dayOfMonth === '*' &&
    dayOfWeek === '*'
  ) {
    return 'Every hour';
  }
  const everyHours = /^\*\/(\d{1,2})$/.exec(hour);
  if (minute === '0' && everyHours && dayOfMonth === '*' && dayOfWeek === '*') {
    const step = Number(everyHours[1]);
    if (step < 1 || 24 % step !== 0) return null;
    return step === 1 ? 'Every hour' : `Every ${step} hours`;
  }

  const minuteValue = parseNumber(minute, 59);
  const hourValue = parseNumber(hour, 23);
  if (minuteValue === null || hourValue === null) return null;
  const time = `${pad(hourValue)}:${pad(minuteValue)}`;

  if (dayOfMonth === '*' && dayOfWeek === '*') return `Every day at ${time}`;
  if (dayOfMonth === '*') {
    if (dayOfWeek === '1-5') return `Every weekday at ${time}`;
    const days = parseDayList(dayOfWeek);
    if (!days || days.length === 0) return null;
    return `Every ${joinNames(days.map((day): string => DAY_NAMES[day] ?? ''))} at ${time}`;
  }
  if (dayOfWeek === '*') {
    const day = parseNumber(dayOfMonth, 31);
    if (day === null || day === 0) return null;
    return `On day ${day} of every month at ${time}`;
  }
  return null;
}
