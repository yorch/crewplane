export type Bump = "major" | "minor" | "patch";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export function nextVersion(current: string, request: string): string {
  const match = SEMVER.exec(current);
  if (!match) throw new Error(`current version is not x.y.z: ${current}`);
  const [major, minor, patch] = match.slice(1).map(Number) as [
    number,
    number,
    number,
  ];
  let next: string;
  if (request === "major") next = `${major + 1}.0.0`;
  else if (request === "minor") next = `${major}.${minor + 1}.0`;
  else if (request === "patch") next = `${major}.${minor}.${patch + 1}`;
  else if (SEMVER.test(request)) next = request;
  else throw new Error(`expected major|minor|patch|x.y.z, got: ${request}`);
  if (compare(next, current) <= 0)
    throw new Error(`${next} must be greater than ${current}`);
  return next;
}

function compare(a: string, b: string): number {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
