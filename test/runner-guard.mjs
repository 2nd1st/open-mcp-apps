// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// test/runner-guard.mjs — the sandbox chokepoint, pinned with fake io.
//
// One machine (src/runner.mjs makeGuard) now carries every rule the three hand-kept copies
// used to drift on, so this file is the policy table in executable form: each row here is a
// line the adversarial review called "one missing line = a cross-app escape". Every effect
// goes through io, so the whole policy runs in node.
//
// Run: node test/runner-guard.mjs
import { makeGuard, composeChildDoc, BRIDGE, RUNNER_CSP, readFileParts, RATES, stubOmaScript, composePreviewDoc } from "../src/runner.mjs";

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
    updateContext: async () => null,
    snapshot: () => ({ collection: "bound", items: [{ id: "in1", group: "", position: 1, fields: {}, version: 42 }], version: 100 }),
    settingsIds: () => new Set(["srow1"]),
    readCollection: async (c) => ({ collection: c, items: [], version: 1, total: 0 }),
    readFile: async () => ({ base64: "QUJD", mime: "text/plain" }),
    notify: () => {},
    confirm: () => false,
    uuid: () => "u-1",
    ...overrides,
  };
}
const FULL = { call_tools: ["*"], send_message: true, update_context: true, delete_items: "allow",
  cross_collection_read: true, cross_collection_write: true, settings_write: true, read_source: true,
  file_read: true, file_write: true };
const guard = (caps, io, preset = "live", tier) => makeGuard({ name: "child-app", coll: "bound", caps, tier, preset, io });

console.log("1. the walls no cap combination can open");
{
  const io = makeIo();
  const g = guard(FULL, io);
  ok("control-plane tools denied under FULL caps + wildcard", await throws(() => g("callTool", { name: "save_component", args: {} }), /not available/));
  ok("…case/padding variants too", await throws(() => g("callTool", { name: "  Save_Component ", args: {} }), /not available/));
  ok("library_* reserved prefix denied", await throws(() => g("callTool", { name: "library_install", args: {} }), /not available/));
  ok("internal `_` RPC names denied (undo and the via ledger never reach a child)",
    await throws(() => g("callTool", { name: "_undo_last", args: {} }), /not available/));
  ok("data_batch denied even under wildcard (the F2 seam, closed by name)",
    await throws(() => g("callTool", { name: "data_batch", args: {} }), /not available to components/));
  ok("nothing above ever reached io", io.calls.length === 0);
}

