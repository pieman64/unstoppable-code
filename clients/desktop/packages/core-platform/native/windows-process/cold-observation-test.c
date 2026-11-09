#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winternl.h>
#include <wtsapi32.h>
#include <psapi.h>
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static PROCESS_INFORMATION child, extra[4];
static int enumerated, intercepted, phase, enumerations, handle_queries;
static DWORD fixture_exempt;
static HANDLE ready, stop, tracked_file, arriving_file, optional_duplicate;
static unsigned tracked_duplicates, arrival_path_queries, mapping_queries, image_queries;
static unsigned identity_checks, last_query_identity, retry_waits;
static unsigned absence_queries;
static ULONGLONG denial_started;
static HANDLE inspected_process, type_duplicate;
static WCHAR reused_path[MAX_PATH];
static PWTS_PROCESS_INFO_EXW original_rows;
static DWORD original_count;
static WTS_PROCESS_INFO_EXW departed;
static WCHAR departed_name[32768];
static FARPROC WINAPI address_fixture(HMODULE module, LPCSTR name);
static BOOL times_fixture(HANDLE process, LPFILETIME created, LPFILETIME exited,
                          LPFILETIME kernel, LPFILETIME user) {
  BOOL result = GetProcessTimes(process, created, exited, kernel, user);
  if (result && GetProcessId(process) == child.dwProcessId) ++identity_checks;
  if (result && phase == 69 && enumerations > 1 && GetProcessId(process) == child.dwProcessId) {
    ++intercepted; SetLastError(ERROR_ACCESS_DENIED); return FALSE;
  }
  if (result && ((phase == 21 && intercepted) || (phase == 32 && tracked_duplicates) || ((phase == 57 && mapping_queries && retry_waits) || (phase == 60 && image_queries && retry_waits)) || ((phase == 36 || phase == 52 || phase == 68) && enumerations > 1)) &&
      GetProcessId(process) == child.dwProcessId) {
    ++created->dwLowDateTime;
    if (phase == 36 || phase == 52 || phase == 68) ++intercepted;
  }
  return result;
}
static DWORD WINAPI final_path_fixture(HANDLE handle, LPWSTR path, DWORD size, DWORD flags) {
  if (phase == 31 && handle == optional_duplicate) {
    optional_duplicate = NULL;
    ++arrival_path_queries;
    SetLastError(ERROR_ACCESS_DENIED);
    return 0;
  }
  return GetFinalPathNameByHandleW(handle, path, size, flags);
}

static HANDLE deleted_duplicate;
static DWORD WINAPI mapped_name_fixture(HANDLE process, LPVOID address, LPWSTR path, DWORD capacity) {
  DWORD length = GetMappedFileNameW(process, address, path, capacity);
  if (length && GetProcessId(process) == child.dwProcessId &&
      phase >= 46 && phase <= 49 && wcsstr(path, L"$Deleted")) ++intercepted;
  if (length && (phase == 53 || phase == 54) && GetProcessId(process) == child.dwProcessId &&
      wcsstr(path, L"pending")) {
    if (phase == 53) {
      typedef NTSTATUS (NTAPI *UNMAP)(HANDLE, PVOID);
      UNMAP unmap;
      FARPROC fn = GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtUnmapViewOfSection");
      assert(fn && sizeof unmap == sizeof fn);
      memcpy(&unmap, &fn, sizeof unmap);
      assert(unmap(child.hProcess, address) >= 0);
    }
    ++intercepted;
    SetLastError(ERROR_ACCESS_DENIED);
    return 0;
  }
  return length;
}
static BOOL WINAPI volume_info_fixture(HANDLE handle, LPWSTR label, DWORD label_size,
                                       LPDWORD serial, LPDWORD maximum, LPDWORD flags,
                                       LPWSTR filesystem, DWORD size) {
  if (phase == 49) { ++intercepted; SetLastError(ERROR_ACCESS_DENIED); return FALSE; }
  if (phase == 48) {
    assert(size >= 5); wcscpy_s(filesystem, size, L"ReFS"); ++intercepted; return TRUE;
  }
  return GetVolumeInformationByHandleW(handle, label, label_size, serial, maximum, flags, filesystem, size);
}
static BOOL WINAPI file_info_fixture(HANDLE handle, FILE_INFO_BY_HANDLE_CLASS kind, LPVOID info, DWORD size) {
  BOOL result;
  if (phase >= 41 && phase <= 44 && handle == deleted_duplicate &&
      (kind == FileStandardInfo || (int)kind == 18)) {
    ++intercepted;
    if ((phase == 41 && kind == FileStandardInfo) || (phase == 42 && (int)kind == 18)) {
      SetLastError(ERROR_ACCESS_DENIED);
      return FALSE;
    }
    result = GetFileInformationByHandleEx(handle, kind, info, size);
    if (result && kind == FileStandardInfo) {
      FILE_STANDARD_INFO *standard = info;
      if (phase == 43) standard->DeletePending = FALSE;
      if (phase == 44) standard->NumberOfLinks = 1;
    }
    return result;
  }
  return GetFileInformationByHandleEx(handle, kind, info, size);
}

static BOOL remove_fixture_directory(const WCHAR *path) {
  unsigned attempt;
  for (attempt = 0; ; ++attempt) {
    DWORD error;
    if (RemoveDirectoryW(path)) return TRUE;
    error = GetLastError();
    if (attempt == 40 || (error != ERROR_SHARING_VIOLATION &&
        error != ERROR_ACCESS_DENIED && error != ERROR_DIR_NOT_EMPTY)) {
      fprintf(stderr, "fixture cleanup: RemoveDirectoryW win32=%lu attempts=%u\n",
              (unsigned long)error, attempt + 1);
      SetLastError(error);
      return FALSE;
    }
    /* Cleanup only: scanners may briefly pin delete-pending fixture entries. */
    Sleep(25);
  }
}

