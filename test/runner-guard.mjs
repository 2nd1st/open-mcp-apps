// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// test/runner-guard.mjs — the sandbox chokepoint, pinned with fake io.
//
// One machine (src/runner.mjs makeGuard) now carries every rule the three hand-kept copies
// used to drift on, so this file is the policy table in executable form: each row here is a
// line the adversarial review called "one missing line = a cross-app escape". Every effect
// goes through io, so the whole policy runs in node.
//
// Run: node test/runner-guard.mjs
import { makeGuard, composeChildDoc, BRIDGE, RUNNER_CSP, readFileParts, stubOmaScript, composePreviewDoc, measureNaturalBodyHeight, capBroadcastHeight, screenHeightCap, unpinDocumentHeight } from "../src/runner.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0, fail = 0;
const ok = (name, cond, note) => (cond
  ? (pass++, console.log("  ✓ " + name))
  : (fail++, console.log("  ✗ " + name + (note ? "\n      " + note : ""))));
const throws = async (fn, re) => {
  try { await fn(); return false; } catch (e) { return re ? re.test(String(e.message)) : true; }
};

function makeIo(overrides = {}) {
  const calls = [];
  return {
    calls,
    callTool: async (name, args) => { calls.push({ name, args }); return { structuredContent: { ok: true } }; },
    sendMessage: async (t) => ({ sent: t }),
    snapshot: () => ({ collection: "bound", items: [{ id: "in1", group: "", position: 1, fields: {}, version: 42 }], version: 100 }),
    settingsIds: () => new Set(["srow1"]),
    readCollection: async (c) => ({ collection: c, items: [], version: 1, total: 0 }),
    readFile: async () => ({ base64: "QUJD", mime: "text/plain" }),
    notify: () => {},
    uuid: () => "u-1",
    ...overrides,
  };
}
const FULL = { call_tools: ["*"], send_message: true, delete_items: "allow",
  cross_collection_read: true, cross_collection_write: true, settings_write: true, read_source: true,
  file_read: true, file_write: true };
const guard = (caps, io, preset = "live", tier) => makeGuard({ name: "child-app", coll: "bound", caps, tier, preset, io });

console.log("1. the walls no cap combination can open");
{
  const io = makeIo();
  const g = guard(FULL, io);
  ok("control-plane tools denied under FULL caps + wildcard", await throws(() => g("callTool", { name: "save_app", args: {} }), /not available/));
  ok("…case/padding variants too", await throws(() => g("callTool", { name: "  Save_App ", args: {} }), /not available/));
  ok("app_store_* reserved prefix denied", await throws(() => g("callTool", { name: "app_store_install", args: {} }), /not available/));
  // ON THE HOST GATE, STILL OFF THIS ONE. `install_from_app_store` carries
  // `openai/widgetAccessible: true` so the App Store app's Add button works on a default-DENY host
  // (engine.mjs WIDGET_CALLABLE) — that is a statement about the TOP-LEVEL widget. A nested child
  // asking for the same name is a different question and the answer does not change: an embedded
  // app may not write the registry it lives in.
  ok("install_from_app_store denied to a nested child even though the HOST gate advertises it",
    await throws(() => g("callTool", { name: "install_from_app_store", args: { name: "kanban" } }), /not available/));
  ok("internal `_` RPC names denied (undo and the via ledger never reach a child)",
    await throws(() => g("callTool", { name: "_undo_last", args: {} }), /not available/));
  ok("apply_data_writes denied even under wildcard (the F2 seam, closed by name)",
    await throws(() => g("callTool", { name: "apply_data_writes", args: {} }), /not available to apps/));
  // A RETIRED NAME IS THE SAME TOOL. Seven seats still answer to their pre-rename spelling so that
  // apps saved before the rename keep working, and every wall in this file matches on a name — so
  // a child typing the old one must land in exactly the same place. Without the canonicalisation
  // the rename itself would have been the hole.
  ok("…and its retired spelling lands on the same refusal",
    await throws(() => g("callTool", { name: "data_batch", args: {} }), /not available to apps/));
  ok("a retired control-plane spelling is refused too",
    await throws(() => g("callTool", { name: "app_store_preview", args: {} }), /not available/));
  ok("nothing above ever reached io", io.calls.length === 0);
}

