#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stddef.h>
#include <stdio.h>
#include <stdint.h>
#include <string.h>

/* The opened handle, not a second PID lookup, brackets the creation query. */
static int observe_process(DWORD pid, ULONGLONG *ticks) {
  FILETIME created, exited, kernel, user;
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
                               FALSE, pid);
  int result = 1;
  if (process == NULL)
    return GetLastError() == ERROR_INVALID_PARAMETER ? 2 : 1;
  if (WaitForSingleObject(process, 0) == WAIT_TIMEOUT &&
      GetProcessTimes(process, &created, &exited, &kernel, &user) &&
      WaitForSingleObject(process, 0) == WAIT_TIMEOUT) {
    *ticks = ((ULONGLONG)created.dwHighDateTime << 32) | created.dwLowDateTime;
    if (*ticks > 9 && *ticks <= 2650467743999999999ULL) result = 0;
  }
  if (!CloseHandle(process)) result = 1;
  return result;
}

static int parse_pid(const char *text, DWORD *pid) {
  uint64_t value = 0;
  const char *digit;
  if (text[0] < '1' || text[0] > '9') return 1;
  for (digit = text; *digit; ++digit) {
    if (*digit < '0' || *digit > '9') return 1;
    value = value * 10 + (unsigned)(*digit - '0');
    if (value > 2147483647) return 1;
  }
  if (value < 2) return 1;
  *pid = (DWORD)value;
  return 0;
}

static int write_receipt(int result, DWORD pid, ULONGLONG ticks) {
  int written;
  if (result == 2) written = puts("canopy-process-v1 absent");
  else if (result == 0)
    written = printf("canopy-process-v1 %lu %llu\n", (unsigned long)pid, ticks);
  else return 1;
  return written < 0 || fflush(stdout) == EOF ? 1 : 0;
}

/* "S-1-" + 15-digit 48-bit authority + 15 x "-" 10-digit subauthorities. */
#define SID_TEXT_MAX 184
#define PRINCIPAL_MODE "--token-user"

/*
 * Serializes binary SID components directly in pinned decimal form: revision 1,
 * at most 15 subauthorities, every byte inside the returned token buffer.
 * ConvertSidToStringSid's hex form for large authorities is never used.
 */
static int format_sid(const BYTE *sid, size_t length, char *text) {
  const size_t header = offsetof(SID, SubAuthority);
  ULONGLONG authority = 0;
  DWORD part;
  size_t count, index, used;
  int written;
  if (length < header || sid[0] != SID_REVISION ||
      sid[1] > SID_MAX_SUB_AUTHORITIES)
    return 1;
  count = sid[1];
  if (length - header < count * sizeof(DWORD)) return 1;
  for (index = 0; index < 6; ++index)
    authority = (authority << 8) | sid[2 + index];
  written = snprintf(text, SID_TEXT_MAX + 1, "S-1-%llu", authority);
  if (written < 0) return 1;
  for (used = (size_t)written, index = 0; index < count; ++index) {
    memcpy(&part, sid + header + index * sizeof(DWORD), sizeof part);
    written = snprintf(text + used, SID_TEXT_MAX + 1 - used, "-%lu",
                       (unsigned long)part);
    if (written < 0 || (size_t)written > SID_TEXT_MAX - used) return 1;
    used += (size_t)written;
  }
  return 0;
}

/* Current-process TokenUser only; success requires the token handle to close. */
static int observe_principal(char *text) {
  union {
    TOKEN_USER user;
    BYTE raw[sizeof(TOKEN_USER) + SECURITY_MAX_SID_SIZE];
  } info;
  HANDLE token;
  DWORD size = 0;
  ULONG_PTR offset;
  int result = 1;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return 1;
  if (GetTokenInformation(token, TokenUser, &info, (DWORD)sizeof info, &size) &&
      size <= sizeof info) {
    /* The SID must lie after TOKEN_USER inside the bytes the call returned. */
    offset = (ULONG_PTR)info.user.User.Sid - (ULONG_PTR)info.raw;
    if (offset >= sizeof(TOKEN_USER) && offset <= size)
      result = format_sid(info.raw + offset, size - offset, text);
  }
  if (!CloseHandle(token)) result = 1;
  return result;
}

static int write_principal(const char *sid) {
  int written = printf("canopy-principal-v1 %s\n", sid);
  return written < 0 || fflush(stdout) == EOF ? 1 : 0;
}

/* Two fixed modes; anything else exits nonzero before any Win32 query. */
static int dispatch(int argc, char **argv) {
  DWORD pid;
  ULONGLONG ticks = 0;
  char sid[SID_TEXT_MAX + 1];
  int result;
  if (argc != 2) return 1;
  if (strcmp(argv[1], PRINCIPAL_MODE) == 0)
    return observe_principal(sid) ? 1 : write_principal(sid);
  if (parse_pid(argv[1], &pid)) return 1;
  /* Separate statements: C leaves argument evaluation order unspecified. */
  result = observe_process(pid, &ticks);
  return write_receipt(result, pid, ticks);
}

#ifndef PROCESS_IDENTITY_TEST
int main(int argc, char **argv) { return dispatch(argc, argv); }
#endif
