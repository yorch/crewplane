import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Node, SourceFile } from "typescript/unstable/ast";
import { SyntaxKind } from "typescript/unstable/ast";
import { API } from "typescript/unstable/sync";
import { afterAll, beforeAll, expect, it } from "vitest";

/**
 * The lane revision pins every widening control, so a record's `status` or
 * `pauseKind` may only change through the supervisor's `transition` helper.
 * This is a syntactic rule over the parsed source (TypeScript's native API,
 * which is "unstable" but pinned by the lockfile) rather than a text search:
 *
 *  - any assignment, compound assignment, increment, delete, destructuring
 *    target or for-in/of target naming `.status` / `.pauseKind` (dot, string or
 *    template literal element access) is flagged;
 *  - an element write whose key is not a literal is flagged unless the target
 *    is one of the supervisor's own non-record maps (`DYNAMIC_TARGETS`);
 *  - `Object.assign`, `Object.defineProperty/ies`, `Object.setPrototypeOf` and
 *    `Reflect.set/defineProperty/deleteProperty/setPrototypeOf` are banned
 *    outright (the supervisor has no use for them);
 *  - an object literal naming `status` or `pauseKind` (identifier, string,
 *    shorthand, computed-literal key) or any non-literal computed key is
 *    flagged, because such a literal is how a replacement record is minted.
 *    Allowed: a literal inside `JSON.stringify(...)` (a log line stores
 *    nothing) and the initializer of a `RecordState`-typed declaration whose
 *    `status` is the fresh-record value `"idle"` (or `<stored>.status ?? "idle"`)
 *    and which sets no `pauseKind`; every later change goes through transition.
 *
 * Known limit: a record mutated through a function that receives it under
 * another static type is still caught by name (the property name is the rule),
 * but a write through an alias to the property name held in a variable is only
 * caught when the target is not an allowlisted map.
 */
const GUARDED = new Set(["status", "pauseKind"]);
const DYNAMIC_TARGETS = new Set([
  "state.records",
  "state.laneRev",
  "state.notices",
  "state.noticeQueuedAt",
  "state.controlOutcome",
  "retired",
]);
const BANNED_CALLS = new Set([
  "Object.assign",
  "Object.defineProperty",
  "Object.defineProperties",
  "Object.setPrototypeOf",
  "Reflect.set",
  "Reflect.defineProperty",
  "Reflect.deleteProperty",
  "Reflect.setPrototypeOf",
]);
type N = Node & Record<string, unknown>;
const asNode = (value: unknown) => value as N;
const nodes = (value: unknown) => (value ? [...(value as Iterable<N>)] : []);
const unwrap = (node: N): N => {
  let current = node;
  while (
    [
      SyntaxKind.ParenthesizedExpression,
      SyntaxKind.NonNullExpression,
      SyntaxKind.AsExpression,
      SyntaxKind.TypeAssertionExpression,
      SyntaxKind.SatisfiesExpression,
    ].includes(current.kind)
  )
    current = asNode(current.expression);
  return current;
};
const literalText = (node: N): string | undefined =>
  [
    SyntaxKind.StringLiteral,
    SyntaxKind.NoSubstitutionTemplateLiteral,
    SyntaxKind.NumericLiteral,
  ].includes(node.kind)
    ? (node.text as string)
    : undefined;
const nameOf = (name: N): string | undefined => {
  if (name.kind === SyntaxKind.ComputedPropertyName) {
    const inner = unwrap(asNode(name.expression));
    return literalText(inner) ?? "<computed>";
  }
  return (name.text as string | undefined) ?? literalText(name);
};

