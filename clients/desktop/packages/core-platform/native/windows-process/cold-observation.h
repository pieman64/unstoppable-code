#include <windows.h>
#include <winternl.h>
#include <wtsapi32.h>
#include <psapi.h>
#include <aclapi.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>

typedef NTSTATUS (NTAPI *QUERY)(HANDLE, ULONG, PVOID, ULONG, PULONG);
typedef struct {
  HANDLE value;
  ULONG_PTR count, pointers;
  ULONG access, type, attributes, reserved;
} HANDLE_ROW;
typedef struct {
  ULONG_PTR count, reserved;
  HANDLE_ROW rows[1];
} HANDLE_TABLE;
/* RTL_USER_PROCESS_PARAMETERS up to (but not including) DllPath. */
typedef struct {
  ULONG maximum, length, flags, debug;
  HANDLE console;
  ULONG console_flags;
  HANDLE input, output, error;
  UNICODE_STRING cwd;
  HANDLE cwd_handle;
} PARAMS_PREFIX;

typedef struct { USHORT length, maximum; ULONG buffer; } STRING32;
typedef struct {
  ULONG maximum, length, flags, debug, console, console_flags;
  ULONG input, output, error;
  STRING32 cwd;
  ULONG cwd_handle;
} PARAMS_PREFIX32;
typedef struct { PVOID parameters, buffer; USHORT length; } COLD_CWD;
static int read_exact(HANDLE process, const void *remote, void *local, SIZE_T size);
static int cold_same_instance_alive(HANDLE process, const FILETIME *expected);


static int cold_cwd(HANDLE process, PVOID peb, int wow64, COLD_CWD *cwd) {
  if (wow64) {
    ULONG parameters;
    PARAMS_PREFIX32 params;
    if (read_exact(process, (BYTE *)peb + 0x10, &parameters, sizeof parameters) ||
        !parameters || read_exact(process, (PVOID)(ULONG_PTR)parameters, &params, sizeof params) ||
        params.length < sizeof params || !params.cwd.buffer ||
        params.cwd.maximum < params.cwd.length) return 1;
    cwd->parameters = (PVOID)(ULONG_PTR)parameters;
    cwd->buffer = (PVOID)(ULONG_PTR)params.cwd.buffer;
    cwd->length = params.cwd.length;
  } else {
    PVOID parameters;
    PARAMS_PREFIX params;
    if (read_exact(process, (BYTE *)peb + 0x20, &parameters, sizeof parameters) ||
        !parameters || read_exact(process, parameters, &params, sizeof params) ||
        params.length < sizeof params || !params.cwd.Buffer ||
        params.cwd.MaximumLength < params.cwd.Length) return 1;
    cwd->parameters = parameters;
    cwd->buffer = params.cwd.Buffer;
    cwd->length = params.cwd.Length;
  }
  return !cwd->length || cwd->length % 2 || cwd->length > 65534;
}

static int hex_path(const char *kind, const WCHAR *text, size_t length) {
  size_t i;
  if (!length || length > 32768) return 1;
  if (printf("%s ", kind) < 0) return 1;
  for (i = 0; i < length; i++) {
    if (!text[i] || printf("%04x", (unsigned)text[i]) < 0) return 1;
  }
  return puts("") < 0;
}
static int read_exact(HANDLE process, const void *remote, void *local, SIZE_T size) {
  SIZE_T got = 0;
  return !ReadProcessMemory(process, remote, local, size, &got) || got != size;
}
/* Only a kernel name immediately under the reserved NTFS metafile directory
 * proves a nameless mapped object. Never infer deletion from a DOS path/error. */
