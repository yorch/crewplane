// The document title in one place: "<view> · Crewplane", with an optional
// "(n)" prefix for alerts the person has not seen yet.
import { titleWithBadge } from "./notify-core.js";

let base = "Crewplane";
let unseen = 0;
function write() {
  document.title = titleWithBadge(base, unseen);
}
export function setBaseTitle(text) {
  base = text;
  write();
}
export function setUnseen(count) {
  unseen = count;
  write();
}
export function unseenCount() {
  return unseen;
}
