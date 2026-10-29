// Owned daemon root for startup rollback (Darwin only).
//
// The root is spawned with posix_spawn as a new session and process-group
// leader. Its exit is observed with waitid(WNOWAIT), which leaves it
// unreaped, so its PID, and with it the group ID, cannot be reused until this
// addon reaps it. Group signals are sent only through a validated, owned,
// unreaped handle. Errors carry fixed text: no paths, arguments, or input.
#ifndef __APPLE__
#error "core-owned-child supports Darwin only"
#endif

#include <node_api.h>

#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define MAX_STDIN_BYTES 4096
#define MAX_STRING_BYTES (64 * 1024)
#define MAX_VECTOR 4096
#define GROUP_CAPACITY 4096
#define DEADLINE_MS 2000

typedef enum { OWNED, COMMITTED } handle_state;

typedef struct record {
  uint64_t serial;
  pid_t pid;
  handle_state state;
  bool delivered;
  struct record *next;
} record;

// One list per load: a handle from another load or env is unrelated.
typedef struct {
  record *head;
} instance;

// Process-wide, so a serial never resolves in a load that did not issue it.
static uint64_t next_serial = 0;

// The wrapped JS object names its issuing load and serial; records live in
// that load's instance.
typedef struct {
  const instance *owner;
  uint64_t serial;
} token;

static const napi_type_tag HANDLE_TAG = {0x6f776e6564636869ULL,
                                         0x6c642d68616e646cULL};

typedef enum { ROOT_LOST, ROOT_RUNNING, ROOT_EXITED } root_state;

static void throw_code(napi_env env, const char *code, const char *message) {
  napi_throw_error(env, code, message);
}

