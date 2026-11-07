// Owned daemon root for startup rollback, owned jobs for execution
// children, the host's power execution state, handle-confined W5 capture
// reads (confined_read_win.c) and Recycle Bin moves (recycle_item_win.c)
// (Windows).
//
// The root is created suspended inside a job of its own
// (PROC_THREAD_ATTRIBUTE_JOB_LIST) and resumed only once its membership is
// confirmed. The job kills on close and permits no breakaway, so every
// descendant stays in it, including those libuv lets break away silently from
// its own jobs. The job handle is not inheritable and never leaves this addon:
// a launcher crash closes it and the kernel ends the tree. commit() clears
// kill-on-close; a process cannot leave its job, so a committed daemon and its
// helpers stay in a job that no longer ends them.
//
// Execution children start the same way, suspended inside a job of their own
// with the same limits, so no descendant can start outside it. Their stdio
// are named pipes the host connects to; the child runs only once each pipe's
// client is the host.
//
// The record holds the root's process handle, so its PID cannot name another
// process while the record exists; every action goes through that handle or
// the job, never a PID. Errors carry fixed text: no paths, arguments, or input.
#ifndef _WIN32
#error "core-owned-child (Windows) supports Windows only"
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
#include <sddl.h>

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#include <node_api.h>

#include "confined_read_win.h"
#include "migration_image_win.h"
#include "migration_fs_win.h"
#include "recycle_item_win.h"

// Windows 10 headers only define it for _WIN32_WINNT >= 0x0A00.
#ifndef PROC_THREAD_ATTRIBUTE_JOB_LIST
#define PROC_THREAD_ATTRIBUTE_JOB_LIST \
  ProcThreadAttributeValue(13, FALSE, TRUE, FALSE)
#endif

// One argument or environment string, in UTF-16 code units.
#define MAX_STRING_CHARS 32767
#define MAX_VECTOR 4096
// CreateProcessW's limit, including the terminating NUL.
#define MAX_COMMAND_LINE 32767
#define DEADLINE_MS 2000
// Exit code of every process this addon terminates. observe() reports it as
// SIGKILL only once the addon has terminated the job.
#define TERMINATED_CODE 0x4F430009u
#define SIGKILL_NUMBER 9
// An execution child's stdin, stdout and stderr.
#define STDIO_COUNT 3
// libuv's stdio pipe buffers.
#define PIPE_BUFFER 65536
// Hex digits of the caller's pipe-name nonce.
#define NONCE_CHARS 32

typedef enum { OWNED, COMMITTED } handle_state;

typedef struct record {
  uint64_t serial;
  HANDLE process;
  HANDLE job;
  HANDLE channel;
  bool channel_seen;
  DWORD pid;
  handle_state state;
  bool delivered;
  // Set before the first job termination this addon requests.
  bool terminated;
  // An execution child created suspended keeps its initial thread and the
  // server ends of its stdio pipes here until resume().
  HANDLE thread;
  HANDLE pipes[STDIO_COUNT];
  struct record *next;
} record;

// One list per load: a handle from another load or env is unrelated.
typedef struct {
  record *head;
} instance;

// Process-wide, so a serial never resolves in a load that did not issue it.
static volatile LONG64 next_serial = 0;

typedef struct {
  const instance *owner;
  uint64_t serial;
} token;

static const napi_type_tag HANDLE_TAG = {0x6f776e6564636869ULL,
                                         0x6c642d77696e3332ULL};

typedef enum { ROOT_LOST, ROOT_RUNNING, ROOT_EXITED } root_state;

static void throw_code(napi_env env, const char *code, const char *message) {
  napi_throw_error(env, code, message);
}

static root_state inspect_root(const record *item) {
  switch (WaitForSingleObject(item->process, 0)) {
    case WAIT_TIMEOUT:
      return ROOT_RUNNING;
    case WAIT_OBJECT_0:
      return ROOT_EXITED;
    default:
      return ROOT_LOST;
  }
}

// Live processes in the job, nested jobs included; -1 when the query fails.
// A running root counts itself, and the hidden console host of a console root
// is a member too, until it exits after its last client.
static int64_t job_active(HANDLE job) {
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info;
  if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation,
                                 &info, (DWORD)sizeof info, NULL))
    return -1;
  return (int64_t)info.ActiveProcesses;
}

// Ends every process in the job, nested jobs included. The root is also ended
// through its own handle, which is safe because the handle pins its identity.
static bool terminate_job(record *item) {
  item->terminated = true;
  bool ended = TerminateJobObject(item->job, TERMINATED_CODE) != 0;
  if (inspect_root(item) == ROOT_RUNNING)
    TerminateProcess(item->process, TERMINATED_CODE);
  return ended;
}

static void close_pipes(record *item) {
  for (size_t n = 0; n < STDIO_COUNT; n++)
    if (item->pipes[n]) {
      CloseHandle(item->pipes[n]);
      item->pipes[n] = NULL;
    }
}

static void close_record(record *item) {
  if (item->channel) CloseHandle(item->channel);
  close_pipes(item);
  if (item->thread) CloseHandle(item->thread);
  if (item->process) CloseHandle(item->process);
  if (item->job) CloseHandle(item->job);
  free(item);
}

static void unlink_record(instance *inst, record *target) {
  for (record **at = &inst->head; *at; at = &(*at)->next)
    if (*at == target) {
      *at = target->next;
      close_record(target);
      return;
    }
}

// Synchronous rollback for paths that cannot wait on the event loop: host
// exit, env teardown, and a failed start. Returns true once the root has
// exited and the job holds no live process.
static bool rollback_blocking(record *item) {
  ULONGLONG deadline = GetTickCount64() + DEADLINE_MS;
  for (;;) {
    root_state root = inspect_root(item);
    if (root == ROOT_LOST) return false;
    if (root == ROOT_EXITED && job_active(item->job) == 0) return true;
    // Repeated: a process created after the previous call is ended next.
    terminate_job(item);
    if (GetTickCount64() >= deadline) return false;
    Sleep(10);
  }
}

static void report_teardown_failure(void) {
  static const char line[] = "Uncommitted child cleanup failed.\n";
  HANDLE err = GetStdHandle(STD_ERROR_HANDLE);
  DWORD written = 0;
  if (err && err != INVALID_HANDLE_VALUE)
    WriteFile(err, line, (DWORD)(sizeof line - 1), &written, NULL);
}

// Env teardown: an uncommitted handle is a startup that never committed, so
// its job is rolled back; committed daemons are left running. Closing a job
// handle that still kills on close also ends what a failed rollback left.
static void env_cleanup(void *data) {
  instance *inst = data;
  record *item = inst->head;
  while (item) {
    record *next = item->next;
    if (item->state == OWNED && !rollback_blocking(item))
      report_teardown_failure();
    close_record(item);
    item = next;
  }
  free(inst);
}

static void finalize_token(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  free(data);
}

// Resolves a handle issued by this load's spawn and not yet released. The
// instance arrives as callback data: env instance data is shared by every
// addon in the env, so it cannot identify this load.
static record *resolve_handle(napi_env env, instance *inst, napi_value value) {
  napi_valuetype type;
  bool tagged = false;
  void *data = NULL;
  if (inst && napi_typeof(env, value, &type) == napi_ok &&
      type == napi_object &&
      napi_check_object_type_tag(env, value, &HANDLE_TAG, &tagged) ==
          napi_ok &&
      tagged && napi_unwrap(env, value, &data) == napi_ok && data &&
      ((token *)data)->owner == inst) {
    uint64_t serial = ((token *)data)->serial;
    for (record *item = inst->head; item; item = item->next)
      if (item->serial == serial) return item;
  }
  throw_code(env, "ERR_OWNED_CHILD_HANDLE", "Owned child handle is invalid.");
  return NULL;
}

