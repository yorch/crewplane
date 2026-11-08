import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { main } from "./agents.mjs";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
async function fixture(
  test: (root: string, worker: string, base: string) => Promise<void>,
) {
  const dir = realpathSync(
      mkdtempSync(join(tmpdir(), "crewplane-acceptance-")),
    ),
    root = join(dir, "project"),
    worker = join(dir, "worker");
  try {
    mkdirSync(join(root, "tasks"), { recursive: true });
    writeFileSync(join(root, "tasks/SAFE-1.md"), "# SAFE-1\nOwner: builder.\n");
    writeFileSync(join(root, ".gitignore"), ".crewplane-state/\n");
    git(root, "init", "-q", "--initial-branch=main");
    git(root, "config", "user.name", "Synthetic");
    git(root, "config", "user.email", "fixture@example.invalid");
    git(root, "add", ".");
    git(root, "commit", "-qm", "test: baseline");
    const base = git(root, "rev-parse", "HEAD");
    await main(
      [
        "assign",
        "--agent",
        "coordinator",
        "--task",
        "SAFE-1",
        "--owner",
        "builder",
        "--ref",
        base,
        "--text",
        "Synthetic scope",
      ],
      root,
    );
    git(root, "worktree", "add", "-qb", "builder", worker);
    await main(["claim", "--agent", "builder", "--task", "SAFE-1"], worker);
    writeFileSync(join(worker, "feature.txt"), "Synthetic feature\n");
    git(worker, "add", ".");
    git(worker, "commit", "-qm", "feat: synthetic feature");
    await main(
      [
        "status",
        "--agent",
        "builder",
        "--task",
        "SAFE-1",
        "--state",
        "ready",
        "--commit",
        "HEAD",
        "--text",
        "Synthetic handoff",
      ],
      worker,
    );
    await test(root, worker, base);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const accept = (strategy: string, base: string) => [
  "accept",
  "--agent",
  "coordinator",
  "--task",
  "SAFE-1",
  "--commit",
  "HEAD",
  "--strategy",
  strategy,
  "--integration-base",
  base,
  "--text",
  "Synthetic integration validation",
];
it.each(["ff", "rebase", "squash"])(
  "refuses %s acceptance of a worker tip that has not reached the primary checkout",
  async (strategy) => {
    await fixture(async (root, worker, base) => {
      await expect(main(accept(strategy, base), worker)).rejects.toThrow(
        "primary integration HEAD",
      );
      const board = (await main(["board"], root)) as {
        tasks: Array<{ accepted: unknown }>;
      };
      expect(board.tasks[0]?.accepted).toBeNull();
      expect(git(root, "rev-parse", "HEAD")).toBe(base);
    });
  },
);
it("accepts the source only after it is integrated into primary and serializes acceptance with author transitions", async () => {
  await fixture(async (root, worker, base) => {
    const source = git(worker, "rev-parse", "HEAD");
    git(root, "merge", "--ff-only", source);
    const { store } = (await main(["init"], root)) as { store: string };
    writeFileSync(
      join(store, "board-mutation.lock"),
      JSON.stringify({
        pid: process.pid,
        token: "11111111-1111-4111-8111-111111111111",
      }),
      { mode: 0o600 },
    );
    await expect(main(accept("ff", base), root)).rejects.toThrow(
      "Process lock unavailable; inspect ownership before retry",
    );
    rmSync(join(store, "board-mutation.lock"), { recursive: true });
    const accepted = (await main(accept("ff", base), root)) as {
      commit: string;
    };
    expect(accepted.commit).toBe(source);
  });
});
