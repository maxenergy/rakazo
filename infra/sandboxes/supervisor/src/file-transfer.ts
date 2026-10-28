/** Scripts run inside the computer, where the file descriptors live. */
export function fileReadScript(noFollow: boolean) {
  return [
    "import base64, os, stat, sys",
    "target, limit = sys.argv[1], int(sys.argv[2])",
    ...(noFollow
      ? [
          "parent = os.path.realpath(os.path.dirname(target))",
          "if os.path.commonpath([parent, '/home/rakazo']) != '/home/rakazo': sys.exit(43)",
          "fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)",
          "info = os.fstat(fd)",
          "if not stat.S_ISREG(info.st_mode): os.close(fd); sys.exit(43)",
          "resolved = os.path.realpath('/proc/self/fd/' + str(fd))",
          "if os.path.commonpath([resolved, '/home/rakazo']) != '/home/rakazo': os.close(fd); sys.exit(43)",
          "if limit >= 0 and info.st_size > limit: os.close(fd); sys.exit(42)",
          "source = os.fdopen(fd, 'rb')",
        ]
      : ["source = open(target, 'rb')"]),
    "with source:",
    "  content = source.read() if limit < 0 else source.read(limit + 1)",
    "if limit >= 0 and len(content) > limit: sys.exit(42)",
    "sys.stdout.write(base64.b64encode(content).decode())",
  ].join("\n");
}

export function fileWriteScript(exclusive: boolean, executable = false) {
  return exclusive
    ? [
        "parent = os.path.realpath(os.path.dirname(target))",
        "if os.path.commonpath([parent, '/home/rakazo']) != '/home/rakazo': sys.exit(43)",
        "directory = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)",
        "try:",
        "  fd = os.open(os.path.basename(target), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)",
        "  with os.fdopen(fd, 'wb') as f:",
        "    f.write(sys.stdin.buffer.read())",
        `    os.fchmod(f.fileno(), ${executable ? "0o700" : "0o600"})`,
        "finally: os.close(directory)",
      ].join("\n")
    : "with open(target, 'wb') as f: f.write(sys.stdin.buffer.read())";
}
