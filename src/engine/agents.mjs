import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  readdir,
  readFile,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  coordinatorOf,
  discoverProject,
  projectPolicy,
  reviewersOf,
  validId,
  validTaskId,
} from "../project.ts";
import { agentPrompt } from "../prompts.ts";

const kinds = ["question", "answer", "update", "handoff", "request"];
function ensure(condition, message) {
  if (!condition) throw new Error(message);
}
function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
async function read(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== undefined) return fallback;
    throw error;
  }
}
async function put(path, value, exclusive = false) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    if (exclusive) await link(temp, path);
    else await rename(temp, path);
  } finally {
    await unlink(temp).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
function options(args) {
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    ensure(
      args[i]?.startsWith("--") && args[i + 1] && !args[i + 1].startsWith("--"),
      "Options require --name value pairs",
    );
    const key = args[i].slice(2);
    ensure(!(key in result), `Duplicate option: ${key}`);
    result[key] = args[i + 1];
  }
  return result;
}
function lane(value) {
  ensure(validId(value), "Agent/owner must be a safe configured identifier");
  return value;
}
function task(value) {
  ensure(validTaskId(value), "Task must be a task-card ID, e.g. P1-01");
  return value;
}
function uuid(value) {
  ensure(/^[a-f0-9-]{36}$/.test(value ?? ""), "Invalid message ID");
  return value;
}
async function text(options, cwd) {
  ensure(
    Boolean(options.text) !== Boolean(options.file),
    "Provide exactly one of --text or --file",
  );
  const value = options.file
    ? await readFile(resolve(cwd, options.file), "utf8")
    : options.text;
  ensure(
    value.trim().length > 0 && value.length <= 32768,
    "Text must contain 1–32768 characters",
  );
  return value;
}
async function context(cwd) {
  const identity = discoverProject(cwd);
  return { ...identity, policy: projectPolicy(identity.primary) };
}