static record *handle_arg(napi_env env, napi_callback_info info,
                          instance **inst) {
  size_t argc = 1;
  napi_value argv[1];
  void *data = NULL;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, &data) != napi_ok ||
      argc != 1 || !data) {
    throw_code(env, "ERR_OWNED_CHILD_ARGUMENT", "Owned child call is invalid.");
    return NULL;
  }
  *inst = data;
  return resolve_handle(env, *inst, argv[0]);
}

static napi_value make_int(napi_env env, int64_t value) {
  napi_value out;
  napi_create_int64(env, value, &out);
  return out;
}

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

static napi_value make_state(napi_env env, const char *state) {
  napi_value out, text;
  napi_create_object(env, &out);
  napi_create_string_utf8(env, state, NAPI_AUTO_LENGTH, &text);
  napi_set_named_property(env, out, "state", text);
  return out;
}

// Copies a JS string as UTF-16, lone surrogates included, without embedded
// NULs. Returns NULL with no exception pending; the caller throws one fixed
// error.
static wchar_t *copy_string(napi_env env, napi_value value) {
  napi_valuetype type;
  size_t size = 0;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string ||
      napi_get_value_string_utf16(env, value, NULL, 0, &size) != napi_ok ||
      size > MAX_STRING_CHARS)
    return NULL;
  char16_t *text = calloc(size + 1, sizeof *text);
  if (!text) return NULL;
  size_t copied = 0;
  if (napi_get_value_string_utf16(env, value, text, size + 1, &copied) !=
          napi_ok ||
      copied != size || wcslen((const wchar_t *)text) != size) {
    free(text);
    return NULL;
  }
  return (wchar_t *)text;
}

static void free_vector(wchar_t **items) {
  if (!items) return;
  for (wchar_t **at = items; *at; at++) free(*at);
  free(items);
}

static wchar_t **copy_vector(napi_env env, napi_value value, size_t minimum,
                             size_t maximum, size_t *count) {
  bool array = false;
  uint32_t length = 0;
  if (napi_is_array(env, value, &array) != napi_ok || !array ||
      napi_get_array_length(env, value, &length) != napi_ok ||
      length < minimum || length > maximum)
    return NULL;
  wchar_t **items = calloc((size_t)length + 1, sizeof *items);
  if (!items) return NULL;
  for (uint32_t n = 0; n < length; n++) {
    napi_value item;
    if (napi_get_element(env, value, n, &item) != napi_ok ||
        !(items[n] = copy_string(env, item))) {
      free_vector(items);
      return NULL;
    }
  }
  *count = length;
  return items;
}

static bool separator(wchar_t c) { return c == L'\\' || c == L'/'; }

// A drive (`C:\`) or UNC (`\\server\share`) path. Drive-relative, rooted-only
// and `\\?\` / `\\.\` device paths are refused, as in the TS path helpers.
static bool fully_qualified(const wchar_t *path) {
  wchar_t drive = (wchar_t)(path[0] | 0x20);
  if (drive >= L'a' && drive <= L'z' && path[1] == L':' && separator(path[2]))
    return true;
  if (!separator(path[0]) || !separator(path[1])) return false;
  if ((path[2] == L'?' || path[2] == L'.') && separator(path[3])) return false;
  size_t at = 2;
  if (path[at] == 0 || separator(path[at])) return false;
  while (path[at] && !separator(path[at])) at++;
  while (separator(path[at])) at++;
  return path[at] != 0 && at > 3 && separator(path[at - 1]);
}

// libuv's quote_cmd_arg: the root parses its argv exactly as a child Node
// spawns does (CommandLineToArgvW and the MSVC CRT agree on these rules).
// Writes at most 2 * length + 2 characters and returns the new end.
static wchar_t *quote_argument(const wchar_t *source, wchar_t *target) {
  size_t length = wcslen(source);
  if (length == 0) {
    *target++ = L'"';
    *target++ = L'"';
    return target;
  }
  if (!wcspbrk(source, L" \t\"")) {
    memcpy(target, source, length * sizeof *target);
    return target + length;
  }
  if (!wcspbrk(source, L"\"\\")) {
    *target++ = L'"';
    memcpy(target, source, length * sizeof *target);
    target += length;
    *target++ = L'"';
    return target;
  }
  // Backslashes double only before a quote or the closing quote; every
  // embedded quote is escaped. Built back to front, then reversed.
  *target++ = L'"';
  wchar_t *start = target;
  bool quote_hit = true;
  for (size_t i = length; i > 0; --i) {
    *target++ = source[i - 1];
    if (quote_hit && source[i - 1] == L'\\') {
      *target++ = L'\\';
    } else if (source[i - 1] == L'"') {
      quote_hit = true;
      *target++ = L'\\';
    } else {
      quote_hit = false;
    }
  }
  for (wchar_t *low = start, *high = target - 1; low < high; low++, high--) {
    wchar_t swap = *low;
    *low = *high;
    *high = swap;
  }
  *target++ = L'"';
  return target;
}

// NULL when the quoted line would exceed CreateProcessW's limit.
static wchar_t *command_line(wchar_t **args, size_t count) {
  size_t unquoted = 0, capacity = 1;
  for (size_t n = 0; n < count; n++) {
    unquoted += wcslen(args[n]) + 1;
    capacity += 2 * wcslen(args[n]) + 3;
  }
  // Quoting never shortens the line.
  if (unquoted > MAX_COMMAND_LINE) return NULL;
  wchar_t *line = calloc(capacity, sizeof *line);
  if (!line) return NULL;
  wchar_t *end = line;
  for (size_t n = 0; n < count; n++) {
    if (n > 0) *end++ = L' ';
    end = quote_argument(args[n], end);
  }
  *end = 0;
  if ((size_t)(end - line) >= MAX_COMMAND_LINE) {
    free(line);
    return NULL;
  }
  return line;
}

static size_t key_length(const wchar_t *entry) {
  return (size_t)(wcschr(entry, L'=') - entry);
}

// Windows orders an environment block by name, case-insensitively and
// ordinally (CompareStringOrdinal), without regard to locale.
static int compare_keys(const void *left, const void *right) {
  const wchar_t *a = *(wchar_t *const *)left;
  const wchar_t *b = *(wchar_t *const *)right;
  return CompareStringOrdinal(a, (int)key_length(a), b, (int)key_length(b),
                              TRUE) -
         CSTR_EQUAL;
}

// The complete child environment, sorted, as one UTF-16 block. Each entry
// needs a name before its `=`; names differing only in case are refused,
// because Windows treats them as one variable. Nothing is inherited.
static wchar_t *environment_block(wchar_t **entries, size_t count) {
  size_t chars = 2;
  for (size_t n = 0; n < count; n++) {
    const wchar_t *equals = wcschr(entries[n], L'=');
    if (!equals || equals == entries[n]) return NULL;
    chars += wcslen(entries[n]) + 1;
  }
  qsort(entries, count, sizeof *entries, compare_keys);
  for (size_t n = 1; n < count; n++)
    if (compare_keys(&entries[n - 1], &entries[n]) == 0) return NULL;
  wchar_t *block = calloc(chars, sizeof *block);
  if (!block) return NULL;
  wchar_t *end = block;
  for (size_t n = 0; n < count; n++) {
    size_t length = wcslen(entries[n]);
    memcpy(end, entries[n], length * sizeof *end);
    end += length + 1;
  }
  return block;
}