static int64_t now_ms(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (int64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}

static void sleep_ms(long ms) {
  struct timespec t = {0, ms * 1000000L};
  while (nanosleep(&t, &t) == -1 && errno == EINTR) {
  }
}

// Leaves the root waitable. ROOT_LOST means it is no longer this process's
// unreaped child (reaped elsewhere), so its PID must never be signaled.
static root_state inspect_root(pid_t pid, siginfo_t *info) {
  siginfo_t local;
  siginfo_t *out = info ? info : &local;
  for (;;) {
    memset(out, 0, sizeof *out);
    if (waitid(P_PID, (id_t)pid, out, WEXITED | WNOWAIT | WNOHANG) == 0)
      return out->si_pid == pid ? ROOT_EXITED : ROOT_RUNNING;
    if (errno != EINTR) return ROOT_LOST;
  }
}

// Members of the root's group other than the root, zombies included. -1 when
// the bounded enumeration fails or may be truncated. proc_listpids returns
// bytes; proc_listpgrppids returns a PID count, so it is not used. Callers
// hold the root unreaped, so a valid listing always contains the root: one
// without it (including an empty one) is a failure, never an empty group.
static int group_members(pid_t pid) {
  pid_t pids[GROUP_CAPACITY];
  errno = 0;
  int bytes =
      proc_listpids(PROC_PGRP_ONLY, (uint32_t)pid, pids, (int)sizeof pids);
  if (bytes <= 0 || bytes >= (int)sizeof pids || bytes % (int)sizeof(pid_t))
    return -1;
  int count = 0;
  bool root = false;
  for (int n = 0; n < bytes / (int)sizeof(pid_t); n++) {
    if (pids[n] == pid)
      root = true;
    else if (pids[n] > 0)
      count++;
  }
  return root ? count : -1;
}

static bool reap(pid_t pid) {
  int status = 0;
  pid_t reaped;
  do {
    reaped = waitpid(pid, &status, WNOHANG);
  } while (reaped == -1 && errno == EINTR);
  return reaped == pid;
}

static void unlink_record(instance *inst, record *target) {
  for (record **at = &inst->head; *at; at = &(*at)->next)
    if (*at == target) {
      *at = target->next;
      free(target);
      return;
    }
}

// Synchronous rollback for paths that cannot wait on the event loop: host
// exit, env teardown, and a failed handle construction. Returns true once root and group are gone
// and the root is reaped.
static bool rollback_blocking(pid_t pid) {
  int64_t deadline = now_ms() + DEADLINE_MS;
  for (;;) {
    // The unreaped root reserves the group ID; never signal without it.
    root_state root = inspect_root(pid, NULL);
    if (root == ROOT_LOST) return false;
    if (root == ROOT_EXITED && group_members(pid) == 0) return reap(pid);
    // Repeated: a member forked after the previous signal is caught next.
    if (kill(-pid, SIGKILL) != 0 && errno != ESRCH) return false;
    if (now_ms() >= deadline) return false;
    sleep_ms(10);
  }
}

static void report_teardown_failure(void) {
  static const char line[] = "Uncommitted child cleanup failed.\n";
  ssize_t ignored = write(STDERR_FILENO, line, sizeof line - 1);
  (void)ignored;
}

// Env teardown: an uncommitted handle is a startup that never committed, so
// its group is rolled back; committed daemons are left running.
static void env_cleanup(void *data) {
  instance *inst = data;
  record *item = inst->head;
  while (item) {
    record *next = item->next;
    if (item->state == OWNED && !rollback_blocking(item->pid))
      report_teardown_failure();
    free(item);
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

// Copies a JS string without embedded NULs. Returns NULL with no exception
// pending; the caller throws one fixed error.
static char *copy_string(napi_env env, napi_value value) {
  napi_valuetype type;
  size_t size = 0;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string ||
      napi_get_value_string_utf8(env, value, NULL, 0, &size) != napi_ok ||
      size > MAX_STRING_BYTES)
    return NULL;
  char *text = calloc(size + 1, 1);
  if (!text) return NULL;
  size_t copied = 0;
  if (napi_get_value_string_utf8(env, value, text, size + 1, &copied) !=
          napi_ok ||
      copied != size || strlen(text) != size) {
    free(text);
    return NULL;
  }
  return text;
}

static void free_vector(char **items) {
  if (!items) return;
  for (char **at = items; *at; at++) free(*at);
  free(items);
}

static char **copy_vector(napi_env env, napi_value value, size_t minimum) {
  bool array = false;
  uint32_t length = 0;
  if (napi_is_array(env, value, &array) != napi_ok || !array ||
      napi_get_array_length(env, value, &length) != napi_ok ||
      length < minimum || length > MAX_VECTOR)
    return NULL;
  char **items = calloc((size_t)length + 1, sizeof *items);
  if (!items) return NULL;
  for (uint32_t n = 0; n < length; n++) {
    napi_value item;
    if (napi_get_element(env, value, n, &item) != napi_ok ||
        !(items[n] = copy_string(env, item))) {
      free_vector(items);
      return NULL;
    }
  }
  return items;
}

static int prepare_spawn(posix_spawnattr_t *attrs,
                         posix_spawn_file_actions_t *actions, int stdin_fd) {
  sigset_t defaults, mask;
  sigfillset(&defaults);
  sigemptyset(&mask);
  int failed = posix_spawnattr_setflags(
      attrs, POSIX_SPAWN_SETSID | POSIX_SPAWN_CLOEXEC_DEFAULT |
                 POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK);
  failed = failed || posix_spawnattr_setsigdefault(attrs, &defaults);
  failed = failed || posix_spawnattr_setsigmask(attrs, &mask);
  failed = failed ||
           (stdin_fd >= 0
                ? posix_spawn_file_actions_adddup2(actions, stdin_fd, 0)
                : posix_spawn_file_actions_addopen(actions, 0, "/dev/null",
                                                   O_RDONLY, 0));
  failed = failed || posix_spawn_file_actions_addopen(actions, 1, "/dev/null",
                                                      O_WRONLY, 0);
  failed = failed || posix_spawn_file_actions_addopen(actions, 2, "/dev/null",
                                                      O_WRONLY, 0);
  return failed;
}

// Bounded private handoff. A failure leaves the child to fail its own
// bounded read; the handle is still returned because the child exists.
static void write_stdin(int fd, const char *data, size_t size) {
  int64_t deadline = now_ms() + DEADLINE_MS;
  size_t written = 0;
  while (written < size) {
    ssize_t n = write(fd, data + written, size - written);
    if (n > 0) {
      written += (size_t)n;
      continue;
    }
    if (n < 0 && errno == EINTR) continue;
    if (n < 0 && errno != EAGAIN) return;
    int64_t left = deadline - now_ms();
    if (left <= 0) return;
    struct pollfd ready = {fd, POLLOUT, 0};
    if (poll(&ready, 1, (int)left) < 0 && errno != EINTR) return;
  }
}

static bool open_pipe(int fds[2]) {
  if (pipe(fds) != 0) return false;
  bool ok = fcntl(fds[0], F_SETFD, FD_CLOEXEC) == 0 &&
            fcntl(fds[1], F_SETFD, FD_CLOEXEC) == 0 &&
            fcntl(fds[1], F_SETNOSIGPIPE, 1) == 0 &&
            fcntl(fds[1], F_SETFL, O_NONBLOCK) == 0;
  if (!ok) {
    close(fds[0]);
    close(fds[1]);
  }
  return ok;
}

// Wraps a fresh record; on failure the child is rolled back here, since no
// handle can be returned for it.
static napi_value make_handle(napi_env env, instance *inst, record *item) {
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
       napi_set_named_property(env, result, "pid", make_int(env, item->pid)) ==
           napi_ok;
  free(tok);
  if (ok) {
    item->delivered = true;
    return result;
  }
  bool cleaned = rollback_blocking(item->pid);
  if (cleaned) unlink_record(inst, item);
  throw_code(env, cleaned ? "ERR_OWNED_CHILD_SPAWN" : "ERR_OWNED_CHILD_CLEANUP",
             cleaned ? "Owned child could not be started."
                     : "Owned child cleanup did not complete.");
  return NULL;
}

// spawn(executable, argv, envPairs, stdin | null) -> { handle, pid }
static napi_value spawn_child(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  void *data = NULL;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, &data) != napi_ok ||
      argc != 4 || !data) {
    throw_code(env, "ERR_OWNED_CHILD_ARGUMENT", "Owned child call is invalid.");
    return NULL;
  }
  napi_valuetype stdin_type = napi_undefined;
  napi_typeof(env, argv[3], &stdin_type);
  char *executable = copy_string(env, argv[0]);
  char **args = copy_vector(env, argv[1], 1);
  char **environment = copy_vector(env, argv[2], 0);
  char *input = stdin_type == napi_null ? NULL : copy_string(env, argv[3]);
  bool valid = executable && executable[0] == '/' && args && environment &&
               (stdin_type == napi_null || (input && strlen(input) <= MAX_STDIN_BYTES));
  for (char **at = environment; valid && *at; at++)
    valid = strchr(*at, '=') != NULL && **at != '=';
  record *item = valid ? calloc(1, sizeof *item) : NULL;
  int fds[2] = {-1, -1};
  pid_t pid = 0;
  int spawn_error = -1;
  if (item && (!input || open_pipe(fds))) {
    posix_spawnattr_t attrs;
    posix_spawn_file_actions_t actions;
    if (posix_spawnattr_init(&attrs) == 0) {
      if (posix_spawn_file_actions_init(&actions) == 0) {
        if (!prepare_spawn(&attrs, &actions, fds[0]))
          spawn_error =
              posix_spawn(&pid, executable, &actions, &attrs, args, environment);
        posix_spawn_file_actions_destroy(&actions);
      }
      posix_spawnattr_destroy(&attrs);
    }
    if (fds[0] >= 0) close(fds[0]);
    if (spawn_error == 0 && input) write_stdin(fds[1], input, strlen(input));
    if (fds[1] >= 0) close(fds[1]);
  }
  free(executable);
  free_vector(args);
  free_vector(environment);
  free(input);
  if (spawn_error != 0 || pid <= 1) {
    free(item);
    throw_code(env, valid ? "ERR_OWNED_CHILD_SPAWN" : "ERR_OWNED_CHILD_ARGUMENT",
               valid ? "Owned child could not be started."
                     : "Owned child call is invalid.");
    return NULL;
  }
  instance *inst = data;
  item->serial = __atomic_add_fetch(&next_serial, 1, __ATOMIC_RELAXED);
  item->pid = pid;
  item->state = OWNED;
  item->next = inst->head;
  inst->head = item;
  return make_handle(env, inst, item);
}

