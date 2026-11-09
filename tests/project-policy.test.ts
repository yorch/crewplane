import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };
import { main } from "../src/engine/agents.mjs";
import {
  ProjectVersionError,
  printablePath,
  projectPolicy,
} from "../src/project.ts";
import { projectAgentPrompt } from "../src/prompts.ts";

const env = {
  ...process.env,
  CREWPLANE_COORD_DIR: "",
  CREWPLANE_NO_AUTO_UPDATE: "1",
};
function fixture() {
  const outer = realpathSync(
      mkdtempSync(join(tmpdir(), "crewplane-policy-v2-")),
    ),
    root = join(outer, "primary # with spaces");
  mkdirSync(root);
  execFileSync("git", ["init", "-q", "--initial-branch=main"], {
    cwd: root,
    env,
  });
  execFileSync("git", ["config", "user.name", "Synthetic"], { cwd: root, env });
  execFileSync("git", ["config", "user.email", "fixture@example.invalid"], {
    cwd: root,
    env,
  });
  const save = (value: unknown) =>
    writeFileSync(join(root, "crewplane.json"), JSON.stringify(value));
  const policy = {
    version: 2,
    requiredVersion: pkg.version,
    coordinator: "captain",
    reviewers: ["inspector", "qa"],
    reviewerRoles: { qa: "visual" },
    promptFiles: {
      builder: ["guide.md", "worker.md"],
      inspector: ["review.md"],
      qa: ["qa.md"],
    },
  };
  for (const [file, text] of Object.entries({
    "guide.md": "SHARED_PRIMARY_GUIDANCE",
    "worker.md": "PRIMARY_WORKER_GUIDANCE",
    "review.md": "REVIEW_ONLY_GUIDANCE",
    "qa.md": "VISUAL_ONLY_GUIDANCE",
  }))
    writeFileSync(join(root, file), text);
  save(policy);
  return { outer, root, save, policy };
}
it("keeps v1 defaults and requires v2 for additive project capabilities", () => {
  const f = fixture();
  try {
    f.save({ version: 1 });
    expect(projectPolicy(f.root).tasksPath).toBe("tasks");
    for (const extra of [
      { requiredVersion: pkg.version },
      { promptFiles: { builder: ["guide.md"] } },
    ]) {
      f.save({ version: 1, ...extra });
      expect(() => projectPolicy(f.root)).toThrow(
        "require project policy version 2",
      );
    }
    f.save(f.policy);
    expect(projectPolicy(f.root).requiredVersion).toBe(pkg.version);
  } finally {
    rmSync(f.outer, { recursive: true, force: true });
  }
});
it("rejects malformed version pins and mismatches before preparing state", async () => {
  const f = fixture();
  try {
    for (const requiredVersion of [
      "latest",
      "^0.2.0",
      "v0.2.0",
      1,
      null,
      "01.2.0",
    ]) {
      f.save({ ...f.policy, requiredVersion });
      expect(() => projectPolicy(f.root)).toThrow("exact release version");
    }
    f.save({ ...f.policy, requiredVersion: "999.0.0" });
    await expect(main(["init"], f.root)).rejects.toThrow(
      `Project requires Crewplane 999.0.0; running ${pkg.version}`,
    );
    expect(existsSync(join(f.root, ".crewplane-state"))).toBe(false);
  } finally {
    rmSync(f.outer, { recursive: true, force: true });
  }
});
it("reports an unsupported schema after the pin, and the pin before role errors", () => {
  const f = fixture();
  try {
    f.save({ ...f.policy, version: 3, requiredVersion: "0.3.0" });
    expect(() => projectPolicy(f.root)).toThrow(ProjectVersionError);
    f.save({ ...f.policy, version: 3 });
    expect(() => projectPolicy(f.root)).toThrow(
      "Unsupported project policy version",
    );
    f.save({
      ...f.policy,
      requiredVersion: "0.3.0",
      coordinator: "NOT VALID",
    });
    expect(() => projectPolicy(f.root)).toThrow(ProjectVersionError);
    f.save(f.policy);
  } finally {
    rmSync(f.outer, { recursive: true, force: true });
  }
});
it("renders pin recovery context in the CLI without widening the error message", () => {
  const f = fixture();
  try {
    const bin = resolve("dist/crewplane");
    f.save({ ...f.policy, requiredVersion: "0.3.0" });
    let raised: unknown;
    try {
      projectPolicy(f.root);
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(ProjectVersionError);
    expect((raised as ProjectVersionError).required).toBe("0.3.0");
    expect((raised as ProjectVersionError).running).toBe(pkg.version);
    expect((raised as ProjectVersionError).policyPath).toBe(
      join(f.root, "crewplane.json"),
    );
    expect((raised as ProjectVersionError).message).not.toContain("\n");

    const refused = spawnSync(bin, ["--project", f.root, "status"], {
      cwd: f.root,
      env,
      encoding: "utf8",
    });
    expect(refused.status).toBe(1);
    expect(refused.stderr.split("\n")[0]).toContain(
      `Project requires Crewplane 0.3.0; running ${pkg.version}`,
    );
    expect(refused.stderr).toContain(
      `  pin:     requiredVersion in ${join(f.root, "crewplane.json")}`,
    );
    expect(refused.stderr).toContain("OLDER release");
    expect(refused.stderr).toContain('docs/USAGE.md "Project version pins"');
    // Recovery context must never be an executable command for a lane to run.
    expect(refused.stderr).not.toMatch(/curl|\| sh/);
    expect(existsSync(join(f.root, ".crewplane-state"))).toBe(false);
    expect(existsSync(join(f.root, ".git/crewplane-project.json"))).toBe(false);

    const refusedRetry = spawnSync(
      bin,
      ["--project", f.root, "retry", "--lane", "builder", "--text", "x"],
      { cwd: f.root, env, encoding: "utf8" },
    );
    expect(refusedRetry.status).toBe(1);
    expect(refusedRetry.stderr).toContain("Project requires Crewplane");

    // Operator controls must survive a swapped binary; nothing else does.
    const queued = spawnSync(bin, ["--project", f.root, "stop"], {
      cwd: f.root,
      env,
      encoding: "utf8",
    });
    expect(queued.status).toBe(0);
    expect(JSON.parse(queued.stdout).queued).toBe("stop");
    expect(queued.stderr).toContain(
      "queuing stop despite the release mismatch",
    );

    const cancelled = spawnSync(
      bin,
      ["--project", f.root, "cancel", "--all", "true"],
      { cwd: f.root, env, encoding: "utf8" },
    );
    expect(cancelled.status).toBe(0);
    expect(JSON.parse(cancelled.stdout).queued).toBe("cancel");

    const newer = spawnSync(bin, ["--project", f.root], {
      cwd: f.root,
      env,
      encoding: "utf8",
    });
    expect(newer.stdout).toContain("Crewplane");
    expect(
      spawnSync(bin, ["--project", f.root, "--version"], {
        env,
        encoding: "utf8",
      }).stdout.trim(),
    ).toBe(pkg.version);
  } finally {
    rmSync(f.outer, { recursive: true, force: true });
  }
});
it("repins the project at the running release and preserves the rest of the policy", () => {
  const f = fixture();
  try {
    const bin = resolve("dist/crewplane");
    const read = () =>
      JSON.parse(readFileSync(join(f.root, "crewplane.json"), "utf8"));
    f.save({
      ...f.policy,
      requiredVersion: "0.3.0",
      projectOwner: { team: "core" },
    });
    const before = readFileSync(join(f.root, "crewplane.json"), "utf8");
    const pin = (...args: string[]) =>
      spawnSync(bin, ["--project", f.root, "pin", ...args], {
        cwd: f.root,
        env,
        encoding: "utf8",
      });

    const unconfirmed = pin();
    expect(unconfirmed.status).toBe(1);
    expect(unconfirmed.stderr).toContain("rerun with --confirm true");
    expect(read().requiredVersion).toBe("0.3.0");

    const upgraded = pin("--confirm", "true");
    expect(upgraded.status).toBe(0);
    expect(JSON.parse(upgraded.stdout)).toMatchObject({
      from: "0.3.0",
      to: pkg.version,
      changed: true,
    });
    expect(read()).toMatchObject({
      version: 2,
      requiredVersion: pkg.version,
      coordinator: "captain",
      reviewers: ["inspector", "qa"],
      projectOwner: { team: "core" },
    });
    expect(readFileSync(join(f.root, "crewplane.json"), "utf8")).toBe(
      before.replace('"0.3.0"', `"${pkg.version}"`),
    );
    expect(
      spawnSync(bin, ["--project", f.root, "status"], {
        cwd: f.root,
        env,
        encoding: "utf8",
      }).status,
    ).toBe(0);
    expect(JSON.parse(pin("--confirm", "true").stdout).changed).toBe(false);

    // A live supervisor must never see its own project's policy change.
    f.save({ ...f.policy, requiredVersion: "0.3.0" });
    mkdirSync(join(f.root, ".crewplane-state", "supervisor"), {
      recursive: true,
    });
    writeFileSync(
      join(f.root, ".crewplane-state", "supervisor", "state.json"),
      JSON.stringify({ running: true, supervisorVersion: "0.1.0" }),
    );
    const running = pin("--confirm", "true");
    expect(running.status).toBe(1);
    expect(running.stderr).toContain("Stop the supervisor (0.1.0)");
    expect(read().requiredVersion).toBe("0.3.0");

    f.save({ ...f.policy, requiredVersion: undefined });
    expect(pin("--confirm", "true").stderr).toContain("is not pinned");
    f.save({ version: 1 });
    expect(pin("--confirm", "true").stderr).toContain("is not pinned");
    f.save({ version: 1, requiredVersion: pkg.version });
    expect(pin("--confirm", "true").stderr).toContain(
      "require project policy version 2",
    );
  } finally {
    rmSync(f.outer, { recursive: true, force: true });
  }
});
it("keeps the pin message safe for the supervisor's pause-reason slice", () => {
  const f = fixture();
  try {
    f.save({ ...f.policy, requiredVersion: "0.3.0" });
    let raised: ProjectVersionError | undefined;
    try {
      projectPolicy(f.root);
    } catch (error) {
      raised = error as ProjectVersionError;
    }
    // The supervisor slices a paused lane's reason at 500 characters and
    // persists it, so recovery hints must never enter the message itself.
    expect(raised?.message).not.toContain("\n");
    expect(raised?.message.length ?? 0).toBeLessThan(500);
    expect(raised?.message).not.toContain("pin:");
    expect(raised?.message).not.toContain("docs/USAGE.md");
    expect(raised?.message).not.toContain("curl");
  } finally {
    rmSync(f.outer, { recursive: true, force: true });
  }
});
it("sanitizes control bytes before printing a project path", () => {
  expect(printablePath("/tmp/a\u001b[2Jb\u0000c")).toBe("/tmp/a?[2Jb?c");
  expect(printablePath("/plain/path")).toBe("/plain/path");
});
it("names the primary pin when a linked worktree disagrees with it", () => {
  const f = fixture();
  try {
    f.save({ ...f.policy, requiredVersion: "0.3.0" });
    execFileSync("git", ["add", "."], { cwd: f.root, env });
    execFileSync("git", ["commit", "-qm", "test: pin the project"], {
      cwd: f.root,
      env,
    });
    const worker = join(f.outer, "worker");
    execFileSync("git", ["worktree", "add", "-qb", "worker", worker], {
      cwd: f.root,
      env,
    });
    // A divergent copy inside the worktree must not decide the pin.
    writeFileSync(
      join(worker, "crewplane.json"),
      JSON.stringify({ ...f.policy, requiredVersion: "9.9.9" }),
    );
    const refused = spawnSync(
      resolve("dist/crewplane"),
      ["--project", worker, "status"],
      { cwd: worker, env, encoding: "utf8" },
    );
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("Project requires Crewplane 0.3.0");
    expect(refused.stderr).toContain(`requiredVersion in ${f.root}`);
    expect(refused.stderr).not.toContain(worker);
  } finally {
    rmSync(f.outer, { recursive: true, force: true });
  }
});
it("warns when the live supervisor's release may ignore a queued verb", () => {
  const f = fixture();
  try {
    const bin = resolve("dist/crewplane");
    const stateFile = join(
      f.root,
      ".crewplane-state",
      "supervisor",
      "state.json",
    );
    mkdirSync(join(f.root, ".crewplane-state", "supervisor"), {
      recursive: true,
    });
    f.save({ ...f.policy, requiredVersion: "0.3.0" });
    const queue = () =>
      spawnSync(bin, ["--project", f.root, "stop"], {
        cwd: f.root,
        env,
        encoding: "utf8",
      });

    writeFileSync(
      stateFile,
      JSON.stringify({ running: true, supervisorVersion: "0.1.0" }),
    );
    const named = queue();
    expect(named.status).toBe(0);
    expect(named.stderr).toContain(
      "supervisor 0.1.0 interprets queued commands",
    );

    // The same release understands every verb, so silence is the contract.
    writeFileSync(
      stateFile,
      JSON.stringify({ running: true, supervisorVersion: pkg.version }),
    );
    const same = queue();
    expect(same.status).toBe(0);
    expect(same.stderr).not.toContain("may ignore");

    // A supervisor older than the recording field is the likely real case.
    writeFileSync(stateFile, JSON.stringify({ running: true }));
    expect(queue().stderr).toContain(
      "the running supervisor's release is unknown",
    );
  } finally {
    rmSync(f.outer, { recursive: true, force: true });
  }
});
it("composes ordered primary files and retains reviewer boundaries across worker checkouts", async () => {
  const f = fixture();
  try {
    execFileSync("git", ["add", "."], { cwd: f.root, env });
    execFileSync("git", ["commit", "-qm", "test: project instructions"], {
      cwd: f.root,
      env,
    });
    const worker = join(f.outer, "worker");
    execFileSync("git", ["worktree", "add", "-qb", "worker", worker], {
      cwd: f.root,
      env,
    });
    writeFileSync(join(worker, "guide.md"), "STALE_WORKER_GUIDANCE");
    writeFileSync(
      join(worker, "crewplane.json"),
      JSON.stringify({ version: 2, promptFiles: { builder: ["worker.md"] } }),
    );
    const result = await main(["prompt", "builder"], worker);
    expect(result).toContain("Crewplane agent builder");
    expect(result).toContain("SHARED_PRIMARY_GUIDANCE");
    expect(result).not.toContain("STALE_WORKER_GUIDANCE");
    expect(result.indexOf("SHARED_PRIMARY_GUIDANCE")).toBeLessThan(
      result.indexOf("PRIMARY_WORKER_GUIDANCE"),
    );
    const review = await main(["prompt", "inspector"], worker);
    expect(review).toContain("Verification-only reviewer");
    expect(review).toContain("REVIEW_ONLY_GUIDANCE");
    expect(review).not.toContain("PRIMARY_WORKER_GUIDANCE");
    expect(await main(["prompt", "qa"], worker)).toContain(
      "Verification-only visual",
    );
    expect(projectAgentPrompt(f.root, "unconfigured")).toContain(
      "Worker self-service",
    );
  } finally {
    rmSync(f.outer, { recursive: true, force: true });
  }
});
it("rejects unsafe and invalid lists without reading arbitrary filesystem paths", () => {
  const f = fixture();
  try {
    for (const promptFiles of [
      { builder: ["../escape"] },
      { builder: ["/etc/passwd"] },
      { builder: [".git/config"] },
      { builder: [".crewplane-state/messages/x"] },
      { builder: ["a\\b"] },
      { builder: ["a\0b"] },
      { builder: ["guide.md", "guide.md"] },
      { builder: "guide.md" },
      { constructor: ["guide.md"] },
      { builder: Array.from({ length: 17 }, (_, i) => `f${i}.md`) },
      null,
      [],
    ]) {
      f.save({ ...f.policy, promptFiles });
      expect(() => projectPolicy(f.root)).toThrow();
    }
  } finally {
    rmSync(f.outer, { recursive: true, force: true });
  }
});
it("bounds regular UTF-8 files and combined context and rejects missing or escaping symlinks", () => {
  const f = fixture();
  try {
    for (const content of [
      "x".repeat(32769),
      Buffer.from([0xc0, 0xaf]),
      "bad\0text",
    ]) {
      writeFileSync(join(f.root, "guide.md"), content);
      expect(() => projectAgentPrompt(f.root, "builder")).toThrow(
        "unavailable or unsafe",
      );
    }
    writeFileSync(join(f.root, "guide.md"), "valid");
    f.save({ ...f.policy, promptFiles: { builder: ["missing.md"] } });
    expect(() => projectAgentPrompt(f.root, "builder")).toThrow("missing.md");
    mkdirSync(join(f.root, ".crewplane-state"));
    writeFileSync(
      join(f.root, ".crewplane-state/private.md"),
      "PRIVATE_STATE_SENTINEL",
    );
    symlinkSync(
      join(f.root, ".crewplane-state/private.md"),
      join(f.root, "state-alias.md"),
    );
    f.save({ ...f.policy, promptFiles: { builder: ["state-alias.md"] } });
    expect(() => projectAgentPrompt(f.root, "builder")).toThrow(
      "state-alias.md",
    );
    mkdirSync(join(f.root, "directory.md"));
    f.save({ ...f.policy, promptFiles: { builder: ["directory.md"] } });
    expect(() => projectAgentPrompt(f.root, "builder")).toThrow("directory.md");
    writeFileSync(join(f.outer, "outside.md"), "PRIVATE_SENTINEL");
    symlinkSync(join(f.outer, "outside.md"), join(f.root, "escape.md"));
    f.save({ ...f.policy, promptFiles: { builder: ["escape.md"] } });
    expect(() => projectAgentPrompt(f.root, "builder")).toThrow("escape.md");
    f.save({ ...f.policy, promptFiles: { builder: ["."] } });
    expect(() => projectPolicy(f.root)).toThrow();
    for (const file of ["one.md", "two.md"])
      writeFileSync(join(f.root, file), "x".repeat(32768));
    f.save({ ...f.policy, promptFiles: { builder: ["one.md", "two.md"] } });
    expect(() => projectAgentPrompt(f.root, "builder")).toThrow("64 KiB");
  } finally {
    rmSync(f.outer, { recursive: true, force: true });
  }
});
it("compiled CLI enforces v2 before writes and exposes version/help for recovery", () => {
  const f = fixture();
  try {
    const bin = resolve("dist/crewplane");
    f.save({ ...f.policy, requiredVersion: "999.0.0" });
    const r = spawnSync(bin, ["--project", f.root, "status"], {
      cwd: f.root,
      env,
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Project requires Crewplane 999.0.0");
    expect(existsSync(join(f.root, ".crewplane-state"))).toBe(false);
    expect(
      execFileSync(bin, ["--project", f.root, "--version"], {
        env,
        encoding: "utf8",
      }).trim(),
    ).toBe(pkg.version);
    expect(execFileSync(bin, ["--help"], { env, encoding: "utf8" })).toContain(
      "Crewplane",
    );
    f.save(f.policy);
    const prompt = execFileSync(
      bin,
      ["--project", f.root, "agents", "prompt", "builder"],
      { env, encoding: "utf8" },
    );
    expect(prompt).toContain("SHARED_PRIMARY_GUIDANCE");
  } finally {
    rmSync(f.outer, { recursive: true, force: true });
  }
});