static HANDLE open_nul(DWORD access) {
  SECURITY_ATTRIBUTES inherit = {(DWORD)sizeof inherit, NULL, TRUE};
  return CreateFileW(L"NUL", access, FILE_SHARE_READ | FILE_SHARE_WRITE,
                     &inherit, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
}

// Unnamed and not inheritable. No breakaway flag: a descendant that asks to
// break away is refused, and silent breakaway from nested libuv jobs stops
// here. Die-on-unhandled-exception keeps Windows Error Reporting dialogs off.
static bool set_kill_on_close(HANDLE job, bool kill) {
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  memset(&limits, 0, sizeof limits);
  limits.BasicLimitInformation.LimitFlags =
      JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION |
      (kill ? JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE : 0);
  return SetInformationJobObject(job, JobObjectExtendedLimitInformation,
                                 &limits, (DWORD)sizeof limits) != 0;
}

static HANDLE create_job(void) {
  HANDLE job = CreateJobObjectW(NULL, NULL);
  if (!job) return NULL;
  if (!set_kill_on_close(job, true)) {
    CloseHandle(job);
    return NULL;
  }
  return job;
}

// Creates the root suspended, in `job`, with only the NUL handles inherited,
// a hidden console of its own (its console children need no window either),
// its own Ctrl+C group, and the Windows directory as working directory, so no
// install or repository directory is held open or searched for DLLs.
//
// When the launcher is itself in a job, the root first asks to break away, so
// a committed daemon outlives the launcher's job. Node and Electron join a
// kill-on-close libuv job of their own on their first spawn, so this is the
// usual case. A job that refuses explicit
// breakaway fails the call; the root is then created nested inside it, and
// that enclosing job bounds the daemon's lifetime.
static bool create_root(const wchar_t *executable, wchar_t *line,
                        wchar_t *environment, HANDLE job, HANDLE in,
                        HANDLE out, PROCESS_INFORMATION *created) {
  wchar_t directory[MAX_PATH + 1];
  UINT length = GetSystemWindowsDirectoryW(directory, MAX_PATH + 1);
  if (length == 0 || length > MAX_PATH) return false;
  SIZE_T size = 0;
  InitializeProcThreadAttributeList(NULL, 2, 0, &size);
  LPPROC_THREAD_ATTRIBUTE_LIST attributes = size ? malloc(size) : NULL;
  if (!attributes) return false;
  HANDLE inherited[2] = {in, out};
  HANDLE jobs[1] = {job};
  bool ok = InitializeProcThreadAttributeList(attributes, 2, 0, &size);
  bool initialized = ok;
  ok = ok && UpdateProcThreadAttribute(attributes, 0,
                                       PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                                       inherited, sizeof inherited, NULL,
                                       NULL);
  ok = ok && UpdateProcThreadAttribute(attributes, 0,
                                       PROC_THREAD_ATTRIBUTE_JOB_LIST, jobs,
                                       sizeof jobs, NULL, NULL);
  if (ok) {
    STARTUPINFOEXW startup;
    memset(&startup, 0, sizeof startup);
    startup.StartupInfo.cb = (DWORD)sizeof startup;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    startup.StartupInfo.wShowWindow = SW_HIDE;
    startup.StartupInfo.hStdInput = in;
    startup.StartupInfo.hStdOutput = out;
    startup.StartupInfo.hStdError = out;
    startup.lpAttributeList = attributes;
    DWORD flags = CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW |
                  CREATE_NEW_PROCESS_GROUP | CREATE_SUSPENDED |
                  EXTENDED_STARTUPINFO_PRESENT;
    BOOL in_job = FALSE;
    bool enclosed = IsProcessInJob(GetCurrentProcess(), NULL, &in_job) &&
                    in_job;
    ok = enclosed && CreateProcessW(executable, line, NULL, NULL, TRUE,
                                    flags | CREATE_BREAKAWAY_FROM_JOB,
                                    environment, directory,
                                    &startup.StartupInfo, created);
    // Any refusal of the breakaway attempt falls back to nesting; a request
    // that cannot start at all fails the same way again.
    if (!ok)
      ok = CreateProcessW(executable, line, NULL, NULL, TRUE, flags,
                          environment, directory, &startup.StartupInfo,
                          created);
  }
  if (initialized) DeleteProcThreadAttributeList(attributes);
  free(attributes);
  return ok;
}

// A record whose handle cannot be delivered: roll the child back here.
static napi_value fail_undelivered(napi_env env, instance *inst,
                                   record *item) {
  bool cleaned = rollback_blocking(item);
  if (cleaned) unlink_record(inst, item);
  throw_code(env, cleaned ? "ERR_OWNED_CHILD_SPAWN" : "ERR_OWNED_CHILD_CLEANUP",
             cleaned ? "Owned child could not be started."
                     : "Owned child cleanup did not complete.");
  return NULL;
}

static const char *const STDIO_NAMES[STDIO_COUNT] = {"stdin", "stdout",
                                                      "stderr"};

static bool set_text(napi_env env, napi_value object, const char *key,
                     const wchar_t *text) {
  napi_value value;
  if (!text) return napi_set_named_property(env, object, key,
                                            make_null(env)) == napi_ok;
  return napi_create_string_utf16(env, (const char16_t *)text,
                                  NAPI_AUTO_LENGTH, &value) == napi_ok &&
         napi_set_named_property(env, object, key, value) == napi_ok;
}

// Wraps a fresh record, with the pipe names of an execution child when given;
// on failure the child is rolled back here, since no handle can be returned
// for it.
static napi_value make_handle(napi_env env, instance *inst, record *item,
                              wchar_t *const *pipe_names) {
  napi_value handle, result;
  token *tok = malloc(sizeof *tok);
  bool ok = tok && napi_create_object(env, &handle) == napi_ok &&
            napi_type_tag_object(env, handle, &HANDLE_TAG) == napi_ok;
  if (ok) {
    tok->owner = inst;
    tok->serial = item->serial;
    ok = napi_wrap(env, handle, tok, finalize_token, NULL, NULL) == napi_ok;
    if (ok) tok = NULL;
  }
  ok = ok && napi_create_object(env, &result) == napi_ok &&
       napi_set_named_property(env, result, "handle", handle) == napi_ok &&
       napi_set_named_property(env, result, "pid",
                               make_int(env, item->pid)) == napi_ok;
  for (size_t n = 0; ok && pipe_names && n < STDIO_COUNT; n++)
    ok = set_text(env, result, STDIO_NAMES[n], pipe_names[n]);
  free(tok);
  if (ok) {
    item->delivered = true;
    return result;
  }
  return fail_undelivered(env, inst, item);
}

static PSECURITY_DESCRIPTOR user_only_descriptor(void);
static bool valid_nonce(const wchar_t *nonce);
#define MIGRATION_NAME_CHARS 100

static bool migration_name(wchar_t *name, DWORD pid, const wchar_t *nonce) {
  return swprintf(name, MIGRATION_NAME_CHARS,
                   L"\\\\.\\pipe\\canopy-migration-%lu-%ls",
                   (unsigned long)pid, nonce) > 0;
}

static uint64_t creation_ticks(HANDLE process) {
  FILETIME created, exited, kernel, user;
  if (!GetProcessTimes(process, &created, &exited, &kernel, &user)) return 0;
  return ((uint64_t)created.dwHighDateTime << 32) | created.dwLowDateTime;
}

// The header locates the channel, not admission evidence. Only stdin is
// inherited; neither the server nor any process/job handle enters the child.
static napi_value spawn_root(napi_env env, napi_callback_info info,
                              bool with_channel) {
  size_t argc = 5;
  napi_value argv[5];
  void *data = NULL;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, &data) != napi_ok ||
      argc != (with_channel ? 5u : 4u) || !data) {
    throw_code(env, "ERR_OWNED_CHILD_ARGUMENT", "Owned child call is invalid.");
    return NULL;
  }
  napi_valuetype stdin_type = napi_undefined;
  napi_typeof(env, argv[3], &stdin_type);
  size_t arg_count = 0, env_count = 0;
  wchar_t *executable = copy_string(env, argv[0]);
  wchar_t **args = copy_vector(env, argv[1], 1, MAX_VECTOR, &arg_count);
  wchar_t **environment = copy_vector(env, argv[2], 0, MAX_VECTOR, &env_count);
  char input[4097];
  size_t input_size = 0;
  bool input_ok = stdin_type == napi_null;
  if (stdin_type == napi_string)
    input_ok = napi_get_value_string_utf8(env, argv[3], NULL, 0,
                                          &input_size) == napi_ok &&
               input_size <= 4096 &&
               napi_get_value_string_utf8(env, argv[3], input, sizeof input,
                                          &input_size) == napi_ok &&
               strlen(input) == input_size;
  wchar_t *nonce = with_channel ? copy_string(env, argv[4]) : NULL;
  bool valid = executable && fully_qualified(executable) && args &&
               environment && input_ok && (with_channel || stdin_type == napi_null) &&
               (!with_channel || (nonce && valid_nonce(nonce)));
  wchar_t *line = valid ? command_line(args, arg_count) : NULL;
  wchar_t *block = valid ? environment_block(environment, env_count) : NULL;
  valid = line && block;
  record *item = valid ? calloc(1, sizeof *item) : NULL;
  HANDLE job = item ? create_job() : NULL;
  HANDLE in = INVALID_HANDLE_VALUE, writer = NULL;
  bool has_input = with_channel || stdin_type == napi_string;
  if (job && has_input) {
    SECURITY_ATTRIBUTES attributes = {(DWORD)sizeof attributes, NULL, TRUE};
    if (!CreatePipe(&in, &writer, &attributes, 8192) ||
        !SetHandleInformation(writer, HANDLE_FLAG_INHERIT, 0)) {
      if (in != INVALID_HANDLE_VALUE) CloseHandle(in);
      in = INVALID_HANDLE_VALUE;
    }
  } else if (job) in = open_nul(GENERIC_READ);
  HANDLE out = job ? open_nul(GENERIC_WRITE) : INVALID_HANDLE_VALUE;
  HANDLE channel = NULL;
  if (job && with_channel) {
    wchar_t name[MIGRATION_NAME_CHARS];
    PSECURITY_DESCRIPTOR descriptor = user_only_descriptor();
    SECURITY_ATTRIBUTES attributes = {(DWORD)sizeof attributes, descriptor, FALSE};
    if (descriptor && migration_name(name, GetCurrentProcessId(), nonce)) {
      channel = CreateNamedPipeW(name,
          PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
          PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_NOWAIT |
              PIPE_REJECT_REMOTE_CLIENTS,
          1, PIPE_BUFFER, PIPE_BUFFER, 0, &attributes);
      if (channel == INVALID_HANDLE_VALUE) channel = NULL;
      if (channel) ConnectNamedPipe(channel, NULL);
    }
    LocalFree(descriptor);
  }
  bool handed = !has_input;
  if (writer) {
    DWORD written = 0;
    handed = true;
    if (with_channel) {
      char header[160];
      uint64_t ticks = creation_ticks(GetCurrentProcess());
      int length = ticks ? sprintf_s(header, sizeof header,
          "canopy-launcher-v1 %lu %llu %ls\n",
          (unsigned long)GetCurrentProcessId(), (unsigned long long)ticks,
          nonce) : -1;
      handed = length > 0 && WriteFile(writer, header, (DWORD)length,
                                       &written, NULL) && written == (DWORD)length;
    }
    if (handed && input_size)
      handed = WriteFile(writer, input, (DWORD)input_size, &written, NULL) &&
               written == (DWORD)input_size;
    CloseHandle(writer);
  }
  SecureZeroMemory(input, sizeof input);
  free(nonce);
  PROCESS_INFORMATION created;
  memset(&created, 0, sizeof created);
  bool started = job && handed && (!with_channel || channel) &&
                 in != INVALID_HANDLE_VALUE &&
                 out != INVALID_HANDLE_VALUE &&
                 create_root(executable, line, block, job, in, out, &created);
  if (in != INVALID_HANDLE_VALUE) CloseHandle(in);
  if (out != INVALID_HANDLE_VALUE) CloseHandle(out);
  free(executable);
  free_vector(args);
  free_vector(environment);
  free(line);
  free(block);
  if (!started) {
    if (channel) CloseHandle(channel);
    if (job) CloseHandle(job);
    free(item);
    throw_code(env, valid ? "ERR_OWNED_CHILD_SPAWN" : "ERR_OWNED_CHILD_ARGUMENT",
               valid ? "Owned child could not be started."
                     : "Owned child call is invalid.");
    return NULL;
  }
  instance *inst = data;
  item->serial = (uint64_t)InterlockedIncrement64(&next_serial);
  item->process = created.hProcess;
  item->job = job;
  item->channel = channel;
  item->pid = created.dwProcessId;
  item->state = OWNED;
  item->next = inst->head;
  inst->head = item;
  // Resumed only inside the job; otherwise it is ended before it ever runs.
  BOOL member = FALSE;
  bool contained = IsProcessInJob(created.hProcess, job, &member) && member &&
                   ResumeThread(created.hThread) != (DWORD)-1;
  CloseHandle(created.hThread);
  if (!contained) return fail_undelivered(env, inst, item);
  return make_handle(env, inst, item, NULL);
}