static int cold_ntfs_deleted_mapping(const WCHAR *name) {
  const WCHAR prefix[] = L"\\Device\\";
  const WCHAR marker[] = L"\\$Extend\\$Deleted\\";
  const WCHAR *volume, *tail, *component, *p;
  WCHAR root[32769], filesystem[32];
  HANDLE handle;
  DWORD drive;
  int result;
  if (wcsncmp(name, prefix, wcslen(prefix))) return 0;
  volume = name + wcslen(prefix);
  tail = wcschr(volume, L'\\');
  if (!tail || tail == volume || wcsncmp(tail, marker, wcslen(marker))) return 0;
  component = tail + wcslen(marker);
  if (!*component || !wcscmp(component, L".") || !wcscmp(component, L"..")) return 0;
  for (p = volume; p < tail; ++p) if (*p == L'/' || *p == L':') return 0;
  for (p = component; *p; ++p) if (*p == L'\\' || *p == L'/' || *p == L':') return 0;
  if (swprintf(root, 32769, L"\\\\?\\GLOBALROOT%.*ls\\", (int)(tail - name), name) < 0) return 0;
  /* In particular, an SMB server claiming NTFS is not a local metafile proof. */
  drive = GetDriveTypeW(root);
  if (drive != DRIVE_FIXED && drive != DRIVE_REMOVABLE) return 0;
  handle = CreateFileW(root, FILE_READ_ATTRIBUTES,
                       FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                       NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, NULL);
  if (handle == INVALID_HANDLE_VALUE) return 0;
  memset(filesystem, 0, sizeof filesystem);
  result = GetVolumeInformationByHandleW(handle, NULL, 0, NULL, NULL, NULL,
                                        filesystem, 32) && !wcscmp(filesystem, L"NTFS");
  if (!CloseHandle(handle)) result = 0;
  return result;
}
/* Convert mapped NT device paths to DOS paths; unknown device aliases refuse. */
static int cold_mapped_path(const WCHAR *name) {
  WCHAR device[32769], path[32769];
  WCHAR drive[] = L"A:";
  size_t length;
  if (cold_ntfs_deleted_mapping(name)) return hex_path("m ntfs", name, wcslen(name));
  if (!wcsncmp(name, L"\\Device\\Mup\\", 12)) {
    if (swprintf(path, 32769, L"\\\\%ls", name + 12) < 0) return 1;
    return hex_path("f", path, wcslen(path));
  }
  for (drive[0] = L'A'; drive[0] <= L'Z'; ++drive[0]) {
    if (!QueryDosDeviceW(drive, device, 32768)) continue;
    length = wcslen(device);
    if (!wcsncmp(name, device, length) && name[length] == L'\\') {
      if (swprintf(path, 32769, L"%ls%ls", drive, name + length) < 0) return 1;
      return hex_path("f", path, wcslen(path));
    }
  }
  return 1;
}
/* Use Win32's documented Flags, not native section allocation attributes. */
static int cold_pagefile_mapping(HANDLE process, PVOID base, DWORD type) {
  typedef BOOL (WINAPI *REGION_QUERY)(HANDLE, LPCVOID, int, PVOID, SIZE_T, PSIZE_T);
  struct { PVOID base; ULONG protect, flags; SIZE_T size, committed; } region;
  REGION_QUERY query;
  FARPROC address = GetProcAddress(GetModuleHandleW(L"kernelbase.dll"), "QueryVirtualMemoryInformation");
  BOOL queried;
  if (!address || sizeof query != sizeof address || type != MEM_MAPPED) return 0;
  memcpy(&query, &address, sizeof query);
  memset(&region, 0, sizeof region);
  queried = query(process, base, 0, &region, sizeof region, NULL);
  if (queried && (region.flags & 8) && !(region.flags & 6)) return 1;
  return 0;
}
/* One shared denial window per process, including image and mapping queries. */
typedef struct {
  ULONGLONG started, elapsed;
  unsigned waits, attempts;
  int active, exhausted;
  const char *stage;
} COLD_DENIAL;
static int cold_retry_denial(HANDLE process, const FILETIME *created, COLD_DENIAL *denial,
                             const char *stage, unsigned attempts) {
  static const DWORD delays[] = {25, 50, 100, 200, 300, 325};
  ULONGLONG now = GetTickCount64(), remaining;
  DWORD delay;
  if (!cold_same_instance_alive(process, created)) {
    SetLastError(ERROR_RETRY); return 0;
  }
  if (!denial->active) { denial->active = 1; denial->started = now; }
  denial->elapsed = now - denial->started;
  if (denial->elapsed >= 1000) {
    denial->exhausted = 1; denial->stage = stage; denial->attempts = attempts;
    SetLastError(ERROR_ACCESS_DENIED); return 0;
  }
  remaining = 1000 - denial->elapsed;
  delay = denial->waits < 6 ? delays[denial->waits++] : (DWORD)remaining;
  if (delay > remaining) delay = (DWORD)remaining;
  Sleep(delay);
  if (denial->waits == 6) {
    /* Sleep may return before a tick boundary; finish the last backoff once. */
    while ((now = GetTickCount64()) - denial->started < 1000)
      Sleep((DWORD)(1000 - (now - denial->started)));
  }
  return 1;
}
static SIZE_T cold_query_region(HANDLE process, LPCVOID address,
                               MEMORY_BASIC_INFORMATION *region,
                               const FILETIME *created, unsigned *attempts, COLD_DENIAL *denial) {
  SIZE_T got;
  DWORD error;
  for (*attempts = 1;; ++*attempts) {
    if (!cold_same_instance_alive(process, created)) {
      SetLastError(ERROR_RETRY); return 0;
    }
    got = VirtualQueryEx(process, address, region, sizeof *region);
    if (got == sizeof *region) return got;
    error = GetLastError();
    if (got || error != ERROR_ACCESS_DENIED) { SetLastError(error); return got; }
    if (!cold_retry_denial(process, created, denial, "mapping-query", *attempts)) return 0;
  }
}
static DWORD cold_mapping_name(HANDLE process, LPVOID base, WCHAR *path,
                                const FILETIME *created, COLD_DENIAL *denial) {
  unsigned attempts;
  DWORD length, error;
  for (attempts = 1;; ++attempts) {
    if (!cold_same_instance_alive(process, created)) { SetLastError(ERROR_RETRY); return 0; }
    length = GetMappedFileNameW(process, base, path, 32768);
    if (length) return length;
    error = GetLastError();
    if (error != ERROR_ACCESS_DENIED) { SetLastError(error); return 0; }
    if (!cold_retry_denial(process, created, denial, "mapping-name", attempts)) return 0;
  }
}
static int cold_image_name(HANDLE process, WCHAR *text, DWORD *length,
                           const FILETIME *created, COLD_DENIAL *denial) {
  unsigned attempts;
  DWORD error;
  for (attempts = 1;; ++attempts) {
    if (!cold_same_instance_alive(process, created)) { SetLastError(ERROR_RETRY); return 1; }
    *length = 32768;
    if (QueryFullProcessImageNameW(process, 0, text, length)) return 0;
    error = GetLastError();
    if (error != ERROR_ACCESS_DENIED) { SetLastError(error); return 1; }
    if (!cold_retry_denial(process, created, denial, "image-name", attempts)) return 1;
  }
}
static int cold_mappings(HANDLE process, const FILETIME *created, char *diagnostic, size_t capacity, COLD_DENIAL *denial) {
  SYSTEM_INFO system;
  MEMORY_BASIC_INFORMATION region;
  WCHAR path[32769];
  ULONG_PTR cursor = 0, next;
  DWORD length;
  unsigned count = 0, attempts = 0;
  GetNativeSystemInfo(&system);
  while (cursor <= (ULONG_PTR)system.lpMaximumApplicationAddress) {
    attempts = 0;
    if (++count > 1000000 || cold_query_region(process, (LPCVOID)cursor, &region,
                                             created, &attempts, denial) != sizeof region) {
      DWORD error = GetLastError();
      snprintf(diagnostic, capacity, "cold mapping query: pid=%lu process-handle=0x%llx cursor=0x%llx attempts=%u win32=%lu liveness=%lu\n",
              (unsigned long)GetProcessId(process), (unsigned long long)(ULONG_PTR)process,
              (unsigned long long)cursor, attempts,
              (unsigned long)error, (unsigned long)WaitForSingleObject(process, 0));
      SetLastError(error);
      return 1;
    }
    if (region.State == MEM_COMMIT && (region.Type == MEM_MAPPED || region.Type == MEM_IMAGE)) {
      length = cold_mapping_name(process, region.BaseAddress, path, created, denial);
      if (!length) {
        DWORD error = GetLastError();
        if (denial->exhausted || error == ERROR_RETRY) return 1;
        if (!cold_pagefile_mapping(process, region.BaseAddress, region.Type)) {
          MEMORY_BASIC_INFORMATION after = {0};
          SIZE_T got = cold_query_region(process, region.BaseAddress, &after, created, &attempts, denial);
          DWORD query_error = GetLastError();
          if (denial->exhausted || (got != sizeof after && query_error == ERROR_RETRY)) return 1;
          if (got == sizeof after && after.State == MEM_FREE) {
            next = (ULONG_PTR)after.BaseAddress + after.RegionSize;
            if (next <= cursor) return 1;
            cursor = next;
            continue;
          }
          snprintf(diagnostic, capacity, "cold mapping name: pid=%lu base=0x%llx size=0x%llx state=0x%lx type=0x%lx win32=%lu requery-bytes=%llu requery-win32=%lu after-base=0x%llx after-size=0x%llx after-state=0x%lx after-type=0x%lx liveness=%lu\n",
                  (unsigned long)GetProcessId(process), (unsigned long long)(ULONG_PTR)region.BaseAddress,
                  (unsigned long long)region.RegionSize, (unsigned long)region.State, (unsigned long)region.Type,
                  (unsigned long)error, (unsigned long long)got, (unsigned long)query_error,
                  (unsigned long long)(ULONG_PTR)after.BaseAddress, (unsigned long long)after.RegionSize,
                  (unsigned long)after.State, (unsigned long)after.Type,
                  (unsigned long)WaitForSingleObject(process, 0));
          SetLastError(error);
          return 1;
        }
      } else if (length >= 32768 || cold_mapped_path(path)) return 1;
    }
    next = (ULONG_PTR)region.BaseAddress + region.RegionSize;
    if (next <= cursor) return 1;
    cursor = next;
  }
  return 0;
}
static void cold_free_file_hosts(COLD_FILE_HOSTS *hosts) {
  size_t i;
  for (i = 0; i < hosts->count; ++i) free(hosts->names[i]);
  memset(hosts, 0, sizeof *hosts);
}
static int cold_add_file_host(COLD_FILE_HOSTS *hosts, const WCHAR *name, size_t length) {
  size_t i, bytes = (length + 1) * sizeof(WCHAR);
  WCHAR *copy;
  if (!length || name[0] != L'\\' || hosts->count >= 4096 ||
      bytes > 4 * 1024 * 1024 - hosts->bytes) return 1;
  while (length > 1 && name[length - 1] == L'\\') --length;
  for (i = 0; i < hosts->count; ++i)
    if (wcslen(hosts->names[i]) == length && !_wcsnicmp(hosts->names[i], name, length)) return 0;
  copy = calloc(length + 1, sizeof(WCHAR));
  if (!copy) return 1;
  memcpy(copy, name, length * sizeof(WCHAR));
  hosts->names[hosts->count++] = copy; hosts->bytes += bytes;
  return 0;
}
static int cold_add_device_targets(COLD_FILE_HOSTS *hosts, const WCHAR *device, DWORD size) {
  size_t offset = 0;
  if (!size || size > 32768 || !device[0]) return 1;
  while (offset < size && device[offset]) {
    size_t end = offset;
    while (end < size && device[end]) ++end;
    if (end == size || cold_add_file_host(hosts, device + offset, end - offset)) return 1;
    offset = end + 1;
  }
  return offset >= size;
}
static int cold_host_order(const void *left, const void *right) {
  return _wcsicmp(*(WCHAR *const *)left, *(WCHAR *const *)right);
}
/* Volume GUIDs include mounted-folder and unlettered volumes. Drive aliases
 * additionally cover network/substituted drives. Ambiguity never yields a set.
 */
