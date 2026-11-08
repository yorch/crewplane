import { expect, test } from "vitest";
import { nextVersion } from "./version.ts";

test("bumps and validates versions", () => {
  expect(nextVersion("0.1.0", "patch")).toBe("0.1.1");
  expect(nextVersion("0.1.9", "minor")).toBe("0.2.0");
  expect(nextVersion("1.4.2", "major")).toBe("2.0.0");
  expect(nextVersion("0.1.0", "0.3.0")).toBe("0.3.0");
  expect(() => nextVersion("0.2.0", "0.2.0")).toThrow();
  expect(() => nextVersion("0.2.0", "0.1.0")).toThrow();
  expect(() => nextVersion("0.2.0", "v1")).toThrow();
});