static napi_value spawn_child(napi_env env, napi_callback_info info) {
  return spawn_root(env, info, false);
}

static napi_value spawn_channel(napi_env env, napi_callback_info info) {
  return spawn_root(env, info, true);
}

// observe(handle) -> { state: 'running' | 'lost' } | { state: 'exited', code, signal }
// A root this addon terminated reports SIGKILL's number and no code; any other
// exit reports its unsigned exit code.
static napi_value observe(napi_env env, napi_callback_info info) {
  instance *inst;
  record *item = handle_arg(env, info, &inst);
  if (!item) return NULL;
  switch (inspect_root(item)) {
    case ROOT_RUNNING:
      return make_state(env, "running");
    case ROOT_LOST:
      return make_state(env, "lost");
    case ROOT_EXITED:
      break;
  }
  DWORD code = 0;
  if (!GetExitCodeProcess(item->process, &code)) return make_state(env, "lost");
  bool killed = item->terminated && code == TERMINATED_CODE;
  napi_value out = make_state(env, "exited");
  napi_set_named_property(env, out, "code",
                          killed ? make_null(env) : make_int(env, code));
  napi_set_named_property(env, out, "signal",
                          killed ? make_int(env, SIGKILL_NUMBER)
                                 : make_null(env));
  return out;
}

static bool require_owned(napi_env env, record *item) {
  if (item->state == OWNED) return true;
  throw_code(env, "ERR_OWNED_CHILD_COMMITTED",
             "Owned child is committed and cannot be stopped.");
  return false;
}

static bool require_waitable(napi_env env, record *item, root_state *state) {
  *state = inspect_root(item);
  if (*state != ROOT_LOST) return true;
  throw_code(env, "ERR_OWNED_CHILD_LOST", "Owned child ownership was lost.");
  return false;
}

static napi_value enumeration_failed(napi_env env) {
  throw_code(env, "ERR_OWNED_CHILD_ENUMERATION",
             "Owned child group could not be enumerated.");
  return NULL;
}

// stopGroup(handle): terminates the owned job of a held root.
static napi_value stop_group(napi_env env, napi_callback_info info) {
  instance *inst;
  record *item = handle_arg(env, info, &inst);
  root_state root;
  if (!item || !require_owned(env, item) || !require_waitable(env, item, &root))
    return NULL;
  if (!terminate_job(item) && job_active(item->job) != 0) {
    throw_code(env, "ERR_OWNED_CHILD_SIGNAL",
               "Owned child could not be signaled.");
    return NULL;
  }
  return make_bool(env, true);
}

