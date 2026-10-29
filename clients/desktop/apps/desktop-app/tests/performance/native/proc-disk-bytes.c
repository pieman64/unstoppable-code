/* Harness-only macOS collector. Legacy <root-pid> keeps disk protocol v1.
 * --resources <root-pid> discovers a tree; --identities [pid:sec.usec ...]
 * samples explicit identities (including reparented processes), without discovery.
 * Resource protocol v2 adds q pid start quantity status value domain code stage
 * cleanup-mach-code.
 * Process row (unchanged from v1): p pid ppid start state resident footprint user-ns
 * system-ns idle-wakeups interrupt-wakeups read-bytes written-bytes name.
 * Unknown counters are '-'; e pid expected-start stage errno; t count capacity;
 * end marks a complete response. RSS/physical footprint are not private bytes.
 */
#include <errno.h>
#include <limits.h>
#include <libproc.h>
#include <mach/mach.h>
#include <mach_debug/ipc_info.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc.h>
#include <sys/proc_info.h>
#include <sys/resource.h>

#ifndef MAX_PIDS
#define MAX_PIDS 16384
#endif
#define MAX_IDENTITIES 1024

static int resources;

struct quantity { unsigned long long value; int code; const char *domain; const char *stage; int cleanup_code; };

/* Count returned descriptors, not pbi_nfiles (descriptor-table capacity). */
static struct quantity open_fds(pid_t pid) {
  const int capacity = 65536 * sizeof(struct proc_fdinfo);
  void *fds = malloc(capacity);
  if (!fds) return (struct quantity){0, ENOMEM, "errno", "proc_pidlistfds", 0};
  errno = 0;
  int bytes = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, fds, capacity);
  int code = errno;
  free(fds);
  if (bytes < 0 || (!bytes && code))
    return (struct quantity){0, code ? code : EIO, "errno", "proc_pidlistfds", 0};
  if (bytes >= capacity) return (struct quantity){0, EOVERFLOW, "errno", "proc_pidlistfds", 0};
  if (bytes % sizeof(struct proc_fdinfo)) return (struct quantity){0, EIO, "errno", "proc_pidlistfds", 0};
  return (struct quantity){bytes / sizeof(struct proc_fdinfo), 0, "errno", "proc_pidlistfds", 0};
}

static struct quantity port_names(pid_t pid) {
  mach_port_t task = MACH_PORT_NULL;
  kern_return_t code = task_for_pid(mach_task_self(), pid, &task);
  if (code != KERN_SUCCESS) return (struct quantity){0, code, "mach", "task_for_pid", 0};
  ipc_info_space_basic_t info = {0};
  code = mach_port_space_basic_info(task, &info);
  kern_return_t cleanup = mach_port_deallocate(mach_task_self(), task);
  int cleanup_code = code == KERN_SUCCESS ? 0 : cleanup;
  const char *stage = "mach_port_space_basic_info";
  if (code == KERN_SUCCESS && cleanup != KERN_SUCCESS) {
    code = cleanup;
    stage = "mach_port_deallocate";
  }
  return (struct quantity){info.iisb_table_inuse, code, "mach", stage,
    cleanup_code};
}

static void quantity_row(pid_t pid, const char *start, const char *name,
                         struct quantity q, int zombie) {
  const char *status = zombie ? "unavailable" : !q.code ? "ok" :
    ((q.code == ENOTSUP && !strcmp(q.domain, "errno")) ||
     (q.code == KERN_NOT_SUPPORTED && !strcmp(q.domain, "mach"))) ? "unsupported" : "error";
  printf("q\t%d\t%s\t%s\t%s\t", pid, start, name, status);
  if (!strcmp(status, "ok")) printf("%llu", q.value);
  else printf("-");
  printf("\t%s\t%d\t%s\t%d\n", zombie ? "process" : q.domain, zombie ? 0 : q.code,
         zombie ? "zombie" : q.stage, zombie ? 0 : q.cleanup_code);
}

static int bsd_info(pid_t pid, struct proc_bsdinfo *info) {
  errno = 0;
  int size = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, info, sizeof(*info));
  if (size == (int)sizeof(*info)) return 0;
  if (!errno) errno = EIO;
  return -1;
}

static void start_id(const struct proc_bsdinfo *info, char *out) {
  snprintf(out, 64, "%llu.%06llu", (unsigned long long)info->pbi_start_tvsec,
           (unsigned long long)info->pbi_start_tvusec);
}

static void failure(pid_t pid, const char *start, const char *stage, int code) {
  if (resources) printf("e\t%d\t%s\t%s\t%d\n", pid, start, stage, code);
  else printf("e\t%d\t%d\n", pid, code);
}

static int parse_identity(const char *text, pid_t *pid, char *start,
                          int explicit_identity) {
  char *end;
  errno = 0;
  long value = strtol(text, &end, 10);
  if (errno || text == end || value <= 0 || value > INT_MAX ||
      strspn(text, "0123456789") != (size_t)(end - text)) return -1;
  *pid = (pid_t)value;
  if (!explicit_identity) return *end ? -1 : 0;
  if (*end++ != ':') return -1;
  const char *seconds = end;
  if (strspn(seconds, "0123456789") == 0) return -1;
  errno = 0;
  unsigned long long sec = strtoull(seconds, &end, 10);
  if (errno || *end++ != '.') return -1;
  if (strlen(end) != 6 || strspn(end, "0123456789") != 6) return -1;
  snprintf(start, 64, "%llu.%s", sec, end);
  return 0;
}

