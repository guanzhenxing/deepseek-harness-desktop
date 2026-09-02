/*
 * lease-helper: minimal macOS process-identity and advisory-lock helper for
 * the desktop home lease. It never boots DSH, never writes profile data, and
 * never prints argv/env of other processes.
 *
 * Protocol: one JSON object per line on stdout; diagnostics on stderr.
 *
 *   lease-helper identity <pid>
 *       -> {"ok":true,"pid":N,"start":"<bootSec>.<bootUsec>-<startSec>.<startUsec>"}
 *       -> {"ok":false,"error":"unknown"} (permission or missing process)
 *
 *   lease-helper probe <pid> <start>
 *       -> {"ok":true,"status":"same"|"absent"|"different"|"unknown"}
 *
 *   lease-helper scan <excludePidCsv> <entryRealpathCsv>
 *       -> {"ok":true,"result":"none"}
 *       -> {"ok":true,"result":"active","pid":N,"start":"..."}
 *       -> {"ok":true,"result":"unknown"}
 *
 *   lease-helper lock <guardPath> <parentDir> <parentDev> <parentIno> <retryMs>
 *       -> {"ok":true,"locked":true}   then holds flock(LOCK_EX) until stdin
 *          closes or a "release" line arrives, and exits 0.
 *       -> {"ok":false,"error":"busy"|"refused"}
 *
 * The helper exits non-zero on usage errors. On non-macOS builds it reports
 * "unsupported" so callers can degrade to injected probes.
 */

#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/sysctl.h>
#include <sys/types.h>
#include <unistd.h>

#if defined(__APPLE__)
#include <libproc.h>
#endif

static void print_result(const char *json) {
    if (printf("%s\n", json) < 0) exit(1);
    if (fflush(stdout) != 0) exit(1);
}

static void fail(const char *error) {
    if (strcmp(error, "refused") == 0 || strcmp(error, "unsupported") == 0 ||
        strcmp(error, "busy") == 0 || strcmp(error, "unknown") == 0) {
        printf("{\"ok\":false,\"error\":\"%s\"}\n", error);
    } else {
        /* Non-protocol diagnostics never leak into machine-readable output. */
        print_result("{\"ok\":false,\"error\":\"internal\"}");
    }
    fprintf(stderr, "lease-helper: %s\n", error);
    fflush(stdout);
    exit(1);
}

#if defined(__APPLE__)

#define PATH_BUFFER_SIZE PROC_PIDPATHINFO_MAXSIZE

static bool boot_identity(char *out, size_t capacity) {
    struct timeval boottime;
    size_t length = sizeof(boottime);
    int mib[2] = {CTL_KERN, KERN_BOOTTIME};
    if (sysctl(mib, 2, &boottime, &length, NULL, 0) != 0) return false;
    int written = snprintf(out, capacity, "%" PRIdMAX ".%06d",
                           (intmax_t)boottime.tv_sec, (int)boottime.tv_usec);
    return written > 0 && (size_t)written < capacity;
}

static bool process_identity(pid_t pid, char *out, size_t capacity) {
    struct proc_bsdinfo info;
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) <= 0) {
        return false;
    }
    if ((pid_t)info.pbi_pid != pid) return false;
    char boot[64];
    if (!boot_identity(boot, sizeof(boot))) return false;
    int written = snprintf(out, capacity, "%s-%" PRIdMAX ".%06" PRIdMAX,
                           boot, (intmax_t)info.pbi_start_tvsec,
                           (intmax_t)info.pbi_start_tvusec);
    return written > 0 && (size_t)written < capacity;
}

static int cmd_identity(const char *pidText) {
    char *end = NULL;
    long value = strtol(pidText, &end, 10);
    if (end == pidText || *end != '\0' || value <= 0) fail("invalid pid");
    char start[128];
    if (!process_identity((pid_t)value, start, sizeof(start))) {
        print_result("{\"ok\":false,\"error\":\"unknown\"}");
        return 1;
    }
    printf("{\"ok\":true,\"pid\":%ld,\"start\":\"%s\"}\n", value, start);
    return fflush(stdout) == 0 ? 0 : 1;
}

static int cmd_probe(const char *pidText, const char *expected) {
    char *end = NULL;
    long value = strtol(pidText, &end, 10);
    if (end == pidText || *end != '\0' || value <= 0) fail("invalid pid");
    char start[128];
    if (!process_identity((pid_t)value, start, sizeof(start))) {
        /* Distinguish "no such process" from "cannot look" (permissions). */
        struct proc_bsdinfo info;
        if (proc_pidinfo((pid_t)value, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) <= 0 &&
            (errno == ESRCH || errno == EINVAL)) {
            print_result("{\"ok\":true,\"status\":\"absent\"}");
        } else {
            print_result("{\"ok\":true,\"status\":\"unknown\"}");
        }
        return 0;
    }
    print_result(strcmp(start, expected) == 0
                     ? "{\"ok\":true,\"status\":\"same\"}"
                     : "{\"ok\":true,\"status\":\"different\"}");
    return 0;
}

static bool csv_contains(const char *csv, long value) {
    if (csv == NULL || csv[0] == '\0') return false;
    const char *cursor = csv;
    while (*cursor != '\0') {
        char *end = NULL;
        long item = strtol(cursor, &end, 10);
        if (end == cursor) return false;
        if (item == value) return true;
        cursor = (*end == ',') ? end + 1 : end;
    }
    return false;
}