static int cold_read_file_hosts(COLD_FILE_HOSTS *hosts) {
  WCHAR volume[32769], device[32769], drive[] = L"A:";
  HANDLE search = FindFirstVolumeW(volume, 32768);
  int result = 1;
  memset(hosts, 0, sizeof *hosts);
  if (search == INVALID_HANDLE_VALUE) return 1;
  for (;;) {
    size_t chars = wcslen(volume);
    DWORD size;
    if (chars < 5 || wcsncmp(volume, L"\\\\?\\", 4) || volume[chars - 1] != L'\\') goto done;
    volume[chars - 1] = 0;
    size = QueryDosDeviceW(volume + 4, device, 32768);
    if (cold_add_device_targets(hosts, device, size)) goto done;
    if (!FindNextVolumeW(search, volume, 32768)) {
      if (GetLastError() != ERROR_NO_MORE_FILES) goto done;
      break;
    }
  }
  for (drive[0] = L'A'; drive[0] <= L'Z'; ++drive[0]) {
    DWORD size = QueryDosDeviceW(drive, device, 32768);
    if (!size) {
      if (GetLastError() == ERROR_FILE_NOT_FOUND) continue;
      goto done;
    }
    if (cold_add_device_targets(hosts, device, size)) goto done;
  }
  if (!hosts->count) goto done;
  qsort(hosts->names, hosts->count, sizeof(WCHAR *), cold_host_order);
  hosts->complete = 1;
  result = 0;
done:
  if (!FindVolumeClose(search)) result = 1;
  if (result) cold_free_file_hosts(hosts);
  return result;
}
static int cold_same_file_hosts(const COLD_FILE_HOSTS *a, const COLD_FILE_HOSTS *b) {
  size_t i;
  if (!a->complete || !b->complete || a->count != b->count) return 0;
  for (i = 0; i < a->count; ++i) if (_wcsicmp(a->names[i], b->names[i])) return 0;
  return 1;
}
static int cold_nonfilesystem_disk(HANDLE handle, DWORD access, const COLD_FILE_HOSTS *hosts) {
  typedef NTSTATUS (NTAPI *OBJECT_QUERY)(HANDLE, ULONG, PVOID, ULONG, PULONG);
  OBJECT_QUERY query;
  FARPROC address = GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryObject");
  union { UNICODE_STRING name; BYTE bytes[65536]; } info;
  ULONG needed = 0;
  NTSTATUS status;
  ULONG_PTR name, begin = (ULONG_PTR)&info;
  if (!address || sizeof query != sizeof address) return 0;
  memcpy(&query, &address, sizeof query);
  memset(&info, 0, sizeof info);
  status = query(handle, 1, &info, sizeof info, &needed);
  name = (ULONG_PTR)info.name.Buffer;
  if (status < 0 || needed > sizeof info || !info.name.Length ||
      info.name.Length % 2 || name < begin || name > begin + sizeof info ||
      info.name.Length > begin + sizeof info - name) return 0;
  if (cold_nonfile_object(info.name.Buffer, info.name.Length / 2, access, hosts)) return 1;
  return 0;
}
static int cold_handle_order(const void *left, const void *right) {
  ULONG_PTR a = (ULONG_PTR)((const HANDLE_ROW *)left)->value;
  ULONG_PTR b = (ULONG_PTR)((const HANDLE_ROW *)right)->value;
  return a < b ? -1 : a > b ? 1 : 0;
}
static int cold_same_instance_alive(HANDLE process, const FILETIME *expected) {
  FILETIME created, exited, kernel, user;
  return WaitForSingleObject(process, 0) == WAIT_TIMEOUT &&
         GetProcessTimes(process, &created, &exited, &kernel, &user) &&
         !CompareFileTime(expected, &created) &&
         WaitForSingleObject(process, 0) == WAIT_TIMEOUT;
}
/* FileIdInfo (18) is available on the qualified Windows hosts, but SDK headers
 * hide FILE_ID_INFO at our existing Vista compile target. Keep its documented ABI. */