// observe(handle) -> { state: 'running' | 'lost' } | { state: 'exited', code, signal }
static napi_value observe(napi_env env, napi_callback_info info) {
  instance *inst;
  record *item = handle_arg(env, info, &inst);
  if (!item) return NULL;
  siginfo_t status;
  switch (inspect_root(item->pid, &status)) {
    case ROOT_RUNNING:
      return make_state(env, "running");
    case ROOT_LOST:
      return make_state(env, "lost");
    case ROOT_EXITED:
      break;
  }
  napi_value out = make_state(env, "exited");
  bool exited = status.si_code == CLD_EXITED;
  bool killed = status.si_code == CLD_KILLED || status.si_code == CLD_DUMPED;
  napi_set_named_property(env, out, "code",
                          exited ? make_int(env, status.si_status)
                                 : make_null(env));
  napi_set_named_property(env, out, "signal",
                          killed ? make_int(env, status.si_status)
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
  *state = inspect_root(item->pid, NULL);
  if (*state != ROOT_LOST) return true;
  throw_code(env, "ERR_OWNED_CHILD_LOST", "Owned child ownership was lost.");
  return false;
}

// stopGroup(handle): SIGKILL to the owned group of an unreaped root.
static napi_value stop_group(napi_env env, napi_callback_info info) {
  instance *inst;
  record *item = handle_arg(env, info, &inst);
  root_state root;
  if (!item || !require_owned(env, item) || !require_waitable(env, item, &root))
    return NULL;
  if (kill(-item->pid, SIGKILL) != 0 && errno != ESRCH) {
    throw_code(env, "ERR_OWNED_CHILD_SIGNAL", "Owned child could not be signaled.");
    return NULL;
  }
  return make_bool(env, true);
}

// members(handle) -> live group members other than the root.
static napi_value members(napi_env env, napi_callback_info info) {
  instance *inst;
  record *item = handle_arg(env, info, &inst);
  root_state root;
  if (!item || !require_waitable(env, item, &root)) return NULL;
  int count = group_members(item->pid);
  if (count < 0) {
    throw_code(env, "ERR_OWNED_CHILD_ENUMERATION",
               "Owned child group could not be enumerated.");
    return NULL;
  }
  return make_int(env, count);
}

// release(handle) -> true once reaped; false while the root runs or, for an
// uncommitted handle, while its group has members.
static napi_value release(napi_env env, napi_callback_info info) {
  instance *inst;
  record *item = handle_arg(env, info, &inst);
  root_state root;
  if (!item || !require_waitable(env, item, &root)) return NULL;
  if (root != ROOT_EXITED) return make_bool(env, false);
  if (item->state == OWNED) {
    int count = group_members(item->pid);
    if (count < 0) {
      throw_code(env, "ERR_OWNED_CHILD_ENUMERATION",
                 "Owned child group could not be enumerated.");
      return NULL;
    }
    if (count > 0) return make_bool(env, false);
  }
  if (!reap(item->pid)) {
    throw_code(env, "ERR_OWNED_CHILD_LOST", "Owned child ownership was lost.");
    return NULL;
  }
  unlink_record(inst, item);
  return make_bool(env, true);
}

// commit(handle): drops kill authority; the root stays reapable. An exited
// root is refused: its surviving group must be rolled back, not disowned.
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
  item->state = COMMITTED;
  return make_bool(env, true);
}