static void exit_child(void) {
  if (phase >= 4) assert(SetEvent(stop));
  else assert(ResumeThread(child.hThread) != (DWORD)-1);
  assert(WaitForSingleObject(child.hProcess, 5000) == WAIT_OBJECT_0);
  assert(CloseHandle(child.hThread));
  assert(CloseHandle(child.hProcess));
  child.hThread = child.hProcess = NULL;
}
/* Scope the deterministic fixture to controlled real processes, not ambient host churn. */
static BOOL enumerate_fixture(HANDLE server, DWORD *level, DWORD session, LPWSTR *rows, DWORD *count) {
  DWORD i, j, kept = 0;
  PWTS_PROCESS_INFO_EXW selected;
  assert(!original_rows);
  if (phase == 66 && enumerations == 1) {
    ++enumerations;
    ++intercepted;
    SetLastError(ERROR_ACCESS_DENIED);
    return FALSE;
  }
  if (!WTSEnumerateProcessesExW(server, level, session, (LPWSTR *)&original_rows, &original_count)) return FALSE;
  selected = calloc(6, sizeof *selected);
  assert(selected);
  ++enumerations;
  for (i = 0; i < original_count; ++i) {
    DWORD pid = original_rows[i].ProcessId;
    int include = pid == fixture_exempt;
    if (pid == child.dwProcessId) {
      if ((phase == 8 || phase == 63 || phase == 67) && enumerations == 1) {
        size_t length = wcslen(original_rows[i].pProcessName);
        assert(length < 32768);
        departed = original_rows[i];
        memcpy(departed_name, departed.pProcessName, (length + 1) * sizeof(WCHAR));
        departed.pProcessName = departed_name;
        departed.pUserSid = NULL;
      }
      if ((phase == 62 || phase == 63 || phase == 64 || phase == 65) && enumerations > 1) continue;
      if ((phase == 4 || phase == 7 || (phase >= 33 && phase <= 35) || phase == 51) && enumerations == 1) continue;
      enumerated = 1;
      if ((phase == 4 || phase == 7 || (phase >= 33 && phase <= 35) || phase == 51) && !intercepted) intercepted = 1;
      include = 1;
    }
    for (j = 0; phase == 7 && j < 4; ++j)
      if (pid == extra[j].dwProcessId && enumerations >= (int)j + 3) include = 1;
    if ((phase == 8 || phase == 36) && pid == extra[0].dwProcessId && enumerations >= 2)
      include = 1;
    if (!include) continue;
    assert(kept < 6);
    selected[kept++] = original_rows[i];
  }
  /* Reappear in fresh enumeration, then disappear before identity inspection.
   * A prior exited receipt must not absorb this unconfirmed new instance. */
  if ((phase == 8 || phase == 63 || phase == 67) && enumerations > 1 && !child.hProcess) {
    assert(departed.ProcessId && kept < 6);
    if (phase == 67) {
      departed.pProcessName = L"reused-different-image.exe";
      ++intercepted;
    }
    selected[kept++] = departed;
  }
  *rows = (LPWSTR)selected;
  *count = kept;
  return TRUE;
}
static BOOL WINAPI enumerate_pids_fixture(DWORD *pids, DWORD capacity, DWORD *bytes) {
  if (phase >= 62 && enumerations > 1) {
    ++absence_queries;
    if (phase == 62) {
      /* A redundant process snapshot can still contain the signaled instance. */
      assert(capacity >= 2 * sizeof(DWORD));
      pids[0] = GetCurrentProcessId();
      pids[1] = child.dwProcessId;
      *bytes = 2 * sizeof(DWORD);
      return TRUE;
    }
    if (phase == 65) {
      ++intercepted;
      SetLastError(ERROR_ACCESS_DENIED);
      return FALSE;
    }
    if (phase == 63 || phase == 67) {
      assert(capacity >= sizeof(DWORD));
      pids[0] = GetCurrentProcessId();
      *bytes = sizeof(DWORD);
      return TRUE;
    }
  }
  return EnumProcesses(pids, capacity, bytes);
}
static BOOL free_fixture(WTS_TYPE_CLASS type, PVOID rows, ULONG count) {
  BOOL result;
  assert(type == WTSTypeProcessInfoLevel1 && count <= 6 && original_rows);
  free(rows);
  result = WTSFreeMemoryExW(type, original_rows, original_count);
  original_rows = NULL;
  return result;
}
static HANDLE open_fixture(DWORD access, BOOL inherit, DWORD pid) {
  if ((phase == 50 || phase == 52) && enumerations > 1 && pid == child.dwProcessId && access == READ_CONTROL) {
    ++intercepted; SetLastError(ERROR_ACCESS_DENIED); return NULL;
  }
  if (phase == 33 && pid == child.dwProcessId && (access & PROCESS_VM_READ)) {
    ++intercepted;
    SetLastError(ERROR_ACCESS_DENIED);
    return NULL;
  }
  if (pid == child.dwProcessId && (access & PROCESS_VM_READ) && (phase <= 3 || phase == 8) && phase != 1) {
    assert(enumerated);
    intercepted = 1;
    if (phase == 0 || phase == 8) exit_child();
    else {
      SetLastError(phase == 2 ? ERROR_INVALID_PARAMETER : ERROR_ACCESS_DENIED);
      return NULL;
    }
  }
  {
    HANDLE process = OpenProcess(access, inherit, pid);
    if ((phase == 62 || phase == 63 || phase == 66 || phase == 67) &&
        pid == child.dwProcessId && (access & PROCESS_VM_READ)) {
      assert(process && !intercepted);
      ++intercepted;
      exit_child();
    }
    if (pid == child.dwProcessId && (access & PROCESS_VM_READ)) {
      assert(access == (PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | PROCESS_DUP_HANDLE | SYNCHRONIZE));
      inspected_process = process;
    }
    return process;
  }
}
static SIZE_T WINAPI region_fixture(HANDLE process, LPCVOID address,
                                    PMEMORY_BASIC_INFORMATION region, SIZE_T length) {
  if (((phase >= 55 && phase <= 57) || phase == 61) && GetProcessId(process) == child.dwProcessId && !address) {
    assert(process == inspected_process && length == sizeof *region);
    assert(identity_checks > last_query_identity); last_query_identity = identity_checks;
    if (!mapping_queries) denial_started = GetTickCount64();
    ++mapping_queries;
    if (phase != 55 || mapping_queries == 1) {
      ++intercepted; SetLastError(ERROR_ACCESS_DENIED); return 0;
    }
  }
  return VirtualQueryEx(process, address, region, length);
}
static void WINAPI sleep_fixture(DWORD duration) {
  Sleep(duration);
  ++retry_waits;
  if (phase == 61 && child.hProcess) exit_child();
}
static BOOL WINAPI image_fixture(HANDLE process, DWORD flags, LPWSTR path, PDWORD length) {
  if (phase >= 58 && phase <= 60 && GetProcessId(process) == child.dwProcessId) {
    assert(identity_checks > last_query_identity); last_query_identity = identity_checks;
    if (!image_queries) denial_started = GetTickCount64();
    ++image_queries;
    if (phase != 59 || image_queries < 3) {
      ++intercepted; SetLastError(ERROR_ACCESS_DENIED); return FALSE;
    }
  }
  return QueryFullProcessImageNameW(process, flags, path, length);
}
static BOOL read_fixture(HANDLE process, LPCVOID address, LPVOID buffer, SIZE_T bytes, SIZE_T *read) {
  if (phase == 37 && GetProcessId(process) == child.dwProcessId) {
    ++intercepted;
    SetLastError(ERROR_ACCESS_DENIED);
    return FALSE;
  }
  if (phase == 1 && !intercepted && GetProcessId(process) == child.dwProcessId) {
    assert(enumerated);
    intercepted = 1;
    exit_child();
  }
  return ReadProcessMemory(process, address, buffer, bytes, read);
}
static DWORD WINAPI file_type_fixture(HANDLE handle) {
  if ((phase == 71 || phase == 72) && handle == type_duplicate) {
    type_duplicate = NULL;
    ++intercepted;
    assert(GetFileType(handle) == FILE_TYPE_DISK);
    SetLastError(phase == 72 ? ERROR_ACCESS_DENIED : ERROR_INVALID_HANDLE);
    return FILE_TYPE_UNKNOWN;
  }
  return GetFileType(handle);
}
static BOOL duplicate_fixture(HANDLE source, HANDLE handle, HANDLE target, LPHANDLE copy,
                              DWORD access, BOOL inherit, DWORD options) {
  if (phase == 34 && GetProcessId(source) == child.dwProcessId) {
    ++intercepted;
    SetLastError(ERROR_ACCESS_DENIED);
    return FALSE;
  }
  /* These slots appear only after T. Failures are optional evidence, not retries;
   * phase 32 still changes process identity after the ignored denial. */
  if (phase >= 27 && phase <= 32 && GetProcessId(source) == child.dwProcessId && handle == tracked_file) {
    ++tracked_duplicates;
    if (phase == 30) {
      *copy = CreateEventW(NULL, TRUE, FALSE, NULL);
      assert(*copy);
      return TRUE;
    }
    if (phase == 31) {
      BOOL result = DuplicateHandle(source, handle, target, copy, access, inherit, options);
      assert(result);
      optional_duplicate = *copy;
      return result;
    }
    if (phase == 29) {
      HANDLE closed;
      assert(DuplicateHandle(source, handle, target, &closed, access, inherit,
                             options | DUPLICATE_CLOSE_SOURCE));
      assert(CloseHandle(closed));
    }
    SetLastError(phase == 28 ? ERROR_NOT_SUPPORTED :
                 phase == 29 ? ERROR_INVALID_HANDLE : ERROR_ACCESS_DENIED);
    return FALSE;
  }
  if (phase >= 14 && phase <= 25 && GetProcessId(source) == child.dwProcessId && handle == tracked_file) {
    ++tracked_duplicates;
    if (((phase == 16 || phase == 20 || phase == 21) && tracked_duplicates == 1) ||
        (phase == 17 && tracked_duplicates == 2) || phase == 18 ||
        (phase == 19 && tracked_duplicates % 2 == 0) ||
        (phase == 20 && tracked_duplicates == 2)) {
      ++intercepted;
      SetLastError(phase == 20 && tracked_duplicates == 2 ? ERROR_ACCESS_DENIED : ERROR_NOT_SUPPORTED);
      return FALSE;
    }
  }
  if ((phase == 5 || phase == 6) && !intercepted && GetProcessId(source) == child.dwProcessId) {
    HANDLE closed;
    assert(enumerated);
    intercepted = 1;
    if (phase == 5) {
      assert(DuplicateHandle(source, handle, target, &closed, access, inherit,
                             options | DUPLICATE_CLOSE_SOURCE));
      assert(CloseHandle(closed));
    }
    SetLastError(phase == 5 ? ERROR_INVALID_HANDLE : ERROR_ACCESS_DENIED);
    return FALSE;
  }
  if ((phase == 38 || phase == 39) && GetProcessId(source) == child.dwProcessId && handle == tracked_file &&
      ++tracked_duplicates % 2 == 0) {
    ++intercepted;
    *copy = CreateFileW(reused_path, FILE_READ_ATTRIBUTES,
                        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                        NULL, OPEN_EXISTING, 0, NULL);
    assert(*copy != INVALID_HANDLE_VALUE);
    return TRUE;
  }
  if (((phase >= 9 && phase <= 11) || phase == 13 || phase == 26) && GetProcessId(source) == child.dwProcessId) {
    if (!tracked_file) tracked_file = handle;
    if (handle == tracked_file && ++tracked_duplicates % 2 == 0 &&
        ((phase != 9) || !intercepted)) {
      ++intercepted;
      if (phase == 11) {
        SetLastError(ERROR_ACCESS_DENIED);
        return FALSE;
      }
      if (phase == 13) {
        *copy = CreateEventW(NULL, TRUE, FALSE, NULL);
        assert(*copy);
        return TRUE;
      }
      /* Every reached continuity pass sees a different File object in 10/26. */
      *copy = CreateFileW(L"NUL", FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE,
                          NULL, OPEN_EXISTING, 0, NULL);
      assert(*copy != INVALID_HANDLE_VALUE);
      SetLastError(NO_ERROR);
      return TRUE;
    }
  }
  if (phase == 12 && !intercepted && GetProcessId(source) == child.dwProcessId) {
    ++intercepted;
    *copy = CreateEventW(NULL, TRUE, FALSE, NULL);
    assert(*copy);
    return TRUE;
  }
  {
    BOOL result = DuplicateHandle(source, handle, target, copy, access, inherit, options);
    if (result && phase >= 40 && GetProcessId(source) == child.dwProcessId && handle == tracked_file)
      deleted_duplicate = *copy;
    if (result && (phase == 71 || phase == 72) && GetProcessId(source) == child.dwProcessId && handle == tracked_file) {
      ++tracked_duplicates;
      type_duplicate = *copy;
    }
    return result;
  }
}
#define WTSEnumerateProcessesExW enumerate_fixture
#define EnumProcesses enumerate_pids_fixture
#define WTSFreeMemoryExW free_fixture
#define OpenProcess open_fixture
#define ReadProcessMemory read_fixture
#define DuplicateHandle duplicate_fixture
#define GetFileType file_type_fixture
#define GetProcAddress address_fixture
#define GetProcessTimes times_fixture
#define GetFileInformationByHandleEx file_info_fixture
#define GetFinalPathNameByHandleW final_path_fixture
#define GetMappedFileNameW mapped_name_fixture
#define GetVolumeInformationByHandleW volume_info_fixture
#define VirtualQueryEx region_fixture
#define QueryFullProcessImageNameW image_fixture
#define Sleep sleep_fixture
#define main shipped_main
#include "process-identity.c"
#undef main
#undef GetFileType
#undef EnumProcesses
#undef Sleep
#undef QueryFullProcessImageNameW
#undef VirtualQueryEx
#undef GetMappedFileNameW
#undef GetVolumeInformationByHandleW
#undef GetFileInformationByHandleEx
#undef GetFinalPathNameByHandleW
#undef GetProcAddress
#undef GetProcessTimes