// members(handle) -> live job members other than the root, nested jobs and
// the root's console host included.
static napi_value members(napi_env env, napi_callback_info info) {
  instance *inst;
  record *item = handle_arg(env, info, &inst);
  root_state root;
  if (!item || !require_waitable(env, item, &root)) return NULL;
  int64_t count = job_active(item->job);
  if (count < 0) return enumeration_failed(env);
  if (root == ROOT_RUNNING && count > 0) count--;
  return make_int(env, count);
}

// release(handle) -> true once the handles are closed; false while the root
// runs or, for an uncommitted handle, while its job has a live process.
static napi_value release(napi_env env, napi_callback_info info) {
  instance *inst;
  record *item = handle_arg(env, info, &inst);
  root_state root;
  if (!item || !require_waitable(env, item, &root)) return NULL;
  if (root != ROOT_EXITED) return make_bool(env, false);
  if (item->state == OWNED) {
    int64_t count = job_active(item->job);
    if (count < 0) return enumeration_failed(env);
    if (count > 0) return make_bool(env, false);
  }
  unlink_record(inst, item);
  return make_bool(env, true);
}

// commit(handle): clears kill-on-close, so neither the launcher's exit nor a
// later rollback ends the daemon. An exited root is refused: its surviving
// job must be rolled back, not disowned.
static napi_value commit(napi_env env, napi_callback_info info) {
  instance *inst;
  record *item = handle_arg(env, info, &inst);
  root_state root;
  if (!item || !require_owned(env, item) || !require_waitable(env, item, &root))
    return NULL;
  if (root == ROOT_EXITED) {
    throw_code(env, "ERR_OWNED_CHILD_EXITED", "Owned child exited before commit.");
    return NULL;
  }
  if (!set_kill_on_close(item->job, false)) {
    throw_code(env, "ERR_OWNED_CHILD_COMMIT", "Owned child could not be committed.");
    return NULL;
  }
  // A root that exited meanwhile leaves its job to rollback, as above.
  if (inspect_root(item) != ROOT_RUNNING) {
    if (!set_kill_on_close(item->job, true)) {
      throw_code(env, "ERR_OWNED_CHILD_COMMIT",
                 "Owned child could not be committed.");
      return NULL;
    }
    throw_code(env, "ERR_OWNED_CHILD_EXITED", "Owned child exited before commit.");
    return NULL;
  }
  item->state = COMMITTED;
  return make_bool(env, true);
}

// rollbackSync(handle) -> true once the job is empty and the handles closed.
// Blocks up to the deadline; for host exit, where no timer can run.
static napi_value rollback_sync(napi_env env, napi_callback_info info) {
  instance *inst;
  record *item = handle_arg(env, info, &inst);
  if (!item || !require_owned(env, item)) return NULL;
  if (!rollback_blocking(item)) return make_bool(env, false);
  unlink_record(inst, item);
  return make_bool(env, true);
}

// Only failed handle constructions: never touches another caller's delivered child.
static napi_value rollback_undelivered(napi_env env, napi_callback_info info) {
  size_t argc = 0;
  void *data = NULL;
  if (napi_get_cb_info(env, info, &argc, NULL, NULL, &data) != napi_ok || !data)
    return NULL;
  instance *inst = data;
  bool complete = true;
  for (record *item = inst->head; item;) {
    record *next = item->next;
    if (!item->delivered && item->state == OWNED) {
      if (rollback_blocking(item)) unlink_record(inst, item);
      else complete = false;
    }
    item = next;
  }
  return make_bool(env, complete);
}

// The token user alone: owner, and the only allow ACE (generic read and
// write), as the secured daemon pipe grants. LocalFree the result.
static PSECURITY_DESCRIPTOR user_only_descriptor(void) {
  union {
    TOKEN_USER user;
    BYTE raw[sizeof(TOKEN_USER) + SECURITY_MAX_SID_SIZE];
  } info;
  HANDLE token;
  DWORD size = 0;
  LPWSTR sid = NULL;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return NULL;
  bool ok = GetTokenInformation(token, TokenUser, &info, (DWORD)sizeof info,
                                &size) &&
            ConvertSidToStringSidW(info.user.User.Sid, &sid);
  CloseHandle(token);
  wchar_t sddl[512];
  ok = ok && swprintf(sddl, sizeof sddl / sizeof *sddl,
                      L"O:%lsD:P(A;;0x0012019f;;;%ls)", sid, sid) > 0;
  LocalFree(sid);
  PSECURITY_DESCRIPTOR descriptor = NULL;
  if (!ok || !ConvertStringSecurityDescriptorToSecurityDescriptorW(
                 sddl, SDDL_REVISION_1, &descriptor, NULL))
    return NULL;
  return descriptor;
}

static bool valid_nonce(const wchar_t *nonce) {
  if (wcslen(nonce) != NONCE_CHARS) return false;
  for (const wchar_t *at = nonce; *at; at++)
    if (!((*at >= L'0' && *at <= L'9') || (*at >= L'a' && *at <= L'f')))
      return false;
  return true;
}

#define PIPE_NAME_CHARS 96

// One stdio pipe, named by this process, the caller's nonce and the stream.
// FILE_FLAG_FIRST_PIPE_INSTANCE and a single instance mean nobody else can
// have created or later serve it; the child keeps the synchronous server end,
// as libuv gives a child the synchronous end of its pipes. stdin carries data
// to the child, stdout and stderr from it.
static HANDLE create_pipe(wchar_t *name, const wchar_t *nonce, size_t stream,
                          PSECURITY_DESCRIPTOR descriptor) {
  if (swprintf(name, PIPE_NAME_CHARS, L"\\\\.\\pipe\\canopy-execution-%lu-%ls-%u",
               (unsigned long)GetCurrentProcessId(), nonce,
               (unsigned)stream) <= 0)
    return NULL;
  SECURITY_ATTRIBUTES attributes = {(DWORD)sizeof attributes, descriptor,
                                    FALSE};
  HANDLE pipe = CreateNamedPipeW(
      name,
      (stream == 0 ? PIPE_ACCESS_INBOUND : PIPE_ACCESS_OUTBOUND) |
          FILE_FLAG_FIRST_PIPE_INSTANCE,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT |
          PIPE_REJECT_REMOTE_CLIENTS,
      1, PIPE_BUFFER, PIPE_BUFFER, 0, &attributes);
  return pipe == INVALID_HANDLE_VALUE ? NULL : pipe;
}

// An inheritable copy for the child alone; closed once the child exists.
static HANDLE inheritable(HANDLE source) {
  HANDLE copy = NULL;
  if (!DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), &copy,
                       0, TRUE, DUPLICATE_SAME_ACCESS))
    return NULL;
  return copy;
}