typedef struct { ULONGLONG volume; BYTE file_id[16]; } COLD_FILE_ID;
static int cold_file_path(HANDLE duplicate, const WCHAR *path, DWORD length) {
  FILE_STANDARD_INFO standard;
  COLD_FILE_ID identity;
  size_t i;
  /* NTFS can retain the original final name after POSIX unlink. The pinned
   * object's zero-link/DeletePending evidence, not that spelling, is decisive. */
  if (GetFileInformationByHandleEx(duplicate, FileStandardInfo, &standard, sizeof standard) &&
      standard.DeletePending && !standard.NumberOfLinks && !standard.Directory &&
      GetFileInformationByHandleEx(duplicate, (FILE_INFO_BY_HANDLE_CLASS)18, &identity, sizeof identity)) {
    if (printf("d %016llx ", (unsigned long long)identity.volume) < 0) return 1;
    for (i = 0; i < sizeof identity.file_id; ++i)
      if (printf("%02x", (unsigned)identity.file_id[i]) < 0) return 1;
    return puts("") < 0;
  }
  return hex_path("f", path, length);
}
/* Arrivals after T are outside the proof; keep cheap, readable paths as extra evidence. */
static int cold_arrival_file_path(HANDLE duplicate) {
  WCHAR text[32769];
  DWORD type, length;
  int result = 0;
  SetLastError(NO_ERROR);
  type = GetFileType(duplicate);
  if (type == FILE_TYPE_DISK || (type == FILE_TYPE_UNKNOWN && GetLastError() == NO_ERROR)) {
    length = GetFinalPathNameByHandleW(duplicate, text, 32768, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    if (length && length < 32768) result = cold_file_path(duplicate, text, length);
  }
  return result;
}
static int cold_arrival_path(HANDLE process, const HANDLE_ROW *row) {
  HANDLE duplicate;
  int result;
  if (!DuplicateHandle(process, row->value, GetCurrentProcess(), &duplicate,
                       0, FALSE, DUPLICATE_SAME_ACCESS)) return 0;
  result = cold_arrival_file_path(duplicate);
  if (!CloseHandle(duplicate)) result = 1;
  return result;
}
static int cold_inspect_with_hosts(DWORD pid, DWORD exempt, ULONGLONG *identity, const COLD_FILE_HOSTS *hosts, int optional, COLD_DENIAL *denial) {
  HANDLE process = NULL, duplicate = NULL, known = NULL;
  QUERY query;
  FARPROC address;
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  struct {
    NTSTATUS exit_status;
    PVOID peb;
    ULONG_PTR affinity;
    LONG priority;
    ULONG_PTR pid, parent;
  } basic;
  COLD_CWD cwd, after_cwd;
  PVOID peb = NULL;
  ULONG_PTR peb32 = 0;
  WCHAR text[32769], cwd_before[32768];
  FILETIME created, exited, kernel, user, again;
  HANDLE_TABLE *table = NULL, *after_table = NULL;
  HANDLE *retained = NULL;
  ULONG size = 16 * 1024 * 1024, needed = 0;
  ULONG_PTR i;
  DWORD length, handle_pass;
  int handles_complete = 0;
  const char *churn = "none";
  DWORD churn_error = ERROR_RETRY;
  HANDLE_ROW candidate_handle = {0};
  char churn_stage[160], mapping_diagnostic[1024] = {0};
  ULONG file_type = 0;
  typedef BOOL (WINAPI *WOW_QUERY)(HANDLE, USHORT *, USHORT *);
  WOW_QUERY wow_query;
  USHORT machine = 0, native_machine = 0;
  int wow64;
  int result = 1;
  const char *stage = "resolve APIs";
  NTSTATUS status = 0;
  address = GetProcAddress(ntdll, "NtQueryInformationProcess");
  if (!address || sizeof query != sizeof address) return 1;
  memcpy(&query, &address, sizeof query);

  stage = "OpenProcess";
  process = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ |
                        PROCESS_DUP_HANDLE | SYNCHRONIZE, FALSE, pid);
  if (!process) {
    if (GetLastError() == ERROR_INVALID_PARAMETER && cold_pid_absent(pid)) result = 2;
    goto done;
  }
  stage = "IsWow64Process2";
  address = GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "IsWow64Process2");
  if (!address || sizeof wow_query != sizeof address) goto done;
  memcpy(&wow_query, &address, sizeof wow_query);
  if (!wow_query(process, &machine, &native_machine)) goto done;
  if (native_machine != IMAGE_FILE_MACHINE_AMD64 ||
      (machine != IMAGE_FILE_MACHINE_UNKNOWN && machine != IMAGE_FILE_MACHINE_I386)) {
    goto done;
  }
  wow64 = machine == IMAGE_FILE_MACHINE_I386;
  stage = "initial liveness";
  if (WaitForSingleObject(process, 0) != WAIT_TIMEOUT) goto done;
  stage = "initial GetProcessTimes";
  if (!GetProcessTimes(process, &created, &exited, &kernel, &user)) goto done;
  stage = "ProcessBasicInformation";
  if (query(process, 0, &basic, sizeof basic, &needed) < 0 || basic.pid != pid ||
      basic.parent > 2147483647) goto done;
  peb = basic.peb;
  if (wow64) {
    stage = "ProcessWow64Information";
    if (query(process, 26, &peb32, sizeof peb32, &needed) < 0 || !peb32 || peb32 > UINT32_MAX) goto done;
    peb = (PVOID)peb32;
  }
  *identity = ((ULONGLONG)created.dwHighDateTime << 32) | created.dwLowDateTime;
  if (*identity <= 9 || *identity > 2650467743999999999ULL ||
      (!optional && printf("p %lu %llu %020llu\n", (unsigned long)pid,
             (unsigned long long)basic.parent, *identity) < 0)) goto done;
  stage = "QueryFullProcessImageNameW";
  length = 32768;
  if (cold_image_name(process, text, &length, &created, denial) ||
      hex_path(optional ? "f" : "e", text, length)) goto done;
  stage = "ReadProcessMemory(cwd)";
  if (!peb || cold_cwd(process, peb, wow64, &cwd) ||
      read_exact(process, cwd.buffer, text, cwd.length) ||
      hex_path("c", text, cwd.length / 2)) goto done;
  memcpy(cwd_before, text, cwd.length);
  if (pid == exempt) goto continuity;
  stage = "malloc handle table";
  table = malloc(size);
  if (!table) goto done;
  stage = "CreateFileW(known File type)";
  known = CreateFileW(L"NUL", FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE,
                      NULL, OPEN_EXISTING, 0, NULL);
  if (known == INVALID_HANDLE_VALUE) { known = NULL; goto done; }
  stage = "NtQueryInformationProcess(self handle table)";
  status = query(GetCurrentProcess(), 51, table, size, &needed);
  if (status < 0 || table->count > (size - offsetof(HANDLE_TABLE, rows)) / sizeof(HANDLE_ROW)) goto done;
  for (i = 0; i < table->count; i++) {
    if (table->rows[i].value == known) file_type = table->rows[i].type;
  }
  if (!file_type) goto done;
  if (!CloseHandle(known)) goto done;
  known = NULL;
  after_table = malloc(size);
  if (!after_table) goto done;
  for (handle_pass = 0; handle_pass < 5; ++handle_pass) {
    stage = "handle-pass process identity";
    if (!cold_same_instance_alive(process, &created)) goto done;
    stage = "NtQueryInformationProcess(ProcessHandleInformation)";
    status = query(process, 51, table, size, &needed);
    if (status < 0) goto done;
    stage = "validate handle table";
    if (needed > size || table->count > (size - offsetof(HANDLE_TABLE, rows)) / sizeof(HANDLE_ROW)) goto done;
    qsort(table->rows, table->count, sizeof(HANDLE_ROW), cold_handle_order);
    retained = calloc(table->count ? table->count : 1, sizeof(HANDLE));
    if (!retained) goto done;
    for (i = 0; i < table->count; i++) {
      DWORD type;
      if (table->rows[i].type != file_type) continue;
      candidate_handle = table->rows[i];
      stage = "DuplicateHandle";
      if (!DuplicateHandle(process, table->rows[i].value, GetCurrentProcess(),
                           &duplicate, 0, FALSE, DUPLICATE_SAME_ACCESS)) {
        DWORD error = GetLastError();
        if (error == ERROR_INVALID_HANDLE) goto closed_observed_handle;
        if (error == ERROR_NOT_SUPPORTED && cold_same_instance_alive(process, &created)) {
          /* File type is already known: error 50 cannot exclude a kernel endpoint.
           * Only a later, fully observable pass can discharge this uncertainty. */
          churn = "DuplicateHandle ERROR_NOT_SUPPORTED";
          churn_error = error;
          goto retry_handles;
        }
        SetLastError(error);
        goto done;
      }
      stage = "GetFileType(observed File handle)";
      SetLastError(NO_ERROR);
      type = GetFileType(duplicate);
      if (type == FILE_TYPE_UNKNOWN && GetLastError() != NO_ERROR) goto done;
      if (type != FILE_TYPE_UNKNOWN && type != FILE_TYPE_DISK &&
          type != FILE_TYPE_PIPE && type != FILE_TYPE_CHAR) goto done;
      if (type == FILE_TYPE_DISK || type == FILE_TYPE_UNKNOWN) {
        stage = "GetFinalPathNameByHandleW";
        length = GetFinalPathNameByHandleW(duplicate, text, 32768, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
        if (!length) {
          if (!cold_nonfilesystem_disk(duplicate, table->rows[i].access, hosts)) goto done;
        } else if (length >= 32768 || cold_file_path(duplicate, text, length)) goto done;
      }
      retained[i] = duplicate;
      duplicate = NULL;
      continue;
closed_observed_handle: {
        DWORD error = GetLastError();
        if (duplicate && !CloseHandle(duplicate)) goto done;
        duplicate = NULL;
        if (!cold_same_instance_alive(process, &created)) {
          SetLastError(error);
          goto done;
        }
        /* A missing retained object still needs absent/non-File continuity. */
      }
    }
    stage = "handle-table continuity";
    status = query(process, 51, after_table, size, &needed);
    if (status < 0 || needed > size ||
        after_table->count > (size - offsetof(HANDLE_TABLE, rows)) / sizeof(HANDLE_ROW)) goto done;
    qsort(after_table->rows, after_table->count, sizeof(HANDLE_ROW), cold_handle_order);
    /* T is the initial enumeration, not a whole-set fixed point. Validate every
     * surviving File slot from T; absent/non-File slots confirm closure. */
    for (i = 0; i < after_table->count; i++) {
      ULONG_PTR j;
      const HANDLE_ROW *b = &after_table->rows[i];
      if (b->type != file_type) continue;
      candidate_handle = *b;
      for (j = 0; j < table->count && table->rows[j].value != b->value; ++j) {}
      if (j == table->count || table->rows[j].type != file_type) {
        stage = "best-effort arrival path";
        if (cold_arrival_path(process, b)) goto done;
        continue;
      }
      if (!retained[j]) {
        churn = "continuity reopened File handle";
        churn_error = ERROR_RETRY;
        goto retry_handles;
      }
      stage = "DuplicateHandle(continuity)";
      if (!DuplicateHandle(process, b->value, GetCurrentProcess(), &duplicate,
                           0, FALSE, DUPLICATE_SAME_ACCESS)) {
        DWORD error = GetLastError();
        if ((error == ERROR_INVALID_HANDLE || error == ERROR_NOT_SUPPORTED) &&
            cold_same_instance_alive(process, &created)) {
          if (error == ERROR_INVALID_HANDLE) continue;
          churn = "DuplicateHandle(continuity) ERROR_NOT_SUPPORTED";
          churn_error = error;
          goto retry_handles;
        }
        SetLastError(error);
        goto done;
      }
      stage = "GetFileType(continuity File handle)";
      SetLastError(NO_ERROR);
      {
        DWORD type = GetFileType(duplicate);
        if ((type == FILE_TYPE_UNKNOWN && GetLastError() != NO_ERROR) ||
            (type != FILE_TYPE_UNKNOWN && type != FILE_TYPE_DISK &&
             type != FILE_TYPE_PIPE && type != FILE_TYPE_CHAR)) goto done;
      }
      stage = "CompareObjectHandles(continuity)";
      {
        int same = cold_same_object(retained[j], duplicate);
        if (same < 0) goto done;
        if (!same) {
          /* A different object proves closure of the T handle, not a gap in T.
           * Preserve the pinned replacement's readable path as arrival evidence. */
          stage = "best-effort reused-slot path";
          if (cold_arrival_file_path(duplicate)) goto done;
        } else if (table->rows[j].access != b->access ||
                   table->rows[j].attributes != b->attributes) {
          churn = "continuity handle metadata mismatch";
          churn_error = ERROR_RETRY;
          goto retry_handles;
        }
      }
      stage = "CloseHandle(continuity)";
      if (!CloseHandle(duplicate)) goto done;
      duplicate = NULL;
    }
    handles_complete = 1;
    break;
retry_handles:
    stage = "CloseHandle(retry)";
    if (duplicate && !CloseHandle(duplicate)) goto done;
    duplicate = NULL;
    for (i = 0; i < table->count; ++i) {
      if (retained[i] && !CloseHandle(retained[i])) goto done;
      retained[i] = NULL;
    }
    free(retained); retained = NULL;
  }
  if (!handles_complete) {
    snprintf(churn_stage, sizeof churn_stage,
             "%s: File handle inspection incomplete after five passes", churn);
    stage = churn_stage;
    SetLastError(churn_error);
    goto done;
  }
  stage = "handle-pass final process identity";
  if (!cold_same_instance_alive(process, &created)) goto done;
  if (cold_mappings(process, &created, mapping_diagnostic, sizeof mapping_diagnostic, denial)) { stage = "mapped-file observation"; goto done; }
continuity:
  stage = "cwd continuity";
  if (cold_cwd(process, peb, wow64, &after_cwd) ||
      after_cwd.parameters != cwd.parameters || after_cwd.buffer != cwd.buffer ||
      after_cwd.length != cwd.length || read_exact(process, after_cwd.buffer, text, after_cwd.length) ||
      memcmp(cwd_before, text, cwd.length)) goto done;
  stage = "final liveness/GetProcessTimes";
  if (!GetProcessTimes(process, &again, &exited, &kernel, &user) ||
      CompareFileTime(&created, &again) ||
      WaitForSingleObject(process, 0) != WAIT_TIMEOUT) goto done;
  if (!optional && puts("end") < 0) goto done;
  result = 0;
done: {
    DWORD error = GetLastError();
    /* The opened handle pins this instance even if the PID is subsequently reused.
     * Defer diagnostics until exit confirmation: successful receipts need empty stderr. */
    if (result == 1 && !ferror(stdout) && process && WaitForSingleObject(process, 0) == WAIT_OBJECT_0)
      result = 2;
    if (result == 1 && !optional && denial->exhausted && cold_same_instance_alive(process, &created))
      result = 3;
    if ((result == 1 || result == 3) && !optional && mapping_diagnostic[0]) fputs(mapping_diagnostic, stderr);
    if ((result == 1 || result == 3) && !optional) fprintf(stderr, "refused pid=%lu stage=%s access=0x%08lx win32=%lu ntstatus=0x%08lx last-file handle=0x%llx handle-type=%lu file-type=%lu handle-access=0x%08lx handle-attributes=0x%08lx\n", (unsigned long)pid, stage, (unsigned long)(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | PROCESS_DUP_HANDLE | SYNCHRONIZE), (unsigned long)error, (unsigned long)status, (unsigned long long)(ULONG_PTR)candidate_handle.value, (unsigned long)candidate_handle.type, (unsigned long)file_type, (unsigned long)candidate_handle.access, (unsigned long)candidate_handle.attributes);
  }
  if (known && !CloseHandle(known)) result = 1;
  if (duplicate && !CloseHandle(duplicate)) result = 1;
  if (process && !CloseHandle(process)) result = 1;
  if (retained) {
    for (i = 0; i < table->count; i++)
      if (retained[i] && !CloseHandle(retained[i])) result = 1;
  }
  free(retained); free(after_table); free(table);
  return fflush(stdout) == EOF ? 1 : result;
}


