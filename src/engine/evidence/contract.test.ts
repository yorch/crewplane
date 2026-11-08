import { expect, it } from "vitest";
import {
  defaultEvidenceLimits,
  evidenceCommitPattern,
  evidenceIdPattern,
  evidenceRoutes,
  evidenceTaskPattern,
} from "./contract.ts";

it("freezes opaque identity, secret-free route keys and bounded evidence defaults", () => {
  expect(evidenceIdPattern.test(`ev_${"a".repeat(32)}`)).toBe(true);
  for (const value of [
    "../secret",
    "ev_../../secret",
    "/tmp/video.webm",
    "token=private",
  ])
    expect(evidenceIdPattern.test(value)).toBe(false);
  expect(evidenceTaskPattern.test("P0-20")).toBe(true);
  expect(evidenceCommitPattern.test("b".repeat(40))).toBe(true);
  expect(evidenceRoutes.some((route) => route.includes("?"))).toBe(false);
  expect(defaultEvidenceLimits.maxArtifactBytes).toBeLessThan(
    defaultEvidenceLimits.maxRunBytes,
  );
  expect(defaultEvidenceLimits.maxRunBytes).toBeLessThan(
    defaultEvidenceLimits.maxTotalBytes,
  );
});