// Creates an execution child suspended, already in `job`, with exactly the
// three stdio handles inherited, as Node would start it with windowsHide: a
// hidden console of its own, the requested working directory, and no new
// process group. No breakaway is attempted, so the child also stays in any
// job of the host's that does not let it break away silently.
static bool create_execution(const wchar_t *executable, wchar_t *line,
                             wchar_t *environment, const wchar_t *directory,
                             HANDLE job, HANDLE stdio[STDIO_COUNT],
                             PROCESS_INFORMATION *created) {
  SIZE_T size = 0;
  InitializeProcThreadAttributeList(NULL, 2, 0, &size);
  LPPROC_THREAD_ATTRIBUTE_LIST attributes = size ? malloc(size) : NULL;
  if (!attributes) return false;
  HANDLE jobs[1] = {job};
  bool ok = InitializeProcThreadAttributeList(attributes, 2, 0, &size);
  bool initialized = ok;
  ok = ok && UpdateProcThreadAttribute(attributes, 0,
                                       PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                                       stdio, STDIO_COUNT * sizeof *stdio,
                                       NULL, NULL);
  ok = ok && UpdateProcThreadAttribute(attributes, 0,
                                       PROC_THREAD_ATTRIBUTE_JOB_LIST, jobs,
                                       sizeof jobs, NULL, NULL);
  if (ok) {
    STARTUPINFOEXW startup;
    memset(&startup, 0, sizeof startup);
    startup.StartupInfo.cb = (DWORD)sizeof startup;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    startup.StartupInfo.wShowWindow = SW_HIDE;
    startup.StartupInfo.hStdInput = stdio[0];
    startup.StartupInfo.hStdOutput = stdio[1];
    startup.StartupInfo.hStdError = stdio[2];
    startup.lpAttributeList = attributes;
    ok = CreateProcessW(executable, line, NULL, NULL, TRUE,
                        CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW |
                            CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT,
                        environment, directory, &startup.StartupInfo, created);
  }
  if (initialized) DeleteProcThreadAttributeList(attributes);
  free(attributes);
  return ok;
}

// launch(executable, argv, envPairs, cwd, nonce, stdinPipe)
//   -> { handle, pid, stdin, stdout, stderr }
// Creates an execution child suspended inside a job of its own with the root
// limits above (kill on close, no breakaway), so it runs no instruction, and
// creates no descendant, outside that job. Its stdout and stderr, and its
// stdin when `stdinPipe` is set (NUL otherwise), are named pipes whose names
// are returned: Node cannot hand pipes it owns to a child it did not start,
// so the caller connects to them as their only client, then calls resume().
// The record takes the same stop, release and rollback paths as roots and is
// never committed; a child stopped before resume() never runs.
static napi_value launch_child(napi_env env, napi_callback_info info) {
  size_t argc = 6;
  napi_value argv[6];
  void *data = NULL;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, &data) != napi_ok ||
      argc != 6 || !data) {
    throw_code(env, "ERR_OWNED_CHILD_ARGUMENT", "Owned child call is invalid.");
    return NULL;
  }
  napi_valuetype flag_type = napi_undefined;
  bool stdin_pipe = false;
  bool flag = napi_typeof(env, argv[5], &flag_type) == napi_ok &&
              flag_type == napi_boolean &&
              napi_get_value_bool(env, argv[5], &stdin_pipe) == napi_ok;
  size_t arg_count = 0, env_count = 0;
  wchar_t *executable = copy_string(env, argv[0]);
  wchar_t **args = copy_vector(env, argv[1], 1, MAX_COMMAND_LINE, &arg_count);
  wchar_t **environment = copy_vector(env, argv[2], 0, MAX_VECTOR, &env_count);
  wchar_t *directory = copy_string(env, argv[3]);
  wchar_t *nonce = copy_string(env, argv[4]);
  bool valid = flag && executable && fully_qualified(executable) && args &&
               environment && directory && fully_qualified(directory) &&
               nonce && valid_nonce(nonce);
  wchar_t *line = valid ? command_line(args, arg_count) : NULL;
  wchar_t *block = valid ? environment_block(environment, env_count) : NULL;
  valid = line && block;
  record *item = valid ? calloc(1, sizeof *item) : NULL;
  HANDLE job = item ? create_job() : NULL;
  PSECURITY_DESCRIPTOR descriptor = job ? user_only_descriptor() : NULL;
  wchar_t names[STDIO_COUNT][PIPE_NAME_CHARS];
  wchar_t *named[STDIO_COUNT] = {NULL, NULL, NULL};
  HANDLE stdio[STDIO_COUNT] = {NULL, NULL, NULL};
  bool ready = descriptor != NULL;
  for (size_t n = 0; ready && n < STDIO_COUNT; n++) {
    if (n == 0 && !stdin_pipe) {
      HANDLE nul = open_nul(GENERIC_READ);
      stdio[n] = nul == INVALID_HANDLE_VALUE ? NULL : nul;
    } else {
      item->pipes[n] = create_pipe(names[n], nonce, n, descriptor);
      stdio[n] = item->pipes[n] ? inheritable(item->pipes[n]) : NULL;
      named[n] = names[n];
    }
    ready = stdio[n] != NULL;
  }
  PROCESS_INFORMATION created;
  memset(&created, 0, sizeof created);
  bool started = ready && create_execution(executable, line, block, directory,
                                           job, stdio, &created);
  for (size_t n = 0; n < STDIO_COUNT; n++)
    if (stdio[n]) CloseHandle(stdio[n]);
  if (descriptor) LocalFree(descriptor);
  free(executable);
  free_vector(args);
  free_vector(environment);
  free(directory);
  free(line);
  free(block);
  if (!started) {
    free(nonce);
    if (item) close_pipes(item);
    if (job) CloseHandle(job);
    free(item);
    throw_code(env, valid ? "ERR_OWNED_CHILD_SPAWN" : "ERR_OWNED_CHILD_ARGUMENT",
               valid ? "Owned child could not be started."
                     : "Owned child call is invalid.");
    return NULL;
  }
  free(nonce);
  instance *inst = data;
  item->serial = (uint64_t)InterlockedIncrement64(&next_serial);
  item->process = created.hProcess;
  item->thread = created.hThread;
  item->job = job;
  item->pid = created.dwProcessId;
  item->state = OWNED;
  item->next = inst->head;
  inst->head = item;
  BOOL member = FALSE;
  if (!IsProcessInJob(created.hProcess, job, &member) || !member)
    return fail_undelivered(env, inst, item);
  return make_handle(env, inst, item, named);
}

// resume(handle) -> true once the launched child runs. Each of its pipes must
// be connected, and by this process: a pipe another process connected to
// first is refused, and the caller then stops the job, which ends the child
// before it ever ran. The server ends are closed here, so the child holds the
// only ones and its exit ends the streams.
static napi_value resume_child(napi_env env, napi_callback_info info) {
  instance *inst;
  record *item = handle_arg(env, info, &inst);
  if (!item || !require_owned(env, item)) return NULL;
  bool ok = item->thread != NULL;
  DWORD self = GetCurrentProcessId();
  for (size_t n = 0; ok && n < STDIO_COUNT; n++) {
    ULONG client = 0;
    ok = !item->pipes[n] ||
         (GetNamedPipeClientProcessId(item->pipes[n], &client) &&
          client == self);
  }
  if (ok) {
    close_pipes(item);
    ok = ResumeThread(item->thread) != (DWORD)-1;
    CloseHandle(item->thread);
    item->thread = NULL;
  }
  if (!ok) {
    throw_code(env, "ERR_OWNED_CHILD_SPAWN", "Owned child could not be started.");
    return NULL;
  }
  return make_bool(env, true);
}

// Windows connection custody is deliberately not Darwin audit evidence.
// A connection PID identifies the opener, not every future writer after a
// hostile same-user DuplicateHandle; W2 must not interpret it as the latter.
typedef struct {
  const instance *owner;
  HANDLE pipe;
  HANDLE process;
  DWORD pid;
  bool seen;
} launcher_end;

static const napi_type_tag LAUNCHER_TAG = {0x77696e6c61756e63ULL,
                                           0x686572656e643031ULL};

static void close_launcher(launcher_end *end) {
  if (end->pipe) CloseHandle(end->pipe);
  if (end->process) CloseHandle(end->process);
  end->pipe = end->process = NULL;
}

static void finalize_launcher(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  close_launcher(data);
  free(data);
}