console.log("2. writes: identity is FORCED, never child-supplied");
{
  const io = makeIo();
  const g = guard(FULL, io);
  await g("addItem", { fields: { t: 1 } });
  const w = io.calls[0];
  ok("typed write stamps actor:human + via:{component:child}", w.args.actor === "human" && w.args.via.component === "child-app");
  await g("callTool", { name: "data_add_item", args: { collection: "elsewhere", via: { component: "forged" }, actor: "agent", fields: {} } });
  const w2 = io.calls[1];
  ok("generic-path write: via/actor OVERWRITTEN (a forged via dies at the chokepoint)",
    w2.args.via.component === "child-app" && w2.args.actor === "human");
  ok("cross_collection_write=true lets the collection through", w2.args.collection === "elsewhere");
  const io2 = makeIo();
  await guard({ ...FULL, cross_collection_write: false }, io2)("callTool", { name: "data_add_item", args: { collection: "elsewhere", fields: {} } });
  ok("cross_collection_write=false FORCES the bound collection", io2.calls[0].args.collection === "bound");
  ok("call_function: callee forced to the child itself (second hop unreachable by shape)", await (async () => {
    const io3 = makeIo();
    await guard(FULL, io3)("callFunction", { function: "tick", args: {} });
    const c = io3.calls[0];
    return c.name === "call_function" && c.args.component === "child-app" && c.args.via.component === "child-app" && !!c.args.command_id;
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
  // back as an isError the child bridge RESOLVES with, so a component that ignores the return value
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
  ok("delete 'confirm' degrades to deny when confirm is unavailable", await throws(
    () => guard({ ...FULL, delete_items: "confirm" }, makeIo())("deleteItem", { id: "in1" }), /not confirmed/));
  const gs = guard({ ...FULL, settings_write: false }, makeIo());
  ok("a foreign id that IS a known settings row hits the settings guard",
    await throws(() => guard({ ...FULL, settings_write: false, cross_collection_write: true }, makeIo())("callTool", { name: "data_update_item", args: { id: "srow1", fields: {} } }), /settings write denied/));
  ok("setPref needs settings_write", await throws(() => gs("setPref", { key: "a", value: 1 }), /denied by policy/));
  ok("setPref validates its key even with the cap", await throws(
    () => guard(FULL, makeIo())("setPref", { key: "_bad", value: 1 }), /invalid or reserved/));
}

console.log("4. reads: binding + caps");
{
  const io = makeIo();
  await guard({ ...FULL, cross_collection_read: false }, io)("callTool", { name: "data_list", args: { collection: "other" } });
  ok("data_list forced to the bound collection without cross_collection_read", io.calls[0].args.collection === "bound");
  const io2 = makeIo();
  await guard({ ...FULL, cross_collection_read: false }, io2)("callTool", { name: "data_query", args: { collection: "other" } });
  ok("data_query binds exactly like data_list (same read, same rule)", io2.calls[0].args.collection === "bound");
  const io3 = makeIo();
  const rc = await guard({ ...FULL, cross_collection_read: false }, io3)("readCollection", { collection: "other" });
  ok("readCollection binds too", rc.collection === "bound");
  ok("component source reads need read_source", await throws(
    () => guard({ ...FULL, read_source: false }, makeIo())("callTool", { name: "get_component", args: {} }), /source read denied/));
  const io4 = makeIo();
  await guard(FULL, io4)("callTool", { name: "file_read", args: { component: "other", path: "x" } });
  ok("file reads bound to the child's OWN files", io4.calls[0].args.component === "child-app");
  ok("file reads need the cap", await throws(
    () => guard({ ...FULL, file_read: false }, makeIo())("filesRead", { path: "x" }), /file read denied/));
  const fr = await guard(FULL, makeIo())("filesRead", { path: "x" });
  ok("filesRead returns base64+mime for the bridge to decode", fr.base64 === "QUJD" && fr.mime === "text/plain");
}

console.log("5. rates — one table, enforced");
{
  const io = makeIo();
  const g = guard(FULL, io);
  let tripped = false;
  for (let i = 0; i <= RATES.writes[0]; i++) {
    try { await g("addItem", { fields: {} }); } catch (e) { tripped = /rate limit/.test(String(e.message)); break; }
  }
  ok("the writes rate trips at the table's limit", tripped);
}

console.log("5b. …and the notice says WHOSE budget ran out, once");
// Both halves are measured defects (2026-07-28), not hypotheticals. The stamps are per-guard, so
// a preview starves its OWN allowance — yet the notice named the component, and settings' Installed
// grid reported 'Component "dashboard" hit its refresh rate limit' while the real dashboard was
// fine. It said it four times, too: every refused call notified, so ten installed apps meant a
// toast storm. A notice that misattributes is worse than none — the user goes looking at an app
// that has nothing wrong with it.
{
  const saturate = async (preset) => {
    const notes = [];
    const g = guard(FULL, makeIo({ notify: (m) => notes.push(m) }), preset, "local");
    for (let i = 0; i <= RATES.refresh[0] + 4; i++) {
      try { await g("callTool", { name: "data_list", args: { collection: "c" + i } }); } catch { /* refused past the limit */ }
    }
    return notes;
  };
  const preview = await saturate("readonly");
  const live = await saturate("live");
  ok("one notice per saturation episode, not one per refused call", preview.length === 1, `${preview.length} notices`);
  ok("a starved PREVIEW does not read as the app being throttled",
    /^Preview of "child-app"/.test(preview[0] || "") && /app itself is unaffected/.test(preview[0] || ""), preview[0]);
  ok("a live widget still reports as the component itself",
    /^Component "child-app"/.test(live[0] || "") && live.length === 1, live[0]);
}

console.log("5c. the PARENTLESS stub answers from the same fixtures the guard's inert preset does");
// The public preview path (composePreviewDoc → stubOmaScript) is a second inert machine, and it
// had not learned what the first one did: answering every fetch empty reads as CORRUPT data, not
// as "no rows". Measured 2026-07-28 — training-log rendered "0/0 · No entries yet" plus "Refresh
// failed: training-plan returned invalid data" with its fixtures sitting in the same document.
// A stranger's first look at a shared app runs through here (hosted /library today, T19 P-a next),
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
  // A meta component asks WHICH collections exist, and WHICH apps exist, before it asks for rows.
  // Answering either with an empty envelope renders an app whose whole job is "show me everything"
  // as though the user owned nothing — on the machine that composes PUBLIC preview pages.
  const cols = await oma.callTool("data_collections", {});
  ok("the stub derives data_collections from the same fixtures",
    cols.structuredContent.collections.map((c) => c.collection).sort().join() === "a,b", JSON.stringify(cols.structuredContent));
  const bare = await oma.callTool("list_components", {});
  ok("with no roster supplied it answers an EMPTY list — honest, and never undefined",
    Array.isArray(bare.structuredContent.components) && bare.structuredContent.components.length === 0);

  // ⚠️ This pair replaces a single `Array.isArray(...)` assertion that passed on `[]` — i.e. it
  // passed whether or not the roster was ever wired, and it was covering a half-finished fix.
  // The roster is the ONLY way an installed app with an EMPTY collection stays visible in a
  // preview: inert derives data_collections from rows, and zero rows reads as "does not exist".
  const withRoster = stubOmaScript("a", items, [{ name: "a" }, { name: "empty-app" }]);
  const w2 = {};
  new Function("window", withRoster.replace(/^<script>/, "").replace(/<\/scr" *\+ *"ipt>$|<\/script>$/, ""))(w2);
  const named = await w2.oma.callTool("list_components", {});
  ok("…and hands back the composer's roster VERBATIM when there is one",
    named.structuredContent.components.map((c) => c.name).sort().join() === "a,empty-app",
    JSON.stringify(named.structuredContent.components));
  ok("…including the app that has no rows at all (the whole point of carrying a roster)",
    named.structuredContent.components.some((c) => c.name === "empty-app"));
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
  const cols = (await win.oma.callTool("data_collections", {})).structuredContent.collections;
  const names = cols.map((c) => c.collection).sort();
  ok("a collection named __proto__ still appears (a bare object swallowed it)",
    names.join() === "__proto__,constructor,ordinary", names.join());
  ok("…and every count is a NUMBER, not something inherited from Object.prototype",
    cols.every((c) => typeof c.items === "number" && c.items === 1),
    JSON.stringify(cols));
  // Same question of the guard's twin, so the two machines are pinned to the same answer.
  const g = guard(FULL, makeIo({ snapshot: () => ({ collection: "ordinary", items, version: 1 }) }), "inert", "local");
  const viaGuard = (await g("callTool", { name: "data_collections", args: {} })).structuredContent.collections;
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
  ok("the preview document broadcasts omaRunHeight", /omaRunHeight/.test(doc));
  ok("…the same message shape the runner child sends, so one embedder handles both",
    /postMessage\(\{omaRunHeight:true,\s*h:document\.documentElement\.scrollHeight\}/.test(doc.replace(/\s+/g, " ")),
    "shape drifted from src/runner.mjs's own broadcast");
  ok("…after the body, so the height it reports includes the app", doc.indexOf("omaRunHeight") > doc.indexOf("<div>hi</div>"));
  ok("…and it re-reports on resize rather than measuring once", /ResizeObserver/.test(doc));
  ok("…degrading to a single load-time report where ResizeObserver is missing",
    /typeof ResizeObserver==='function'/.test(doc) && /else window\.addEventListener\("load"/.test(doc));
  ok("a host that rejects postMessage cannot break the preview", /catch\(e\)\{\}/.test(doc));
  ok("the CSP still comes first — the broadcast did not become an injection anchor",
    doc.indexOf("Content-Security-Policy") < doc.indexOf("<div>hi</div>"));
}

console.log("5d. the PARENTED inert preset answers the same two questions from its snapshot");
// The other inert machine. Its roster arrives through oma.embed's childSnap, which used to
// rebuild the snapshot from an explicit key list and dropped `components` on the floor — so this
// half of "both preview machines now agree" was never true. Pinned on the guard directly.
{
  const snap = {
    collection: "a",
    items: [{ id: "i1", group: "", position: 1, fields: { t: "x" }, version: 1, collection: "a" }],
    components: [{ name: "a" }, { name: "empty-app" }],
    version: 3,
  };
  const g = guard(FULL, makeIo({ snapshot: () => snap }), "inert", "local");
  const roster = await g("callTool", { name: "list_components", args: {} });
  ok("inert answers list_components from the snapshot's roster",
    roster.structuredContent.components.map((c) => c.name).sort().join() === "a,empty-app",
    JSON.stringify(roster.structuredContent.components));
  const noRoster = await guard(FULL, makeIo({ snapshot: () => ({ collection: "a", items: [], version: 1 }) }), "inert", "local")(
    "callTool", { name: "list_components", args: {} });
  ok("…and an empty list when the embedder had none, never undefined",
    Array.isArray(noRoster.structuredContent.components) && noRoster.structuredContent.components.length === 0);
}

console.log("6. presets — readonly refuses writes; inert touches nothing");
{
  const io = makeIo();
  const g = guard(FULL, io, "readonly", "local");
  ok("readonly: every write path refuses", await throws(() => g("addItem", { fields: {} }), /read-only/));
  const snap = await g("refresh", {});
  ok("readonly: refresh answers from the cached snapshot, zero io", snap.collection === "bound" && io.calls.length === 0);
  await g("callTool", { name: "list_components", args: {} });
  ok("readonly local tier keeps the three-tool browse allowance", io.calls[0].name === "list_components");
  const io2 = makeIo();
  await guard(FULL, io2, "readonly", "unreviewed")("callTool", { name: "data_list", args: { collection: "other" } });
  ok("readonly non-local: only data_list, FORCED to the bound collection", io2.calls[0].args.collection === "bound");
  ok("readonly non-local: enumeration denied", await throws(
    () => guard(FULL, makeIo(), "readonly", "unreviewed")("callTool", { name: "list_components", args: {} }), /read-only/));
  ok("readonly: control-plane still walled", await throws(
    () => guard(FULL, makeIo(), "readonly", "local")("callTool", { name: "save_component", args: {} }), /not available/));
  const io3 = makeIo();
  const gi = guard(FULL, io3, "inert");
  const w = await gi("addItem", { fields: {} });
  const r = await gi("callTool", { name: "data_list", args: {} });
  ok("inert: writes pretend to succeed, reads answer, and io is NEVER touched",
    w.ok === true && r.structuredContent && io3.calls.length === 0);

  // Multi-collection previews lean on the snapshot answering PER COLLECTION: fixture rows carry
  // a `collection` key, and a self-fetching app (the GUIDE pattern) must get real rows back for
  // each one — the old empty envelope painted five of sixteen library cards as an error banner.
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
  const dv = await gm("callTool", { name: "data_version", args: {} });
  ok("inert data_version answers the snapshot's version as seq", dv.structuredContent.seq === 3);
  ok("…and the mixed-snapshot io was never touched either", mixed.calls.length === 0);
}

console.log("7. the child document + bridge surface");
{
  const doc = composeChildDoc("<h1>x</h1><script>evil()</script>", { tokenCss: "<style>:root{}</style>" });
  ok("CSP is the FIRST head child; untrusted markup rides wholesale in OUR body",
    doc.startsWith("<!doctype html><html><head>" + RUNNER_CSP) && doc.includes("<body><h1>x</h1>"));
  for (const m of ["addItem", "updateItem", "moveItem", "deleteItem", "refresh", "callTool", "readCollection", "callFunction", "files", "pref", "onPrefChange", "setPref", "sendMessage", "updateContext"])
    ok(`bridge exposes ${m}`, BRIDGE.includes(m + ":"));
  ok("bridge repaints on item-count change at an equal version (zero-row lesson)",
    BRIDGE.includes("d.snapshot.items.length!==S.items.length"));
  ok("bridge never claims embed (depth 1 — an embedded child cannot embed further)",
    !/embed\s*:/.test(BRIDGE));
  const kitted = composeChildDoc("<h1>x</h1>", { tokenCss: "<style>:root{}</style>", kitCss: ".k-btn{color:red}" });
  ok("the kit travels into the child (a separate document inherits no CSS)",
    kitted.includes('<style data-oma="kit">.k-btn{color:red}</style>'));
  ok("…after the tokens it reads, and before the component's own markup",
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

  // P0-4: the chunked family carries no `component` — only an id minted server-side.
  const uploadIo = (overrides) => makeIo({
    callTool: async (name, args) => { overrides.calls.push({ name, args }); return { structuredContent: name === "file_write_begin" ? { upload_id: "up-A" } : { ok: true } }; },
    ...overrides,
  });
  const calls = [];
  const gA = guard(FULL, uploadIo({ calls }));
  ok("an upload_id this child never opened is refused", await throws(
    () => gA("callTool", { name: "file_write_chunk", args: { upload_id: "up-VICTIM", data_base64: "QQ==" } }), /not opened by this component/));
  await gA("callTool", { name: "file_write_begin", args: {} });
  ok("file_write_begin is still component-bound", calls[0].args.component === "child-app");
  await gA("callTool", { name: "file_write_chunk", args: { upload_id: "up-A", data_base64: "QQ==" } });
  ok("…and its OWN id then works", calls[1].name === "file_write_chunk");
  await gA("callTool", { name: "file_write_commit", args: { upload_id: "up-A", path: "f.txt" } });
  ok("commit retires the id — a replay after commit is refused", await throws(
    () => gA("callTool", { name: "file_write_chunk", args: { upload_id: "up-A", data_base64: "QQ==" } }), /not opened by this component/));
  const calls2 = [];
  const gB = guard(FULL, uploadIo({ calls: calls2 }));
  await gB("callTool", { name: "file_write_begin", args: {} });
  ok("a SECOND child holding the same id string is still refused (per-guard set)", await throws(
    () => gA("callTool", { name: "file_write_abort", args: { upload_id: "up-A" } }), /not opened by this component/));
  ok("the chunked family still needs the file_write cap at all", await throws(
    () => guard({ ...FULL, file_write: false }, makeIo())("callTool", { name: "file_write_chunk", args: { upload_id: "x" } }), /file write denied/));

  // P0-2: the child half of the source check. The parent has always had it (shell-runtime's
  // onMessage); without the mirror, a sibling WindowProxy could forge snapshots/results.
  ok("bridge refuses any message whose source is not the embedder", BRIDGE.includes("ev.source!==parent"));
  ok("…as the FIRST thing the handler does, before reading ev.data",
    /addEventListener\("message",function\(ev\)\{if\(ev\.source!==parent\)return;/.test(BRIDGE));
}

console.log(`\nrunner-guard: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
