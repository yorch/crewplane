import { el } from "./dom.js";

// The instance hold (pause --all) is lifted only from the CLI: the dashboard
// never sends resume --all. Wherever the page says the hold is on, it also says
// how to lift it, with a command the operator can copy as it is.
export const RESUME_ALL_COMMAND = "crewplane resume --all true";

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** The notice for an active instance hold, or null when none is on. */
export function instanceHoldNotice(headless) {
  if (headless?.instanceHeld !== true) return null;
  const box = el("div", undefined, "instance-hold");
  box.dataset.hold = "instance";
  box.setAttribute("role", "note");
  const code = el("code", RESUME_ALL_COMMAND, "instance-hold-command");
  const status = el("span", undefined, "instance-hold-status");
  status.setAttribute("role", "status");
  const copy = el("button", "Copy command", "text-button");
  copy.type = "button";
  copy.dataset.focusKey = "instance-hold:copy";
  copy.addEventListener("click", async () => {
    status.textContent = (await copyText(RESUME_ALL_COMMAND))
      ? "Copied"
      : "Select the command and copy it";
  });
  box.append(
    el(
      "p",
      "An instance hold is on: no agent starts new runs. The dashboard cannot lift it. In the project's terminal, run:",
      "instance-hold-text",
    ),
    code,
    copy,
    status,
  );
  return box;
}
