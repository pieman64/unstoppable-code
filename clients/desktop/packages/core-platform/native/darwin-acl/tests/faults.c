/* Unshipped: links operation.c, never main.c or a staged bin directory. */
#include "../operation.h"
#include <assert.h>
#include <errno.h>
#include <limits.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/kauth.h>
#include <sys/mman.h>
#ifdef NDEBUG
#error "assertions carry this harness's side effects and checks"
#endif

static const struct stat sample = {.st_dev = -7, .st_ino = UINT64_MAX - 1};
static const size_t header = offsetof(struct kauth_filesec, fsec_acl) + offsetof(struct kauth_acl, acl_ace);
static const size_t count_at = offsetof(struct kauth_filesec, fsec_acl) + offsetof(struct kauth_acl, acl_entrycount);
static void build(unsigned char *buffer, const struct stat *sb, uint32_t full,
                  uint32_t start, uint32_t slice, uint32_t count) {
    struct acl_attributes fixed = {0};
    fixed.length = full;
    fixed.returned.commonattr = ACL_PAYLOAD;
    fixed.device = sb->st_dev;
    fixed.security.attr_dataoffset = (int32_t)(start - offsetof(struct acl_attributes, security));
    fixed.security.attr_length = slice;
    fixed.file_id = sb->st_ino;
    memset(buffer, 0, ACL_BUFFER_BYTES);
    memcpy(buffer, &fixed, sizeof(fixed));
    uint32_t magic = KAUTH_FILESEC_MAGIC;
    memcpy(buffer + start, &magic, sizeof(magic));
    memcpy(buffer + start + count_at, &count, sizeof(count));
}
static void payload(unsigned char *buffer, uint32_t count) {
    uint32_t slice = (uint32_t)(header + count * sizeof(struct kauth_ace));
    build(buffer, &sample, (uint32_t)sizeof(struct acl_attributes) + slice,
          sizeof(struct acl_attributes), slice, count);
}
static const unsigned char *guard_page;
static size_t guard_size;
/* SA_RESETHAND: a fault outside the guard page re-raises with the default action. */
static void guard_fault(int sig, siginfo_t *info, void *context) {
    (void)sig; (void)context;
    const unsigned char *at = info->si_addr;
    if (at < guard_page || at >= guard_page + guard_size) return;
    static const char message[] = "guard page: witness read past its capacity\n";
    (void)write(2, message, sizeof(message) - 1);
    _exit(86);
}
/* Runs the witness on a copy ending at a PROT_NONE page, so any over-read faults. */
static int guarded(const unsigned char *bytes, size_t n, const struct stat *sb, int *entries) {
    size_t page = (size_t)getpagesize();
    assert(n <= page);
    unsigned char *base = mmap(NULL, 2 * page, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0);
    assert(base != MAP_FAILED && mprotect(base + page, page, PROT_NONE) == 0);
    memcpy(base + page - n, bytes, n);
    struct sigaction action = {.sa_sigaction = guard_fault, .sa_flags = SA_SIGINFO | SA_RESETHAND}, segv, bus;
    guard_page = base + page; guard_size = page;
    assert(sigemptyset(&action.sa_mask) == 0);
    assert(sigaction(SIGSEGV, &action, &segv) == 0 && sigaction(SIGBUS, &action, &bus) == 0);
    int rc = acl_count_witness(base + page - n, n, sb, entries);
    assert(sigaction(SIGSEGV, &segv, NULL) == 0 && sigaction(SIGBUS, &bus, NULL) == 0);
    assert(munmap(base, 2 * page) == 0);
    return rc;
}