static NTSTATUS NTAPI query_fixture(HANDLE process, ULONG kind, PVOID buffer,
                                    ULONG size, PULONG needed) {
  QUERY query;
  FARPROC address = GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryInformationProcess");
  NTSTATUS status;
  ULONG_PTR i;
  HANDLE_TABLE *table = buffer;
  assert(address && sizeof query == sizeof address);
  memcpy(&query, &address, sizeof query);
  status = query(process, kind, buffer, size, needed);
  if (status < 0 || kind != 51 || phase < 14 || (phase > 32 && phase != 38 && phase != 39 && phase != 71 && phase != 72) || GetProcessId(process) != child.dwProcessId)
    return status;
  ++handle_queries;
  if (phase == 71 || phase == 72) return status;
  assert(table->count <= (size - offsetof(HANDLE_TABLE, rows)) / sizeof(HANDLE_ROW));
  for (i = 0; i < table->count && table->rows[i].value != tracked_file; ++i) {}
  assert(i < table->count);
  if ((phase == 14 && handle_queries == 1) ||
      ((phase == 22 || (phase >= 27 && phase <= 32)) && handle_queries % 2 == 1)) {
    /* A real inherited File handle arrives between the two table receipts. */
    memmove(table->rows + i, table->rows + i + 1,
            (table->count - i - 1) * sizeof(HANDLE_ROW));
    --table->count;
    ++intercepted;
  }
  if (((phase == 15 || phase == 24) && handle_queries == 2) ||
      (phase == 23 && handle_queries % 2 == 0)) {
    if (phase == 24) table->rows[i].access ^= FILE_READ_DATA;
    else table->rows[i].attributes ^= HANDLE_FLAG_INHERIT;
    ++intercepted;
  }
  if ((phase == 25 && handle_queries == 2) || (phase == 39 && handle_queries % 2 == 0)) {
    table->rows[i].attributes ^= HANDLE_FLAG_INHERIT;
    if (phase == 25) ++intercepted;
  }
  if (phase == 39) {
    /* Only the reused object, not an enumerated second slot, can reveal this path. */
    for (i = 0; i < table->count && table->rows[i].value != arriving_file; ++i) {}
    assert(i < table->count);
    memmove(table->rows + i, table->rows + i + 1,
            (table->count - i - 1) * sizeof(HANDLE_ROW));
    --table->count;
  }
  if (phase == 38 && handle_queries % 2 == 0 && handle_queries < 10) {
    /* Force five passes after the reused tracked slot: the other object is
     * unchanged, but its metadata is incomplete until the final pass. */
    for (i = 0; i < table->count && table->rows[i].value != arriving_file; ++i) {}
    assert(i < table->count);
    table->rows[i].attributes ^= HANDLE_FLAG_INHERIT;
  }
  if (phase == 25 || phase == 26) {
    /* Phase 25 retries same-object metadata, then omits its earlier path.
     * Phase 26 accepts a reused T slot alongside a continuity-only arrival. */
    for (i = table->count; i-- > 0;) {
      HANDLE value = table->rows[i].value;
      if ((value == arriving_file && handle_queries % 2 == 1) ||
          (phase == 25 && value == tracked_file && handle_queries > 2)) {
        memmove(table->rows + i, table->rows + i + 1,
                (table->count - i - 1) * sizeof(HANDLE_ROW));
        --table->count;
      }
    }
  }
  return status;
}
static NTSTATUS NTAPI system_query_fixture(ULONG kind, PVOID buffer, ULONG size, PULONG needed) {
  typedef NTSTATUS (NTAPI *SYSTEM_QUERY)(ULONG, PVOID, ULONG, PULONG);
  struct { HANDLE pid; UNICODE_STRING image; } *request = buffer;
  SYSTEM_QUERY query;
  FARPROC address = GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQuerySystemInformation");
  assert(address && sizeof query == sizeof address);
  memcpy(&query, &address, sizeof query);
  if (phase == 35 && kind == 88 && (DWORD)(ULONG_PTR)request->pid == child.dwProcessId) {
    const WCHAR image[] = L"C:\\Canopy\\Canopy.exe";
    assert(request->image.MaximumLength >= sizeof image);
    memcpy(request->image.Buffer, image, sizeof image);
    request->image.Length = sizeof image - sizeof(WCHAR);
    return 0;
  }
  if (phase == 51 && kind == 88 && enumerations >= 3 &&
      (DWORD)(ULONG_PTR)request->pid == child.dwProcessId && child.hProcess) {
    exit_child(); ++intercepted;
  }
  return query(kind, buffer, size, needed);
}
static FARPROC WINAPI address_fixture(HMODULE module, LPCSTR name) {
  FARPROC address;
  if (!strcmp(name, "NtQuerySystemInformation")) {
    typedef NTSTATUS (NTAPI *SYSTEM_QUERY)(ULONG, PVOID, ULONG, PULONG);
    SYSTEM_QUERY query = system_query_fixture;
    assert(sizeof address == sizeof query);
    memcpy(&address, &query, sizeof address);
    return address;
  }
  if (!strcmp(name, "NtQueryInformationProcess")) {
    QUERY query = query_fixture;
    assert(sizeof address == sizeof query);
    memcpy(&address, &query, sizeof address);
    return address;
  }
  return GetProcAddress(module, name);
}