static int cold_kernel_image(DWORD pid, WCHAR **image);
/* Only emit the typed receipt after cleanup succeeds. It never completes a snapshot. */
static int cold_write_denial(DWORD pid, ULONGLONG identity, const WCHAR *image, const COLD_DENIAL *denial) {
  size_t i;
  ULONGLONG observed = 0;
  WCHAR *fresh = NULL;
  int image_matches;
  if (!image || !*image || !denial->exhausted ||
      observe_process(pid, &observed) || observed != identity) return 1;
  if (cold_kernel_image(pid, &fresh)) return 1;
  image_matches = !wcscmp(image, fresh);
  free(fresh);
  if (!image_matches || observe_process(pid, &observed) || observed != identity) return 1;
  if (fprintf(stderr, "canopy-cold-retry-exhausted-v1 %lu %020llu %s %u %llu ",
              (unsigned long)pid, identity, denial->stage, denial->attempts, denial->elapsed) < 0) return 1;
  for (i = 0; image[i]; ++i) if (fprintf(stderr, "%04x", (unsigned)image[i]) < 0) return 1;
  return fprintf(stderr, "\nclose %ls (pid %lu) and retry\n", image, (unsigned long)pid) < 0;
}
static int cold_inspect(DWORD pid, DWORD exempt, ULONGLONG *identity) {
  COLD_FILE_HOSTS before = {0}, after = {0};
  COLD_DENIAL denial = {0};
  WCHAR *image = NULL;
  int result = 1, inspection;
  if (!cold_read_file_hosts(&before) && !cold_kernel_image(pid, &image)) {
    inspection = cold_inspect_with_hosts(pid, exempt, identity, &before, 0, &denial);
    if (inspection == 3) (void)cold_write_denial(pid, *identity, image, &denial);
    if (!inspection && !cold_read_file_hosts(&after) && cold_same_file_hosts(&before, &after)) result = 0;
  }
  free(image);
  cold_free_file_hosts(&before); cold_free_file_hosts(&after);
  return result;
}


