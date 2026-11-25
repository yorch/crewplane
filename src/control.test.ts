import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  checkControlDirectory,
  controlDirectory,
  controlStateBase,
  ensureControlDirectory,
} from "./control.ts";

const scratch: string[] = [];
const temp = () => {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "crewplane-control-")));
  scratch.push(path);
  return path;
};
afterEach(() => {
  for (const path of scratch.splice(0))
    rmSync(path, { recursive: true, force: true });
});
// Independently authored expectation of the key.
const key = (path: string) =>
  createHash("sha256").update(path).digest("hex").slice(0, 24);

it("prefers an absolute CREWPLANE_STATE_DIR, then absolute XDG_STATE_HOME, then ~/.local/state", () => {
  const project = temp();
  const relative = (base: string) =>
    join(base, "crewplane/projects", key(project));
  expect(
    controlDirectory(project, { CREWPLANE_STATE_DIR: "/srv/state" }, "/home/u"),
  ).toBe(relative("/srv/state"));
  expect(
    controlDirectory(
      project,
      { CREWPLANE_STATE_DIR: "/srv/state", XDG_STATE_HOME: "/xdg" },
      "/home/u",
    ),
  ).toBe(relative("/srv/state"));
  expect(controlDirectory(project, { XDG_STATE_HOME: "/xdg" }, "/home/u")).toBe(
    relative("/xdg"),
  );
  // A relative XDG value is ignored, as the XDG specification requires.
  expect(
    controlDirectory(project, { XDG_STATE_HOME: "relative/xdg" }, "/home/u"),
  ).toBe(relative("/home/u/.local/state"));
  expect(controlDirectory(project, {}, "/home/u")).toBe(
    relative("/home/u/.local/state"),
  );
});

it("refuses a relative CREWPLANE_STATE_DIR instead of guessing", () => {
  expect(() => controlStateBase({ CREWPLANE_STATE_DIR: "state" })).toThrow(
    "CREWPLANE_STATE_DIR must be an absolute path",
  );
  expect(() =>
    controlDirectory(temp(), { CREWPLANE_STATE_DIR: "./x" }, "/home/u"),
  ).toThrow("absolute");
});

it("derives one stable directory from the canonical root, through symlinks", () => {
  const base = temp();
  const project = join(base, "project");
  mkdirSync(project);
  symlinkSync(project, join(base, "alias"));
  const env = { CREWPLANE_STATE_DIR: join(base, "state") };
  const direct = controlDirectory(project, env);
  expect(controlDirectory(join(base, "alias"), env)).toBe(direct);
  expect(direct.endsWith(key(project))).toBe(true);
  const other = join(base, "other");
  mkdirSync(other);
  expect(controlDirectory(other, env)).not.toBe(direct);
});

it("creates the directory private (0700) and verifies it", async () => {
  const base = temp();
  const project = join(base, "p");
  mkdirSync(project);
  const directory = controlDirectory(project, {
    CREWPLANE_STATE_DIR: join(base, "state"),
  });
  expect(checkControlDirectory(directory)).toBe(false);
  await ensureControlDirectory(directory);
  expect(statSync(directory).mode & 0o777).toBe(0o700);
  expect(checkControlDirectory(directory)).toBe(true);
  await ensureControlDirectory(directory);
});

it("refuses symlinked, group-writable, world-writable and non-directory control paths", async () => {
  const base = temp();
  const project = join(base, "p");
  mkdirSync(project);
  const directory = controlDirectory(project, {
    CREWPLANE_STATE_DIR: join(base, "state"),
  });
  await ensureControlDirectory(directory);
  chmodSync(directory, 0o770);
  expect(() => checkControlDirectory(directory)).toThrow("group or world");
  await expect(ensureControlDirectory(directory)).rejects.toThrow(
    "Unsafe control directory",
  );
  chmodSync(directory, 0o707);
  expect(() => checkControlDirectory(directory)).toThrow("group or world");
  chmodSync(directory, 0o700);
  // A parent that other users can write could be swapped underneath us.
  const parent = join(directory, "..");
  chmodSync(parent, 0o777);
  expect(() => checkControlDirectory(directory)).toThrow("group or world");
  chmodSync(parent, 0o700);

  rmSync(directory, { recursive: true });
  const elsewhere = join(base, "elsewhere");
  mkdirSync(elsewhere, { mode: 0o700 });
  symlinkSync(elsewhere, directory);
  expect(() => checkControlDirectory(directory)).toThrow("symbolic link");
  await expect(ensureControlDirectory(directory)).rejects.toThrow(
    "symbolic link",
  );
  rmSync(directory);
  writeFileSync(directory, "not a directory");
  expect(() => checkControlDirectory(directory)).toThrow("not a directory");
});
