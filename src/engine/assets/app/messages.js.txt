import { badge } from "./badges.js";
import { decisionBlock } from "./controls.js";
import {
  closeLink,
  detailHeading,
  el,
  emptyState,
  firstLine,
  includesText,
  link,
} from "./dom.js";
import { clearButton, hasClearable, syncClear } from "./filters.js";
import { agentLink, taskLink } from "./links.js";
import { hrefFor } from "./route.js";
import { $, hooks, store } from "./store.js";
import { timeEl } from "./time.js";

function buildThreadIndex() {
  const byId = new Map(
    store.data.messages.map((message) => [message.id, message]),
  );
  const children = new Map();
  for (const message of store.data.messages) {
    if (!message.replyTo) continue;
    const list = children.get(message.replyTo) ?? [];
    list.push(message);
    children.set(message.replyTo, list);
  }
  return { byId, children };
}
function threadRootId(index, message) {
  const seen = new Set();
  let current = message;
  while (
    current.replyTo &&
    index.byId.has(current.replyTo) &&
    !seen.has(current.id)
  ) {
    seen.add(current.id);
    current = index.byId.get(current.replyTo);
  }
  return current.id;
}
function resolveThreadRoot(index, id) {
  const message = index.byId.get(id) ?? index.children.get(id)?.[0];
  return message ? threadRootId(index, message) : null;
}
function collectThread(index, rootId) {
  const ordered = [];
  const visited = new Set();
  const stack = [[rootId, 0]];
  while (stack.length) {
    const [id, depth] = stack.pop();
    if (visited.has(id)) continue;
    visited.add(id);
    const message = index.byId.get(id);
    if (message) ordered.push({ message, depth });
    for (const child of (index.children.get(id) ?? []).toReversed())
      stack.push([child.id, depth + 1]);
  }
  return ordered;
}
function visibleMessage(message, params) {
  if (
    params.agent &&
    ![message.from, message.to].includes(params.agent) &&
    message.to !== "all"
  )
    return false;
  if (
    params.phase &&
    store.data.tasks.find((task) => task.id === message.task)?.phase !==
      params.phase
  )
    return false;
  return includesText(
    `${message.text} ${message.task ?? ""} ${message.from} ${message.to}`,
    params.q,
  );
}
function messageRow(message, open, index) {
  const row = el("li");
  const selected = store.route.params.thread === message.id;
  const anchor = link(
    hrefFor("messages", { ...store.route.params, thread: message.id }),
    undefined,
    `message-row${selected ? " is-selected" : ""}`,
  );
  anchor.dataset.focusKey = `message:${message.id}`;
  anchor.dataset.messageId = message.id;
  if (selected) anchor.setAttribute("aria-current", "true");
  const head = el("span", undefined, "message-row-head");
  head.append(
    badge(message.kind, open ? "warning" : "neutral"),
    el("span", `${message.from} → ${message.to}`, "message-route"),
    timeEl(message.at, true),
  );
  const replies = (index.children.get(message.id) ?? []).length;
  const meta = el("span", undefined, "message-row-meta");
  meta.append(el("span", message.task ?? "General", "mono"));
  if (replies)
    meta.append(
      el("span", `${replies} ${replies === 1 ? "reply" : "replies"}`),
    );
  if (open) meta.append(el("span", "Awaiting answer", "text-warning"));
  anchor.append(
    head,
    el("span", firstLine(message.text), "message-row-text"),
    meta,
  );
  row.append(anchor);
  return row;
}
function renderMessageList(index) {
  const params = store.route.params;
  const limitKey = JSON.stringify([params.q, params.agent, params.phase]);
  if (limitKey !== store.messageLimitKey) {
    store.messageLimitKey = limitKey;
    store.messageLimit = 100;
  }
  const showOpen = (params.filter ?? "open") === "open";
  const openIds = new Set(store.data.unanswered.map((message) => message.id));
  const questions = store.data.unanswered.filter((m) =>
    visibleMessage(m, params),
  );
  const messages = store.data.messages
    .filter((m) => visibleMessage(m, params))
    .toReversed();
  $("question-count").textContent = String(questions.length);
  $("message-count").textContent = String(messages.length);
  $("messages-open").setAttribute("aria-pressed", String(showOpen));
  $("messages-all").setAttribute("aria-pressed", String(!showOpen));
  $("questions").hidden = !showOpen;
  $("messages").hidden = showOpen;
  const emptyNode = (title, hint) => {
    const node = emptyState(title, hint);
    if (hasClearable("messages")) node.append(clearButton("messages"));
    return node;
  };
  if (showOpen) {
    const list = el("ol", undefined, "message-rows");
    list.append(...questions.map((m) => messageRow(m, true, index)));
    const decisions = decisionBlock();
    $("questions").replaceChildren(
      ...(decisions ? [decisions] : []),
      questions.length
        ? list
        : emptyNode(
            "No open questions in this view.",
            "Questions and requests appear here until they receive an answer.",
          ),
    );
    $("messages").replaceChildren();
  } else {
    const visible = messages.slice(0, store.messageLimit);
    const list = el("ol", undefined, "message-rows");
    list.append(...visible.map((m) => messageRow(m, openIds.has(m.id), index)));
    const nodes = [
      messages.length ? list : emptyNode("No messages in this view."),
    ];
    if (messages.length > visible.length) {
      const more = el("button", "Show older messages", "more-button");
      more.type = "button";
      more.dataset.focusKey = "messages-more";
      more.addEventListener("click", () => {
        store.messageLimit += 100;
        hooks.render();
      });
      nodes.push(more);
    }
    $("messages").replaceChildren(...nodes);
    $("questions").replaceChildren();
  }
}
function renderThreadDetail(index) {
  const pane = $("thread-detail");
  const split = $("messages-split");
  const id = store.route.params.thread;
  split.classList.toggle("has-detail", Boolean(id));
  if (!id) {
    pane.removeAttribute("aria-labelledby");
    pane.replaceChildren(
      emptyState(
        "Select a conversation",
        "Pick a message to read its full thread and context.",
      ),
    );
    return;
  }
  const closeHref = hrefFor("messages", {
    ...store.route.params,
    thread: undefined,
  });
  const close = closeLink(closeHref, "Close thread");
  const rootId = resolveThreadRoot(index, id);
  pane.setAttribute("aria-labelledby", "thread-detail-title");
  if (!rootId) {
    pane.replaceChildren(
      close,
      detailHeading("Thread unavailable", "thread-detail-title"),
      emptyState(
        "This conversation is not in the current snapshot.",
        "It may be older than the retained message history.",
      ),
    );
    return;
  }
  const thread = collectThread(index, rootId);
  const openIds = new Set(store.data.unanswered.map((message) => message.id));
  const openCount = thread.filter(({ message }) =>
    openIds.has(message.id),
  ).length;
  const root = thread[0]?.message;
  const header = el("div", undefined, "detail-header");
  const tags = el("div", undefined, "detail-tags");
  if (root?.task) tags.append(taskLink(root.task, "mono"));
  else tags.append(el("span", "General", "mono"));
  tags.append(
    badge(
      `${thread.length} ${thread.length === 1 ? "message" : "messages"}`,
      "neutral",
    ),
  );
  if (openCount) tags.append(badge(`${openCount} open`, "warning"));
  header.append(tags, detailHeading("Thread", "thread-detail-title"));
  const list = el("ol", undefined, "thread");
  for (const { message, depth } of thread) {
    const item = el("li", undefined, `thread-item depth-${Math.min(depth, 2)}`);
    const card = el(
      "article",
      undefined,
      `thread-message${message.id === id ? " is-target" : ""}`,
    );
    card.id = `message-${message.id}`;
    const meta = el("div", undefined, "thread-meta");
    meta.append(
      badge(message.kind, openIds.has(message.id) ? "warning" : "neutral"),
      agentLink(message.from),
      el("span", "→", "thread-arrow"),
      agentLink(message.to),
      timeEl(message.at),
    );
    card.append(meta);
    if (openIds.has(message.id))
      card.append(el("p", "Awaiting answer", "text-warning"));
    if (message.replyTo && !index.byId.has(message.replyTo))
      card.append(
        el("p", "Replies to a message that is no longer retained.", "note"),
      );
    card.append(el("p", message.text, "prose"));
    const extras = [];
    if (message.reviewCommit)
      extras.push(`Review commit ${message.reviewCommit}`);
    if (message.assignmentId) extras.push(`Assignment ${message.assignmentId}`);
    if (extras.length) card.append(el("p", extras.join(" · "), "note mono"));
    item.append(card);
    list.append(item);
  }
  pane.replaceChildren(close, header, list);
}
export function renderMessages() {
  syncClear("messages");
  const index = buildThreadIndex();
  renderMessageList(index);
  renderThreadDetail(index);
}