typedef struct {
  DWORD pid, session;
  ULONGLONG identity;
  WCHAR *image;
  int foreign, exited, post_t;
  const char *classification;
} COLD_OWNER;

/* Approved CAN-5879 scope: owner-rights inference, not omniscient token inspection.
 * Residuals: OWNER RIGHTS ACE overriding implicit READ_CONTROL; same-SID elevated
 * non-product processes owned by Administrators. Kernel image checks still apply.
 */
static int cold_classify_unknown(DWORD pid, PSID self, int *foreign, const char **why) {
  HANDLE process = OpenProcess(READ_CONTROL, FALSE, pid);
  PSECURITY_DESCRIPTOR descriptor = NULL;
  PSID owner = NULL;
  DWORD error;
  int result = 1;
  if (!process) {
    if (GetLastError() != ERROR_ACCESS_DENIED) return 1;
    *foreign = 1; *why = "owner-rights-denied";
    return 0;
  }
  error = GetSecurityInfo(process, SE_KERNEL_OBJECT, OWNER_SECURITY_INFORMATION,
                          &owner, NULL, NULL, NULL, &descriptor);
  if (error == ERROR_SUCCESS && owner && IsValidSid(owner)) {
    *foreign = !EqualSid(owner, self);
    *why = *foreign ? "foreign-owner" : "same-owner";
    result = 0;
  }
  if (descriptor) LocalFree(descriptor);
  if (!CloseHandle(process)) result = 1;
  return result;
}
static int cold_system_image(DWORD pid, WCHAR **image) {
  typedef NTSTATUS (NTAPI *SYSTEM_QUERY)(ULONG, PVOID, ULONG, PULONG);
  SYSTEM_QUERY query;
  FARPROC address = GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQuerySystemInformation");
  BYTE *buffer;
  ULONG size = 32 * 1024 * 1024, needed = 0, offset = 0;
  NTSTATUS status;
  int result = 1;
  const char *stage = "query";
  if (!address || sizeof query != sizeof address) return 1;
  memcpy(&query, &address, sizeof query);
  buffer = malloc(size);
  if (!buffer) return 1;
  status = query(5, buffer, size, &needed);
  if (status < 0 || needed > size) goto done;
  stage = "walk";
  for (;;) {
    SYSTEM_PROCESS_INFORMATION *row;
    ULONG_PTR name;
    if (offset > needed || needed - offset < sizeof(SYSTEM_PROCESS_INFORMATION)) goto done;
    row = (SYSTEM_PROCESS_INFORMATION *)(buffer + offset);
    if ((ULONG_PTR)row->UniqueProcessId == pid) {
      stage = "name";
      name = (ULONG_PTR)row->ImageName.Buffer;
      if (!row->ImageName.Length) {
        if (pid == 0 || pid == 4) *image = _wcsdup(pid == 0 ? L"System Idle Process" : L"System");
      } else if (row->ImageName.Length % 2 == 0 && name >= (ULONG_PTR)buffer &&
                 name <= (ULONG_PTR)buffer + needed &&
                 row->ImageName.Length <= (ULONG_PTR)buffer + needed - name) {
        size_t chars = row->ImageName.Length / 2;
        *image = calloc(chars + 1, sizeof(WCHAR));
        if (*image) memcpy(*image, row->ImageName.Buffer, row->ImageName.Length);
      }
      result = *image ? 0 : 1;
      break;
    }
    if (!row->NextEntryOffset || row->NextEntryOffset > needed - offset) goto done;
    offset += row->NextEntryOffset;
  }
done:
  if (result && cold_pid_absent(pid)) result = 2;
  if (result == 1) fprintf(stderr, "system image incomplete pid=%lu stage=%s ntstatus=0x%08lx size=%lu offset=%lu\n", (unsigned long)pid, stage, (unsigned long)status, (unsigned long)needed, (unsigned long)offset);
  free(buffer);
  return result;
}
static int cold_kernel_image(DWORD pid, WCHAR **image) {
  typedef NTSTATUS (NTAPI *SYSTEM_QUERY)(ULONG, PVOID, ULONG, PULONG);
  struct { HANDLE pid; UNICODE_STRING image; } request;
  SYSTEM_QUERY query;
  FARPROC address = GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQuerySystemInformation");
  WCHAR text[32768];
  NTSTATUS status;
  /* These two reserved PIDs are kernel identities, not reusable user PIDs.
   * ProcessIdInformation rejects System on some Windows 11 builds, and WTS may
   * omit its name. Do not treat an arbitrary unnamed process as a kernel row.
   */
  if (pid == 0 || pid == 4) {
    *image = _wcsdup(pid == 0 ? L"System Idle Process" : L"System");
    return *image ? 0 : 1;
  }
  if (!address || sizeof query != sizeof address) return 1;
  memcpy(&query, &address, sizeof query);
  request.pid = (HANDLE)(ULONG_PTR)pid;
  request.image.Buffer = text;
  request.image.Length = 0;
  request.image.MaximumLength = 65534;
  status = query(88, &request, sizeof request, NULL);
  if (status >= 0 && request.image.Length && request.image.Length % 2 == 0 &&
      request.image.Length <= 65532 && request.image.Buffer == text) {
    text[request.image.Length / 2] = 0;
    *image = _wcsdup(text);
  } else {
    /* Protected/kernel-backed rows may succeed with an empty full path. The
     * system snapshot still supplies their executable basename for policy.
     */
    int fallback = cold_system_image(pid, image);
    if (fallback != 1) return fallback;
    fprintf(stderr, "kernel image unavailable pid=%lu ntstatus=0x%08lx length=%u\n", (unsigned long)pid, (unsigned long)status, (unsigned)request.image.Length);
    return 1;
  }
  return *image ? 0 : 1;
}
static void cold_free_owners(COLD_OWNER *owners, DWORD count) {
  DWORD i;
  if (owners) for (i = 0; i < count; i++) free(owners[i].image);
  free(owners);
}
static int cold_owners(COLD_OWNER **owners, DWORD *count, const COLD_OWNER *initial, DWORD initial_count) {
  DWORD level = 1, total = 0, i;
  PWTS_PROCESS_INFO_EXW rows = NULL;
  HANDLE token = NULL, process = NULL;
  BYTE self_bytes[sizeof(TOKEN_USER) + SECURITY_MAX_SID_SIZE];
  BYTE other_bytes[sizeof(TOKEN_USER) + SECURITY_MAX_SID_SIZE];
  BYTE owner_bytes[sizeof(TOKEN_OWNER) + SECURITY_MAX_SID_SIZE];
  TOKEN_USER *self = (TOKEN_USER *)self_bytes;
  TOKEN_USER *other = (TOKEN_USER *)other_bytes;
  TOKEN_OWNER *default_owner = (TOKEN_OWNER *)owner_bytes;
  DWORD needed;
  int result = 1;
  const char *stage = "GetTokenInformation(self user/default owner)";
  DWORD candidate = 0;
  const WCHAR *candidate_image = L"unavailable";
  *owners = NULL; *count = 0;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token) ||
      !GetTokenInformation(token, TokenUser, self_bytes, sizeof self_bytes, &needed) ||
      !GetTokenInformation(token, TokenOwner, owner_bytes, sizeof owner_bytes, &needed) ||
      !IsValidSid(self->User.Sid) || !IsValidSid(default_owner->Owner)) goto done;
  if (!EqualSid(default_owner->Owner, self->User.Sid)) {
    fprintf(stderr, "cold observer owner mismatch: TokenOwner is not TokenUser\n");
    goto done;
  }
  if (!CloseHandle(token)) goto done;
  token = NULL;
  stage = "WTSEnumerateProcessesExW";
  if (!WTSEnumerateProcessesExW(WTS_CURRENT_SERVER_HANDLE, &level,
                              WTS_ANY_SESSION, (LPWSTR *)&rows, &total) ||
      !total || total > 100000) goto done;
  *owners = calloc(total, sizeof(COLD_OWNER));
  if (!*owners) goto done;
  for (i = 0; i < total; i++) {
    PSID sid = rows[i].pUserSid;
    DWORD pid = rows[i].ProcessId;
    COLD_OWNER *row;
    candidate = pid;
    candidate_image = L"unavailable";
    if (pid == GetCurrentProcessId()) continue;
    row = *owners + *count;
    row->pid = pid;
    row->session = rows[i].SessionId;
    ++*count;
    if (initial) {
      DWORD j;
      for (j = 0; j < initial_count && initial[j].pid != pid; ++j) {}
      row->post_t = j == initial_count;
    }
    stage = "NtQuerySystemInformation(ProcessIdInformation)";
    {
      int image_result = cold_kernel_image(pid, &row->image);
      if (image_result == 2) goto row_exited;
      if (image_result) goto done;
    }
    candidate_image = row->image;
    if (row->post_t) {
      row->classification = "post-t";
      goto row_complete;
    }
    if (!sid) {
      stage = "OpenProcess/OpenProcessToken/GetTokenInformation(unclassified)";
      process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
      if (process && OpenProcessToken(process, TOKEN_QUERY, &token) &&
          GetTokenInformation(token, TokenUser, other_bytes, sizeof other_bytes, &needed)) sid = other->User.Sid;
      if (!sid) {
        stage = "owner-rights classification";
        if (pid == 0) { row->foreign = 1; row->classification = "kernel-idle"; }
        else if (cold_classify_unknown(pid, self->User.Sid, &row->foreign, &row->classification)) {
          if (cold_pid_absent(pid)) goto row_exited;
          goto done;
        }
      }
    }
    if (sid) {
      if (!IsValidSid(sid)) goto done;
      row->foreign = !EqualSid(sid, self->User.Sid);
      row->classification = row->foreign ? "foreign-token" : "same-token";
      if (!row->foreign) {
        /* Same-SID elevation can have Administrators as the process owner.
         * A same-owner sandbox still requires complete inspection below.
         */
        stage = "same-user owner-rights classification";
        if (cold_classify_unknown(pid, self->User.Sid, &row->foreign, &row->classification)) {
          if (cold_pid_absent(pid)) goto row_exited;
          goto done;
        }
      }
    }
    goto row_complete;
row_exited:
    if (!cold_pid_absent(pid)) goto done;
    if (!row->image && rows[i].pProcessName && rows[i].pProcessName[0])
      row->image = _wcsdup(rows[i].pProcessName);
    if (!row->image) goto done;
    row->exited = 1;
    row->classification = "exited";
row_complete:
    if (token) { if (!CloseHandle(token)) goto done; token = NULL; }
    if (process) { if (!CloseHandle(process)) goto done; process = NULL; }
  }
  result = 0;
