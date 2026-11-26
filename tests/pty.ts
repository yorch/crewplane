import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A command run on a genuine pseudo-terminal (python3's `pty` module, which
 * ubuntu-latest and macos-latest both ship): stdin and stdout are the tty,
 * stderr is a separate pipe. Expect-style: wait for text with a timeout, then
 * send keystrokes. No fixed sleeps; always `close()` in a finally block.
 */
const driver = join(dirname(fileURLToPath(import.meta.url)), "pty-driver.py");

/** A reason to skip the pty tests, or null when a pty is usable. */
export function ptyUnavailable(): string | null {
  const probe = spawnSync(
    "python3",
    [
      "-I",
      "-c",
      "import pty, os\nm, s = pty.openpty()\nos.close(m); os.close(s)",
    ],
    { encoding: "utf8", timeout: 15000 },
  );
  if (probe.error || probe.status !== 0)
    return `no usable python3 pty module on this host (${probe.error?.message ?? probe.stderr.trim()})`;
  return null;
}

export interface PtyExit {
  code: number | null;
  signal: number | null;
}

export class PtyProcess {
  /** Everything the child wrote to the terminal (its stdout), CRLF as seen. */
  tty = "";
  /** Everything the child wrote to its stderr pipe. */
  stderr = "";
  exit: PtyExit | null = null;
  private child: ChildProcess;
  private buffer = "";
  private waiters = new Set<() => void>();
  private dead = false;

  constructor(
    argv: string[],
    options: { cwd: string; env: Record<string, string> },
  ) {
    this.child = spawn(
      "python3",
      ["-I", driver, JSON.stringify({ argv, ...options })],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => {
      this.buffer += chunk;
      let newline = this.buffer.indexOf("\n");
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        newline = this.buffer.indexOf("\n");
        if (!line.trim()) continue;
        const event = JSON.parse(line) as {
          t: string;
          d?: string;
          code?: number | null;
          signal?: number | null;
        };
        if (event.t === "out") this.tty += event.d ?? "";
        else if (event.t === "err") this.stderr += event.d ?? "";
        else if (event.t === "exit")
          this.exit = {
            code: event.code ?? null,
            signal: event.signal ?? null,
          };
      }
      this.wake();
    });
    this.child.stdin?.on("error", () => {});
    this.child.on("close", () => {
      this.dead = true;
      this.wake();
    });
  }

  private wake() {
    for (const waiter of [...this.waiters]) waiter();
  }

  private command(value: object) {
    if (!this.dead && this.child.stdin?.writable)
      this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  /** Type text on the terminal (include "\n" to press Enter). */
  send(text: string) {
    this.command({ send: text });
  }

  /**
   * Wait until `pattern` matches the child's stderr text after `from` (an
   * offset into `stderr`); returns the new end offset. Rejects on timeout or
   * when the child exits first, with the transcript in the message.
   */
  async expectStderr(
    pattern: RegExp,
    from: number,
    timeoutMs = 30000,
  ): Promise<number> {
    return this.until(
      () => {
        const match = pattern.exec(this.stderr.slice(from));
        return match ? from + match.index + match[0].length : null;
      },
      `stderr to match ${pattern}`,
      timeoutMs,
      false,
    );
  }

  /** Wait for the child to exit. */
  async waitExit(timeoutMs = 30000): Promise<PtyExit> {
    await this.until(
      () => (this.exit && this.dead ? true : null),
      "the process to exit",
      timeoutMs,
      true,
    );
    return this.exit as PtyExit;
  }

  private until<T>(
    probe: () => T | null,
    what: string,
    timeoutMs: number,
    exitIsExpected: boolean,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const done = (action: () => void) => {
        clearTimeout(timer);
        this.waiters.delete(check);
        action();
      };
      const fail = (why: string) =>
        done(() =>
          reject(
            new Error(
              `${why} while waiting for ${what}\n--- stderr ---\n${this.stderr}\n--- tty ---\n${this.tty}`,
            ),
          ),
        );
      const check = () => {
        const found = probe();
        if (found !== null) return done(() => resolve(found));
        if (this.dead) fail("driver ended");
        else if (this.exit && !exitIsExpected) fail("process exited");
      };
      const timer = setTimeout(
        () => fail(`timed out after ${timeoutMs}ms`),
        timeoutMs,
      );
      this.waiters.add(check);
      check();
    });
  }

  /** Always call: kills the child's process group and the driver. */
  async close() {
    this.command({ kill: true });
    this.child.stdin?.end();
    if (!this.dead) {
      const killer = setTimeout(() => this.child.kill("SIGKILL"), 5000);
      await new Promise<void>((resolve) => {
        if (this.dead) return resolve();
        this.child.once("close", () => resolve());
      });
      clearTimeout(killer);
    }
  }
}