static void throw_channel(napi_env env, const char *stage, DWORD win32) {
  napi_value message, error, value;
  napi_create_string_utf8(env, "Launcher channel is unavailable.", NAPI_AUTO_LENGTH, &message);
  napi_create_error(env, NULL, message, &error);
  napi_create_string_utf8(env, "ERR_OWNED_CHILD_CHANNEL", NAPI_AUTO_LENGTH, &value);
  napi_set_named_property(env, error, "code", value);
  napi_create_string_utf8(env, stage, NAPI_AUTO_LENGTH, &value);
  napi_set_named_property(env, error, "stage", value);
  napi_set_named_property(env, error, "win32", make_int(env, win32));
  napi_throw(env, error);
}

// Client-side connection: identity comes from GetNamedPipeServerProcessId,
// never from bytes received on the pipe. The opened process stays held.
static napi_value connect_launcher(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  int64_t pid_value = 0;
  DWORD pid = 0;
  uint64_t ticks = 0;
  void *data = NULL;
  bool lossless = false;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, &data) != napi_ok ||
      argc != 3 || !data || napi_get_value_int64(env, argv[0], &pid_value) != napi_ok ||
      pid_value <= 1 || pid_value > 0xffffffffLL || napi_get_value_bigint_uint64(env, argv[1], &ticks,
                                               &lossless) != napi_ok ||
      !lossless || !ticks) goto invalid;
  pid = (DWORD)pid_value;
  wchar_t *nonce = copy_string(env, argv[2]);
  wchar_t name[MIGRATION_NAME_CHARS];
  bool valid = nonce && valid_nonce(nonce) && migration_name(name, pid, nonce);
  free(nonce);
  if (!valid) goto invalid;
  const char *stage = "allocation";
  DWORD win32 = ERROR_NOT_ENOUGH_MEMORY;
  launcher_end *end = calloc(1, sizeof *end);
  if (!end) goto failed;
  end->owner = data;
  stage = "open";
  end->pipe = CreateFileW(name, GENERIC_READ | GENERIC_WRITE, 0, NULL,
                          OPEN_EXISTING, SECURITY_SQOS_PRESENT |
                          SECURITY_IDENTIFICATION, NULL);
  if (end->pipe == INVALID_HANDLE_VALUE) { end->pipe = NULL; goto native_failed; }
  ULONG observed = 0;
  stage = "server_pid";
  if (!GetNamedPipeServerProcessId(end->pipe, &observed)) goto native_failed;
  stage = "server_mismatch";
  if (observed != pid) { win32 = ERROR_INVALID_DATA; goto cleanup; }
  DWORD mode = PIPE_READMODE_BYTE | PIPE_NOWAIT;
  stage = "mode";
  if (!SetNamedPipeHandleState(end->pipe, &mode, NULL, NULL)) goto native_failed;
  stage = "process";
  end->process = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                              FALSE, pid);
  if (!end->process) goto native_failed;
  stage = "creation_time";
  if (creation_ticks(end->process) != ticks) { win32 = ERROR_INVALID_DATA; goto cleanup; }
  stage = "process_exited";
  if (WaitForSingleObject(end->process, 0) != WAIT_TIMEOUT) { win32 = ERROR_PROCESS_ABORTED; goto cleanup; }
  end->pid = pid;
  napi_value handle;
  stage = "delivery";
  win32 = ERROR_NOT_ENOUGH_MEMORY;
  bool ok = napi_create_object(env, &handle) == napi_ok &&
       napi_type_tag_object(env, handle, &LAUNCHER_TAG) == napi_ok &&
       napi_wrap(env, handle, end, finalize_launcher, NULL, NULL) == napi_ok;
  if (ok) return handle;
  goto cleanup;
native_failed:
  win32 = GetLastError();
cleanup:
  close_launcher(end);
  free(end);
failed:
  throw_channel(env, stage, win32);
  return NULL;
invalid:
  throw_code(env, "ERR_OWNED_CHILD_ARGUMENT", "Owned child call is invalid.");
  return NULL;
}

typedef struct {
  HANDLE *pipe;
  HANDLE process;
  DWORD pid;
  bool server;
  bool *seen;
  HANDLE *client_process;
} channel_view;

static bool channel_arg(napi_env env, napi_value handle, instance *inst,
                         channel_view *view) {
  bool tagged = false;
  void *data = NULL;
  if (napi_check_object_type_tag(env, handle, &LAUNCHER_TAG, &tagged) == napi_ok &&
      tagged && napi_unwrap(env, handle, &data) == napi_ok && data) {
    launcher_end *end = data;
    if (end->owner != inst) {
      throw_code(env, "ERR_OWNED_CHILD_HANDLE", "Owned child handle is invalid.");
      return false;
    }
    view->pipe = &end->pipe;
    view->process = end->process;
    view->pid = end->pid;
    view->server = false;
    view->seen = &end->seen;
    view->client_process = &end->process;
    return true;
  }
  record *item = resolve_handle(env, inst, handle);
  if (!item) return false;
  view->pipe = &item->channel;
  view->process = item->process;
  view->pid = item->pid;
  view->server = true;
  view->seen = &item->channel_seen;
  view->client_process = NULL;
  return true;
}

// A client owns its retained launcher handle only while the channel is live.
// The server's process handle belongs to the launch record, not the channel.
static void retire_channel(channel_view *view) {
  if (*view->pipe) CloseHandle(*view->pipe);
  *view->pipe = NULL;
  if (view->client_process && *view->client_process) {
    CloseHandle(*view->client_process);
    *view->client_process = NULL;
    view->process = NULL;
  }
}

// 0: waiting for the first connection, 1: exact peer, -1: retired.
// A wrong first connector retires the name, never reconnects it.
static int channel_connected(channel_view *view) {
  if (!*view->pipe) return -1;
  if (!view->process) goto retire;
  // In nonblocking mode the listening transition is explicit. A PID query
  // before a connection exists is not a peer observation.
  if (view->server && !*view->seen) {
    BOOL accepted = ConnectNamedPipe(*view->pipe, NULL);
    DWORD error = accepted ? ERROR_SUCCESS : GetLastError();
    if (error == ERROR_PIPE_LISTENING) {
      if (WaitForSingleObject(view->process, 0) != WAIT_TIMEOUT) goto retire;
      return 0;
    }
    // A client may write and close before the server's first poll.
    if (error != ERROR_SUCCESS && error != ERROR_PIPE_CONNECTED &&
        error != ERROR_NO_DATA) goto retire;
  }
  ULONG observed = 0;
  BOOL ok = view->server
      ? GetNamedPipeClientProcessId(*view->pipe, &observed)
      : GetNamedPipeServerProcessId(*view->pipe, &observed);
  if (!ok) {
    DWORD error = GetLastError();
    if (view->server && !*view->seen &&
        (error == ERROR_PIPE_LISTENING || error == ERROR_PIPE_NOT_CONNECTED)) {
      if (WaitForSingleObject(view->process, 0) != WAIT_TIMEOUT) goto retire;
      return 0;
    }
    goto retire;
  }
  if (observed == view->pid &&
      PeekNamedPipe(*view->pipe, NULL, 0, NULL, NULL, NULL)) {
    *view->seen = true;
    return 1;
  }
retire:
  retire_channel(view);
  return -1;
}

