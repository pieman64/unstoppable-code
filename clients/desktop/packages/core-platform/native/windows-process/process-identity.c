#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <psapi.h>
#include <stdlib.h>
#include <stddef.h>
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <wchar.h>

/* A vanished PID is evidence only after a fresh, complete enumeration. A present
 * PID (including a reused one) must still be inspected or refuse. */
static int cold_pid_absent(DWORD pid) {
  DWORD *pids, bytes = 0, i;
  const DWORD capacity = 100001 * sizeof(DWORD);
  int absent = 0;
  if (pid == 0 || pid == 4) return 0;
  pids = malloc(capacity);
  if (!pids) return 0;
  if (EnumProcesses(pids, capacity, &bytes) && bytes && bytes < capacity &&
      bytes % sizeof(DWORD) == 0) {
    absent = 1;
    for (i = 0; i < bytes / sizeof(DWORD); ++i)
      if (pids[i] == pid) { absent = 0; break; }
  }
  free(pids);
  return absent;
}

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

static int cold_same_object(HANDLE left, HANDLE right) {
  typedef BOOL (WINAPI *COMPARE)(HANDLE, HANDLE);
  COMPARE compare;
  FARPROC address = GetProcAddress(GetModuleHandleW(L"kernelbase.dll"), "CompareObjectHandles");
  if (!address || sizeof compare != sizeof address) {
    SetLastError(ERROR_PROC_NOT_FOUND);
    return -1;
  }
  memcpy(&compare, &address, sizeof compare);
  SetLastError(NO_ERROR);
  if (compare(left, right)) return 1;
  return GetLastError() == NO_ERROR || GetLastError() == ERROR_NOT_SAME_OBJECT ? 0 : -1;
}

/* Metadata-only raw devices cannot establish filesystem data access. */
static int cold_metadata_device(const WCHAR *name, size_t length, DWORD access) {
  const WCHAR *end = name + length, *cursor;
  const WCHAR disk[] = L"\\Device\\Harddisk";
  const WCHAR volume[] = L"\\Device\\HarddiskVolume";
  size_t prefix;
  if (access & (FILE_READ_DATA | FILE_WRITE_DATA | FILE_APPEND_DATA |
                GENERIC_READ | GENERIC_WRITE | GENERIC_ALL)) return 0;
  prefix = (sizeof volume / sizeof *volume) - 1;
  if (length > prefix && !wcsncmp(name, volume, prefix)) {
    for (cursor = name + prefix; cursor < end && *cursor >= L'0' && *cursor <= L'9'; ++cursor) {}
    return cursor == end;
  }
  prefix = (sizeof disk / sizeof *disk) - 1;
  if (length <= prefix || wcsncmp(name, disk, prefix)) return 0;
  cursor = name + prefix;
  if (*cursor < L'0' || *cursor > L'9') return 0;
  while (cursor < end && *cursor >= L'0' && *cursor <= L'9') ++cursor;
  if (end - cursor < 4 || wcsncmp(cursor, L"\\DR", 3)) return 0;
  cursor += 3;
  if (*cursor < L'0' || *cursor > L'9') return 0;
  while (cursor < end && *cursor >= L'0' && *cursor <= L'9') ++cursor;
  return cursor == end;
}

typedef struct {
  WCHAR *names[4096];
  size_t count, bytes;
  int complete;
} COLD_FILE_HOSTS;

/* File object type also covers driver communication endpoints. Only complete
 * filesystem-host namespace evidence can distinguish those from unresolved files.
 */
static int cold_nonfile_object(const WCHAR *name, size_t length, DWORD access,
                               const COLD_FILE_HOSTS *hosts) {
  const WCHAR prefix[] = L"\\Device\\";
  const WCHAR *storage[] = { L"Harddisk", L"CdRom", L"Floppy", L"VhdHardDisk",
                             L"Volume", L"Disk", L"Ramdisk", L"Mup" };
  const WCHAR redirector[] = L"Redirector";
  const size_t start = (sizeof prefix / sizeof *prefix) - 1;
  const size_t suffix = (sizeof redirector / sizeof *redirector) - 1;
  size_t i, chars;
  if (!hosts->complete || !length || name[0] != L'\\') return 0;
  for (i = 0; i < length; ++i) if (!name[i]) return 0;
  if (cold_metadata_device(name, length, access)) return 1;
  for (i = 0; i < hosts->count; ++i) {
    size_t size = wcslen(hosts->names[i]);
    if (length >= size && !_wcsnicmp(name, hosts->names[i], size) &&
        (length == size || name[size] == L'\\')) return 0;
  }
  if (length > start && !_wcsnicmp(name, prefix, start)) {
    chars = length - start;
    for (i = 0; i < sizeof storage / sizeof *storage; ++i) {
      size_t size = wcslen(storage[i]);
      if (chars >= size && !_wcsnicmp(name + start, storage[i], size)) return 0;
    }
    for (i = start; i + suffix <= length && name[i] != L'\\'; ++i)
      if (!_wcsnicmp(name + i, redirector, suffix)) return 0;
  }
  return 1;
}

#ifndef PROCESS_IDENTITY_TEST
#include "cold-observation.h"
#endif

/* Fixed modes; anything else exits nonzero before any Win32 query. */
static int dispatch(int argc, char **argv) {
  DWORD pid;
  ULONGLONG ticks = 0;
  char sid[SID_TEXT_MAX + 1];
  int result;
#ifndef PROCESS_IDENTITY_TEST
  if (argc == 3 && (!strcmp(argv[1], "--cold-snapshot") || !strcmp(argv[1], "--cold-process") || !strcmp(argv[1], "--cold-classify"))) {
    if (parse_pid(argv[2], &pid)) return 1;
    if (!strcmp(argv[1], "--cold-snapshot")) return cold_snapshot(pid);
    if (!strcmp(argv[1], "--cold-classify")) return cold_classification(pid);
    if (puts("canopy-cold-v1") < 0 || cold_inspect(pid, 0, &ticks)) return 1;
    return puts("complete 1") < 0 || fflush(stdout) == EOF ? 1 : 0;
  }
#endif
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