static void parser_tests(void) {
    unsigned char buffer[ACL_BUFFER_BYTES];
    int entries = -9;
    const uint32_t counts[] = {0, 1, 128, 1024, 1025};
    for (size_t i = 0; i < sizeof(counts) / sizeof(counts[0]); i++) {
        payload(buffer, counts[i]);
        int rc = acl_count_witness(buffer, sizeof(buffer), &sample, &entries);
        assert((rc == 0) == (counts[i] <= ACL_ENTRY_CEILING));
        if (rc == 0) assert(entries == (int)counts[i]);
    }
    /* Each edit starts from a valid empty witness, not initialized zeros. */
    for (int fault = 0; fault < 30; fault++) {
        payload(buffer, 0);
        struct acl_attributes fixed;
        memcpy(&fixed, buffer, sizeof(fixed));
        uint32_t value = 0;
        switch (fault) {
            case 0: fixed.returned.commonattr &= ~ATTR_CMN_DEVID; break;
            case 1: fixed.returned.commonattr |= ATTR_CMN_NAME; break;
            case 2: fixed.returned.volattr = 1; break;
            case 3: fixed.returned.dirattr = 1; break;
            case 4: fixed.returned.fileattr = 1; break;
            case 5: fixed.returned.forkattr = 1; break;
            case 6: fixed.length = sizeof(fixed) - 1; break;
            case 7: fixed.length = ACL_BUFFER_BYTES + 1; break;
            case 8: fixed.security.attr_dataoffset = INT32_MIN; break;
            case 9: fixed.security.attr_dataoffset = INT32_MAX; break;
            case 10: fixed.security.attr_dataoffset = 0; break;
            case 11: fixed.security.attr_dataoffset++; break;
            case 12: fixed.security.attr_length = 0; break;
            case 13: fixed.security.attr_length = UINT32_MAX; break;
            case 14: fixed.security.attr_length = (uint32_t)header - 1; break;
            case 15: fixed.length--; break;
            case 16: fixed.device++; break;
            case 17: fixed.file_id++; break;
            case 18: value = KAUTH_FILESEC_NOACL; break;
            case 19: value = 1025; break;
            case 20: value = UINT32_MAX - 1; break;
            case 21: value = 1; break; /* ACE missing from slice */
            case 22: value = 0x6dc12c01; break; /* swapped magic */
            case 23: value = 0; break;
            case 24: fixed.returned.commonattr &= ~ATTR_CMN_FILEID; break;
            case 25: fixed.returned.commonattr &= ~ATTR_CMN_EXTENDED_SECURITY; break;
            case 26: fixed.security.attr_dataoffset = -4; break;
            case 27: fixed.length++; fixed.security.attr_length++; break;
            case 28: fixed.device ^= INT32_MIN; break; /* identity differs in the top bit only */
            case 29: fixed.file_id ^= 1ULL << 63; break;
        }
        memcpy(buffer, &fixed, sizeof(fixed));
        if (fault >= 18 && fault <= 21)
            memcpy(buffer + sizeof(fixed) + offsetof(struct kauth_filesec, fsec_acl), &value, sizeof(value));
        if (fault == 22 || fault == 23) memcpy(buffer + sizeof(fixed), &value, sizeof(value));
        entries = -9;
        assert(acl_count_witness(buffer, sizeof(buffer), &sample, &entries) != 0);
        assert(entries == -9);
    }
    payload(buffer, 0);
    uint32_t mask = ACL_PAYLOAD | ATTR_CMN_RETURNED_ATTRS;
    memcpy(buffer + offsetof(struct acl_attributes, returned), &mask, sizeof(mask));
    assert(acl_count_witness(buffer, sizeof(buffer), &sample, &entries) == 0);
    assert(guarded(buffer, 43, &sample, &entries) != 0);
    memset(buffer, 0, sizeof(buffer));
    assert(acl_count_witness(buffer, sizeof(buffer), &sample, &entries) != 0);
    /* Capacity is the reported full size. One rule decides each layout; magic
       is planted wherever a mutant would look. */
    const struct stat planted = {.st_dev = sample.st_dev, .st_ino = (uint64_t)KAUTH_FILESEC_MAGIC << 32 | 5};
    const uint32_t h = (uint32_t)header, ace = sizeof(struct kauth_ace);
    const struct { uint32_t full, start, slice, count; int accepted; } edges[] = {
        {44 + h, 44, h, 0, 1},                           /* full size equals capacity */
        {40 + h, 40, h, 0, 0},                           /* overlaps file_id's magic high word */
        {46 + h, 46, h, 0, 0},                           /* misaligned, in bounds */
        {44 + h, 200, h, 0, 0},                          /* aligned, beyond the full size */
        {64, 60, 4, 0, 0},                               /* slice ends at the allocation */
        {44 + h + 4 * ace - 4, 44, h + 4 * ace - 4, 4, 0}, /* final ACE short by 4 */
    };
    for (size_t i = 0; i < sizeof(edges) / sizeof(edges[0]); i++) {
        build(buffer, &planted, edges[i].full, edges[i].start, edges[i].slice, edges[i].count);
        entries = -9;
        int rc = guarded(buffer, edges[i].full, &planted, &entries);
        assert(edges[i].accepted ? rc == 0 && entries == 0 : rc != 0 && entries == -9);
    }
}