static int cmd_scan(const char *excludeCsv, const char *entryCsv) {
    static int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0};
    size_t size = 0;
    if (sysctl(mib, 4, NULL, &size, NULL, 0) != 0) {
        print_result("{\"ok\":true,\"result\":\"unknown\"}");
        return 0;
    }
    struct kinfo_proc *processes = malloc(size);
    if (processes == NULL) fail("out of memory");
    if (sysctl(mib, 4, processes, &size, NULL, 0) != 0) {
        free(processes);
        print_result("{\"ok\":true,\"result\":\"unknown\"}");
        return 0;
    }
    size_t count = size / sizeof(struct kinfo_proc);
    uid_t selfUid = geteuid();
    pid_t selfPid = getpid();
    char path[PATH_BUFFER_SIZE];
    char resolved[PATH_BUFFER_SIZE];
    for (size_t index = 0; index < count; index += 1) {
        pid_t pid = processes[index].kp_proc.p_pid;
        uid_t uid = processes[index].kp_eproc.e_ucred.cr_uid;
        if (pid == selfPid || uid != selfUid) continue;
        /* Zombies have no executable to resolve and cannot be a live writer. */
        if (processes[index].kp_proc.p_stat == SZOMB) continue;
        if (csv_contains(excludeCsv, (long)pid)) continue;
        int length = proc_pidpath(pid, path, sizeof(path));
        if (length <= 0) {
            /* Same-uid process whose executable cannot be resolved: be honest
             * about inconclusive scans instead of guessing. */
            free(processes);
            print_result("{\"ok\":true,\"result\":\"unknown\"}");
            return 0;
        }
        path[length] = '\0';
        const char *cursor = entryCsv;
        while (cursor != NULL && *cursor != '\0') {
            const char *comma = strchr(cursor, ',');
            size_t entryLength = comma == NULL ? strlen(cursor) : (size_t)(comma - cursor);
            char entry[PATH_BUFFER_SIZE];
            if (entryLength >= sizeof(entry)) {
                entryLength = sizeof(entry) - 1;
            }
            memcpy(entry, cursor, entryLength);
            entry[entryLength] = '\0';
            if (strcmp(entry, path) == 0 ||
                (realpath(path, resolved) != NULL && strcmp(entry, resolved) == 0)) {
                char start[128];
                if (!process_identity(pid, start, sizeof(start))) {
                    free(processes);
                    print_result("{\"ok\":true,\"result\":\"unknown\"}");
                    return 0;
                }
                free(processes);
                printf("{\"ok\":true,\"result\":\"active\",\"pid\":%d,\"start\":\"%s\"}\n",
                       pid, start);
                fflush(stdout);
                return 0;
            }
            cursor = comma == NULL ? NULL : comma + 1;
        }
    }
    free(processes);
    print_result("{\"ok\":true,\"result\":\"none\"}");
    return 0;
}

static int cmd_lock(const char *guardPath, const char *parentDir,
                    const char *parentDevText, const char *parentInoText,
                    const char *retryMsText) {
    struct stat parent;
    if (lstat(parentDir, &parent) != 0 || !S_ISDIR(parent.st_mode)) fail("refused");
    if ((uintmax_t)parent.st_dev != strtoumax(parentDevText, NULL, 10) ||
        (uintmax_t)parent.st_ino != strtoumax(parentInoText, NULL, 10)) {
        fail("refused");
    }
    long retryMs = strtol(retryMsText, NULL, 10);
    if (retryMs < 0) retryMs = 0;
    int fd = open(guardPath, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (fd < 0) {
        /* O_NOFOLLOW rejection, missing parent, permission: never retry a
         * tampered or misplaced guard target. */
        fail("refused");
    }
    if (flock(fd, LOCK_EX | LOCK_NB) != 0) {
        if (retryMs == 0) {
            close(fd);
            print_result("{\"ok\":false,\"error\":\"busy\"}");
            return 3;
        }
        const long stepMs = 20;
        long waited = 0;
        while (flock(fd, LOCK_EX | LOCK_NB) != 0) {
            if (waited >= retryMs) {
                close(fd);
                print_result("{\"ok\":false,\"error\":\"busy\"}");
                return 3;
            }
            usleep((useconds_t)stepMs * 1000);
            waited += stepMs;
        }
    }
    struct stat held;
    if (fstat(fd, &held) != 0 || !S_ISREG(held.st_mode)) {
        close(fd);
        fail("refused");
    }
    print_result("{\"ok\":true,\"locked\":true}");
    char line[32];
    while (fgets(line, sizeof(line), stdin) != NULL) {
        if (strncmp(line, "release", 7) == 0) break;
    }
    close(fd);
    return 0;
}

int main(int argc, char **argv) {
    if (argc >= 3 && strcmp(argv[1], "identity") == 0 && argc == 3) {
        return cmd_identity(argv[2]);
    }
    if (argc == 4 && strcmp(argv[1], "probe") == 0) {
        return cmd_probe(argv[2], argv[3]);
    }
    if (argc == 4 && strcmp(argv[1], "scan") == 0) {
        return cmd_scan(argv[2], argv[3]);
    }
    if (argc == 7 && strcmp(argv[1], "lock") == 0) {
        return cmd_lock(argv[2], argv[3], argv[4], argv[5], argv[6]);
    }
    fail("usage");
    return 1;
}

#else

int main(void) {
    fail("unsupported");
    return 1;
}

#endif
