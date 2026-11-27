import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it("exits promptly after server.close() with an event stream open (no leaked timers or sockets)", async () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "crewplane-live-exit-")),
  );
  try {
    writeFileSync(join(root, ".gitignore"), ".crewplane-state/\n");
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: root, stdio: "pipe" });
    git("init", "-q", "--initial-branch=main");
    git("config", "user.name", "Synthetic");
    git("config", "user.email", "fixture@example.invalid");
    git("add", ".");
    git("commit", "-qm", "test: fixture");
    const child = spawn("bun", [resolve("tests/fixtures/live-exit.ts"), root], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      out += chunk;
    });
    const code = await new Promise<number | null>((done) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        done(null);
      }, 15000);
      child.on("exit", (status) => {
        clearTimeout(timer);
        done(status);
      });
    });
    expect(out).toContain("closed after");
    expect(code).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
