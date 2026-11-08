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
export function gitEnvironment(
  input: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(input).filter(
      ([key]) => !repositoryVariables.has(key) && !key.startsWith("GIT_CONFIG"),
    ),
  );
}