console.log("1b. ONE chokepoint, and the comment says one");
{
  // The policy file used to claim this list was enforced at BOTH the runner guard and the direct
  // runtime's generic door. It never was: direct mode mounts local-authored documents only and its
  // passthrough is deliberate (security-model §5). The claim is pinned to the code here so the
  // next reader of tool-policy.mjs is told the truth by a test rather than by a sentence.
  const policy = readFileSync(join(ROOT, "src", "tool-policy.mjs"), "utf-8");
  const runner = readFileSync(join(ROOT, "src", "runner.mjs"), "utf-8");
  const direct = readFileSync(join(ROOT, "src", "shell-runtime.js"), "utf-8");
  ok("the runner guard is the one enforcer", /isControlPlaneTool\(/.test(runner));
  ok("…the direct runtime does not consult the list, and never claimed to import it",
    !/isControlPlaneTool/.test(direct));
  ok("…and tool-policy.mjs no longer says it does",
    !/BOTH chokepoints/.test(policy) && /ONE chokepoint/.test(policy));
}

console.log("2. writes: identity is FORCED, never child-supplied");
{
  const io = makeIo();
  const g = guard(FULL, io);
  await g("addItem", { fields: { t: 1 } });
  const w = io.calls[0];
  ok("typed write stamps actor:human + via:{app:child}", w.args.actor === "human" && w.args.via.app === "child-app");
  await g("callTool", { name: "data_add_item", args: { collection: "elsewhere", via: { app: "forged" }, actor: "agent", fields: {} } });
  const w2 = io.calls[1];
  ok("generic-path write: via/actor OVERWRITTEN (a forged via dies at the chokepoint)",
    w2.args.via.app === "child-app" && w2.args.actor === "human");
  ok("cross_collection_write=true lets the collection through", w2.args.collection === "elsewhere");
  const io2 = makeIo();
  await guard({ ...FULL, cross_collection_write: false }, io2)("callTool", { name: "data_add_item", args: { collection: "elsewhere", fields: {} } });
  ok("cross_collection_write=false FORCES the bound collection", io2.calls[0].args.collection === "bound");
  // (W3: the server seat exists now and oma.callFunction is back — this shaping is the wall
  // that keeps a widget inside its OWN roster: callee, via AND actor are all forced.)
  ok("call_function via callTool: callee forced to the child itself (second hop unreachable by shape)", await (async () => {
    const io3 = makeIo();
    await guard(FULL, io3)("callTool", { name: "call_function", args: { function: "tick", args: {}, app: "victim", via: { app: "victim" }, actor: "agent" } });
    const c = io3.calls[0];
    return c.name === "call_function" && c.args.app === "child-app" && c.args.via.app === "child-app"
      && c.args.actor === "human" && !!c.args.command_id;
  })());
}

console.log("3. scope, write policy, settings and delete guards");
{
  const io = makeIo();
  const g = guard({ ...FULL, cross_collection_write: false, delete_items: "deny" }, io);
  ok("id-addressed write outside the held snapshot refuses", await throws(() => g("updateItem", { id: "ghost", fields: {} }), /out of scope/));
  await g("updateItem", { id: "in1", fields: {} });
  // LAST-WRITE-WINS, matching direct mode (Leo 2026-07-27). Sending the version the child was last
  // SHOWN made a second rapid click carry a pre-echo stale one; here the resulting conflict came
  // back as an isError the child bridge RESOLVES with, so an app that ignores the return value
  // lost the write with nothing on screen. Explicit OCC is still reachable through generic callTool.
  ok("a typed write does NOT send expected_version — one policy for one verb, LWW like direct mode",
    io.calls[0].args.expected_version === undefined);
  ok("…for every id-addressed verb, not just update", await (async () => {
    const io2 = makeIo(); const g2 = guard(FULL, io2);
    await g2("moveItem", { id: "in1", group: "z" });
    await g2("deleteItem", { id: "in1" });
    return io2.calls.every((c) => c.args.expected_version === undefined);
  })());
  ok("…and a caller that genuinely wants OCC can still state it through callTool", await (async () => {
    const io3 = makeIo();
    await guard(FULL, io3)("callTool", { name: "data_update_item", args: { id: "in1", fields: {}, expected_version: 42 } });
    return io3.calls[0].args.expected_version === 42;
  })());
  ok("delete denied by caps refuses", await throws(() => g("deleteItem", { id: "in1" }), /delete denied/));
  // The "confirm" tier no longer asks with window.confirm — the sandbox BLOCKS that call, so the
  // middle tier silently degraded to deny in every real host. It now RAISES THE BAR on the
  // engine's own prompt, which is the only one that works and the only one the user sees.
  {
    const io4 = makeIo();
    await guard({ ...FULL, delete_items: "confirm" }, io4)("deleteItem", { id: "in1" });
    ok("delete 'confirm' asks the ENGINE to require confirmation, whatever the preference says",
      io4.calls[0].args.require_confirmation === true, JSON.stringify(io4.calls[0]));
    const io5 = makeIo();
    await guard({ ...FULL, delete_items: "allow" }, io5)("deleteItem", { id: "in1" });
    ok("…and 'allow' sends no such flag (the preference alone decides)",
      io5.calls[0].args.require_confirmation === undefined);
    ok("nothing calls window.confirm any more", !/io\.confirm/.test(readFileSync(join(ROOT, "src", "runner.mjs"), "utf-8")));
  }
  const gs = guard({ ...FULL, settings_write: false }, makeIo());
  ok("a foreign id that IS a known settings row hits the settings guard",
    await throws(() => guard({ ...FULL, settings_write: false, cross_collection_write: true }, makeIo())("callTool", { name: "data_update_item", args: { id: "srow1", fields: {} } }), /settings write denied/));
  // 🔴 U-a (2026-07-29, CONFIRMED): the assertion above is a belt fastened to a DATA SOURCE.
  // `settingsIds` is not a constant — it starts life as `new Set()` in shell-runtime.js:839 and is
  // only ever filled by rebuildPrefs(). The boot read at :918 swallows its own failure
  // (`.catch(() => { if (prefMap === null) prefMap = {}; })` — note it repairs prefMap and leaves
  // settingsIds alone), and it sits inside Promise.allSettled, so a failed settings read still
  // mounts a fully functional child. From that moment until the first successful settings read,
  // `settingsIds()` is empty, `.has(id)` is vacuously false, and `settings_write: false` protects
  // nothing on the foreign-id path.
  //
  // This is the fifth shape of guard failure we have seen this week, and the most quiet:
  //   1. bless mode swallows failures · 2. golden rebuilt when missing · 3. exemption never matched
  //   4. target absent ⇒ auto-recreate baseline · 5. **THE PREDICATE'S DATA SOURCE IS EMPTY**
  // Nothing throws, nothing logs, and every existing assertion stays green — because they all
  // supply a populated set.
  //
  // The assertion below is written to FAIL until the guard stops trusting a possibly-empty set.
  // It is not a description of current behaviour; it is the line the fix has to make true.
  {
    const ioEmpty = makeIo({ settingsIds: () => new Set() });
    const gEmpty = guard({ ...FULL, settings_write: false, cross_collection_write: true }, ioEmpty);
    const blocked = await throws(
      () => gEmpty("callTool", { name: "data_update_item", args: { id: "srow1", fields: { value: "PWNED" } } }),
      /settings write denied/);
    ok("settings_write:false holds even when settingsIds is EMPTY (boot read failed)", blocked,
      "🔴 CONFIRMED U-a: 空集下写抵达 io —— 守卫的判据是可空的数据源。" +
      "服务端 RESERVED_KEY_RE 仍拦 security:*/policy:*，所以普通全局偏好是暴露面，不是提权到策略。");
    ok("…and nothing reached io in that case", ioEmpty.calls.length === 0,
      `io.calls=${ioEmpty.calls.length} — 写真的落到了 callTool`);

    // The fix reads `!known || known.size === 0 || known.has(id)`, which is three conditions, and
    // a red drill on 2026-07-31 showed only the middle one was pinned: deleting the `!known` half
    // left this file entirely green. An unpinned half of a security predicate is an invitation to
    // "simplify" it later, so the absent-source case gets its own line. It is not a hypothetical —
    // `io` is a plain object assembled by the embedder, and a future embedder that forgets the key
    // gets exactly this shape, with no type system anywhere to notice.
    const ioNone = makeIo({ settingsIds: undefined });
    const gNone = guard({ ...FULL, settings_write: false, cross_collection_write: true }, ioNone);
    ok("…and when io provides no settingsIds AT ALL (absent evidence is not evidence of absence)",
      await throws(() => gNone("callTool", { name: "data_update_item", args: { id: "srow1", fields: {} } }),
        /settings write denied/) && ioNone.calls.length === 0);
  }
  ok("setPref needs settings_write", await throws(() => gs("setPref", { key: "a", value: 1 }), /denied by policy/));
  ok("setPref validates its key even with the cap", await throws(
    () => guard(FULL, makeIo())("setPref", { key: "_bad", value: 1 }), /invalid or reserved/));
}

console.log("4. reads: binding + caps");
{
  const io = makeIo();
  await guard({ ...FULL, cross_collection_read: false }, io)("callTool", { name: "data_list", args: { collection: "other" } });
  ok("data_list forced to the bound collection without cross_collection_read", io.calls[0].args.collection === "bound");
  const io3 = makeIo();
  const rc = await guard({ ...FULL, cross_collection_read: false }, io3)("readCollection", { collection: "other" });
  ok("readCollection binds too", rc.collection === "bound");
  ok("app source reads need read_source", await throws(
    () => guard({ ...FULL, read_source: false }, makeIo())("callTool", { name: "get_app", args: {} }), /source read denied/));
  const io4 = makeIo();
  await guard(FULL, io4)("callTool", { name: "file_read", args: { app: "other", path: "x" } });
  ok("file reads bound to the child's OWN files", io4.calls[0].args.app === "child-app");
  ok("file reads need the cap", await throws(
    () => guard({ ...FULL, file_read: false }, makeIo())("filesRead", { path: "x" }), /file read denied/));
  const fr = await guard(FULL, makeIo())("filesRead", { path: "x" });
  ok("filesRead returns base64+mime for the bridge to decode", fr.base64 === "QUJD" && fr.mime === "text/plain");
}

console.log("5. rates — retired (elegance A9): no per-iframe quota machinery survives");
{
  // The sliding-window limiter's only measured activation throttled a LEGITIMATE dashboard
  // preview; a future abuse case gets a server-side quota keyed by a real principal. Pinned:
  // nothing in the guard source counts calls any more.
  const src = (await import("node:fs")).readFileSync(new URL("../src/runner.mjs", import.meta.url), "utf8");
  ok("no RATES table / rate() machinery in the runner", !/const RATES =/.test(src) && !/function rate\(/.test(src));
  const io = makeIo();
  const g = guard(FULL, io);
  for (let i = 0; i < 80; i++) await g("addItem", { fields: {} });
  ok("80 rapid writes all pass the guard (no hidden quota)", io.calls.length === 80);
}

console.log("5c. the PARENTLESS stub answers from the same fixtures the guard's inert preset does");
// The public preview path (composePreviewDoc → stubOmaScript) is a second inert machine, and it
// had not learned what the first one did: answering every fetch empty reads as CORRUPT data, not
// as "no rows". Measured 2026-07-28 — training-log rendered "0/0 · No entries yet" plus "Refresh
// failed: training-plan returned invalid data" with its fixtures sitting in the same document.
// A stranger's first look at a shared app runs through here (the hosted store page today, T19 P-a next),
// so it is pinned rather than left to the next person to re-measure.
{
  const items = [
    { collection: "a", group: "g1", fields: { title: "a1" } },
    { collection: "a", fields: { title: "a2" } },
    { collection: "b", fields: { title: "b1" } },
  ];
  const script = stubOmaScript("a", items);
  const body = script.replace(/^<script>/, "").replace(/<\/scr" *\+ *"ipt>$|<\/script>$/, "");
  const win = {};
  new Function("window", body)(win);   // the stub is plain ES5 by design — no bundler in the path
  const oma = win.oma;
  const bound = await oma.readCollection();
  ok("readCollection defaults to the bound collection and returns its rows", bound.items.length === 2, `${bound.items.length}`);
  ok("…in real item shape (id/fields), not raw fixture rows",
    typeof bound.items[0].id === "string" && bound.items[0].fields.title === "a1");
  const other = await oma.readCollection("b");
  ok("a second collection is served its OWN rows", other.items.length === 1 && other.collection === "b");
  const listed = await oma.callTool("data_list", { collection: "b" });
  ok("callTool data_list answers from fixtures too (the canonical self-fetch pattern)",
    listed.structuredContent?.items?.length === 1, JSON.stringify(listed.structuredContent));
  const unknown = await oma.callTool("something_else", {});
  ok("an unrelated tool still answers empty, not wrong", JSON.stringify(unknown.structuredContent) === "{}");
  const localized = stubOmaScript("a", items, [], { locale: "zh" });
  const localizedWindow = {};
  new Function("window", localized.replace(/^<script>/, "").replace(/<\/scr" *\+ *"ipt>$|<\/script>$/, ""))(localizedWindow);
  ok("preview prefs carry the requested locale into the real app renderer",
    localizedWindow.oma.pref("locale", "en") === "zh" && localizedWindow.oma.pref("density", "comfortable") === "comfortable");

  // Date-aware Apps must share the narrative clock with the surrounding Landing / Store copy.
  // The shim is opt-in and lives only in the parentless preview document; normal app runtimes
  // never receive preview_date.
  const clocked = stubOmaScript("a", items, [], { locale: "en", preview_date: "2026-08-06" });
  const clockedWindow = {};
  const clockedBody = clocked.replace(/^<script>/, "").replace(/<\/scr" *\+ *"ipt>$|<\/script>$/, "");
  new Function("window", "Date", clockedBody)(clockedWindow, Date);
  const previewToday = new clockedWindow.Date();
  ok("preview clock pins Date() to the Landing narrative date",
    previewToday.getFullYear() === 2026 && previewToday.getMonth() === 7 && previewToday.getDate() === 6,
    previewToday.toString());
  ok("preview clock pins Date.now() to the same instant",
    clockedWindow.Date.now() === previewToday.getTime());
  const liveWindow = {};
  new Function("window", "Date", stubOmaScript("a", items).replace(/^<script>/, "").replace(/<\/scr" *\+ *"ipt>$|<\/script>$/, ""))(liveWindow, Date);
  ok("without preview_date the stub leaves the host Date untouched", liveWindow.Date === undefined);

  // A meta app asks WHICH collections exist, and WHICH apps exist, before it asks for rows.
  // Answering either with an empty envelope renders an app whose whole job is "show me everything"
  // as though the user owned nothing — on the machine that composes PUBLIC preview pages.
  const cols = await oma.callTool("list_data_collections", {});
  ok("the stub derives list_data_collections from the same fixtures",
    cols.structuredContent.collections.map((c) => c.collection).sort().join() === "a,b", JSON.stringify(cols.structuredContent));
  const bare = await oma.callTool("list_apps", {});
  ok("with no roster supplied it answers an EMPTY list — honest, and never undefined",
    Array.isArray(bare.structuredContent.apps) && bare.structuredContent.apps.length === 0);

  // ⚠️ This pair replaces a single `Array.isArray(...)` assertion that passed on `[]` — i.e. it
  // passed whether or not the roster was ever wired, and it was covering a half-finished fix.
  // The roster is the ONLY way an installed app with an EMPTY collection stays visible in a
  // preview: inert derives list_data_collections from rows, and zero rows reads as "does not exist".
  const withRoster = stubOmaScript("a", items, [{ name: "a" }, { name: "empty-app" }]);
  const w2 = {};
  new Function("window", withRoster.replace(/^<script>/, "").replace(/<\/scr" *\+ *"ipt>$|<\/script>$/, ""))(w2);
  const named = await w2.oma.callTool("list_apps", {});
  ok("…and hands back the composer's roster VERBATIM when there is one",
    named.structuredContent.apps.map((c) => c.name).sort().join() === "a,empty-app",
    JSON.stringify(named.structuredContent.apps));
  ok("…including the app that has no rows at all (the whole point of carrying a roster)",
    named.structuredContent.apps.some((c) => c.name === "empty-app"));
}

console.log("5c2. …and it counts collections in a container that has no inherited keys (N7)");
// `__proto__` and `constructor` are LEGAL collection names — the store accepts both (verified
// against a real store, ok:true). The stub tallied collections in a bare object literal, so
// `m["__proto__"] = 1` mutated the prototype instead of creating a key (the collection vanished
// from the answer entirely) and `m["constructor"] || 0` read the inherited FUNCTION, making the
// count `"function Object() { [native code] }1"` — a string where a number belongs. The guard's
// twin uses a Map and was always right, so this was also a place the two machines disagreed.
{
  const items = [
    { collection: "__proto__", fields: { t: "p" } },
    { collection: "constructor", fields: { t: "c" } },
    { collection: "ordinary", fields: { t: "o" } },
  ];
  const script = stubOmaScript("ordinary", items);
  const win = {};
  new Function("window", script.replace(/^<script>/, "").replace(/<\/scr" *\+ *"ipt>$|<\/script>$/, ""))(win);
  const cols = (await win.oma.callTool("list_data_collections", {})).structuredContent.collections;
  const names = cols.map((c) => c.collection).sort();
  ok("a collection named __proto__ still appears (a bare object swallowed it)",
    names.join() === "__proto__,constructor,ordinary", names.join());
  ok("…and every count is a NUMBER, not something inherited from Object.prototype",
    cols.every((c) => typeof c.items === "number" && c.items === 1),
    JSON.stringify(cols));
  // Same question of the guard's twin, so the two machines are pinned to the same answer.
  const g = guard(FULL, makeIo({ snapshot: () => ({ collection: "ordinary", items, version: 1 }) }), "inert", "local");
  const viaGuard = (await g("callTool", { name: "list_data_collections", args: {} })).structuredContent.collections;
  ok("…and the parented guard agrees, name for name and count for count",
    JSON.stringify(viaGuard.map((c) => [c.collection, c.items]).sort()) === JSON.stringify(cols.map((c) => [c.collection, c.items]).sort()),
    JSON.stringify(viaGuard));
}

console.log("5c3. the preview document TELLS its embedder how tall it is");
// A preview iframe is sandbox="allow-scripts" with NO allow-same-origin — on purpose, so the
// embedder cannot read contentDocument.scrollHeight and must be told. The live runner has
// broadcast omaRunHeight since it existed; composePreviewDoc — the document every gallery and
// store page actually embeds — did not, so an embedder had to guess a fixed window and a taller
// app was silently cut off (measured on /app-store/<name>: the render stopped mid-card under a
// fade, with nothing to distinguish "this app is short" from "we truncated it").
{
  const doc = composePreviewDoc("<div>hi</div>", { name: "spending-journal" });
  const flat = doc.replace(/\s+/g, " ");
  ok("the preview document broadcasts omaRunHeight", /omaRunHeight/.test(doc));
  ok("…the same message shape the runner child sends, so one embedder handles both",
    /postMessage\(\{omaRunHeight:true, ?h:omaCapHeight\(omaNaturalHeight\(document\.body,window\.innerHeight\),\(window\.screen\|\|\{\}\)\.height\)\}/.test(flat),
    "shape drifted from src/runner.mjs's own broadcast");
  ok("…measures the body's natural extent, not the viewport-backed documentElement height",
    /measureNaturalBodyHeight/.test(doc) && !/h:document\.documentElement\.scrollHeight/.test(doc));
  ok("…after the body, so the height it reports includes the app", doc.indexOf("omaRunHeight") > doc.indexOf("<div>hi</div>"));
  ok("…and it re-reports on resize rather than measuring once", /ResizeObserver/.test(doc));
  ok("…degrading to a single load-time report where ResizeObserver is missing",
    /typeof ResizeObserver === "function"/.test(doc) && /window\.addEventListener\("load", start\)/.test(doc));
  ok("a host that rejects postMessage cannot break the preview", /catch\(e\)\{\}/.test(doc));
  ok("the CSP still comes first — the broadcast did not become an injection anchor",
    doc.indexOf("Content-Security-Policy") < doc.indexOf("<div>hi</div>"));
  // Both documents now carry the SAME injected machine — the drift this test was written about
  // (one of them observing less than the other) is closed by construction, not by review.
  ok("…and it is byte-for-byte the machine the live bridge injects",
    BRIDGE.includes("var omaWatchHeight=") && doc.includes("var omaWatchHeight=") &&
    BRIDGE.slice(BRIDGE.indexOf("var omaWatchHeight=")).startsWith(doc.slice(doc.indexOf("var omaWatchHeight="), doc.indexOf("var omaSendHeight="))));
}

console.log("5c3b. growth INSIDE the app re-reports, and the report is capped at the device screen");
// Measured on claude.ai: adding one item to habit-streaks changed what was on screen and the
// widget did not grow, while a whole-page re-render (App Store category switch) did. That is the
// signature of watching one box: `document.body` is routinely pinned — by the frame's own
// viewport, by an app that writes html,body{overflow:hidden} — while the element that actually
// grew is a child of it.
for (const [what, src] of [["the live bridge", BRIDGE], ["the preview document", composePreviewDoc("<p>x</p>", { name: "a" })]]) {
  ok(`${what} watches each direct child, not just document.body`,
    /body\.firstElementChild; c; c = c\.nextElementSibling/.test(src) && /ro\.observe\(watched\[j\]\)/.test(src));
  ok(`${what} re-attaches when the child list changes (apps rewrite body.innerHTML wholesale)`,
    /new MutationObserver\(function \(\) \{ rewatch\(\); ping\(\); \}\)\.observe\(document\.body, \{ childList: true \}\)/.test(src));
  ok(`${what} debounces the burst instead of posting per observation`,
    /clearTimeout\(timer\); timer = setTimeout\(report, 50\)/.test(src));
  ok(`${what} still answers immediately on first paint`, /report\(\);\s+\/\/ first paint/.test(src));
  ok(`${what} caps the broadcast at window.screen.height`, /omaCapHeight\(/.test(src) && /window\.screen\|\|\{\}/.test(src));
}
{
  const cap = capBroadcastHeight;
  ok("a store front taller than the screen is asked for at screen height", cap(4200, 1080) === 1080, String(cap(4200, 1080)));
  ok("an app shorter than the screen is unaffected", cap(540, 1080) === 540, String(cap(540, 1080)));
  ok("exactly the screen height is not clipped by an off-by-one", cap(1080, 1080) === 1080, String(cap(1080, 1080)));
  // The cap is a comfort bound, never a way to make a widget vanish: every unreadable or absurd
  // reading has to leave the app at least a usable card.
  for (const bad of [0, -1, NaN, undefined, null, "", "tall", {}])
    ok(`an unreadable screen (${JSON.stringify(bad) ?? String(bad)}) means NO cap, not a zero-height widget`,
      cap(4200, bad) === 4200, String(cap(4200, bad)));
  ok("an implausibly small screen reading is floored, not obeyed", cap(4200, 40) === 320, String(cap(4200, 40)));
  ok("…and the floor never INFLATES a genuinely short app", cap(120, 40) === 120, String(cap(120, 40)));
  ok("a nonsense natural height still reports a number", cap("x", 1080) === 0 && cap(-5, 1080) === 0);
  // ONE bound, ONE consumer — the broadcast. It is a pure function of the screen reading now:
  // no pointer type, no second argument, nothing the document's own styling reads (the self-cap
  // that used to share this number was removed 2026-08-14 — a widget's ceiling is the host's).
  ok("the bound itself is a single exported source the reading goes through",
    screenHeightCap(1080) === 1080 && screenHeightCap(40) === 320 && screenHeightCap(0) === 0
    && capBroadcastHeight(4200, 1080) === screenHeightCap(1080));
  ok("the bound takes ONE argument — a touch pointer is not a smaller screen any more",
    screenHeightCap.length === 1 && screenHeightCap(844, true) === 844 && screenHeightCap(844) === 844);
  ok("…and neither is the broadcast cap — a stray third argument changes nothing",
    capBroadcastHeight.length === 2 && capBroadcastHeight(4200, 844, true) === 844);
}

console.log("5c3c. the document UNPINS itself — the host's own reporter is not ours to fix");
// 🔴 Wire capture on claude.ai (2026-08-13): the height a chat host acts on comes from a shim IT
// injects, posting `ui/notifications/size-changed {width,height}` from inside the widget iframe —
// a string that appears NOWHERE in this repo. It reads the document's scrollHeight and re-reports
// (755 → 1004 → 755 on one app). So the broadcast above cannot be the whole answer: the only
// thing we control is the DOM that shim measures — and what we owe that shim is a document whose
// height is the CONTENT's, not a ceiling of our own. The ceiling shipped for one day and was
// removed 2026-08-14 (it made `body` a scroll container and killed scrolling on phones); the
// unpin stays, because a pinned app cannot be seen to grow at all.
{
  const styles = () => {
    const bag = {};
    return { bag, node: { style: { setProperty: (k, v, p) => { bag[k] = v + (p === "important" ? " !important" : ""); } } } };
  };
  const withDoc = (fn) => {
    const b = styles(), r = styles();
    const prev = globalThis.document;
    globalThis.document = { body: b.node, documentElement: r.node };
    try { return { out: fn(), body: b.bag, root: r.bag }; }
    finally { if (prev === undefined) delete globalThis.document; else globalThis.document = prev; }
  };

  const unpinned = withDoc(() => unpinDocumentHeight());
  // The pin is the root cause, not a side issue: overflow:hidden on html and/or body (7 of the 24
  // shipped apps — counted, not guessed)
  // and body{min-height:100vh} (dashboard) make the measured height equal the FRAME height — which
  // the host set from its own last reading — so the reading freezes and "add a row" moves nothing.
  ok("it unpins the app's own height (height:auto + min-height:0, on BOTH boxes)",
    unpinned.out === true
    && unpinned.body.height === "auto !important" && unpinned.body["min-height"] === "0 !important"
    && unpinned.root.height === "auto !important" && unpinned.root["min-height"] === "0 !important",
    JSON.stringify(unpinned.body) + JSON.stringify(unpinned.root));
  // VISIBLE, not auto. `auto` was the cap's scroll container; without a max-height it is a scroller
  // that can never scroll, and position:sticky binds to the nearest non-visible-overflow ancestor —
  // which would strand the store's and settings' capsule bars on a box that does not move.
  ok("…and leaves the overflow VISIBLE on both, so nothing becomes a dead scroll container",
    unpinned.body["overflow-y"] === "visible !important" && unpinned.root["overflow-y"] === "visible !important",
    JSON.stringify(unpinned.body));
  // The ceiling is gone for good (Leo, 2026-08-14: infinite height, the host's own limit decides).
  ok("…and imposes NO ceiling of its own — no max-height anywhere on either box",
    !("max-height" in unpinned.body) && !("max-height" in unpinned.root)
    && Object.keys(unpinned.body).length === 3 && Object.keys(unpinned.root).length === 3,
    JSON.stringify(unpinned.body) + JSON.stringify(unpinned.root));
  ok("every declaration is !important — we are overriding the app's OWN stylesheet",
    Object.values(unpinned.body).every((v) => / !important$/.test(v)));
  ok("a document with no body at all is survivable", withDoc(() => {
    globalThis.document = { body: null, documentElement: null };
    return unpinDocumentHeight();
  }).out === false);
}
for (const [what, src] of [["the live bridge", BRIDGE], ["the preview document", composePreviewDoc("<p>x</p>", { name: "a" })]]) {
  ok(`${what} injects the height unpin, not only the broadcast`,
    /var omaUnpin=/.test(src) && /min-height/.test(src) && /"overflow-y", "visible"/.test(src));
  ok(`${what} carries NO document ceiling — no max-height, no hidden scrollbar, no drawn thumb`,
    !/max-height/.test(src) && !/scrollbar-width/.test(src) && !/self-cap-thumb/.test(src)
    && !/pointer:coarse/.test(src));
  ok(`${what} hands the watcher the broadcast itself — the unpin is a one-shot, not a per-report step`,
    /omaWatchHeight\(omaSendHeight\)/.test(src) && !/omaFitHeight/.test(src));
  // The bound survives only on the broadcast path, and it has to travel WITH it: omaSendHeight's
  // whole body sits inside a catch, so a screenHeightCap left behind in the unpin source would
  // make every report a silently swallowed ReferenceError.
  ok(`${what} carries screenHeightCap exactly once, on the path that calls it`,
    src.split("function screenHeightCap").length - 1 === 1
    && src.indexOf("function screenHeightCap") < src.indexOf("var omaSendHeight="));
  // A host's own reporter reads documentElement.scrollHeight, and a PINNED app never gives it a
  // different number to read — so an unpin that waits for `load` can arrive after the app has
  // already been frozen at its first size. Unpin as soon as a body exists.
  ok(`${what} unpins as soon as a body exists, not only at load`,
    /if\(document\.body\)omaUnpinNow\(\);else document\.addEventListener\("DOMContentLoaded",omaUnpinNow\)/.test(src));
}

console.log("5c4. natural height can shrink below an old iframe viewport");
{
  const rect = (top, bottom, width = 760) => ({ top, bottom, width, height: bottom - top });
  const body = {
    scrollHeight: 1367,
    getBoundingClientRect: () => rect(0, 1367),
    children: [
      { tagName: "STYLE", getBoundingClientRect: () => rect(0, 0, 0) },
      { tagName: "MAIN", getBoundingClientRect: () => rect(12, 1355) },
      { tagName: "SCRIPT", getBoundingClientRect: () => rect(0, 0, 0) },
    ],
  };
  ok("a filtered app reports 1367px even inside a stale 2459px iframe",
    measureNaturalBodyHeight(body, 2459) === 1367,
    String(measureNaturalBodyHeight(body, 2459)));

  const overflowingBody = {
    ...body,
    scrollHeight: 1800,
    children: [{ tagName: "MAIN", getBoundingClientRect: () => rect(12, 1788) }],
  };
  ok("genuine overflow still reports the full body scroll height",
    measureNaturalBodyHeight(overflowingBody, 900) === 1800,
    String(measureNaturalBodyHeight(overflowingBody, 900)));
}

console.log("5d. the PARENTED inert preset answers the same two questions from its snapshot");
// The other inert machine. Its roster arrives through oma.embed's childSnap, which used to
// rebuild the snapshot from an explicit key list and dropped `apps` on the floor — so this
// half of "both preview machines now agree" was never true. Pinned on the guard directly.
{
  const snap = {
    collection: "a",
    items: [{ id: "i1", group: "", position: 1, fields: { t: "x" }, version: 1, collection: "a" }],
    apps: [{ name: "a" }, { name: "empty-app" }],
    version: 3,
  };
  const g = guard(FULL, makeIo({ snapshot: () => snap }), "inert", "local");
  const roster = await g("callTool", { name: "list_apps", args: {} });
  ok("inert answers list_apps from the snapshot's roster",
    roster.structuredContent.apps.map((c) => c.name).sort().join() === "a,empty-app",
    JSON.stringify(roster.structuredContent.apps));
  const noRoster = await guard(FULL, makeIo({ snapshot: () => ({ collection: "a", items: [], version: 1 }) }), "inert", "local")(
    "callTool", { name: "list_apps", args: {} });
  ok("…and an empty list when the embedder had none, never undefined",
    Array.isArray(noRoster.structuredContent.apps) && noRoster.structuredContent.apps.length === 0);
}

console.log("6. presets — two real ones: live enforces, inert touches nothing (readonly retired, A8)");
{
  const io3 = makeIo();
  const gi = guard(FULL, io3, "inert");
  const w = await gi("addItem", { fields: {} });
  const r = await gi("callTool", { name: "data_list", args: {} });
  ok("inert: writes pretend to succeed, reads answer, and io is NEVER touched",
    w.ok === true && r.structuredContent && io3.calls.length === 0);

  // Multi-collection previews lean on the snapshot answering PER COLLECTION: fixture rows carry
  // a `collection` key, and a self-fetching app (the GUIDE pattern) must get real rows back for
  // each one — the old empty envelope painted five of sixteen App Store cards as an error banner.
  const mixed = {
    calls: [],
    snapshot: () => ({ collection: "elder-days", version: 3, items: [
      { collection: "elder-meds", group: "am", fields: { name: "Amlodipine" } },
      { collection: "elder-meds", group: "pm", fields: { name: "Metformin" } },
      { collection: "elder-bp", fields: { sys: 140 } },
      { fields: { keyless: true } },   // no collection key ⇒ belongs to the BOUND collection
    ] }),
  };
  const gm = makeGuard({ name: "elder-days", coll: "elder-days", caps: FULL, preset: "inert", io: mixed });
  const meds = await gm("callTool", { name: "data_list", args: { collection: "elder-meds" } });
  const sc = meds.structuredContent;
  ok("inert data_list answers the ASKED collection from fixture rows",
    sc.collection === "elder-meds" && sc.items.length === 2 && sc.returned === 2 && sc.total === 2);
  ok("…in the real item shape (id/group/position/fields/version)",
    sc.items[0].id === "fx-0" && sc.items[0].group === "am" && sc.items[0].position === 1
    && sc.items[0].fields.name === "Amlodipine" && sc.items[0].version === 1);
  const bp = await gm("readCollection", { collection: "elder-bp" });
  ok("inert readCollection is collection-scoped too", bp.collection === "elder-bp" && bp.items.length === 1);
  const bound = await gm("refresh", {});
  ok("refresh answers the BOUND collection: keyless fixture rows and nothing else",
    bound.collection === "elder-days" && bound.items.length === 1 && bound.items[0].fields.keyless === true);
  const dv = await gm("callTool", { name: "get_data_version", args: {} });
  ok("inert get_data_version answers the snapshot's version as seq", dv.structuredContent.seq === 3);
  ok("…and the mixed-snapshot io was never touched either", mixed.calls.length === 0);
}

console.log("7. the child document + bridge surface");
{
  const doc = composeChildDoc("<h1>x</h1><script>evil()</script>", { tokenCss: "<style>:root{}</style>" });
  ok("CSP is the FIRST head child; untrusted markup rides wholesale in OUR body",
    doc.startsWith("<!doctype html><html><head>" + RUNNER_CSP) && doc.includes("<body><h1>x</h1>"));
  // (callFunction / updateContext left the bridge with the elegance-A10 cut — each returns
  // with its real consumer.)
  for (const m of ["addItem", "updateItem", "moveItem", "deleteItem", "refresh", "callTool", "readCollection", "files", "pref", "onPrefChange", "setPref", "sendMessage"])
    ok(`bridge exposes ${m}`, BRIDGE.includes(m + ":"));
  ok("bridge repaints on item-count change at an equal version (zero-row lesson)",
    BRIDGE.includes("d.snapshot.items.length!==S.items.length"));
  ok("bridge never claims embed (depth 1 — an embedded child cannot embed further)",
    !/embed\s*:/.test(BRIDGE));
  const kitted = composeChildDoc("<h1>x</h1>", { tokenCss: "<style>:root{}</style>", kitCss: ".k-btn{color:red}" });
  ok("the kit travels into the child (a separate document inherits no CSS)",
    kitted.includes('<style data-oma="kit">.k-btn{color:red}</style>'));
  ok("…after the tokens it reads, and before the app's own markup",
    kitted.indexOf("data-oma=\"kit\"") > kitted.indexOf("<style>:root{}") && kitted.indexOf("data-oma=\"kit\"") < kitted.indexOf("<h1>"));
  ok("no kit supplied ⇒ no empty tag emitted", !composeChildDoc("<p>x</p>").includes("data-oma=\"kit\""));
  ok("bridge treats an explicit `changed` as a change, even at an unmoved version",
    /d\.changed===true\|\|d\.snapshot\.version!==S\.version/.test(BRIDGE),
    "an apply-refresh push keeps childSnap.version, so an UPDATE would otherwise fire no onChange " +
    "and the child's successful click would sit on screen showing the old value");
  ok("bridge applies the parent's theme pairs verbatim and restores what was dropped",
    BRIDGE.includes("d.themeVars") && BRIDGE.includes("st.setProperty") && BRIDGE.includes("st.removeProperty"));
  ok("…and re-implements NO validation: the parent already ran themeVars",
    !/theme:/.test(BRIDGE) && !/--\[a-z\]/.test(BRIDGE));
}

console.log("8. readFileParts — window walk, byte-honest");
{
  const windows = [
    { structuredContent: { data_base64: "QQ==", mime: "text/plain", sha256: "s", size: 2, next_offset: 1 } },
    { structuredContent: { data_base64: "Qg==", mime: "text/plain", sha256: "s", size: 2, next_offset: null } },
  ];
  let i = 0;
  const out = await readFileParts(async () => windows[i++], "c", "p");
  ok("windows collected in order with whole-file meta", out.parts.join(",") === "QQ==,Qg==" && out.sha256 === "s");
  ok("an isError read throws with the server's first line", await throws(
    () => readFileParts(async () => ({ isError: true, content: [{ type: "text", text: "No such file — refresh.\nmore" }] }), "c", "p"), /No such file/));
}

console.log("9. write-set D adversarial review — the four P0 holes, pinned shut");
{
  // P0-3: data_changes is collection-addressed and returns FULL events (fields + item ids).
  // It was the one read the binding branch forgot.
  const io = makeIo();
  await guard({ ...FULL, cross_collection_read: false }, io)("callTool", { name: "data_changes", args: { collection: "other", since: 0 } });
  ok("data_changes forced to the bound collection (the richest read, was unbound)", io.calls[0].args.collection === "bound");
  const io2 = makeIo();
  await guard(FULL, io2)("callTool", { name: "data_changes", args: { collection: "other", since: 0 } });
  ok("…and still free with cross_collection_read", io2.calls[0].args.collection === "other");

  // P0-4: the chunked family carries no `app` — only an id minted server-side.
  const uploadIo = (overrides) => makeIo({
    callTool: async (name, args) => { overrides.calls.push({ name, args }); return { structuredContent: name === "file_write_begin" ? { upload_id: "up-A" } : { ok: true } }; },
    ...overrides,
  });
  const calls = [];
  const gA = guard(FULL, uploadIo({ calls }));
  ok("an upload_id this child never opened is refused", await throws(
    () => gA("callTool", { name: "file_write_chunk", args: { upload_id: "up-VICTIM", data_base64: "QQ==" } }), /not opened by this app/));
  await gA("callTool", { name: "file_write_begin", args: {} });
  ok("file_write_begin is still app-bound", calls[0].args.app === "child-app");
  await gA("callTool", { name: "file_write_chunk", args: { upload_id: "up-A", data_base64: "QQ==" } });
  ok("…and its OWN id then works", calls[1].name === "file_write_chunk");
  await gA("callTool", { name: "file_write_commit", args: { upload_id: "up-A", path: "f.txt" } });
  ok("commit retires the id — a replay after commit is refused", await throws(
    () => gA("callTool", { name: "file_write_chunk", args: { upload_id: "up-A", data_base64: "QQ==" } }), /not opened by this app/));
  const calls2 = [];
  const gB = guard(FULL, uploadIo({ calls: calls2 }));
  await gB("callTool", { name: "file_write_begin", args: {} });
  ok("a SECOND child holding the same id string is still refused (per-guard set)", await throws(
    () => gA("callTool", { name: "file_write_chunk", args: { upload_id: "up-A", data_base64: "QQ==" } }), /not opened by this app/));
  ok("the chunked family still needs the file_write cap at all", await throws(
    () => guard({ ...FULL, file_write: false }, makeIo())("callTool", { name: "file_write_chunk", args: { upload_id: "x" } }), /file write denied/));

  // P0-2: the child half of the source check. The parent has always had it (shell-runtime's
  // onMessage); without the mirror, a sibling WindowProxy could forge snapshots/results.
  ok("bridge refuses any message whose source is not the embedder", BRIDGE.includes("ev.source!==parent"));
  ok("…as the FIRST thing the handler does, before reading ev.data",
    /addEventListener\("message",function\(ev\)\{if\(ev\.source!==parent\)return;/.test(BRIDGE));
}

console.log("11. the engine's confirmation demand (W-S) — parent-rendered, child stays dumb");
{
  const DEMAND = { structuredContent: { ok: false, reason: "confirmation_required", request_state: "st-1", preview: "Buy milk", expires_at: "2099-01-01T00:00:00Z" } };
  const confirmIo = (answer, calls) => makeIo({
    calls,
    callTool: async (name, args) => { calls.push({ name, args }); return args.request_state ? { structuredContent: { ok: true, deleted: true } } : DEMAND; },
    requestConfirm: async (sc) => { calls.push({ name: "__requestConfirm", args: sc }); return answer; },
  });

  const calls = [];
  const g = guard({ ...FULL }, confirmIo(true, calls));
  const r = await g("deleteItem", { id: "in1" });
  ok("yes → overlay asked once, then resent WITH the engine's state",
    calls.map((c) => c.name).join(",") === "data_delete_item,__requestConfirm,data_delete_item"
      && calls[2].args.request_state === "st-1",
    JSON.stringify(calls.map((c) => c.name)));
  ok("…and the child's promise resolves with the FINAL ack", r.structuredContent.deleted === true);
  ok("the overlay was shown the demand itself (preview travels server→shell untouched)",
    calls[1].args.preview === "Buy milk");

  const calls2 = [];
  const r2 = await guard({ ...FULL }, confirmIo(false, calls2))("deleteItem", { id: "in1" });
  ok("no → exactly one delete attempt, nothing deleted, and the refusal says WHY",
    calls2.filter((c) => c.name === "data_delete_item").length === 1 && r2.structuredContent.reason === "confirmation_declined");
  // 🔴 The state is a BEARER credential for one destructive execution. A child that receives it
  // replays it through the generic door and the user's Cancel means nothing (codex review,
  // reproduced end to end). It must never cross back into the sandbox, on ANY branch.
  ok("the cancelled state does NOT come back to the child",
    r2.structuredContent.request_state === undefined && r2.structuredContent.expires_at === undefined,
    JSON.stringify(r2.structuredContent));

  const calls3 = [];
  const bare = makeIo({ calls: calls3, callTool: async (name, args) => { calls3.push({ name, args }); return DEMAND; } });
  const r3 = await guard({ ...FULL }, bare)("deleteItem", { id: "in1" });
  ok("no overlay available = fail closed: demand stated, no retry loop",
    r3.structuredContent.reason === "confirmation_required" && calls3.length === 1);
  ok("…and that branch withholds the state too", r3.structuredContent.request_state === undefined);

  // ONE prompt for one delete: the caps tier and the user's preference both speak through the
  // engine's demand, so there is no second question and no second place to answer it.
  const capsIo = makeIo();
  await guard({ ...FULL, delete_items: "confirm" }, capsIo)("callTool", { name: "data_delete_item", args: { id: "in1" } });
  ok("the generic door carries the same raised bar as the typed one", capsIo.calls[0].args.require_confirmation === true);
  ok("delete_items:'deny' refuses even WITH a state — caps outrank confirmation", await throws(
    () => guard({ ...FULL, delete_items: "deny" }, makeIo())("callTool", { name: "data_delete_item", args: { id: "in1", request_state: "st-x" } }), /delete denied/));

  // file_delete is the OTHER classified destructive command, and it reaches the same door.
  const fileIo = (answer, calls) => makeIo({
    calls,
    callTool: async (name, args) => { calls.push({ name, args }); return args.request_state ? { structuredContent: { deleted: true } } : DEMAND; },
    requestConfirm: async (sc) => { calls.push({ name: "__requestConfirm", args: sc }); return answer; },
  });
  const fcalls = [];
  await guard({ ...FULL }, fileIo(true, fcalls))("callTool", { name: "file_delete", args: { app: "x", path: "a.png" } });
  ok("a file delete gets the same overlay-then-resend flow, not a silent deletion",
    fcalls.map((c) => c.name).join(",") === "file_delete,__requestConfirm,file_delete" && fcalls[2].args.request_state === "st-1",
    JSON.stringify(fcalls.map((c) => c.name)));
  const fcalls2 = [];
  const fr = await guard({ ...FULL }, fileIo(false, fcalls2))("callTool", { name: "file_delete", args: { app: "x", path: "a.png" } });
  ok("…and a cancelled file delete withholds the state too", fr.structuredContent.request_state === undefined);
}

console.log(`\nrunner-guard: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
