#ifndef CANOPY_DARWIN_ACL_OPERATION_H
#define CANOPY_DARWIN_ACL_OPERATION_H
#include <fcntl.h>
#include <sys/acl.h>
#include <sys/attr.h>
#include <sys/stat.h>
#include <stddef.h>
#include <stdint.h>
#include <unistd.h>

#define ACL_BUFFER_BYTES 65536
#define ACL_ENTRY_CEILING 1024
#define ACL_PAYLOAD (ATTR_CMN_DEVID | ATTR_CMN_EXTENDED_SECURITY | ATTR_CMN_FILEID)

/* getattrlist packs attributes on four-byte boundaries, including uint64_t. */
#pragma pack(push, 4)
struct acl_attributes {
    uint32_t length;
    attribute_set_t returned;
    dev_t device;
    attrreference_t security;
    uint64_t file_id;
};
#pragma pack(pop)

struct acl_operations {
    void *(*allocate)(size_t);
    void (*release)(void *);
    filesec_t (*sec_init)(void);
    void (*sec_free)(filesec_t);
    int (*sec_set)(filesec_t, filesec_property_t, const void *);
    int (*stat_fd)(int, struct stat *, filesec_t);
    int (*chmod_fd)(int, filesec_t);
    int (*sec_query)(filesec_t, filesec_property_t, int *);
    int (*sec_get)(filesec_t, filesec_property_t, void *);
    int (*valid_acl)(acl_t);
    int (*free_acl)(void *);
    int (*attributes)(int, struct attrlist *, void *, size_t, unsigned long);
    ssize_t (*write_fd)(int, const void *, size_t);
    int (*close_fd)(int);
    int (*ignore_sigpipe)(void);
};

int acl_count_witness(const unsigned char *, size_t, const struct stat *, int *);
int acl_helper_run(int, const char *const *, const struct acl_operations *);
#endif
