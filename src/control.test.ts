import { createHash } from "node:crypto";
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  bindControl,
  checkBinding,
  checkControlDirectory,
  controlDirectory,
  controlStateBase,
  ensureControlDirectory,
  rebindControl,
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

it("refuses control directories that other users could read or traverse", async () => {
  const base = temp();
  const project = join(base, "p");
  mkdirSync(project);
  const directory = controlDirectory(project, {
    CREWPLANE_STATE_DIR: join(base, "state"),
  });
  await ensureControlDirectory(directory);
  for (const bits of [0o755, 0o701, 0o711, 0o704]) {
    chmodSync(directory, bits);
    expect(() => checkControlDirectory(directory), bits.toString(8)).toThrow(
      "accessible by other",
    );
  }
  chmodSync(directory, 0o700);
  chmodSync(join(directory, ".."), 0o750);
  expect(() => checkControlDirectory(directory)).not.toThrow();
  chmodSync(join(directory, ".."), 0o705);
  expect(() => checkControlDirectory(directory)).toThrow("accessible by other");
  chmodSync(join(directory, ".."), 0o700);
});

function bound() {
  const base = temp();
  const root = join(base, "project");
  const store = join(root, ".crewplane-state");
  mkdirSync(store, { recursive: true });
  const env = { CREWPLANE_STATE_DIR: join(base, "state") };
  return {
    base,
    root,
    store,
    env,
    control: controlDirectory(root, env),
    identity: { primaryRoot: root },
  };
}

it("binds the store and the control directory to one another", async () => {
  const p = bound();
  expect(() => checkBinding(p.store, p.control, p.identity)).not.toThrow();
  await ensureControlDirectory(p.control);
  await bindControl(p.store, p.control, p.identity);
  expect(existsSync(join(p.store, "control-binding.json"))).toBe(true);
  expect(existsSync(join(p.control, "identity.json"))).toBe(true);
  await bindControl(p.store, p.control, p.identity);
});

it("fails closed when the repository moved, the environment differs or a re-clone would inherit state", async () => {
  const p = bound();
  await ensureControlDirectory(p.control);
  await bindControl(p.store, p.control, p.identity);
  writeFileSync(join(p.control, "state.json"), "{}", { mode: 0o600 });

  // Repository renamed: the derived directory is new and empty, but the store
  // records prior supervision.
  const moved = join(p.base, "renamed");
  renameSync(join(p.base, "project"), moved);
  const movedControl = controlDirectory(moved, p.env);
  expect(movedControl).not.toBe(p.control);
  expect(() =>
    checkBinding(join(moved, ".crewplane-state"), movedControl, {
      primaryRoot: moved,
    }),
  ).toThrow("records prior supervision");

  // Different HOME/XDG/override between start and a later command.
  const elsewhere = controlDirectory(moved, {
    CREWPLANE_STATE_DIR: join(p.base, "other"),
  });
  expect(() =>
    checkBinding(join(moved, ".crewplane-state"), elsewhere, {
      primaryRoot: moved,
    }),
  ).toThrow("records prior supervision");
  await expect(
    bindControl(join(moved, ".crewplane-state"), elsewhere, {
      primaryRoot: moved,
    }),
  ).rejects.toThrow("records prior supervision");
  expect(existsSync(elsewhere)).toBe(false);

  // Same path, project identity differs (e.g. the directory was copied over).
  expect(() =>
    checkBinding(join(moved, ".crewplane-state"), p.control, {
      primaryRoot: "/other/root",
    }),
  ).toThrow("different project identity");

  // A re-clone at the same path has a fresh store without the marker.
  const reclone = join(p.base, "reclone-store");
  mkdirSync(reclone);
  expect(() => checkBinding(reclone, p.control, p.identity)).toThrow(
    "different checkout",
  );
  rmSync(join(moved, ".crewplane-state/control-binding.json"));
  expect(() =>
    checkBinding(join(moved, ".crewplane-state"), p.control, p.identity),
  ).toThrow("different checkout");
});

it("requires an absolute home directory when no override or XDG base exists", () => {
  expect(() => controlStateBase({}, "relative/home")).toThrow(
    "HOME must be an absolute path",
  );
  expect(controlStateBase({}, "/home/u")).toBe("/home/u/.local/state");
});

it.runIf(process.getuid?.() === 0)(
  "refuses a control directory owned by another user",
  async () => {
    const base = temp();
    const project = join(base, "p");
    mkdirSync(project);
    const directory = controlDirectory(project, {
      CREWPLANE_STATE_DIR: join(base, "state"),
    });
    await ensureControlDirectory(directory);
    chownSync(directory, 12345, 12345);
    expect(() => checkControlDirectory(directory)).toThrow(
      "not owned by the current user",
    );
  },
);

it("lets narrowing verbs through a lost or rewritten store marker, but not widening ones, and rebinds explicitly", async () => {
  const p = bound();
  await ensureControlDirectory(p.control);
  await bindControl(p.store, p.control, p.identity);
  const marker = join(p.store, "control-binding.json");
  // Marker deleted: stop/pause/cancel (and the dashboard's hold/cancel) still work.
  rmSync(marker);
  expect(() =>
    checkBinding(p.store, p.control, p.identity, { narrowing: true }),
  ).not.toThrow();
  await bindControl(p.store, p.control, p.identity, { narrowing: true });
  expect(existsSync(marker)).toBe(false);
  expect(() => checkBinding(p.store, p.control, p.identity)).toThrow(
    "different checkout",
  );
  // Marker rewritten with another id: same.
  writeFileSync(marker, JSON.stringify({ version: 1, id: "other" }));
  expect(() =>
    checkBinding(p.store, p.control, p.identity, { narrowing: true }),
  ).not.toThrow();
  expect(() => checkBinding(p.store, p.control, p.identity)).toThrow(
    "different checkout",
  );
  // A narrowing verb into a directory bound to ANOTHER project is still refused.
  expect(() =>
    checkBinding(
      p.store,
      p.control,
      { primaryRoot: "/else" },
      { narrowing: true },
    ),
  ).toThrow("different project identity");
  // The operator repairs the marker from identity.json.
  expect(await rebindControl(p.store, p.control, p.identity)).toBe("rebound");
  expect(() => checkBinding(p.store, p.control, p.identity)).not.toThrow();
  expect(await rebindControl(p.store, p.control, p.identity)).toBe("unchanged");
  await expect(
    rebindControl(p.store, p.control, { primaryRoot: "/else" }),
  ).rejects.toThrow("different project identity");
});

it.runIf(process.getuid?.() !== 0)(
  "refuses a directory owned by someone else when not running as root",
  () => {
    expect(() => checkControlDirectory("/")).toThrow(
      /not owned by the current user|accessible by other users|group or world/,
    );
  },
);
