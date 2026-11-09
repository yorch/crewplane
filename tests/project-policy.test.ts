import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
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
import { projectPolicy } from "../src/project.ts";
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
