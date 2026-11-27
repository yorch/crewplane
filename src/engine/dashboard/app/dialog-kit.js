// One modal <dialog> pattern for the palette, the shortcut list and the
// preferences, the same as the evidence lightbox and the control dialogs:
// opened with showModal, labelled by its title, focus moved inside, Tab kept
// inside, Escape or the Close button closes it, and focus returns to what
// opened it. No inline styles or handlers; every string is set as text.
import { el } from "./dom.js";

const FOCUSABLE =
  "button, input, select, textarea, a[href], summary, [tabindex='0']";
function focusables(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter(
    (node) =>
      !node.disabled &&
      !node.hidden &&
      !node.closest("[hidden]") &&
      node.getAttribute("aria-hidden") !== "true",
  );
}
export function trapTab(event, root) {
  if (event.key !== "Tab") return;
  const nodes = focusables(root);
  if (!nodes.length) {
    event.preventDefault();
    return;
  }
  const first = nodes[0];
  const last = nodes.at(-1);
  const active = document.activeElement;
  if (event.shiftKey && (active === first || active === root)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  } else if (!root.contains(active)) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * Creates (once) a modal and returns controls for it. `build` fills the body.
 * `onClose` runs after the dialog closed, before focus is restored.
 */
export function createModal({ id, title, className = "", onClose }) {
  const dialog = el("dialog", undefined, `modal ${className}`.trim());
  dialog.id = id;
  const titleId = `${id}-title`;
  dialog.setAttribute("aria-labelledby", titleId);
  const head = el("div", undefined, "modal-head");
  const heading = el("h2", title, "modal-title");
  heading.id = titleId;
  heading.tabIndex = -1;
  const close = el("button", "Close", "text-button modal-close");
  close.type = "button";
  close.addEventListener("click", () => dialog.close());
  head.append(heading, close);
  const body = el("div", undefined, "modal-body");
  dialog.append(head, body);
  let opener = null;
  dialog.addEventListener("keydown", (event) => trapTab(event, dialog));
  // A click on the backdrop reports the dialog itself as its target.
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", () => {
    onClose?.();
    const target = opener?.isConnected
      ? opener
      : document.getElementById("view-title");
    opener = null;
    target?.focus({ preventScroll: true });
  });
  document.body.append(dialog);
  return {
    dialog,
    body,
    heading,
    get isOpen() {
      return dialog.open;
    },
    open(focusTarget) {
      if (dialog.open) return;
      opener =
        document.activeElement && document.activeElement !== document.body
          ? document.activeElement
          : null;
      dialog.showModal();
      (focusTarget ?? heading).focus({ preventScroll: true });
    },
    close() {
      if (dialog.open) dialog.close();
    },
  };
}
export function anyDialogOpen() {
  return document.querySelector("dialog[open]") !== null;
}
