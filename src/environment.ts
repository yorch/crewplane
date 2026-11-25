/** Git's repository-local environment must never override an explicit project/cwd. */
const repositoryVariables = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
  "GIT_INTERNAL_SUPER_PREFIX",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_SHALLOW_FILE",
  "GIT_REPLACE_REF_BASE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
]);
/** Config-location selectors are safe; counted overrides can inject config. */
const allowedConfigVariables = new Set([
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
]);
export function gitEnvironment(
  input: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(input).filter(
      ([key]) =>
        !repositoryVariables.has(key) &&
        (!key.startsWith("GIT_CONFIG") || allowedConfigVariables.has(key)),
    ),
  );
}

/** Names a lane may opt in to; keeps the child's environment an explicit list. */
export const passEnvName = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const maxPassEnv = 32;
/** Never forwardable, even by opt-in: they steer the runtime, not the harness. */
const forbiddenPassEnv =
  /^(?:NODE_OPTIONS|BUN_OPTIONS|LD_.*|DYLD_.*|BASH_ENV|ENV)$/;
export const validPassEnvName = (name: unknown): name is string =>
  typeof name === "string" &&
  passEnvName.test(name) &&
  !forbiddenPassEnv.test(name) &&
  !name.startsWith("CREWPLANE_");

const baseNames = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "TZ",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "TMPDIR",
  "TMP",
  "TEMP",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  // Windows process basics.
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
]);
const basePrefixes = ["LC_", "XDG_", "GIT_", "CREWPLANE_"];
/** Provider and harness variables each native CLI reads; everything else is opt-in. */
const harnessPrefixes: Record<string, string[]> = {
  codex: ["OPENAI_", "CODEX_"],
  claude: ["ANTHROPIC_", "CLAUDE_"],
  opencode: ["OPENCODE_", "OPENAI_", "ANTHROPIC_"],
  pi: ["PI_", "OPENAI_", "ANTHROPIC_"],
};
/**
 * Environment for an LLM-driven harness child. Starts from the operator's
 * environment but forwards only a safe base, the harness's own provider
 * variables and the lane's explicit `passEnv` names, so unrelated credentials
 * (GITHUB_TOKEN, cloud keys, registry tokens) never reach the agent.
 */
export function harnessEnvironment(
  harness: string,
  passEnv: readonly string[] = [],
  input: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const upper = process.platform === "win32";
  const norm = (key: string) => (upper ? key.toUpperCase() : key);
  const extra = new Set(passEnv.filter(validPassEnvName).map(norm));
  const prefixes = [...basePrefixes, ...(harnessPrefixes[harness] ?? [])];
  const allowed = (key: string) => {
    const k = norm(key);
    return (
      baseNames.has(k) ||
      baseNames.has(k.toUpperCase()) ||
      prefixes.some((prefix) => k.startsWith(prefix)) ||
      extra.has(k)
    );
  };
  const filtered = gitEnvironment(input);
  return Object.fromEntries(
    Object.entries(filtered).filter(([key]) => allowed(key)),
  );
}
