// Test-only probe for the Windows owned-child suite; never staged or shipped.
// Reports the calling process's immediate job, its members and its console,
// and inspects or ends one process by PID only at a recorded creation time.
#ifndef _WIN32
#error "owned-child probe is Windows-only"
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif

#include <windows.h>

#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <node_api.h>

#define MAX_LISTED 1024

static napi_value make_null(napi_env env) {
  napi_value out;
  napi_get_null(env, &out);
  return out;
}

static napi_value make_bool(napi_env env, bool value) {
  napi_value out;
  napi_get_boolean(env, value, &out);
  return out;
}

static napi_value make_number(napi_env env, double value) {
  napi_value out;
  napi_create_double(env, value, &out);
  return out;
}

static void set(napi_env env, napi_value object, const char *key,
                napi_value value) {
  napi_set_named_property(env, object, key, value);
}

// FILETIME ticks as decimal text: exact beyond 2^53.
static napi_value make_ticks(napi_env env, const FILETIME *time) {
  char text[32];
  unsigned long long ticks =
      ((unsigned long long)time->dwHighDateTime << 32) | time->dwLowDateTime;
  snprintf(text, sizeof text, "%llu", ticks);
  napi_value out;
  napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &out);
  return out;
}

static bool pid_arg(napi_env env, napi_callback_info info, size_t expected,
                    DWORD *pid, napi_value *rest) {
  size_t argc = 2;
  napi_value argv[2];
  int64_t value = 0;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok ||
      argc != expected ||
      napi_get_value_int64(env, argv[0], &value) != napi_ok || value < 1 ||
      value > 0xFFFFFFFFLL) {
    napi_throw_error(env, NULL, "probe: invalid arguments");
    return false;
  }
  *pid = (DWORD)value;
  if (rest && expected > 1) *rest = argv[1];
  return true;
}

// jobInfo() -> { inJob, limitFlags, activeProcesses, totalProcesses,
//   assignedProcesses, pids, console: { window, visible } }
// Job fields are null outside a job or when a query fails. The job is the
// caller's immediate job when it is nested.
static napi_value job_info(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value out;
  napi_create_object(env, &out);
  BOOL in_job = FALSE;
  bool known = IsProcessInJob(GetCurrentProcess(), NULL, &in_job) != 0;
  set(env, out, "inJob", known ? make_bool(env, in_job != 0) : make_null(env));
  napi_value flags = make_null(env), active = make_null(env),
             total = make_null(env), assigned = make_null(env),
             pids = make_null(env);
  if (known && in_job) {
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
    if (QueryInformationJobObject(NULL, JobObjectExtendedLimitInformation,
                                  &limits, (DWORD)sizeof limits, NULL))
      flags = make_number(env, limits.BasicLimitInformation.LimitFlags);
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
    if (QueryInformationJobObject(NULL, JobObjectBasicAccountingInformation,
                                  &accounting, (DWORD)sizeof accounting,
                                  NULL)) {
      active = make_number(env, accounting.ActiveProcesses);
      total = make_number(env, accounting.TotalProcesses);
    }
    size_t size = sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST) +
                  (MAX_LISTED - 1) * sizeof(ULONG_PTR);
    JOBOBJECT_BASIC_PROCESS_ID_LIST *list = calloc(1, size);
    if (list && QueryInformationJobObject(NULL, JobObjectBasicProcessIdList,
                                          list, (DWORD)size, NULL)) {
      assigned = make_number(env, list->NumberOfAssignedProcesses);
      napi_create_array_with_length(env, list->NumberOfProcessIdsInList,
                                    &pids);
      for (DWORD n = 0; n < list->NumberOfProcessIdsInList; n++)
        napi_set_element(env, pids, n,
                         make_number(env, (double)list->ProcessIdList[n]));
    }
    free(list);
  }
  set(env, out, "limitFlags", flags);
  set(env, out, "activeProcesses", active);
  set(env, out, "totalProcesses", total);
  set(env, out, "assignedProcesses", assigned);
  set(env, out, "pids", pids);
  napi_value console;
  napi_create_object(env, &console);
  HWND window = GetConsoleWindow();
  set(env, console, "window", make_bool(env, window != NULL));
  set(env, console, "visible",
      make_bool(env, window != NULL && IsWindowVisible(window)));
  set(env, out, "console", console);
  return out;
}

// inspect(pid) -> { name, created, running } | null when no process has it.
static napi_value inspect(napi_env env, napi_callback_info info) {
  DWORD pid;
  if (!pid_arg(env, info, 1, &pid, NULL)) return NULL;
  HANDLE process =
      OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid);
  if (!process) {
    if (GetLastError() == ERROR_INVALID_PARAMETER) return make_null(env);
    napi_value out;
    napi_create_object(env, &out);
    set(env, out, "error", make_number(env, GetLastError()));
    return out;
  }
  napi_value out;
  napi_create_object(env, &out);
  WCHAR image[MAX_PATH * 4];
  DWORD length = (DWORD)(sizeof image / sizeof *image);
  napi_value name = make_null(env);
  if (QueryFullProcessImageNameW(process, 0, image, &length)) {
    DWORD start = length;
    while (start > 0 && image[start - 1] != L'\\') start--;
    napi_create_string_utf16(env, (const char16_t *)(image + start),
                             length - start, &name);
  }
  set(env, out, "name", name);
  FILETIME created, exited, kernel, user;
  set(env, out, "created",
      GetProcessTimes(process, &created, &exited, &kernel, &user)
          ? make_ticks(env, &created)
          : make_null(env));
  set(env, out, "running",
      make_bool(env, WaitForSingleObject(process, 0) == WAIT_TIMEOUT));
  CloseHandle(process);
  return out;
}

// terminate(pid, created) -> true only when that PID still names the process
// created at `created` and it was ended through the same handle.
static napi_value terminate(napi_env env, napi_callback_info info) {
  DWORD pid;
  napi_value expected;
  if (!pid_arg(env, info, 2, &pid, &expected)) return NULL;
  char wanted[32] = {0};
  size_t copied = 0;
  if (napi_get_value_string_utf8(env, expected, wanted, sizeof wanted,
                                 &copied) != napi_ok)
    return make_bool(env, false);
  HANDLE process = OpenProcess(
      PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!process) return make_bool(env, false);
  FILETIME created, exited, kernel, user;
  char actual[32] = {0};
  bool same = false;
  if (GetProcessTimes(process, &created, &exited, &kernel, &user)) {
    unsigned long long ticks =
        ((unsigned long long)created.dwHighDateTime << 32) |
        created.dwLowDateTime;
    snprintf(actual, sizeof actual, "%llu", ticks);
    same = strcmp(actual, wanted) == 0;
  }
  bool ended = same && TerminateProcess(process, 1);
  CloseHandle(process);
  return make_bool(env, ended);
}

NAPI_MODULE_INIT() {
  napi_property_descriptor methods[] = {
      {"jobInfo", NULL, job_info, NULL, NULL, NULL, napi_enumerable, NULL},
      {"inspect", NULL, inspect, NULL, NULL, NULL, napi_enumerable, NULL},
      {"terminate", NULL, terminate, NULL, NULL, NULL, napi_enumerable, NULL},
  };
  if (napi_define_properties(env, exports, sizeof methods / sizeof *methods,
                             methods) != napi_ok)
    return NULL;
  return exports;
}
