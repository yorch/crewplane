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
/** Steer the runtime, the update path or the supervisor's own wiring; never forwardable. */
const forbiddenPassEnv =
  /^(?:NODE_OPTIONS|BUN_OPTIONS|NODE_PATH|NODE_TLS_REJECT_UNAUTHORIZED|SSLKEYLOGFILE|PYTHONPATH|PYTHONSTARTUP|PERL5OPT|PERL5LIB|RUBYOPT|PROMPT_COMMAND|BASH_ENV|ENV|LD_.*|DYLD_.*|BASH_FUNC_.*|CREWPLANE_(?:RELEASE_.*|UPDATE.*|DISPATCHED|INSTALL_DIR|COORD_DIR|HEADLESS_LANE))$/;
export const passEnvRefusal =
  "NODE_OPTIONS, BUN_OPTIONS, NODE_PATH, LD_*, DYLD_*, BASH_ENV, interpreter startup variables, TLS-weakening variables and Crewplane update/wiring variables";
export const validPassEnvName = (name: unknown): name is string =>
  typeof name === "string" &&
  passEnvName.test(name) &&
  !forbiddenPassEnv.test(name.toUpperCase());

/** Always forwarded. Names are upper-case; matching is case-insensitive on Windows. */
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
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  // Git identity and transport trust only; credential helpers (GIT_ASKPASS,
  // SSH_AUTH_SOCK, GNUPGHOME) are opt-in through a lane's passEnv.
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_SSL_CAINFO",
  "GIT_SSL_CAPATH",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_EDITOR",
  "GIT_TERMINAL_PROMPT",
  // Crewplane location settings the board CLI needs inside the child. The
  // board location (CREWPLANE_COORD_DIR) is set by the supervisor; the control
  // directory is never passed. CREWPLANE_STATE_DIR is only the operator's base
  // override, so `crewplane agents` can derive the same directory to READ run
  // state. Under CREWPLANE_HEADLESS_LANE the CLI refuses configure, start,
  // control verbs, migrate and pin, so a child only reads there. Read-only intent is
  // enforced by a sandbox, not by Crewplane.
  // The update cache (and its supervisor registry) is deliberately NOT forwarded:
  // anything that can write it can forge a supervisor registration.
  "CREWPLANE_STATE_DIR",
  "CREWPLANE_EXECUTABLE",
  "CREWPLANE_RELEASES_DIR",
  "CREWPLANE_NO_AUTO_UPDATE",
  // Windows process basics.
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "OS",
  "USERNAME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "PSMODULEPATH",
]);
const basePrefixes = ["LC_"];
/** Variables each native CLI reads for its own provider; everything else is opt-in. */
const harnessNames: Record<string, string[]> = {
  codex: ["CODEX_HOME", "CODEX_API_KEY", "CODEX_CA_CERTIFICATE"],
  claude: [
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
    "CLAUDE_CODE_SKIP_VERTEX_AUTH",
    "CLAUDE_CODE_GIT_BASH_PATH",
    "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
    "CLOUD_ML_REGION",
  ],
  opencode: [],
  pi: [],
};
const harnessPrefixes: Record<string, string[]> = {
  codex: ["OPENAI_"],
  claude: ["ANTHROPIC_"],
  opencode: ["OPENCODE_", "OPENAI_", "ANTHROPIC_"],
  pi: ["PI_", "OPENAI_", "ANTHROPIC_"],
};
/** Conventional key name for a provider id, e.g. "openrouter" -> OPENROUTER_API_KEY. */
const providerKey = (provider: string | undefined) => {
  const id = provider?.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return id && /^[A-Z][A-Z0-9_]{0,40}$/.test(id) ? `${id}_API_KEY` : undefined;
};
export interface HarnessEnvironmentOptions {
  /** Extra names the lane opted in to (already validated). */
  passEnv?: readonly string[] | undefined;
  /** Provider id for Pi (`piModel.provider`) or OpenCode (`provider/model`). */
  provider?: string | undefined;
  input?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}
/**
 * Environment for an LLM-driven harness child. Starts from the operator's
 * environment but forwards only a safe base, the harness's own provider
 * variables and the lane's explicit `passEnv` names, so unrelated credentials
 * (GITHUB_TOKEN, cloud keys, registry tokens, git credential helpers) never
 * reach the agent. Files under HOME/XDG remain readable: this is not a sandbox.
 */
export function harnessEnvironment(
  harness: string,
  options: HarnessEnvironmentOptions = {},
): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform;
  const norm = (key: string) =>
    platform === "win32" ? key.toUpperCase() : key;
  const names = new Set<string>(
    [
      ...baseNames,
      ...(harnessNames[harness] ?? []),
      ...(options.passEnv ?? []).filter(validPassEnvName),
      ...((harness === "pi" || harness === "opencode") &&
      providerKey(options.provider)
        ? [providerKey(options.provider) as string]
        : []),
    ].map(norm),
  );
  const prefixes = [...basePrefixes, ...(harnessPrefixes[harness] ?? [])].map(
    norm,
  );
  const input = options.input ?? process.env;
  // gitEnvironment compares names case-sensitively; Windows names are not.
  const filtered = gitEnvironment(
    platform === "win32"
      ? Object.fromEntries(
          Object.entries(input).map(([k, v]) => [k.toUpperCase(), v]),
        )
      : input,
  );
  return Object.fromEntries(
    Object.entries(filtered).filter(([key]) => {
      const k = norm(key);
      return names.has(k) || prefixes.some((prefix) => k.startsWith(prefix));
    }),
  );
}

/** True inside a `bun build --compile` executable. */
export const standaloneBinary = (): boolean =>
  (globalThis as { Bun?: { isStandaloneExecutable?: boolean } }).Bun
    ?.isStandaloneExecutable === true;