static void expect_union_path(HANDLE file, const char *kind) {
  WCHAR path[32768];
  DWORD i, length = GetFinalPathNameByHandleW(file, path, 32768,
                                             FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  assert(length && length < 32768);
  assert(fprintf(stderr, "%s ", kind) > 0);
  for (i = 0; i < length; ++i) assert(fprintf(stderr, "%04x", (unsigned)path[i]) > 0);
  assert(fputs("\n", stderr) >= 0);
}

int main(int argc, char **argv) {
  WCHAR executable[32768], command[32780], name[128];
  STARTUPINFOW startup = {0};
  HANDLE token;
  HANDLE inherited_file = NULL, mapping = NULL;
  PVOID view = NULL;
  WCHAR temporary[32768], union_paths[2][MAX_PATH], deleted_directory[MAX_PATH], deleted_path[MAX_PATH], linked_path[MAX_PATH];
  HANDLE union_files[2] = {NULL, NULL};
  SECURITY_ATTRIBUTES inheritable = {sizeof inheritable, NULL, TRUE};
  BYTE user_bytes[sizeof(TOKEN_USER) + SECURITY_MAX_SID_SIZE];
  BYTE owner_bytes[sizeof(TOKEN_OWNER) + SECURITY_MAX_SID_SIZE];
  DWORD needed, i;
  int owner_is_user, result, success;
  if (argc == 2 && !strcmp(argv[1], "--fixture-child")) return 0;
  if ((argc == 3 && !strcmp(argv[1], "--fixture-live")) ||
      (argc == 4 && !strcmp(argv[1], "--fixture-mapped"))) {
    DWORD parent;
    assert(!parse_pid(argv[2], &parent));
    assert(swprintf(name, 128, L"Local\\ColdFixtureReady-%lu", (unsigned long)parent) > 0);
    ready = OpenEventW(EVENT_MODIFY_STATE, FALSE, name);
    assert(swprintf(name, 128, L"Local\\ColdFixtureStop-%lu", (unsigned long)parent) > 0);
    stop = OpenEventW(SYNCHRONIZE, FALSE, name);
    if (argc == 4) {
      mapping = (HANDLE)(ULONG_PTR)_strtoui64(argv[3], NULL, 10);
      view = MapViewOfFile(mapping, FILE_MAP_READ, 0, 0, 0);
      assert(view && CloseHandle(mapping));
    }
    assert(ready && stop && SetEvent(ready));
    assert(WaitForSingleObject(stop, 30000) == WAIT_OBJECT_0);
    if (view) assert(UnmapViewOfFile(view) || GetLastError() == ERROR_INVALID_ADDRESS);
    assert(CloseHandle(ready) && CloseHandle(stop));
    return 0;
  }
  assert(argc == 3);
  phase = atoi(argv[1]);
  assert((phase >= 0 && phase <= 69) || phase == 71 || phase == 72);
  success = (phase >= 40 && phase != 52 && phase != 54 && phase != 56 && phase != 57 && phase != 58 && phase != 60 && phase < 63) || phase == 38 || phase == 39 || phase == 10 || phase == 26 || phase < 2 || phase == 4 || phase == 5 || phase == 7 || phase == 9 ||
            (phase >= 33 && phase <= 35) || phase == 51 ||
            phase == 14 || phase == 15 || phase == 16 || phase == 17 ||
            phase == 22 || phase == 24 || phase == 25 || (phase >= 27 && phase <= 31);
  assert(!parse_pid(argv[2], &fixture_exempt));
  assert(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token));
  assert(GetTokenInformation(token, TokenUser, user_bytes, sizeof user_bytes, &needed));
  assert(GetTokenInformation(token, TokenOwner, owner_bytes, sizeof owner_bytes, &needed));
  owner_is_user = EqualSid(((TOKEN_USER *)user_bytes)->User.Sid, ((TOKEN_OWNER *)owner_bytes)->Owner);
  assert(CloseHandle(token));
  assert(GetModuleFileNameW(NULL, executable, 32768));
  if ((phase >= 40 && phase <= 49) || phase == 53 || phase == 54) {
    /* FileDispositionInfoEx (21), DELETE (1), POSIX_SEMANTICS (2):
     * keep the fixture ABI independent of the production Vista SDK target. */
    struct { DWORD flags; } disposition = {1 | 2};
    FILE_STANDARD_INFO standard;
    assert(GetTempPathW(32768, temporary) && wcslen(temporary) < MAX_PATH - 30);
    assert(GetTempFileNameW(temporary, L"cfd", 0, deleted_directory));
    assert(DeleteFileW(deleted_directory) && CreateDirectoryW(deleted_directory, NULL));
    assert(swprintf(deleted_path, MAX_PATH, L"%ls\\pending", deleted_directory) > 0);
    if (phase == 47) {
      assert(swprintf(linked_path, MAX_PATH, L"%ls\\$Extend", deleted_directory) > 0);
      assert(CreateDirectoryW(linked_path, NULL));
      assert(swprintf(linked_path, MAX_PATH, L"%ls\\$Extend\\$Deleted", deleted_directory) > 0);
      assert(CreateDirectoryW(linked_path, NULL));
      assert(swprintf(deleted_path, MAX_PATH, L"%ls\\x", linked_path) > 0);
    }
    inherited_file = CreateFileW(deleted_path, DELETE | FILE_READ_ATTRIBUTES | GENERIC_READ | GENERIC_WRITE,
                                 FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                 &inheritable, CREATE_NEW, 0, NULL);
    assert(inherited_file != INVALID_HANDLE_VALUE);
    if (phase == 45) {
      assert(swprintf(linked_path, MAX_PATH, L"%ls\\surviving", deleted_directory) > 0);
      assert(CreateHardLinkW(linked_path, deleted_path, NULL));
    }
    if (phase >= 46) {
      DWORD written;
      assert(WriteFile(inherited_file, "mapped", 6, &written, NULL) && written == 6);
      mapping = CreateFileMappingW(inherited_file, &inheritable, PAGE_READONLY, 0, 0, NULL);
      assert(mapping && SetHandleInformation(inherited_file, HANDLE_FLAG_INHERIT, 0));
      view = MapViewOfFile(mapping, FILE_MAP_READ, 0, 0, 0);
      assert(view);
    }
    if (phase != 47 && phase != 53 && phase != 54)
      assert(SetFileInformationByHandle(inherited_file, (FILE_INFO_BY_HANDLE_CLASS)21, &disposition, sizeof disposition));
    assert(GetFileInformationByHandleEx(inherited_file, FileStandardInfo, &standard, sizeof standard));
    assert(fprintf(stderr, "fixture standard: delete-pending=%u links=%lu directory=%u\n",
                   (unsigned)standard.DeletePending, (unsigned long)standard.NumberOfLinks,
                   (unsigned)standard.Directory) > 0);
    expect_union_path(inherited_file, "fixture-final-deleted-path");
    if (phase == 45 || phase == 47 || phase == 53 || phase == 54) assert(standard.NumberOfLinks > 0);
    else assert(standard.DeletePending && !standard.NumberOfLinks);
    if (phase != 47 && phase != 53 && phase != 54)
      assert(GetFileAttributesW(deleted_path) == INVALID_FILE_ATTRIBUTES);
    /* An open File object can still pin its parent even with zero links.
     * Recheck parent removal only after closing all File handles below. */
    tracked_file = inherited_file;
  } else if (phase == 25 || phase == 26 || phase == 38 || phase == 39) {
    assert(GetTempPathW(32768, temporary) && wcslen(temporary) < MAX_PATH - 14);
    for (i = 0; i < 2; ++i) {
      assert(GetTempFileNameW(temporary, L"cfx", 0, union_paths[i]));
      union_files[i] = CreateFileW(union_paths[i], FILE_READ_ATTRIBUTES,
                                   FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                   &inheritable, OPEN_EXISTING, 0, NULL);
      assert(union_files[i] != INVALID_HANDLE_VALUE);
    }
    tracked_file = union_files[0];
    arriving_file = union_files[1];
    if (phase == 38 || phase == 39) {
      int first = (ULONG_PTR)union_files[0] < (ULONG_PTR)union_files[1];
      tracked_file = union_files[first ? 0 : 1];
      arriving_file = union_files[first ? 1 : 0];
      memcpy(reused_path, union_paths[first ? 1 : 0], sizeof reused_path);
    }
  } else if (phase >= 14) {
    inherited_file = CreateFileW(executable, FILE_READ_ATTRIBUTES,
                                 FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                 &inheritable, OPEN_EXISTING, 0, NULL);
    assert(inherited_file != INVALID_HANDLE_VALUE);
    tracked_file = inherited_file;
  }
  if (phase >= 4) {
    assert(swprintf(name, 128, L"Local\\ColdFixtureReady-%lu", (unsigned long)GetCurrentProcessId()) > 0);
    ready = CreateEventW(NULL, TRUE, FALSE, name);
    assert(swprintf(name, 128, L"Local\\ColdFixtureStop-%lu", (unsigned long)GetCurrentProcessId()) > 0);
    stop = CreateEventW(NULL, TRUE, FALSE, name);
    assert(ready && stop);
    if (mapping) assert(swprintf(command, 32780, L"\"%ls\" --fixture-mapped %lu %llu", executable,
                                 (unsigned long)GetCurrentProcessId(), (unsigned long long)(ULONG_PTR)mapping) > 0);
    else assert(swprintf(command, 32780, L"\"%ls\" --fixture-live %lu", executable,
                         (unsigned long)GetCurrentProcessId()) > 0);
  } else assert(swprintf(command, 32780, L"\"%ls\" --fixture-child", executable) > 0);
  startup.cb = sizeof startup;
  assert(CreateProcessW(executable, command, NULL, NULL, phase >= 14,
                        CREATE_NO_WINDOW | (phase < 4 ? CREATE_SUSPENDED : 0),
                        NULL, NULL, &startup, &child));
  if (phase >= 4) assert(WaitForSingleObject(ready, 5000) == WAIT_OBJECT_0);
  if (phase == 7 || phase == 8 || phase == 36) for (i = 0; i < (phase == 7 ? 4u : 1u); ++i) {
    assert(ResetEvent(ready));
    assert(swprintf(command, 32780, L"\"%ls\" --fixture-live %lu", executable,
                    (unsigned long)GetCurrentProcessId()) > 0);
    assert(CreateProcessW(executable, command, NULL, NULL, FALSE,
                          CREATE_NO_WINDOW | (phase == 8 ? CREATE_SUSPENDED : 0),
                          NULL, NULL, &startup, &extra[i]));
    if (phase != 8) assert(WaitForSingleObject(ready, 5000) == WAIT_OBJECT_0);
  }
  if (mapping) {
    WCHAR mapped[32769], dos[32769], device[32769], drive[3];
    DWORD length;
    assert(CloseHandle(mapping)); mapping = NULL;
    assert(CloseHandle(inherited_file)); inherited_file = NULL;
    length = GetMappedFileNameW(GetCurrentProcess(), view, mapped, 32768);
    assert(length && length < 32768);
    assert(fputs("fixture-mapped-path ", stderr) >= 0);
    for (i = 0; i < length; ++i) assert(fprintf(stderr, "%04x", (unsigned)mapped[i]) > 0);
    assert(fputs("\n", stderr) >= 0);
    drive[0] = deleted_path[0]; drive[1] = L':'; drive[2] = 0;
    assert(QueryDosDeviceW(drive, device, 32768));
    assert(!wcsncmp(mapped, device, wcslen(device)) && mapped[wcslen(device)] == L'\\');
    assert(swprintf(dos, 32769, L"%ls%ls", drive, mapped + wcslen(device)) > 0);
    assert(fputs("fixture-mapped-file-path ", stderr) >= 0);
    for (i = 0; dos[i]; ++i) assert(fprintf(stderr, "%04x", (unsigned)dos[i]) > 0);
    assert(fputs("\n", stderr) >= 0);
    if (phase != 47 && phase != 53 && phase != 54) {
      const WCHAR *reserved = wcsstr(mapped, L"\\$Extend\\$Deleted\\");
      assert(reserved && reserved == wcschr(mapped + 8, L'\\'));
    }
  }
  result = cold_snapshot(fixture_exempt);
  if (phase >= 62 && phase <= 66 && owner_is_user) {
    assert(enumerations == 2);
    if (phase == 62 || phase == 63 || phase == 66) assert(identity_checks == 0);
    else { assert(identity_checks > 0 && absence_queries == 1); intercepted = 1; }
    if (phase == 62 || phase == 66) assert(absence_queries == 0);
  }
  if (phase >= 55 && phase <= 57 && owner_is_user) {
    assert(phase == 56 ? (mapping_queries >= 2 && mapping_queries <= 7) :
           mapping_queries == (phase == 55 ? 2u : 1u));
    assert(fprintf(stderr, "fixture-mapping-queries %u\n", mapping_queries) > 0);
  }
  if (phase >= 58 && phase <= 60 && owner_is_user) {
    assert(phase == 58 ? (image_queries >= 2 && image_queries <= 7) :
           image_queries == (phase == 59 ? 3u : 1u));
    assert(fprintf(stderr, "fixture-image-queries %u\n", image_queries) > 0);
  }
  if ((phase == 56 || phase == 58) && owner_is_user) {
    ULONGLONG elapsed = GetTickCount64() - denial_started;
    assert(elapsed >= 1000);
    assert(fprintf(stderr, "fixture-denial-elapsed %llu\n", elapsed) > 0);
  }
  if (phase == 40 && owner_is_user) {
    COLD_FILE_ID identity;
    assert(GetFileInformationByHandleEx(inherited_file, (FILE_INFO_BY_HANDLE_CLASS)18, &identity, sizeof identity));
    assert(fprintf(stderr, "fixture-delete-pending %016llx ", (unsigned long long)identity.volume) > 0);
    for (i = 0; i < sizeof identity.file_id; ++i)
      assert(fprintf(stderr, "%02x", (unsigned)identity.file_id[i]) > 0);
    assert(fputs("\n", stderr) >= 0);
    intercepted = 1;
  }
  if (phase >= 41 && phase <= 45 && owner_is_user) {
    expect_union_path(inherited_file, "fixture-deleted-path");
    if (phase == 45) intercepted = 1;
  }
  if (phase == 25 || phase == 26 || phase == 38 || phase == 39) for (i = 0; i < 2; ++i) {
    if (owner_is_user && success) {
      expect_union_path(union_files[i], "fixture-path");
      if (phase == 39 && union_files[i] == arriving_file)
        expect_union_path(union_files[i], "fixture-reused-path");
    }
    assert(CloseHandle(union_files[i]));
  }
  if (inherited_file) assert(CloseHandle(inherited_file));
  if (child.hProcess) exit_child();
  if (view) assert(UnmapViewOfFile(view));
  if (phase == 47 || phase == 53 || phase == 54) assert(DeleteFileW(deleted_path));
  if (phase == 47) {
    assert(remove_fixture_directory(linked_path));
    assert(swprintf(linked_path, MAX_PATH, L"%ls\\$Extend", deleted_directory) > 0);
    assert(remove_fixture_directory(linked_path));
  }
  if ((phase >= 40 && phase <= 49 && phase != 45) || phase == 53 || phase == 54)
    assert(remove_fixture_directory(deleted_directory));
  if (phase == 45) assert(DeleteFileW(linked_path) && remove_fixture_directory(deleted_directory));
  if (phase == 25 || phase == 26 || phase == 38 || phase == 39) for (i = 0; i < 2; ++i) assert(DeleteFileW(union_paths[i]));
  if (phase == 7 || phase == 8 || phase == 36) for (i = 0; i < (phase == 7 ? 4u : 1u); ++i) {
    if (phase == 8) assert(ResumeThread(extra[i].hThread) != (DWORD)-1);
    assert(WaitForSingleObject(extra[i].hProcess, 5000) == WAIT_OBJECT_0);
    assert(CloseHandle(extra[i].hThread) && CloseHandle(extra[i].hProcess));
  }
  if (ready) assert(CloseHandle(ready));
  if (stop) assert(CloseHandle(stop));
  if (result != (owner_is_user && success ? 0 : 1)) fprintf(stderr, "fixture phase=%d snapshot-result=%d intercepted=%d owner-is-user=%d\n",
          phase, result, intercepted, owner_is_user);
  if (owner_is_user) {
    if (phase == 25 && (result != 0 || intercepted != 1 || handle_queries != 4 || tracked_duplicates != 2))
      fprintf(stderr, "fixture phase=25 snapshot-result=%d intercepted=%d handle-queries=%d tracked-duplicates=%u\n",
              result, intercepted, handle_queries, tracked_duplicates);
    assert(intercepted);
    assert(result == (success ? 0 : 1));
    if (phase == 4) assert(enumerations == 3);
    if (phase == 7) assert(enumerations == 6);
    if (phase == 8) assert(enumerations == 2);
    if (phase == 33 || phase == 34) assert(intercepted > 1);
    if (phase == 36) assert(enumerations == 2 && intercepted == 1);
    if (phase == 37) assert(enumerations == 1);
    if (phase == 9) assert(intercepted == 1 && tracked_duplicates == 2);
    if (phase == 10) assert(intercepted == 1 && tracked_duplicates == 2);
    if (phase == 11) assert(intercepted == 1 && tracked_duplicates == 2);
    if (phase == 12) assert(intercepted == 1);
    if (phase == 14) assert(intercepted == 1 && handle_queries == 2);
    if (phase == 15 || phase == 24) assert(intercepted == 1 && handle_queries == 4 && tracked_duplicates == 4);
    if (phase == 16) assert(intercepted == 1 && handle_queries == 3 && tracked_duplicates == 3);
    if (phase == 17) assert(intercepted == 1 && handle_queries == 4 && tracked_duplicates == 4);
    if (phase == 18) assert(intercepted == 5 && handle_queries == 5 && tracked_duplicates == 5);
    if (phase == 19) assert(intercepted == 5 && handle_queries == 10 && tracked_duplicates == 10);
    if (phase == 20) assert(intercepted == 2 && handle_queries == 2 && tracked_duplicates == 2);
    if (phase == 21) assert(intercepted == 1 && handle_queries == 1 && tracked_duplicates == 1);
    if (phase == 22) assert(intercepted == 1 && handle_queries == 2);
    if (phase == 23) assert(intercepted == 5 && handle_queries == 10 && tracked_duplicates == 10);
    if (phase == 25) assert(intercepted == 1 && handle_queries == 4 && tracked_duplicates == 2);
    if (phase == 39) assert(intercepted == 1 && handle_queries == 2 && tracked_duplicates == 2);
    if (phase == 38) assert(intercepted == 5 && handle_queries == 10 && tracked_duplicates == 10);
    if (phase == 26) assert(intercepted == 1 && handle_queries == 2 && tracked_duplicates == 2);
    if (phase >= 27 && phase <= 32) assert(intercepted == 1 && handle_queries == 2 && tracked_duplicates == 1);
    if (phase == 31) assert(arrival_path_queries == 1 && !optional_duplicate);
    if (phase == 71 || phase == 72) {
      assert(intercepted == 1 && handle_queries == 1 && tracked_duplicates == 1);
      assert(!type_duplicate);
      assert(fprintf(stderr, "fixture-file-type phase=%d errors=%d handle-queries=%d tracked-duplicates=%u\n",
                     phase, intercepted, handle_queries, tracked_duplicates) > 0);
    }
    assert(fprintf(stderr, "fixture %lu %s\n", (unsigned long)child.dwProcessId,
                   phase < 2 ? "exited" : success ? "observed" : "refused") > 0);
  } else {
    assert(result == 1 && !intercepted);
    assert(fputs("fixture owner-mismatch\n", stderr) >= 0);
  }
  return 0;
}