static void sample(pid_t pid, const struct proc_bsdinfo *before,
                   const char *expected) {
  char start[64];
  start_id(before, start);
  if (expected && strcmp(expected, start)) {
    failure(pid, expected, "identity_mismatch", ESTALE);
    return;
  }
  struct rusage_info_v2 usage = {0};
  errno = 0;
  int usage_error = proc_pid_rusage(pid, RUSAGE_INFO_V2,
                                   (rusage_info_t *)&usage) ? (errno ? errno : EIO) : 0;
  if (usage_error) failure(pid, start, "rusage", usage_error);
  struct quantity fds = {0, ESRCH, "errno", "proc_pidlistfds", 0}, ports = {0, KERN_FAILURE, "mach", "task_for_pid", 0};
  if (resources && before->pbi_status != SZOMB) {
    fds = open_fds(pid);
    ports = port_names(pid);
  }
  struct proc_bsdinfo after;
  if (bsd_info(pid, &after)) {
    failure(pid, start, "revalidate", errno);
    return;
  }
  char actual[64];
  start_id(&after, actual);
  if (strcmp(start, actual)) {
    failure(pid, start, "identity_changed", ESTALE);
    return;
  }
  int zombie = after.pbi_status == SZOMB;
  if (!resources && (usage_error || zombie)) {
    if (zombie) failure(pid, start, "zombie", ESRCH);
    return;
  }
  char name[2 * MAXCOMLEN + 1];
  snprintf(name, sizeof(name), "%s", after.pbi_name[0] ? after.pbi_name : after.pbi_comm);
  for (char *cursor = name; *cursor; cursor++) {
    if (*cursor == '\t' || *cursor == '\n' || *cursor == '\r') *cursor = ' ';
  }
  printf("p\t%d\t%d\t%s\t", pid, after.pbi_ppid, start);
  if (resources) {
    printf("%s\t", zombie ? "zombie" : "live");
    if (usage_error || zombie) printf("-\t-\t-\t-\t-\t-\t-\t-\t");
    else printf("%llu\t%llu\t%llu\t%llu\t%llu\t%llu\t%llu\t%llu\t",
                (unsigned long long)usage.ri_resident_size,
                (unsigned long long)usage.ri_phys_footprint,
                (unsigned long long)usage.ri_user_time,
                (unsigned long long)usage.ri_system_time,
                (unsigned long long)usage.ri_pkg_idle_wkups,
                (unsigned long long)usage.ri_interrupt_wkups,
                (unsigned long long)usage.ri_diskio_bytesread,
                (unsigned long long)usage.ri_diskio_byteswritten);
  } else printf("%llu\t%llu\t", (unsigned long long)usage.ri_diskio_bytesread,
                (unsigned long long)usage.ri_diskio_byteswritten);
  printf("%s\n", name);
  if (resources) {
    quantity_row(pid, start, "openFileDescriptors", fds, zombie);
    quantity_row(pid, start, "machIpcInUseNameEntries", ports, zombie);
  }
}

int main(int argc, char **argv) {
  int explicit_identity = argc >= 2 && !strcmp(argv[1], "--identities");
  resources = explicit_identity || (argc >= 2 && !strcmp(argv[1], "--resources"));
  static pid_t pids[MAX_PIDS];
  static struct proc_bsdinfo infos[MAX_PIDS];
  static int info_errors[MAX_PIDS];
  static char included[MAX_PIDS];
  static char starts[MAX_IDENTITIES][64];
  int count;
  pid_t root = 0;
  if (explicit_identity) {
    count = argc - 2;
    if (count > MAX_IDENTITIES || count > MAX_PIDS) return 2;
    for (int i = 0; i < count; i++) {
      if (parse_identity(argv[i + 2], &pids[i], starts[i], 1)) return 2;
      for (int j = 0; j < i; j++) if (pids[i] == pids[j]) return 2;
    }
  } else {
    int root_arg = resources ? 2 : 1;
    if (argc != root_arg + 1 || parse_identity(argv[root_arg], &root, NULL, 0)) {
      fprintf(stderr, "usage: %s <root-pid> | --resources <root-pid> | --identities [pid:sec.usec ...]\n", argv[0]);
      return 2;
    }
    /* proc_listallpids returns a count, not bytes. A full buffer is uncertain. */
    count = proc_listallpids(pids, (int)sizeof(pids));
    if (count <= 0) {
      fprintf(stderr, "proc_listallpids failed: %s\n", strerror(errno));
      return 1;
    }
  }
  printf(resources ? "proc-resources\t2\n" : "proc-disk-bytes\t1\n");
  if (count >= MAX_PIDS) {
    printf("t\t%d\t%d\n", count, MAX_PIDS);
    count = MAX_PIDS;
  }
  int root_index = -1;
  for (int i = 0; i < count; i++) {
    if (pids[i] <= 0) continue;
    if (bsd_info(pids[i], &infos[i])) info_errors[i] = errno;
    if (pids[i] == root) root_index = i;
    included[i] = explicit_identity;
  }
  if (!explicit_identity) {
    if (root_index < 0) failure(root, "-", "root_missing", ESRCH);
    else included[root_index] = 1;
    int changed = 1;
    while (changed) {
      changed = 0;
      for (int i = 0; i < count; i++) {
        if (included[i] || info_errors[i]) continue;
        for (int j = 0; j < count; j++) {
          if (included[j] && pids[j] == (pid_t)infos[i].pbi_ppid) {
            included[i] = 1;
            changed = 1;
            break;
          }
        }
      }
    }
  }
  for (int i = 0; i < count; i++) {
    /* Resource discovery retains unknown membership; legacy disk stays tree-scoped. */
    if (pids[i] <= 0) continue;
    if (info_errors[i]) {
      if (resources || included[i])
        failure(pids[i], explicit_identity ? starts[i] : "-", "bsd_info", info_errors[i]);
    } else if (included[i]) sample(pids[i], &infos[i], explicit_identity ? starts[i] : NULL);
  }
  if (resources) printf("end\n");
  return 0;
}