static napi_value channel_call(napi_env env, napi_callback_info info, int op) {
  size_t argc = 2;
  napi_value argv[2];
  void *data = NULL;
  channel_view view;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, &data) != napi_ok ||
      argc != (op < 2 ? 2u : 1u) || !data) {
    throw_code(env, "ERR_OWNED_CHILD_ARGUMENT", "Owned child call is invalid.");
    return NULL;
  }
  if (!channel_arg(env, argv[0], data, &view)) return NULL;
  if (op == 3) {
    retire_channel(&view);
    return make_bool(env, true);
  }
  // Custody needs a live peer; EOF instead follows the pipe after queued bytes.
  // A custody observation must not discard those bytes by retiring the pipe.
  if ((op == 2 || op == 4) && (!view.process ||
      WaitForSingleObject(view.process, 0) != WAIT_TIMEOUT))
    return make_state(env, "refused");
  int connected = channel_connected(&view);
  if (op == 2) {
    napi_value result = make_state(env, connected == 1 ? "connected" : "refused");
    if (connected == 1) {
      napi_value ticks;
      uint64_t created = creation_ticks(view.process);
      if (!created) return make_state(env, "refused");
      napi_create_bigint_uint64(env, created, &ticks);
      napi_set_named_property(env, result, "pid", make_int(env, view.pid));
      napi_set_named_property(env, result, "creationTime", ticks);
    }
    return result;
  }
  if (op == 4) {
    if (connected != 1) return make_null(env);
    napi_value result = capture_migration_image(env, view.process, data), ticks, side;
    napi_valuetype type;
    if (napi_typeof(env, result, &type) != napi_ok || type != napi_object) return result;
    bool is_null = false;
    napi_value null_value = make_null(env);
    napi_strict_equals(env, result, null_value, &is_null);
    if (is_null) return result;
    napi_create_bigint_uint64(env, creation_ticks(view.process), &ticks);
    napi_set_named_property(env, result, "creationTime", ticks);
    napi_set_named_property(env, result, "pid", make_int(env, view.pid));
    napi_set_named_property(env, result, "localPid", make_int(env, GetCurrentProcessId()));
    napi_set_named_property(env, result, "localParentPid", make_int(env, migration_parent_pid(GetCurrentProcess())));
    napi_create_string_utf8(env, view.server ? "daemon" : "launcher", NAPI_AUTO_LENGTH, &side);
    napi_set_named_property(env, result, "role", side);
    return result;
  }
  DWORD count = 0;
  if (op == 0) {
    uint32_t max = 0;
    if (napi_get_value_uint32(env, argv[1], &max) != napi_ok ||
        !max || max > PIPE_BUFFER) goto argument;
    if (connected < 0) return make_null(env);
    char bytes[PIPE_BUFFER];
    if (connected == 1 && !ReadFile(*view.pipe, bytes, max, &count, NULL)) {
      DWORD error = GetLastError();
      if (error != ERROR_NO_DATA && error != ERROR_PIPE_LISTENING) {
        retire_channel(&view);
        return make_null(env);
      }
    }
    napi_value result;
    napi_create_buffer_copy(env, count, bytes, NULL, &result);
    return result;
  }
  napi_typedarray_type type;
  size_t length = 0, offset = 0;
  void *bytes = NULL;
  napi_value buffer;
  if (napi_get_typedarray_info(env, argv[1], &type, &length, &bytes, &buffer,
                                &offset) != napi_ok ||
      type != napi_uint8_array || length > PIPE_BUFFER) goto argument;
  if (connected < 0) goto closed;
  if (connected == 1 && length &&
      !WriteFile(*view.pipe, bytes, (DWORD)length, &count, NULL)) {
    goto closed;
  }
  return make_int(env, count);
argument:
  throw_code(env, "ERR_OWNED_CHILD_ARGUMENT", "Owned child call is invalid.");
  return NULL;
closed:
  retire_channel(&view);
  throw_code(env, "ERR_OWNED_CHILD_CHANNEL", "Launcher channel is unavailable.");
  return NULL;
}

static napi_value channel_read(napi_env env, napi_callback_info info) {
  return channel_call(env, info, 0);
}
static napi_value channel_write(napi_env env, napi_callback_info info) {
  return channel_call(env, info, 1);
}
static napi_value channel_peer(napi_env env, napi_callback_info info) {
  return channel_call(env, info, 2);
}
static napi_value channel_image(napi_env env, napi_callback_info info) {
  return channel_call(env, info, 4);
}
static napi_value channel_close(napi_env env, napi_callback_info info) {
  return channel_call(env, info, 3);
}

// Power (CAN-5066): keeps the system out of idle sleep while the argument
// is true. ES_CONTINUOUS holds the state on this, the host's main thread,
// until it is changed, and Windows drops it when the thread ends, so a
// crashed host never leaves the machine awake. No handle or process involved.
static napi_value set_execution_state(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  bool required = false;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok ||
      argc != 1 || napi_get_value_bool(env, argv[0], &required) != napi_ok) {
    throw_code(env, "ERR_OWNED_CHILD_ARGUMENT", "Owned child call is invalid.");
    return NULL;
  }
  EXECUTION_STATE flags = ES_CONTINUOUS | (required ? ES_SYSTEM_REQUIRED : 0);
  return make_bool(env, SetThreadExecutionState(flags) != 0);
}

NAPI_MODULE_INIT() {
  instance *inst = calloc(1, sizeof *inst);
  if (!inst || napi_add_env_cleanup_hook(env, env_cleanup, inst) != napi_ok) {
    free(inst);
    throw_code(env, "ERR_OWNED_CHILD_LOAD", "Owned child support is unavailable.");
    return NULL;
  }
  napi_property_descriptor methods[] = {
      {"spawnChannel", NULL, spawn_channel, NULL, NULL, NULL, napi_enumerable, inst},
      {"connectLauncher", NULL, connect_launcher, NULL, NULL, NULL, napi_enumerable, inst},
      {"channelRead", NULL, channel_read, NULL, NULL, NULL, napi_enumerable, inst},
      {"channelWrite", NULL, channel_write, NULL, NULL, NULL, napi_enumerable, inst},
      {"channelPeer", NULL, channel_peer, NULL, NULL, NULL, napi_enumerable, inst},
      {"channelImage", NULL, channel_image, NULL, NULL, NULL, napi_enumerable, inst},
      {"imageCurrent", NULL, migration_image_current, NULL, NULL, NULL, napi_enumerable, inst},
      {"imageClose", NULL, migration_image_close, NULL, NULL, NULL, napi_enumerable, inst},
      {"channelClose", NULL, channel_close, NULL, NULL, NULL, napi_enumerable, inst},
      {"spawn", NULL, spawn_child, NULL, NULL, NULL, napi_enumerable, inst},
      {"launch", NULL, launch_child, NULL, NULL, NULL, napi_enumerable, inst},
      {"resume", NULL, resume_child, NULL, NULL, NULL, napi_enumerable, inst},
      {"observe", NULL, observe, NULL, NULL, NULL, napi_enumerable, inst},
      {"stopGroup", NULL, stop_group, NULL, NULL, NULL, napi_enumerable, inst},
      {"members", NULL, members, NULL, NULL, NULL, napi_enumerable, inst},
      {"release", NULL, release, NULL, NULL, NULL, napi_enumerable, inst},
      {"commit", NULL, commit, NULL, NULL, NULL, napi_enumerable, inst},
      {"rollbackSync", NULL, rollback_sync, NULL, NULL, NULL, napi_enumerable,
       inst},
      {"rollbackUndelivered", NULL, rollback_undelivered, NULL, NULL, NULL,
       napi_enumerable, inst},
      {"setExecutionState", NULL, set_execution_state, NULL, NULL, NULL,
       napi_enumerable, NULL},
      // Stateless, so it is safe in any thread's env (the W5 worker's too).
      {"migrationFilesystem", NULL, migration_filesystem, NULL, NULL, NULL, napi_enumerable, NULL},
      {"readConfinedFile", NULL, confined_read_file, NULL, NULL, NULL,
       napi_enumerable, NULL},
      {"recycleItem", NULL, recycle_item, NULL, NULL, NULL, napi_enumerable,
       NULL},
  };
  // On failure the hook stays: it frees the empty instance at teardown.
  if (napi_define_properties(env, exports, sizeof methods / sizeof *methods,
                             methods) != napi_ok)
    return NULL;
  return exports;
}
