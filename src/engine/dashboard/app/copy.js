import { el } from "./dom.js";

// Copy-to-clipboard buttons. The page only ever copies text it displays (fixed
// suggested commands, a digest); it never runs anything. Feedback goes to a
// polite live region and the button label, and survives a re-render for 2s.
const recent = new Map();

function announce(text) {
  const region = document.getElementById("copy-status");
  if (region) region.textContent = text;
}

/** Writes to the clipboard; false when the browser refuses (no permission, no API). */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fall through to the selection-based fallback.
  }
  const area = el("textarea");
  area.value = text;
  area.setAttribute("aria-hidden", "true");
  area.className = "copy-scratch";
  document.body.append(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

/**
 * A button that copies `text`. `what` names it for assistive technology
 * ("command crewplane doctor"); `key` keeps focus and the "Copied" state across
 * re-renders.
 */
export function copyButton(text, { key, what }) {
  const button = el(
    "button",
    recent.has(key) ? "Copied" : "Copy",
    "copy-button",
  );
  button.type = "button";
  button.dataset.focusKey = `copy:${key}`;
  button.setAttribute("aria-label", `Copy ${what}`);
  button.addEventListener("click", async () => {
    const ok = await copyText(text);
    clearTimeout(recent.get(key));
    if (ok) {
      recent.set(
        key,
        setTimeout(() => {
          recent.delete(key);
          for (const node of document.querySelectorAll(
            `[data-focus-key="${CSS.escape(`copy:${key}`)}"]`,
          ))
            node.textContent = "Copy";
        }, 2000),
      );
    } else recent.delete(key);
    for (const node of document.querySelectorAll(
      `[data-focus-key="${CSS.escape(`copy:${key}`)}"]`,
    ))
      node.textContent = ok ? "Copied" : "Copy failed";
    announce(
      ok
        ? `Copied ${what}.`
        : `Could not copy ${what}. Select the text and copy it yourself.`,
    );
  });
  return button;
}