function findRecordWrites(source: string, file: SourceFile) {
  const offenders: string[] = [];
  const report = (node: N, why: string) => {
    const line = source.slice(0, node.pos).split("\n").length;
    offenders.push(`${why} (near line ${line})`);
  };
  const textOf = (node: N) => source.slice(node.pos, node.end).trim();
  const checkTarget = (raw: N): void => {
    const target = unwrap(raw);
    if (target.kind === SyntaxKind.PropertyAccessExpression) {
      const name = nameOf(asNode(target.name));
      if (name && GUARDED.has(name)) report(target, `write to .${name}`);
    } else if (target.kind === SyntaxKind.ElementAccessExpression) {
      const key = literalText(unwrap(asNode(target.argumentExpression)));
      if (key !== undefined) {
        if (GUARDED.has(key)) report(target, `write to ["${key}"]`);
      } else if (!DYNAMIC_TARGETS.has(textOf(asNode(target.expression))))
        report(target, "write through a computed key");
    } else if (target.kind === SyntaxKind.ObjectLiteralExpression) {
      for (const property of nodes(target.properties)) {
        if (property.kind === SyntaxKind.PropertyAssignment)
          checkTarget(asNode(property.initializer));
        else if (property.kind === SyntaxKind.SpreadAssignment)
          checkTarget(asNode(property.expression));
      }
    } else if (target.kind === SyntaxKind.ArrayLiteralExpression) {
      for (const element of nodes(target.elements)) checkTarget(element);
    } else if (target.kind === SyntaxKind.SpreadElement)
      checkTarget(asNode(target.expression));
    else if (
      target.kind === SyntaxKind.BinaryExpression &&
      asNode(target.operatorToken).kind === SyntaxKind.EqualsToken
    )
      checkTarget(asNode(target.left));
  };
  const freshIdle = (value: N) => {
    const inner = unwrap(value);
    if (literalText(inner) === "idle") return true;
    return (
      inner.kind === SyntaxKind.BinaryExpression &&
      asNode(inner.operatorToken).kind === SyntaxKind.QuestionQuestionToken &&
      literalText(unwrap(asNode(inner.right))) === "idle"
    );
  };
  const checkLiteral = (literal: N, allowFresh: boolean) => {
    for (const property of nodes(literal.properties)) {
      if (property.kind === SyntaxKind.SpreadAssignment) continue;
      const name = nameOf(asNode(property.name));
      if (name === "<computed>") report(property, "computed object key");
      else if (name && GUARDED.has(name)) {
        const fresh =
          allowFresh &&
          name === "status" &&
          property.kind === SyntaxKind.PropertyAssignment &&
          freshIdle(asNode(property.initializer));
        if (!fresh) report(property, `object literal sets ${name}`);
      }
    }
  };
  const isRecordDeclaration = (declaration: N) => {
    const type = declaration.type ? asNode(declaration.type) : undefined;
    return (
      !!type &&
      type.kind === SyntaxKind.TypeReference &&
      asNode(type.typeName).text === "RecordState"
    );
  };
  const freshLiterals = (initializer: N, out: Set<N>) => {
    const inner = unwrap(initializer);
    if (inner.kind === SyntaxKind.ObjectLiteralExpression) out.add(inner);
    else if (inner.kind === SyntaxKind.BinaryExpression) {
      freshLiterals(asNode(inner.left), out);
      freshLiterals(asNode(inner.right), out);
    } else if (inner.kind === SyntaxKind.ConditionalExpression) {
      freshLiterals(asNode(inner.whenTrue), out);
      freshLiterals(asNode(inner.whenFalse), out);
    }
  };
  const fresh = new Set<N>();
  const visit = (raw: Node, logging: boolean): void => {
    const node = raw as N;
    switch (node.kind) {
      case SyntaxKind.VariableDeclaration:
        if (asNode(node.name).text === "transition") return;
        if (node.initializer && isRecordDeclaration(node))
          freshLiterals(asNode(node.initializer), fresh);
        break;
      case SyntaxKind.BinaryExpression: {
        const kind = asNode(node.operatorToken).kind;
        if (
          kind >= SyntaxKind.FirstAssignment &&
          kind <= SyntaxKind.LastAssignment
        )
          checkTarget(asNode(node.left));
        break;
      }
      case SyntaxKind.PrefixUnaryExpression:
      case SyntaxKind.PostfixUnaryExpression: {
        const operator = node.operator as number;
        if (
          operator === SyntaxKind.PlusPlusToken ||
          operator === SyntaxKind.MinusMinusToken
        )
          checkTarget(asNode(node.operand));
        break;
      }
      case SyntaxKind.DeleteExpression:
        checkTarget(asNode(node.expression));
        break;
      case SyntaxKind.ForInStatement:
      case SyntaxKind.ForOfStatement:
        if (
          asNode(node.initializer).kind !== SyntaxKind.VariableDeclarationList
        )
          checkTarget(asNode(node.initializer));
        break;
      case SyntaxKind.CallExpression: {
        const callee = textOf(asNode(node.expression));
        if (BANNED_CALLS.has(callee)) report(node, `call to ${callee}`);
        if (callee === "JSON.stringify") {
          for (const argument of nodes(node.arguments)) visit(argument, true);
          visit(asNode(node.expression), logging);
          return;
        }
        break;
      }
      case SyntaxKind.ObjectLiteralExpression:
        if (!logging) checkLiteral(node, fresh.has(node));
        break;
    }
    raw.forEachChild((child) => visit(child, logging));
  };
  visit(file, false);
  return offenders;
}

