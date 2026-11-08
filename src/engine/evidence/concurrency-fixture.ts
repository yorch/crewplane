import { createEvidenceStore } from "./store.ts";

const [root, runId, role] = process.argv.slice(2);
if (!root || !runId) throw Error("Missing synthetic fixture arguments");
const store = await createEvidenceStore(root);
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5ioAAAAASUVORK5CYII=",
  "base64",
);
for (let step = 0; step < 10; step++) {
  if (role === "reader") await store.list();
  else
    await store.append(
      runId,
      {
        route: "synthetic",
        scenario: "initial",
        step,
        browser: "chromium",
        viewport: { width: 390, height: 844 },
        mime: "image/png",
        outcome: "captured",
        findingIds: [],
        recheckOf: null,
      },
      png,
    );
}