function taskPath(ctx, id, file) {
  return join(ctx.store, "tasks", task(id), file);
}
async function prepare(ctx) {
  await mkdir(join(ctx.store, "messages"), { recursive: true, mode: 0o700 });
  await mkdir(join(ctx.store, "tasks"), { recursive: true, mode: 0o700 });
  const path = join(ctx.store, "repository.json");
  try {
    await put(
      path,
      { application: "crewplane", schemaVersion: 1, gitCommonDir: ctx.common },
      true,
    );
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const meta = await read(path);
  ensure(
    meta.application === "crewplane" &&
      meta.schemaVersion === 1 &&
      meta.gitCommonDir === ctx.common,
    "Store belongs to a different Git repository or protocol version",
  );
  if (ctx.root === ctx.primary) {
    const bindingPath = join(ctx.common, "crewplane-project.json");
    const binding = await read(bindingPath, null);
    if (!binding) {
      try {
        await put(
          bindingPath,
          { version: 1, root: ctx.primary, common: ctx.common },
          true,
        );
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    }
    const current = await read(bindingPath);
    ensure(
      current.version === 1 &&
        current.root === ctx.primary &&
        current.common === ctx.common,
      "Primary project binding requires explicit inspection",
    );
  }
}
async function messages(ctx) {
  const files = await readdir(join(ctx.store, "messages"));
  return (
    await Promise.all(
      files
        .filter((f) => /^[a-f0-9-]{36}\.json$/.test(f))
        .map((f) => read(join(ctx.store, "messages", f))),
    )
  ).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}
async function send(ctx, value) {
  const message = {
    schemaVersion: 1,
    id: randomUUID(),
    at: new Date().toISOString(),
    ...value,
  };
  await put(join(ctx.store, "messages", `${message.id}.json`), message, true);
  return message;
}
async function claimed(ctx, id, agent) {
  const assignment = await read(taskPath(ctx, id, "assignment.json"));
  const claim = await read(taskPath(ctx, id, "claim.json"));
  ensure(
    assignment.owner === agent && claim.agent === agent,
    "Task belongs to another lane",
  );
  ensure(
    claim.worktree === ctx.root,
    "Run task status commands from its claimed worktree",
  );
  ensure(
    !(await read(taskPath(ctx, id, "accepted.json"), null)),
    "Task is already accepted",
  );
  return { assignment, claim };
}
function scopePaths(value) {
  ensure(
    Array.isArray(value) && value.length > 0 && value.length <= 64,
    "Scope requires 1–64 paths",
  );
  return [
    ...new Set(
      value.map((path) => {
        ensure(
          typeof path === "string" &&
            path.length > 0 &&
            path.length <= 256 &&
            !/[\\:*?[\]{}\s]/.test(path) &&
            [...path].every(
              (character) =>
                character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127,
            ) &&
            !isAbsolute(path),
          "Scope paths must be relative paths without backslashes, globs or whitespace",
        );
        const normalized = path.replace(/\/$/, "");
        ensure(
          normalized
            .split("/")
            .every((part) => part && part !== "." && part !== ".."),
          "Scope paths must not contain traversal or empty segments",
        );
        return normalized;
      }),
    ),
  ];
}
async function optionalScope(ctx, id) {
  const scope = await read(taskPath(ctx, id, "scope.json"), null);
  if (scope === null) return null;
  ensure(
    scope.version === 1 &&
      scope.task === id &&
      scope.by === coordinatorOf(ctx.policy),
    `Invalid coordinator scope for ${id}`,
  );
  return scopePaths(scope.paths);
}
async function knownScope(ctx, id) {
  const paths = await optionalScope(ctx, id);
  ensure(
    paths !== null,
    `Unknown coordinator scope for ${id}; publish scope before pipelining`,
  );
  return paths;
}
async function outstandingRevision(ctx, id, agent) {
  const all = await messages(ctx);
  const answered = new Set(
    all.filter((m) => m.kind === "answer").map((m) => m.replyTo),
  );
  return all.some(
    (m) =>
      m.from === coordinatorOf(ctx.policy) &&
      m.to === agent &&
      m.task === id &&
      m.kind === "request" &&
      !answered.has(m.id),
  );
}
const priorities = ["urgent-operational", "gate-critical", "normal", "low"];
function schedulingDependencies(value, ownTask) {
  ensure(
    Array.isArray(value) && value.length <= 64,
    "Dependencies require an array of at most 64 entries",
  );
  const seen = new Set();
  return value.map((dependency) => {
    ensure(
      dependency &&
        typeof dependency === "object" &&
        !Array.isArray(dependency) &&
        Object.keys(dependency).every((key) =>
          ["taskId", "require", "commit"].includes(key),
        ),
      "Invalid scheduling dependency fields",
    );
    const dependencyTask = task(dependency.taskId);
    ensure(
      dependencyTask !== ownTask && !seen.has(dependencyTask),
      "Dependencies must be distinct other tasks",
    );
    seen.add(dependencyTask);
    ensure(
      ["accepted", "ready"].includes(dependency.require),
      "Dependency require must be accepted or ready",
    );
    const commit = dependency.commit ?? null;
    ensure(
      commit === null ||
        (typeof commit === "string" && /^[a-f0-9]{40}$/.test(commit)),
      "Dependency commit must be a full lowercase SHA or null",
    );
    ensure(
      dependency.require !== "ready" || commit !== null,
      "Ready dependency requires an exact commit",
    );
    return { taskId: dependencyTask, require: dependency.require, commit };
  });
}
function overlaps(left, right) {
  return left.some((a) =>
    right.some(
      (b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`),
    ),
  );
}
async function taskEntries(ctx) {
  const result = [];
  for (const id of await readdir(join(ctx.store, "tasks"))) {
    if (!validTaskId(id)) continue;
    const assignment = await read(taskPath(ctx, id, "assignment.json"), null);
    if (!assignment) continue;
    result.push({
      id,
      assignment,
      claim: await read(taskPath(ctx, id, "claim.json"), null),
      status: await read(taskPath(ctx, id, "status.json"), null),
      accepted: await read(taskPath(ctx, id, "accepted.json"), null),
    });
  }
  return result;
}
async function executionGuard(ctx, id, agent, revision = false) {
  const state = await read(join(ctx.store, "supervisor", "state.json"), null);
  for (const record of Object.values(state?.records ?? {})) {
    ensure(
      record.lane !== agent ||
        record.status !== "running" ||
        (record.task === id && record.cwd === ctx.root),
      `Lane ${agent} has another running native record; wait for its checkpoint`,
    );
  }
  for (const entry of await taskEntries(ctx)) {
    if (entry.id === id) continue;
    ensure(
      entry.claim?.worktree !== ctx.root,
      `Worktree already claimed by ${entry.id}; preserve frozen resources`,
    );
    if (entry.accepted || entry.assignment.owner !== agent) continue;
    ensure(
      entry.status?.state === "ready" ||
        (revision &&
          ((!entry.claim && !entry.status) ||
            (entry.status?.state === "blocked" &&
              entry.status.checkpointed === true))),
      `Lane ${agent} already has active task ${entry.id}`,
    );
    ensure(
      !overlaps(await knownScope(ctx, id), await knownScope(ctx, entry.id)),
      `Coordinator scopes overlap with ${entry.id}`,
    );
  }
}
const help = `Crewplane coordination commands (JSON output)
  crewplane agents prompt AGENT
  crewplane agents assign --agent COORDINATOR --task ID --owner WORKER --ref SHA --text BRIEF
  crewplane agents scope --agent COORDINATOR --task ID --paths-json '["src/example"]'
  crewplane agents schedule --agent COORDINATOR --task ID --priority normal [--dependencies-json '[]']
  crewplane agents claim --agent WORKER --task ID
  crewplane agents checkpoint --agent WORKER --task ID --text HANDOFF
  crewplane agents status --agent WORKER --task ID --state working|blocked|ready --text NOTE [--commit HEAD]
  crewplane agents send --agent SENDER --to RECIPIENT|all --kind question|answer|update|handoff|request [--task ID] [--reply-to UUID] [--commit SHA] --text NOTE
  crewplane agents inbox --agent AGENT [--task ID] [--unanswered true]
  crewplane agents board|brief
  crewplane agents accept --agent COORDINATOR --task ID --commit SHA --text VALIDATION [--strategy ff|rebase|squash --integration-base SHA]
  crewplane agents release --agent COORDINATOR --task ID --text REASON
Use configured role IDs; --file replaces --text for multiline notes. Pin review requests to an exact SHA. Acceptance never performs Git integration. No daemon, auto-merge or auto-execution.`;

export async function main(args = process.argv.slice(2), cwd = process.cwd()) {
  const [command, ...rest] = args;
  if (!command || command === "help") return help;
  if (command === "prompt") {
    const id = lane(rest[0]);
    const p = projectPolicy(cwd);
    return agentPrompt(
      id,
      id === reviewersOf(p)[1]
        ? "visual"
        : reviewersOf(p).includes(id)
          ? "review"
          : "implementation",
    );
  }
  const valid = [
    "init",
    "assign",
    "scope",
    "schedule",
    "claim",
    "checkpoint",
    "status",
    "send",
    "inbox",
    "board",
    "brief",
    "accept",
    "release",
  ];
  ensure(valid.includes(command), `Unknown command: ${command}`);
  const o = options(rest);
  const ctx = await context(cwd);
  await prepare(ctx);
  const lock = join(ctx.store, "board-mutation.lock");
  const mutating = [
    "scope",
    "schedule",
    "assign",
    "claim",
    "checkpoint",
    "status",
    "accept",
    "release",
  ].includes(command);
  if (mutating) {
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch (error) {
      if (error.code === "EEXIST")
        throw new Error(
          "Board mutation busy; retry after current command finishes (inspect stale lock before recovery)",
        );
      throw error;
    }
  }
  try {
    return await execute(command, o, ctx);
  } finally {
    if (mutating) await rmdir(lock);
  }
}
async function execute(command, o, ctx) {
  if (command === "init")
    return {
      store: ctx.store,
      gitCommonDir: ctx.common,
      projectRoot: ctx.primary,
      schemaVersion: 1,
    };
  if (command === "board" || command === "brief") {
    const entries = await readdir(join(ctx.store, "tasks"));
    const tasks = [];
    for (const id of entries.filter((id) => validTaskId(id)).sort()) {
      const assignment = await read(taskPath(ctx, id, "assignment.json"), null);
      if (!assignment) continue;
      tasks.push({
        task: id,
        assignment,
        claim: await read(taskPath(ctx, id, "claim.json"), null),
        status: await read(taskPath(ctx, id, "status.json"), null),
        accepted: await read(taskPath(ctx, id, "accepted.json"), null),
        scheduling: await read(taskPath(ctx, id, "metadata.json"), null),
        scope: await read(taskPath(ctx, id, "scope.json"), null),
      });
    }
    const all = await messages(ctx);
    const answered = new Set(
      all.filter((m) => m.kind === "answer").map((m) => m.replyTo),
    );
    if (command === "brief")
      return {
        store: ctx.store,
        tasks: tasks.map((t) => ({
          task: t.task,
          owner: t.assignment.owner,
          state: t.accepted
            ? "accepted"
            : (t.status?.state ?? (t.claim ? "claimed" : "assigned")),
          commit: t.accepted?.commit ?? t.status?.commit ?? null,
          scheduling: t.scheduling,
        })),
        unanswered: all.filter(
          (m) =>
            ["question", "request"].includes(m.kind) && !answered.has(m.id),
        ),
        recent: all.slice(-5).map((m) => ({
          id: m.id,
          from: m.from,
          to: m.to,
          kind: m.kind,
          task: m.task,
          at: m.at,
        })),
      };
    return {
      store: ctx.store,
      messages: all,
      tasks,
      unanswered: all.filter(
        (m) => ["question", "request"].includes(m.kind) && !answered.has(m.id),
      ),
    };
  }
  const agent = lane(o.agent);
  ensure(
    !reviewersOf(ctx.policy).includes(agent) ||
      ["inbox", "send"].includes(command),
    "Verification roles only read the board and send findings",
  );
  if (command === "inbox") {
    const all = await messages(ctx);
    const answered = new Set(
      all.filter((m) => m.kind === "answer").map((m) => m.replyTo),
    );
    if (o.task) task(o.task);
    return all.filter(
      (m) =>
        (m.to === agent || m.to === "all") &&
        (!o.task || m.task === o.task) &&
        (o.unanswered !== "true" ||
          (["question", "request"].includes(m.kind) && !answered.has(m.id))),
    );
  }
  if (command === "send") {
    const to = o.to === "all" ? "all" : lane(o.to);
    ensure(kinds.includes(o.kind), "Unknown message kind");
    if (o.task) task(o.task);
    let messageTask = o.task ?? null;
    if (o.kind === "answer")
      ensure(o["reply-to"], "Answers require --reply-to UUID");
    if (o["reply-to"]) {
      const parent = await read(
        join(ctx.store, "messages", `${uuid(o["reply-to"])}.json`),
      );
      ensure(
        !messageTask || !parent.task || messageTask === parent.task,
        "Reply task must match the question/request",
      );
      messageTask ??= parent.task;
      ensure(to === parent.from, "Reply to the original sender");
      ensure(
        parent.to === agent || parent.to === "all",
        "Message was addressed to another lane",
      );
      if (o.kind === "answer")
        ensure(
          ["question", "request"].includes(parent.kind),
          "Answers must reference a question/request",
        );
    }
    let reviewCommit;
    if (o.commit !== undefined) {
      ensure(
        agent === coordinatorOf(ctx.policy) &&
          reviewersOf(ctx.policy).includes(to) &&
          o.kind === "request" &&
          messageTask,
        "Only coordinator task requests to reviewers may pin a review commit",
      );
      reviewCommit = git(
        ["rev-parse", "--verify", "--end-of-options", `${o.commit}^{commit}`],
        ctx.root,
      );
      ensure(/^[a-f0-9]{40}$/.test(reviewCommit), "Invalid review commit");
    }
    return send(ctx, {
      from: agent,
      to,
      kind: o.kind,
      ...(reviewCommit ? { reviewCommit } : {}),
      task: messageTask,
      replyTo: o["reply-to"] ?? null,
      text: await text(o, ctx.root),
    });
  }
  const id = task(o.task);
  if (command === "schedule") {
    ensure(
      agent === coordinatorOf(ctx.policy),
      "Only the coordinator publishes scheduling metadata",
    );
    ensure(
      Object.keys(o).every((key) =>
        [
          "agent",
          "task",
          "priority",
          "dependencies-json",
          "enqueued-at",
        ].includes(key),
      ),
      "Unknown schedule option",
    );
    // Require an actual committed task card; a priority entry does not authorize implementation.
    git(["show", `HEAD:${ctx.policy.tasksPath}/${id}.md`], ctx.root);
    ensure(priorities.includes(o.priority), "Unknown scheduling priority");
    const prior = await read(taskPath(ctx, id, "metadata.json"), null);
    const assignment = await read(taskPath(ctx, id, "assignment.json"), null);
    const enqueuedAt =
      prior?.enqueuedAt ??
      (o["enqueued-at"] === undefined
        ? assignment
          ? Date.parse(assignment.at)
          : Date.now()
        : Number(o["enqueued-at"]));
    ensure(
      Number.isSafeInteger(enqueuedAt) &&
        enqueuedAt >= 0 &&
        enqueuedAt <= Date.now(),
      "Enqueue time must be a nonfuture epoch millisecond integer",
    );
    ensure(
      !prior ||
        o["enqueued-at"] === undefined ||
        Number(o["enqueued-at"]) === prior.enqueuedAt,
      "Existing enqueue time is immutable",
    );
    const dependsOn = schedulingDependencies(
      o["dependencies-json"] === undefined
        ? (prior?.dependsOn ?? [])
        : JSON.parse(o["dependencies-json"]),
      id,
    );
    const metadata = {
      version: 1,
      priority: o.priority,
      dependsOn,
      reviewOf: null,
      enqueuedAt,
      updatedBy: coordinatorOf(ctx.policy),
    };
    await put(taskPath(ctx, id, "metadata.json"), metadata);
    return metadata;
  }
  if (command === "scope") {
    ensure(
      agent === coordinatorOf(ctx.policy),
      "Only the coordinator publishes scope",
    );
    const paths = scopePaths(JSON.parse(o["paths-json"]));
    // Known scopes are exclusive across lanes as well as pipelined submissions.
    // Unknown legacy cross-lane scopes remain governed by the engineering protocol.
    const entries = await taskEntries(ctx);
    const own = entries.find((entry) => entry.id === id);
    for (const entry of entries) {
      if (entry.id === id || entry.accepted) continue;
      const otherPaths =
        own && !own.accepted && entry.assignment.owner === own.assignment.owner
          ? await knownScope(ctx, entry.id)
          : await optionalScope(ctx, entry.id);
      if (otherPaths)
        ensure(
          !overlaps(paths, otherPaths),
          `Coordinator scopes overlap with ${entry.id}`,
        );
    }
    const scope = {
      version: 1,
      task: id,
      paths,
      at: new Date().toISOString(),
      by: coordinatorOf(ctx.policy),
    };
    await put(taskPath(ctx, id, "scope.json"), scope);
    return scope;
  }
  if (command === "assign") {
    ensure(
      agent === coordinatorOf(ctx.policy),
      "Only the coordinator assigns tasks",
    );
    const owner = lane(o.owner);
    ensure(
      !reviewersOf(ctx.policy).includes(owner),
      "Send reviewers a pinned verification request; do not assign implementation ownership",
    );
    ensure(o.ref, "Assignment requires an approved --ref commit");
    const baseCommit = git(
      ["rev-parse", "--verify", `${o.ref}^{commit}`],
      ctx.root,
    );
    const primaryHead = git(["rev-parse", "HEAD"], ctx.primary);
    try {
      git(["merge-base", "--is-ancestor", baseCommit, primaryHead], ctx.root);
    } catch {
      throw new Error("Assignment base must be primary HEAD or its ancestor");
    }
    const card = git(
      ["show", `${baseCommit}:${ctx.policy.tasksPath}/${id}.md`],
      ctx.root,
    );
    const cardOwner = card.match(
      /Owner(?: lane)?: ([A-Za-z][A-Za-z0-9_-]{0,63})\b/,
    );
    ensure(
      cardOwner?.[1] === owner,
      "Owner does not match the committed task card",
    );
    for (const entry of await taskEntries(ctx)) {
      if (entry.id === id || entry.accepted) continue;
      if (entry.assignment.owner === owner) {
        ensure(
          entry.status?.state === "ready",
          `Lane ${owner} already has active task ${entry.id}`,
        );
        ensure(
          !overlaps(await knownScope(ctx, id), await knownScope(ctx, entry.id)),
          `Coordinator scopes overlap with ${entry.id}`,
        );
      } else {
        const mine = await optionalScope(ctx, id),
          other = await optionalScope(ctx, entry.id);
        if (mine && other)
          ensure(
            !overlaps(mine, other),
            `Coordinator scopes overlap with ${entry.id}`,
          );
      }
    }
    const assignment = {
      task: id,
      owner,
      baseCommit,
      at: new Date().toISOString(),
      text: await text(o, ctx.root),
    };
    await put(taskPath(ctx, id, "assignment.json"), assignment, true);
    return assignment;
  }
  const assignment = await read(taskPath(ctx, id, "assignment.json"));
  if (command === "claim") {
    ensure(agent === assignment.owner, "Assigned to another lane");
    ensure(
      agent === coordinatorOf(ctx.policy) || ctx.root !== ctx.primary,
      "Workers must use isolated linked worktrees, not the primary checkout",
    );
    git(
      ["merge-base", "--is-ancestor", assignment.baseCommit, "HEAD"],
      ctx.root,
    );
    await executionGuard(ctx, id, agent);
    const branch = git(["branch", "--show-current"], ctx.root);
    ensure(branch, "Claim requires a named branch");
    const claim = {
      agent,
      task: id,
      worktree: ctx.root,
      branch,
      at: new Date().toISOString(),
    };
    await put(taskPath(ctx, id, "claim.json"), claim, true);
    return claim;
  }
  if (command === "release") {
    ensure(
      agent === coordinatorOf(ctx.policy),
      "Only the coordinator releases abandoned work",
    );
    ensure(
      !(await read(taskPath(ctx, id, "accepted.json"), null)),
      "Accepted work needs a new task, not release",
    );
    const note = await text(o, ctx.root);
    const archive = join(ctx.store, "archive", `${id}-${randomUUID()}`);
    await mkdir(dirname(archive), { recursive: true, mode: 0o700 });
    await rename(dirname(taskPath(ctx, id, "assignment.json")), archive);
    await send(ctx, {
      from: agent,
      to: "all",
      kind: "update",
      task: id,
      replyTo: null,
      text: `Released task; prior state archived at ${archive}. ${note}`,
    });
    return { archive };
  }
  if (command === "accept") {
    const primaryHead = git(["rev-parse", "HEAD"], ctx.primary);
    ensure(
      git(["rev-parse", "HEAD"], ctx.root) === primaryHead,
      "Acceptance requires the current primary integration HEAD, not an unintegrated worktree tip",
    );
    ensure(
      agent === coordinatorOf(ctx.policy),
      "Only the coordinator accepts integration",
    );
    const status = await read(taskPath(ctx, id, "status.json"));
    ensure(
      status.state === "ready" && status.commit,
      "Task must be ready with a handoff commit",
    );
    ensure(o.commit, "Acceptance requires --commit integration-SHA");
    const commit = git(
      ["rev-parse", "--verify", `${o.commit}^{commit}`],
      ctx.root,
    );
    ensure(
      commit === git(["rev-parse", "HEAD"], ctx.root),
      "Accept current integration HEAD only",
    );
    const strategy = o.strategy || "ff";
    ensure(
      ["ff", "rebase", "squash"].includes(strategy),
      "Unknown integration strategy",
    );
    ensure(
      strategy === "ff" || o["integration-base"],
      "Rewritten integration requires --integration-base before integration",
    );
    const integrationBase = git(
      [
        "rev-parse",
        "--verify",
        `${o["integration-base"] || assignment.baseCommit}^{commit}`,
      ],
      ctx.root,
    );
    git(
      ["merge-base", "--is-ancestor", assignment.baseCommit, integrationBase],
      ctx.root,
    );
    git(["merge-base", "--is-ancestor", integrationBase, commit], ctx.root);
    ensure(
      git(
        ["rev-list", "--merges", `${integrationBase}..${commit}`],
        ctx.root,
      ) === "",
      "Integration must not introduce merge commits",
    );
    if (strategy === "ff") {
      git(["merge-base", "--is-ancestor", status.commit, commit], ctx.root);
    } else {
      const sourceBase = git(
        ["merge-base", status.commit, integrationBase],
        ctx.root,
      );
      const diff = (base, tip) =>
        git(
          [
            "diff",
            "--binary",
            "--full-index",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            base,
            tip,
            "--",
          ],
          ctx.root,
        );
      const sourceDiff = diff(sourceBase, status.commit);
      ensure(
        sourceDiff && sourceDiff === diff(integrationBase, commit),
        "Integrated changes differ from ready handoff; refresh and review handoff",
      );
      if (strategy === "squash")
        ensure(
          git(
            ["rev-list", "--count", `${integrationBase}..${commit}`],
            ctx.root,
          ) === "1",
          "Squash integration requires one resulting commit",
        );
    }
    ensure(
      git(["status", "--porcelain"], ctx.root) === "",
      "Integration worktree must be clean",
    );
    const accepted = {
      agent,
      task: id,
      commit,
      sourceCommit: status.commit,
      strategy,
      integrationBase,
      at: new Date().toISOString(),
      text: await text(o, ctx.root),
    };
    await put(taskPath(ctx, id, "accepted.json"), accepted, true);
    return accepted;
  }
  ensure(["status", "checkpoint"].includes(command), "Unknown task action");
  const checkpointing = command === "checkpoint";
  if (checkpointing) {
    ensure(
      !o.state && !o.commit,
      "Checkpoint records blocked state without a new submission SHA",
    );
    o.state = "blocked";
  }
  await claimed(ctx, id, agent);
  ensure(
    ["working", "blocked", "ready"].includes(o.state),
    "State must be working, blocked or ready",
  );
  const previous = await read(taskPath(ctx, id, "status.json"), null);
  const revising = previous?.state === "ready" && o.state === "working";
  if (o.state === "working") {
    await executionGuard(ctx, id, agent, revising);
    if (revising)
      ensure(
        await outstandingRevision(ctx, id, agent),
        "Frozen submission requires an outstanding coordinator revision request",
      );
  }
  if (checkpointing) {
    ensure(
      previous?.state !== "ready",
      "Frozen submission requires an explicit working revision transition through its original claim",
    );
    await executionGuard(ctx, id, agent);
  }
  let commit = null;
  if (o.state === "ready") {
    ensure(o.commit, "Ready requires --commit HEAD (or exact SHA)");
    commit = git(["rev-parse", "--verify", `${o.commit}^{commit}`], ctx.root);
    ensure(
      commit === git(["rev-parse", "HEAD"], ctx.root),
      "Ready commit must be current worktree HEAD",
    );
    ensure(
      git(["status", "--porcelain"], ctx.root) === "",
      "Commit or remove task-local changes before ready",
    );
  }
  if (
    previous?.state === "ready" &&
    (o.state !== "ready" || commit !== previous.commit)
  ) {
    if (o.state !== "working") await executionGuard(ctx, id, agent);
    ensure(
      o.state === "working",
      "Frozen submission requires an explicit working revision transition through its original claim",
    );
  }
  const status = {
    agent,
    task: id,
    state: o.state,
    ...(checkpointing ? { checkpointed: true } : {}),
    commit,
    at: new Date().toISOString(),
    text: await text(o, ctx.root),
  };
  const event = await send(ctx, {
    from: agent,
    to: coordinatorOf(ctx.policy),
    kind: o.state === "ready" ? "handoff" : "update",
    task: id,
    replyTo: null,
    text: status.text,
    state: status.state,
    ...(checkpointing ? { checkpointed: true } : {}),
    commit,
  });
  await put(taskPath(ctx, id, "status.json"), {
    ...status,
    messageId: event.id,
  });
  return status;
}

if (import.meta.main) {
  try {
    const result = await main();
    console.log(
      typeof result === "string" ? result : JSON.stringify(result, null, 2),
    );
  } catch (error) {
    console.error(
      `agents: ${error.code === "EEXIST" ? "Record already exists; inspect board/claim before retrying" : error.message}`,
    );
    process.exitCode = 1;
  }
}
