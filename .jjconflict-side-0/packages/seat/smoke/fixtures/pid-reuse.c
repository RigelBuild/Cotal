/*
 * Seat child for the "a reused pid is never signalled" cell. Run inside a fresh user+pid
 * namespace (the custodian is in it too). The child forks a CLONE_PARENT sibling, so the sibling's
 * parent is the custodian, then exits at once. The sibling waits until the child is reaped,
 * writes the child's pid minus one to ns_last_pid, and forks a second CLONE_PARENT process that
 * therefore takes the child's pid. That process records its pid and lives until SIGTERM/SIGKILL.
 *
 * usage: pid-reuse <dir>   writes <dir>/child.pid, then <dir>/reused.pid once the pid is retaken.
 */
#define _GNU_SOURCE
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <linux/sched.h>

static void put(const char *dir, const char *name, long pid) {
  char path[4096];
  snprintf(path, sizeof path, "%s/%s.tmp", dir, name);
  FILE *f = fopen(path, "w");
  if (!f) _exit(2);
  fprintf(f, "%ld\n", pid);
  fclose(f);
  char final[4096];
  snprintf(final, sizeof final, "%s/%s", dir, name);
  rename(path, final);
}

static pid_t clone_parent(void) {
  struct clone_args args;
  memset(&args, 0, sizeof args);
  args.flags = CLONE_PARENT;
  return (pid_t)syscall(SYS_clone3, &args, sizeof args);
}

int main(int argc, char **argv) {
  if (argc != 2) return 2;
  const char *dir = argv[1];
  pid_t child = getpid();
  /* The leader's exit hangs up its foreground group; only the startup SIGKILL may reach these. */
  signal(SIGHUP, SIG_IGN);
  put(dir, "child.pid", child);
  pid_t sibling = clone_parent();
  if (sibling < 0) return 3;
  if (sibling > 0) _exit(0); /* the seat child exits at once */

  /* sibling: leave the child's session and group, whose ids would otherwise keep its pid number in
   * use, then wait for the custodian to reap the child and retake its pid */
  if (setsid() < 0) _exit(8);
  char proc[64];
  snprintf(proc, sizeof proc, "/proc/%ld", (long)child);
  for (int i = 0; i < 4000 && access(proc, F_OK) == 0; i++) usleep(5000);
  if (access(proc, F_OK) == 0) _exit(4);
  /* The launcher's poll forks in this namespace too, so a retake can lose the race: retry it. */
  for (int attempt = 0; attempt < 2000; attempt++) {
    FILE *last = fopen("/proc/sys/kernel/ns_last_pid", "w");
    if (!last) _exit(5);
    fprintf(last, "%ld", (long)child - 1);
    fclose(last);
    pid_t reused = clone_parent();
    if (reused < 0) _exit(6);
    if (reused == 0) {
      if (getpid() != child) _exit(0);
      put(dir, "reused.pid", getpid());
      for (;;) pause();
    }
    if (reused == child) for (;;) pause();
    usleep(1000);
  }
  _exit(7);
}