let directory = "";
let api: API;
const sources = new Map<string, string>();
const files = new Map<string, SourceFile>();
const wrap = (body: string) =>
  `type RecordState = { status: string; pauseKind?: string };
declare const state: { records: Record<string, RecordState>; laneRev: Record<string, number> };
declare const record: RecordState;
declare const key: string;
declare const other: Record<string, unknown>;
const transition = (r: RecordState, status: string) => {
  r.status = status;
  delete r.pauseKind;
  Object.assign(r, { status });
};
${body}
`;
const clean: Record<string, string> = {
  reads: `const s = record.status; const { pauseKind } = record; console.log(s, pauseKind);`,
  "log line": `console.log(JSON.stringify({ event: "finished", status: record.status }));`,
  "fresh typed record": `const old = state.records.a; const made: RecordState = old ?? { status: "idle" }; state.records.b = made;`,
  "stored status carried": `const failed: RecordState = { ...old, status: state.records.a?.status ?? "idle" };`,
  "record map writes": `state.records[key] = record; delete state.records[key]; state.laneRev[key] = 1;`,
  "through transition": `transition(record, "paused");`,
  "unrelated properties": `const o = { statusCode: 1, paused: true }; (o as any).kind = "x";`,
};
const bypasses: Record<string, string> = {
  "dot assignment": `record.status = "idle";`,
  "bracket assignment": `record["status"] = "paused";`,
  "template key": "record[`pauseKind`] = undefined;",
  "compound assignment": `record.status ||= "idle";`,
  "nullish assignment": `record.pauseKind ??= "failure";`,
  "string concat assignment": `record.status += "x";`,
  "dot delete": `delete record.pauseKind;`,
  "bracket delete": `delete record["pauseKind"];`,
  "cast target": `(record as any).status = "paused";`,
  "non-null target": `record!.pauseKind = "failure";`,
  "inside a closure": `const f = async () => { await 0; record.status = "paused"; }; f();`,
  "Object.assign": `Object.assign(record, { status: "paused" });`,
  "Object.assign with a variable": `Object.assign(record, other);`,
  "Object.defineProperty": `Object.defineProperty(record, "status", { value: "x" });`,
  "Reflect.set": `Reflect.set(record, "pauseKind", "failure");`,
  "Reflect.deleteProperty": `Reflect.deleteProperty(record, "pauseKind");`,
  "object destructuring target": `({ status: record.status } = other as any);`,
  "array destructuring target": `[record.pauseKind] = ["failure"] as any;`,
  "for-of target": `for (record.status of ["a"]) void 0;`,
  "spread replacement with status": `state.records[key] = { ...record, status: "paused" };`,
  "spread replacement with pauseKind": `state.records[key] = { ...record, pauseKind: undefined };`,
  "quoted key replacement": `state.records[key] = { ...record, "status": "paused" };`,
  "computed literal key": `state.records[key] = { ...record, ["status"]: "paused" };`,
  "computed dynamic key": `state.records[key] = { ...record, [key]: "paused" };`,
  "shorthand replacement": `const status = "paused"; state.records[key] = { ...record, status };`,
  "typed construction not idle": `const made: RecordState = { status: "paused" }; state.records[key] = made;`,
  "typed construction with pauseKind": `const made: RecordState = { status: "idle", pauseKind: "failure" }; state.records[key] = made;`,
  "dynamic property write": `(record as any)[key] = "paused";`,
  "alias through a variable": `const prop = "status"; (record as any)[prop] = "paused";`,
};

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "crewplane-scan-"));
  await mkdir(directory, { recursive: true });
  const names: string[] = [];
  for (const [label, body] of [
    ...Object.entries(clean).map(([k, v]) => [`clean:${k}`, v] as const),
    ...Object.entries(bypasses).map(([k, v]) => [`bypass:${k}`, v] as const),
  ]) {
    const name = `case-${names.length}.ts`;
    names.push(name);
    const source = wrap(body);
    sources.set(label, source);
    await writeFile(join(directory, name), source);
  }
  const real = new URL("./supervisor.ts", import.meta.url);
  sources.set("real", await readFile(real, "utf8"));
  await writeFile(join(directory, "real.ts"), sources.get("real") as string);
  names.push("real.ts");
  const anchor = "          record.cwd = cwd;\n";
  const realText = sources.get("real") as string;
  if (!realText.includes(anchor)) throw new Error("mutation anchor moved");
  sources.set(
    "real-mutated",
    realText.replace(anchor, `${anchor}          record.status = "idle";\n`),
  );
  await writeFile(
    join(directory, "real-mutated.ts"),
    sources.get("real-mutated") as string,
  );
  names.push("real-mutated.ts");
  await writeFile(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { noLib: true, noResolve: true, types: [] },
      files: names,
    }),
  );
  api = new API({ cwd: directory });
  const snapshot = api.updateSnapshot({
    openProject: join(directory, "tsconfig.json"),
  });
  const program = snapshot.getProjects()[0]?.program;
  let index = 0;
  for (const label of sources.keys()) {
    const name =
      label === "real"
        ? "real.ts"
        : label === "real-mutated"
          ? "real-mutated.ts"
          : `case-${index++}.ts`;
    const file = program?.getSourceFile(join(directory, name));
    if (!file) throw new Error(`Could not parse ${label}`);
    files.set(label, file);
  }
});
afterAll(async () => {
  api?.close();
  await rm(directory, { recursive: true, force: true });
});

const scan = (label: string) =>
  findRecordWrites(
    sources.get(label) as string,
    files.get(label) as SourceFile,
  );

it("accepts reads, log lines, fresh typed records and the transition helper itself", () => {
  for (const label of Object.keys(clean))
    expect(scan(`clean:${label}`), label).toEqual([]);
});

it.each(Object.keys(bypasses))("catches the bypass form: %s", (label) => {
  expect(scan(`bypass:${label}`).length, label).toBeGreaterThan(0);
});

it("never assigns a record's status or pause kind outside the one revision-bumping helper", () => {
  expect(scan("real"), "route these through transition()").toEqual([]);
});

it("is not vacuous: one injected assignment in the real supervisor source is reported", () => {
  expect(scan("real-mutated")).toHaveLength(1);
});