static const char *fault, *cleanup_fault;
static int sec_live, sec_created, sec_freed, acl_live, buffer_live, cleared;
static int target_closed, stdout_closed, writes, write_stopped, restrict_action;
static size_t output_size;
static char output[256];
static void *owned_buffer, *owned_acl;
static filesec_t owned_sec;
static int is(const char *name) {
    return strcmp(fault, name) == 0 || (cleanup_fault && strcmp(cleanup_fault, name) == 0);
}
static int failure(void) { errno = EIO; return -1; }
static void *allocate(size_t n) {
    assert(n == ACL_BUFFER_BYTES);
    if (is("allocation")) return NULL;
    buffer_live++; owned_buffer = malloc(n);
    return owned_buffer ? memset(owned_buffer, 0xA5, n) : NULL; /* dirty, as malloc may be */
}
static void release(void *p) { assert(buffer_live-- == 1 && p == owned_buffer); free(p); owned_buffer = NULL; }
static filesec_t sec_init(void) {
    if (is("init") || (is("inspect-init") && cleared)) return NULL;
    assert(sec_live++ == 0); sec_created++; return owned_sec = (filesec_t)malloc(1);
}
static void sec_free(filesec_t sec) { assert(sec_live-- == 1 && sec == owned_sec); sec_freed++; free(sec); owned_sec = NULL; }
static int sec_set(filesec_t sec, filesec_property_t p, const void *value) {
    assert(sec && p == FILESEC_ACL && value == _FILESEC_REMOVE_ACL && restrict_action);
    return is("set") ? failure() : 0;
}
static int chmod_fd(int fd, filesec_t sec) {
    assert(fd == 3 && sec && restrict_action); cleared++;
    return is("clear") ? failure() : 0;
}
static int stat_fd(int fd, struct stat *sb, filesec_t sec) {
    assert(fd == 3 && sec && sec_live == 1);
    assert(!restrict_action || (cleared == 1 && sec_freed == 1 && sec_created == 2));
    *sb = sample; return is("stat-denied") ? failure() : 0;
}
static int sec_query(filesec_t sec, filesec_property_t p, int *valid) {
    assert(sec && (p == FILESEC_MODE || p == FILESEC_ACL));
    /* libc reports its FS_VALID_* bit (MODE 16, ACL 32), not 1; main checks MODE. */
    *valid = (p == FILESEC_MODE ? is("mode-missing") : is("absent")) ? 0 : p == FILESEC_MODE ? 16 : 32;
    return is(p == FILESEC_MODE ? "mode-query" : "acl-query") ? failure() : 0;
}
static int sec_get(filesec_t sec, filesec_property_t p, void *result) {
    assert(sec && p == FILESEC_ACL);
    if (!is("null-acl")) { owned_acl = malloc(1); *(acl_t *)result = owned_acl; acl_live++; }
    return is("get") ? failure() : 0;
}
static int valid_acl(acl_t acl) { assert(acl && acl_live == 1); return is("valid") ? failure() : 0; }
static int free_acl(void *acl) { assert(acl_live-- == 1 && acl == owned_acl); free(acl); owned_acl = NULL; return is("acl-free") ? failure() : 0; }
static int attributes(int fd, struct attrlist *q, void *buffer, size_t n, unsigned long options) {
    assert(fd == 3 && n == ACL_BUFFER_BYTES && options == FSOPT_REPORT_FULLSIZE);
    assert(q->bitmapcount == ATTR_BIT_MAP_COUNT && !q->reserved);
    assert(q->commonattr == (ACL_PAYLOAD | ATTR_CMN_RETURNED_ATTRS));
    assert(!q->volattr && !q->dirattr && !q->fileattr && !q->forkattr);
    for (size_t i = 0; i < n; i++) assert(((unsigned char *)buffer)[i] == 0);
    payload(buffer, is("positive") ? 1 : 0);
    if (is("malformed")) memset(buffer, 0, n);
    if (is("oversize")) { uint32_t full = ACL_BUFFER_BYTES + 4; memcpy(buffer, &full, sizeof(full)); }
    return is("attributes-denied") ? failure() : 0;
}
static ssize_t write_fd(int fd, const void *bytes, size_t n) {
    assert(fd == 1 && !sec_live && !acl_live && !buffer_live && target_closed);
    assert(!write_stopped); /* only EINTR is retried */
    writes++;
    if (is("eintr") && writes == 1) { errno = EINTR; return -1; }
    write_stopped = 1;
    if (is("zero")) return 0;
    if (is("epipe") || (is("partial-epipe") && writes > 1)) { errno = EPIPE; return -1; }
    if ((is("short") || is("partial-epipe")) && n > 3) n = 3;
    assert(output_size + n < sizeof(output));
    memcpy(output + output_size, bytes, n); output_size += n;
    write_stopped = is("overlong");
    return (ssize_t)n + is("overlong");
}
static int close_fd(int fd) {
    assert(!sec_live && !acl_live && !buffer_live);
    if (fd == 3) { assert(!stdout_closed); target_closed++; }
    else { assert(fd == 1 && target_closed); stdout_closed++; }
    assert(target_closed <= 1 + is("target-eintr") && stdout_closed <= 1 + is("stdout-eintr"));
    if ((is("target-eintr") && fd == 3 && target_closed == 1) ||
        (is("stdout-eintr") && fd == 1 && stdout_closed == 1)) { errno = EINTR; return -1; }
    if (is(fd == 3 ? "target-close" : "stdout-close")) return failure();
    return 0;
}
static int ignore_sigpipe(void) { return is("signal") ? failure() : 0; }
static const struct acl_operations faults = {
    allocate, release, sec_init, sec_free, sec_set, stat_fd, chmod_fd,
    sec_query, sec_get, valid_acl, free_acl, attributes, write_fd, close_fd, ignore_sigpipe
};
static void run_pair(const char *name, const char *cleanup, int restrict_acl, int expected) {
    fault = name; cleanup_fault = cleanup; restrict_action = restrict_acl;
    sec_live = sec_created = sec_freed = acl_live = buffer_live = cleared = 0;
    target_closed = stdout_closed = writes = write_stopped = 0; output_size = 0;
    memset(output, 0, sizeof(output));
    const char *argv[] = {"helper", "--protocol=1", restrict_acl ? "restrict" : "verify"};
    int code = acl_helper_run(3, argv, &faults);
    assert(code == expected && target_closed && stdout_closed);
    assert(target_closed == (is("target-eintr") ? 2 : 1));
    assert(stdout_closed == (is("stdout-eintr") ? 2 : 1));
    assert(!sec_live && !acl_live && !buffer_live && sec_created == sec_freed);
    assert(!owned_sec && !owned_acl && !owned_buffer);
    if (code == 70) assert(output_size == 0);
    if (is("partial-epipe")) assert(output_size == 3);
    if (is("zero") || is("epipe")) assert(output_size == 0);
    if (code == 0 || (code == 74 && is("stdout-close") &&
        !is("zero") && !is("epipe") && !is("partial-epipe"))) {
        char wanted[160];
        snprintf(wanted, sizeof(wanted),
            "{\"v\":1,\"action\":\"%s\",\"st\":\"+f///wAAAAD+/////////wAAAAAAAAAA\",\"entries\":%s}\n",
            argv[2], is("absent") ? "null" : is("positive") ? "1" : "0");
        assert(strcmp(output, wanted) == 0);
    }
    assert(restrict_acl || !cleared);
    printf("%s/%s%s%s: %d\n", argv[2], name, cleanup ? "+" : "", cleanup ? cleanup : "", code);
}
static void run(const char *name, int restrict_acl, int expected) { run_pair(name, NULL, restrict_acl, expected); }
int main(int argc, char **argv) {
    /* Exec with the pipe reader already gone: exercise real product SIGPIPE/EPIPE. */
    if (argc == 2 || argc == 3) {
        int p[2];
        int destination = argc == 3 ? 2 : 1;
        assert(pipe(p) == 0);
        assert(close(p[0]) == 0 && dup2(p[1], destination) == destination && close(p[1]) == 0);
        execl(argv[1], argv[1], argc == 3 ? "--protocol=2" : "--protocol=1", "verify", (char *)NULL);
        return 99;
    }
    assert(argc == 1);
    setbuf(stdout, NULL);
    parser_tests();
    puts("parser: passed");
    filesec_t real = filesec_init();
    struct stat st;
    int fd = open("/", O_RDONLY), mode_valid = 0;
    assert(real && fd >= 0 && fstatx_np(fd, &st, real) == 0 && close(fd) == 0);
    assert(filesec_query_property(real, FILESEC_MODE, &mode_valid) == 0 && mode_valid == 16);
    filesec_free(real);
    const char *success[] = {"empty", "absent", "positive", "short", "eintr", "target-eintr", "stdout-eintr"};
    const char *native[] = {"init", "stat-denied", "mode-query", "mode-missing", "acl-query", "get", "null-acl", "valid", "allocation", "attributes-denied", "malformed", "oversize", "acl-free", "target-close", "signal"};
    for (int action = 0; action < 2; action++) {
        for (size_t i = 0; i < sizeof(success) / sizeof(success[0]); i++) run(success[i], action, 0);
        for (size_t i = 0; i < sizeof(native) / sizeof(native[0]); i++) run(native[i], action, 70);
        run("zero", action, 74); run("epipe", action, 74); run("partial-epipe", action, 74); run("stdout-close", action, 74);
        run("overlong", action, 74);
        run_pair("eintr", "zero", action, 74); run_pair("eintr", "epipe", action, 74);
        run_pair("short", "eintr", action, 0);
        const char *primary[] = {"get", "valid", "attributes-denied", "malformed"};
        const char *cleanup[] = {"acl-free", "target-close", "stdout-close"};
        for (size_t i = 0; i < sizeof(primary) / sizeof(primary[0]); i++)
            for (size_t j = 0; j < sizeof(cleanup) / sizeof(cleanup[0]); j++)
                run_pair(primary[i], cleanup[j], action, 70);
        run_pair("acl-free", "target-close", action, 70);
        run_pair("target-close", "stdout-close", action, 70);
        run_pair("partial-epipe", "stdout-close", action, 74);
    }
    run("set", 1, 70); run("clear", 1, 70); run("inspect-init", 1, 70);
    return 0;
}
