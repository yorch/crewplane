import releaseKeyFile from "../release-keys.json" with { type: "json" };
import { parseReleaseKeys, type ReleaseKey } from "./release-signing.ts";

/**
 * Trusted release keys, bundled from `release-keys.json` at build time. An
 * empty list means signing is not enabled yet and updates stay SHA-256 only.
 *
 * `CREWPLANE_TEST_RELEASE_KEYS` replaces the list for tests of source runs and
 * plain builds. `build:release` defines it to `undefined`, which removes this
 * branch from the shipped binary, so no environment can swap the trusted keys
 * of a real release.
 */
export function embeddedReleaseKeys(): ReleaseKey[] {
  const override = process.env.CREWPLANE_TEST_RELEASE_KEYS;
  if (override !== undefined && override !== "")
    return parseReleaseKeys(JSON.parse(override));
  return parseReleaseKeys(releaseKeyFile);
}