// rollbackSync(handle) -> true once the group is gone and the root reaped.
// Blocks up to the deadline; for host exit, where no timer can run.
static napi_value rollback_sync(napi_env env, napi_callback_info info) {
  instance *inst;
  record *item = handle_arg(env, info, &inst);
  if (!item || !require_owned(env, item)) return NULL;
  if (!rollback_blocking(item->pid)) return make_bool(env, false);
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
      if (rollback_blocking(item->pid)) unlink_record(inst, item);
      else complete = false;
    }
    item = next;
  }
  return make_bool(env, complete);
}

NAPI_MODULE_INIT() {
  instance *inst = calloc(1, sizeof *inst);
  if (!inst || napi_add_env_cleanup_hook(env, env_cleanup, inst) != napi_ok) {
    free(inst);
    throw_code(env, "ERR_OWNED_CHILD_LOAD", "Owned child support is unavailable.");
    return NULL;
  }
  napi_property_descriptor methods[] = {
      {"spawn", NULL, spawn_child, NULL, NULL, NULL, napi_enumerable, inst},
      {"observe", NULL, observe, NULL, NULL, NULL, napi_enumerable, inst},
      {"stopGroup", NULL, stop_group, NULL, NULL, NULL, napi_enumerable, inst},
      {"members", NULL, members, NULL, NULL, NULL, napi_enumerable, inst},
      {"release", NULL, release, NULL, NULL, NULL, napi_enumerable, inst},
      {"commit", NULL, commit, NULL, NULL, NULL, napi_enumerable, inst},
      {"rollbackSync", NULL, rollback_sync, NULL, NULL, NULL, napi_enumerable,
       inst},
      {"rollbackUndelivered", NULL, rollback_undelivered, NULL, NULL, NULL,
       napi_enumerable, inst},
  };
  // On failure the hook stays: it frees the empty instance at teardown.
  if (napi_define_properties(env, exports, sizeof methods / sizeof *methods,
                             methods) != napi_ok)
    return NULL;
  return exports;
}
