// Applies a saved light or dark choice before the first paint. It is an
// external, blocking classic script (not inline, so the content security policy
// is unchanged) and it only ever sets one attribute. With no saved choice the
// stylesheet follows the system setting by itself. Storage may be blocked.
try {
  const theme = window.localStorage.getItem("crewplane.theme");
  if (theme === "light" || theme === "dark")
    document.documentElement.dataset.theme = theme;
} catch {
  // No storage: the system preference applies.
}
