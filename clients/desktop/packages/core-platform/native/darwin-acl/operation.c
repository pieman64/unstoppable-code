#include "operation.h"
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/kauth.h>

_Static_assert(sizeof(dev_t) == 4 && sizeof(ino_t) == 8, "SDK identity sizes");
_Static_assert(sizeof(attribute_set_t) == 20 && sizeof(attrreference_t) == 8,
               "SDK attribute sizes");
_Static_assert(offsetof(struct acl_attributes, returned) == 4 &&
               offsetof(struct acl_attributes, device) == 24 &&
               offsetof(struct acl_attributes, security) == 28 &&
               offsetof(struct acl_attributes, file_id) == 36 &&
               sizeof(struct acl_attributes) == 44, "SDK four-byte packing");

int acl_count_witness(const unsigned char *bytes, size_t capacity,
                      const struct stat *sb, int *entries) {
    struct acl_attributes fixed;
    if (capacity < sizeof(fixed)) return -1;
    attribute_set_t a;
    memcpy(&a, bytes + offsetof(struct acl_attributes, returned), sizeof(a));
    if ((a.commonattr & ~ATTR_CMN_RETURNED_ATTRS) != ACL_PAYLOAD ||
        a.volattr || a.dirattr || a.fileattr || a.forkattr) return -1;
    memcpy(&fixed, bytes, sizeof(fixed));
    if (fixed.length < sizeof(fixed) || fixed.length > capacity) return -1;
    int64_t start = (int64_t)offsetof(struct acl_attributes, security) +
                    (int64_t)fixed.security.attr_dataoffset;
    size_t length = fixed.security.attr_length;
    const size_t header = offsetof(struct kauth_filesec, fsec_acl) +
                          offsetof(struct kauth_acl, acl_ace);
    if (start < (int64_t)sizeof(fixed) || start % 4 ||
        (uint64_t)start > fixed.length || length < header || length % 4 ||
        length > fixed.length - (size_t)start) return -1;
    uint32_t magic, count;
    memcpy(&magic, bytes + start + offsetof(struct kauth_filesec, fsec_magic), sizeof(magic));
    memcpy(&count, bytes + start + offsetof(struct kauth_filesec, fsec_acl) +
           offsetof(struct kauth_acl, acl_entrycount), sizeof(count));
    if (magic != KAUTH_FILESEC_MAGIC || count == KAUTH_FILESEC_NOACL ||
        count > ACL_ENTRY_CEILING ||
        count > (SIZE_MAX - header) / sizeof(struct kauth_ace) ||
        header + count * sizeof(struct kauth_ace) > length ||
        fixed.device != sb->st_dev || fixed.file_id != sb->st_ino) return -1;
    *entries = (int)count;
    return 0;
}

static int has(const struct acl_operations *o, filesec_t sec,
               filesec_property_t property, int *valid) {
    *valid = 0;
    return o->sec_query(sec, property, valid);
}

static int inspect(const struct acl_operations *o, int restrict_acl,
                   struct stat *sb, int *entries) {
    filesec_t sec = NULL;
    acl_t acl = NULL;
    unsigned char *buffer = NULL;
    int result = -1, valid = 0;
    if (restrict_acl) {
        sec = o->sec_init();
        if (!sec) goto done;
        if (o->sec_set(sec, FILESEC_ACL, _FILESEC_REMOVE_ACL) != 0 ||
            o->chmod_fd(3, sec) != 0) goto done;
        o->sec_free(sec);
        sec = NULL;
    }
    sec = o->sec_init();
    if (!sec || o->stat_fd(3, sb, sec) != 0 ||
        has(o, sec, FILESEC_MODE, &valid) != 0 || !valid ||
        has(o, sec, FILESEC_ACL, &valid) != 0) goto done;
    *entries = -1;
    if (valid) {
        if (o->sec_get(sec, FILESEC_ACL, &acl) != 0 || !acl ||
            o->valid_acl(acl) != 0) goto done;
        buffer = o->allocate(ACL_BUFFER_BYTES);
        if (!buffer) goto done;
        memset(buffer, 0, ACL_BUFFER_BYTES);
        struct attrlist query = {0};
        query.bitmapcount = ATTR_BIT_MAP_COUNT;
        query.commonattr = ATTR_CMN_RETURNED_ATTRS | ACL_PAYLOAD;
        if (o->attributes(3, &query, buffer, ACL_BUFFER_BYTES, FSOPT_REPORT_FULLSIZE) != 0 ||
            acl_count_witness(buffer, ACL_BUFFER_BYTES, sb, entries) != 0) goto done;
    }
    result = 0;
done:
    if (buffer) o->release(buffer);
    if (acl && o->free_acl(acl) != 0) result = -1;
    if (sec) o->sec_free(sec);
    return result;
}

static int close_checked(const struct acl_operations *o, int fd) {
    int rc;
    do { rc = o->close_fd(fd); } while (rc < 0 && errno == EINTR);
    return rc;
}

static void identity(const struct stat *sb, char output[33]) {
    unsigned char st[24] = {0};
    uint32_t device = (uint32_t)sb->st_dev;
    uint64_t inode = sb->st_ino;
    for (size_t i = 0; i < 4; i++) st[i] = (unsigned char)(device >> (8 * i));
    for (size_t i = 0; i < 8; i++) st[8 + i] = (unsigned char)(inode >> (8 * i));
    const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    for (size_t i = 0, j = 0; i < sizeof(st); i += 3) {
        uint32_t n = ((uint32_t)st[i] << 16) | ((uint32_t)st[i + 1] << 8) | st[i + 2];
        output[j++] = alphabet[n >> 18]; output[j++] = alphabet[(n >> 12) & 63];
        output[j++] = alphabet[(n >> 6) & 63]; output[j++] = alphabet[n & 63];
    }
    output[32] = '\0';
}

int acl_helper_run(int argc, const char *const *argv, const struct acl_operations *o) {
    int code = 64;
    struct stat sb = {0};
    int entries = -1;
    int usage = argc != 3 || strcmp(argv[1], "--protocol=1") ||
                (strcmp(argv[2], "verify") && strcmp(argv[2], "restrict"));
    int signal_ready = o->ignore_sigpipe() == 0;
    if (!usage) {
        code = 70;
        if (signal_ready &&
            inspect(o, !strcmp(argv[2], "restrict"), &sb, &entries) == 0) code = 0;
    }
    if (close_checked(o, 3) != 0 && code == 0) code = 70;
    if (code == 0) {
        char st[33], count[16], line[160];
        identity(&sb, st);
        if (entries < 0) memcpy(count, "null", 5);
        else snprintf(count, sizeof(count), "%d", entries);
        int length = snprintf(line, sizeof(line),
            "{\"v\":1,\"action\":\"%s\",\"st\":\"%s\",\"entries\":%s}\n", argv[2], st, count);
        if (length < 0 || (size_t)length >= sizeof(line)) code = 74;
        else for (size_t sent = 0; sent < (size_t)length;) {
            ssize_t n = o->write_fd(1, line + sent, (size_t)length - sent);
            if (n < 0 && errno == EINTR) continue;
            if (n <= 0 || (size_t)n > (size_t)length - sent) { code = 74; break; }
            sent += (size_t)n;
        }
    }
    if (close_checked(o, 1) != 0 && code == 0) code = 74;
    return code;
}
