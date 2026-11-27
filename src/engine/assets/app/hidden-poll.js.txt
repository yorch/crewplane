// Alerts in a background tab. A hidden tab suspends its event stream after a
// short grace period and the 5s poll pauses while hidden, so without this a
// person who enabled alerts and switched to another window would hear
// nothing. While alerts are enabled (the title count or desktop notifications)
// and the tab is hidden and not receiving the stream, this reads
// /api/snapshot about once a minute (spread +-20%, see hiddenPollDelay), which
// runs the usual snapshot comparison. With alerts off it never starts a
// timer, so a hidden tab makes no requests at all. Turning alerts off aborts a
// request in flight and stops the timer.
import { refresh } from "./api.js";
import { hiddenPollDelay, liveTuning } from "./live-core.js";
import { alertsEnabled, onAlertPrefsChange } from "./notify.js";
import { store } from "./store.js";

const tuning = liveTuning(window.crewplaneLiveTuning);
let timer = null;
let controller = null;

function stop() {
  clearTimeout(timer);
  timer = null;
  controller?.abort();
  controller = null;
}
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(tick, hiddenPollDelay(tuning.hiddenPollMs));
}
async function tick() {
  timer = null;
  if (!alertsEnabled()) return;
  schedule();
  if (!document.hidden || store.mode === "live") return;
  const own = new AbortController();
  controller = own;
  try {
    await refresh({ signal: own.signal });
  } finally {
    if (controller === own) controller = null;
  }
}
function sync() {
  if (!alertsEnabled()) stop();
  else if (timer === null) schedule();
}
export function startHiddenPoll() {
  onAlertPrefsChange(sync);
  sync();
}