done:
  if (result) fprintf(stderr, "cold enumeration incomplete stage=%s pid=%lu image=%ls win32=%lu\n", stage, (unsigned long)candidate, candidate_image, (unsigned long)GetLastError());
  if (token && !CloseHandle(token)) result = 1;
  if (process && !CloseHandle(process)) result = 1;
  if (rows && !WTSFreeMemoryExW(WTSTypeProcessInfoLevel1, rows, total)) result = 1;
  if (result) { cold_free_owners(*owners, *count); *owners = NULL; *count = 0; }
  return result;
}
/* Also terminates a partial process frame; the enumerated image still applies. */
static int cold_write_exited(const COLD_OWNER *row) {
  char prefix[64];
  int size = snprintf(prefix, sizeof prefix, "exited %lu", (unsigned long)row->pid);
  if (size < 0 || (size_t)size >= sizeof prefix || !row->image) return 1;
  return hex_path(prefix, row->image, wcslen(row->image));
}
static int cold_observe_row(COLD_OWNER *row, DWORD exempt, const COLD_FILE_HOSTS *hosts) {
  int inspection;
  COLD_DENIAL denial = {0};
  if (row->post_t) {
    /* Image policy is mandatory after T; cwd/file use is a conservative union.
     * CAN-5786's startup guard must block product launches after the snapshot. */
    if (printf("a %lu\n", (unsigned long)row->pid) < 0 ||
        hex_path("e", row->image, wcslen(row->image))) return 1;
    if (!row->exited) (void)cold_inspect_with_hosts(row->pid, exempt, &row->identity, hosts, 1, &denial);
    return ferror(stdout) || puts("end") < 0;
  }
  if (row->exited) return cold_write_exited(row);
  if (row->foreign)
    return printf("x %lu %s\n", (unsigned long)row->pid, row->classification) < 0 ||
           hex_path("e", row->image, wcslen(row->image)) || puts("end") < 0;
  inspection = cold_inspect_with_hosts(row->pid, exempt, &row->identity, hosts, 0, &denial);
  if (inspection == 2) {
    row->exited = 1;
    return cold_write_exited(row);
  }
  if (inspection == 3) (void)cold_write_denial(row->pid, row->identity, row->image, &denial);
  if (inspection) fprintf(stderr, "cold row refused pid=%lu session=%lu classification=%s image=%ls\n",
                          (unsigned long)row->pid, (unsigned long)row->session,
                          row->classification, row->image);
  return inspection;
}
/* Only two distinct native observations qualify this diagnostic; it never admits. */
static void cold_write_pid_reuse(const COLD_OWNER *before, const COLD_OWNER *after,
                                 ULONGLONG after_identity) {
  size_t i;
  if (!before || !after || before->pid != after->pid || !before->image || !after->image ||
      (!wcscmp(before->image, after->image) &&
       (!before->identity || !after_identity || before->identity == after_identity))) return;
  fprintf(stderr, "canopy-cold-pid-reuse-v1 %lu %s %020llu ",
          (unsigned long)before->pid, before->classification, before->identity);
  for (i = 0; before->image[i]; ++i) fprintf(stderr, "%04x", (unsigned)before->image[i]);
  fprintf(stderr, " %s %020llu ", after->classification, after_identity);
  for (i = 0; after->image[i]; ++i) fprintf(stderr, "%04x", (unsigned)after->image[i]);
  fputc('\n', stderr);
}
static int cold_snapshot(DWORD exempt) {
  COLD_OWNER *before = NULL, *after = NULL;
  COLD_FILE_HOSTS hosts = {0}, later_hosts = {0};
  DWORD count = 0, initial_count = 0, later = 0, inspected = 0, i, j, pass;
  ULONGLONG observed = 0;
  int continuity_observation = -1, pid_reuse = 0;
  DWORD continuity_error = NO_ERROR;
  int result = 1;
  const char *stage = "initial hosts/owners/header";
  DWORD candidate = 0;
  const COLD_OWNER *continuity_before = NULL, *continuity_after = NULL;
  if (cold_read_file_hosts(&hosts) || cold_owners(&before, &count, NULL, 0) || puts("canopy-cold-v1") < 0 || puts("owner-is-user") < 0) goto done;
  initial_count = count;
  for (pass = 0; pass < 5; ++pass) {
    for (i = inspected; i < count; ++i) {
      candidate = before[i].pid;
      stage = "process observation/receipt";
      if (cold_observe_row(&before[i], exempt, &hosts)) goto done;
    }
    inspected = count;
    stage = "continuity owner enumeration";
    candidate = 0;
    if (cold_owners(&after, &later, before, initial_count)) goto done;
    for (i = 0; i < inspected; ++i) {
      candidate = before[i].pid;
      stage = "process continuity: post-T image changed";
      for (j = 0; j < later && after[j].pid != before[i].pid; ++j) {}
      continuity_before = &before[i];
      continuity_after = j < later ? &after[j] : NULL;
      continuity_observation = -1;
      observed = 0;
      if (before[i].post_t) {
        if (j < later && !after[j].exited && wcscmp(before[i].image, after[j].image)) { pid_reuse = 1; goto done; }
        if (j < later && after[j].exited) {
          const WCHAR *a = wcsrchr(before[i].image, L'\\');
          const WCHAR *b = wcsrchr(after[j].image, L'\\');
          if (_wcsicmp(a ? a + 1 : before[i].image, b ? b + 1 : after[j].image)) { pid_reuse = 1; goto done; }
          if (!cold_pid_absent(before[i].pid)) goto done;
        } else if (j < later && before[i].identity) {
          stage = "process continuity: post-T creation identity changed";
          continuity_observation = observe_process(before[i].pid, &observed);
          continuity_error = GetLastError();
          if ((continuity_observation || observed != before[i].identity) &&
              !cold_pid_absent(before[i].pid)) { pid_reuse = !continuity_observation && observed != before[i].identity; goto done; }
        }
        continue;
      }
      stage = "process continuity: exited image changed";
      if (j < later && (after[j].exited || before[i].exited)) {
        const WCHAR *a = wcsrchr(before[i].image, L'\\');
        const WCHAR *b = wcsrchr(after[j].image, L'\\');
        if (_wcsicmp(a ? a + 1 : before[i].image, b ? b + 1 : after[j].image)) { pid_reuse = 1; goto done; }
      }
      stage = "process continuity: exited T PID reappeared";
      if (before[i].exited && j < later) goto done;
      if (j == later || after[j].exited || before[i].exited) {
        stage = "process continuity: exit absence unconfirmed";
        /* A confirmed exit plus this complete absent-after enumeration suffices.
         * Do not replace it with a third, potentially stale PID snapshot. */
        if (!before[i].exited && !cold_pid_absent(before[i].pid)) goto done;
        if (!before[i].exited) {
          stage = "process continuity: exit receipt write";
          if (cold_write_exited(&before[i])) goto done;
          before[i].exited = 1;
        }
        continue;
      }
      stage = "process continuity: principal changed";
      /* A later OWNER RIGHTS denial does not undo a complete T inspection.
       * Keep its creation-identity check below. Never skip newly required inspection. */
      if (before[i].foreign && !after[j].foreign) goto done;
      stage = "process continuity: T image changed";
      if (wcscmp(before[i].image, after[j].image)) { pid_reuse = 1; goto done; }
      if (!before[i].foreign) {
        continuity_observation = observe_process(before[i].pid, &observed);
        continuity_error = GetLastError();
        if (continuity_observation || observed != before[i].identity) {
          stage = continuity_observation ? "process continuity: creation query failed, exit unconfirmed" :
                                "process continuity: creation identity changed";
          if (!cold_pid_absent(before[i].pid)) { pid_reuse = !continuity_observation && observed != before[i].identity; goto done; }
          stage = "process continuity: final exit receipt write";
          if (cold_write_exited(&before[i])) goto done;
          before[i].exited = 1;
        }
      }
    }
    continuity_before = continuity_after = NULL;
    for (j = 0; j < later; ++j) {
      COLD_OWNER *grown;
      for (i = 0; i < count && before[i].pid != after[j].pid; ++i) {}
      if (i != count) continue;
      candidate = after[j].pid;
      stage = "append newly observed PID";
      if (count >= 100000) goto done;
      grown = realloc(before, ((size_t)count + 1) * sizeof(COLD_OWNER));
      if (!grown) goto done;
      before = grown;
      before[count++] = after[j];
      after[j].image = NULL;
    }
    cold_free_owners(after, later); after = NULL; later = 0;
    if (count == inspected) break;
  }
  /* The final enumeration may add more post-T rows; it need not stabilize. */
  stage = "final post-T process observation";
  for (i = inspected; i < count; ++i) {
    candidate = before[i].pid;
    if (cold_observe_row(&before[i], exempt, &hosts)) goto done;
  }
  stage = "final filesystem hosts";
  candidate = 0;
  if (cold_read_file_hosts(&later_hosts) || !cold_same_file_hosts(&hosts, &later_hosts)) goto done;
  stage = "complete receipt";
  if (printf("complete %lu\n", (unsigned long)count) < 0 || fflush(stdout) == EOF) goto done;
  result = 0;
done: {
    DWORD error = GetLastError();
    if (result && pid_reuse)
      cold_write_pid_reuse(continuity_before, continuity_after,
                           continuity_observation == 0 ? observed : (continuity_after ? continuity_after->identity : 0));
    if (result && continuity_before) {
      fprintf(stderr, "process continuity before: pid=%lu scope=%s exited=%d identity=%020llu image=%ls\n",
              (unsigned long)continuity_before->pid, continuity_before->classification,
              continuity_before->exited, continuity_before->identity, continuity_before->image);
      if (continuity_after)
        fprintf(stderr, "process continuity after: pid=%lu scope=%s exited=%d identity=%020llu image=%ls\n",
                (unsigned long)continuity_after->pid, continuity_after->classification,
                continuity_after->exited, continuity_after->identity, continuity_after->image);
      else fputs("process continuity after: absent\n", stderr);
      if (continuity_observation >= 0)
        fprintf(stderr, "process continuity creation query: result=%d observed=%020llu win32=%lu\n",
                continuity_observation, observed, (unsigned long)continuity_error);
    }
    if (result) fprintf(stderr, "cold snapshot incomplete stage=%s pid=%lu win32=%lu\n",
                        stage, (unsigned long)candidate, (unsigned long)error);
  }
  cold_free_owners(before, count); cold_free_owners(after, later);
  cold_free_file_hosts(&hosts); cold_free_file_hosts(&later_hosts);
  return result;
}
/* Native qualification of the scope discriminator, never full maintenance admission. */
static int cold_classification(DWORD pid) {
  COLD_OWNER *rows = NULL;
  DWORD count = 0, i;
  int result = 1;
  if (cold_owners(&rows, &count, NULL, 0)) return 1;
  for (i = 0; i < count; i++) if (rows[i].pid == pid) {
    if (printf("canopy-cold-classification-v1 %lu %s\n", (unsigned long)pid, rows[i].classification) >= 0 &&
        hex_path("e", rows[i].image, wcslen(rows[i].image)) == 0 && fflush(stdout) != EOF) result = 0;
    break;
  }
  cold_free_owners(rows, count);
  return result;
}
