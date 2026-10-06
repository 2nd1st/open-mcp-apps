// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// test/edit-range.mjs — range-hash editing (W-E, §8-R1 lite).
//
// What must stay true, in order of what it costs when it breaks:
//   1. a WRONG range never splices silently — the hash turns caller confusion into an error
//      (the whole reason "range-hash" is one word in the design);
//   2. offsets address the ORIGINAL document, ranges never shift each other, overlap is refused;
//   3. the node locator resolves markers at READ time and refuses ambiguity instead of guessing.
//   (A 4th — every edit outcome landing one line in the edit-telemetry sidecar — went with the
//   sidecar in 0.8.1.)
// Run: node test/edit-range.mjs
import { sliceHash, applyRangeEdits, locateNode } from "../src/edit-range.mjs";
import { join } from "node:path";

let pass = 0, fail = 0;
const ok = (name, cond, note) => (cond
  ? (pass++, console.log("  ✓ " + name))
  : (fail++, console.log("  ✗ " + name + (note ? "\n      " + note : ""))));

console.log("1. range apply — original coordinates, end-first, all-or-nothing");
{
  const doc = "aaaa BBBB cccc DDDD eeee";
  const h = (s) => sliceHash(s);
  const r = applyRangeEdits(doc, [
    { offset: 5, length: 4, expect_hash: h("BBBB"), new_string: "b" },      // shrinks
    { offset: 15, length: 4, expect_hash: h("DDDD"), new_string: "dddddd" }, // grows, LATER offset
  ]);
  ok("two ranges, one shrinking before one growing, both land where they were aimed",
    r.ok && r.html === "aaaa b cccc dddddd eeee", r.html);

  const r2 = applyRangeEdits(doc, [
    { offset: 15, length: 4, expect_hash: h("DDDD"), new_string: "x" },
    { offset: 5, length: 4, expect_hash: h("BBBB"), new_string: "y" },
  ]);
  ok("order in the array does not matter — offsets are original-document facts",
    r2.ok && r2.html === "aaaa y cccc x eeee", r2.html);

  const bad = applyRangeEdits(doc, [
    { offset: 5, length: 4, expect_hash: h("BBBB"), new_string: "y" },
    { offset: 7, length: 4, expect_hash: h("BB c"), new_string: "z" },
  ]);
  ok("overlapping ranges are refused as a disagreement, not resolved by luck",
    !bad.ok && bad.error === "overlap", JSON.stringify(bad));
}

console.log("\n2. the hash — caller confusion becomes an error, never a mis-splice");
{
  const doc = "function a() {}\nfunction b() {}\n";
  const wrong = applyRangeEdits(doc, [{ offset: 16, length: 15, expect_hash: sliceHash("function a() {}"), new_string: "X" }]);
  ok("right text, wrong offset → hash_mismatch (this is the D1 shape, caught)",
    !wrong.ok && wrong.error === "hash_mismatch", JSON.stringify(wrong));
  const past = applyRangeEdits(doc, [{ offset: 30, length: 99, expect_hash: "abc", new_string: "X" }]);
  ok("range past the end is bad_range, not a truncated splice", !past.ok && past.error === "bad_range");
  const empty = applyRangeEdits(doc, [{ offset: 0, length: 0, expect_hash: sliceHash(""), new_string: "// new\n" }]);
  ok("zero-length range = pure insertion at a hashed point", empty.ok && empty.html.startsWith("// new\n"));
}

console.log("\n3. the node locator — resolves at read time, refuses ambiguity");
{
  const doc = `<html><body><div id="x"><ul data-oma-node="list"><li>a</li><ul><li>n</li></ul></ul></div><input data-oma-node="field"><p>t</p></body></html>`;
  const list = locateNode(doc, "list");
  ok("nested same-tag element balances to ITS close, not the inner one",
    list.ok && doc.slice(list.offset, list.offset + list.length) === `<ul data-oma-node="list"><li>a</li><ul><li>n</li></ul></ul>`,
    JSON.stringify(list));
  const field = locateNode(doc, "field");
  ok("void element spans exactly its own tag",
    field.ok && doc.slice(field.offset, field.offset + field.length) === `<input data-oma-node="field">`);
  ok("missing marker is node_not_found", locateNode(doc, "ghost").error === "node_not_found");
  const dup = locateNode(doc + `<i data-oma-node="list"></i>`, "list");
  ok("duplicated marker is refused, not first-match-wins", dup.error === "node_ambiguous", JSON.stringify(dup));
}

console.log("\n4. the real tool face — read a window, echo its stamp, never compute anything");
{
  const { Client } = await import("@modelcontextprotocol/client");
  const { StdioClientTransport } = await import("@modelcontextprotocol/client/stdio");
  const { fileURLToPath } = await import("node:url");
  const { dirname: dn } = await import("node:path");
  const { existsSync, unlinkSync } = await import("node:fs");
  const ROOT = join(dn(fileURLToPath(import.meta.url)), "..");
  const DB = join(ROOT, "test", "edit-range.db");
  for (const f of [DB, DB + "-wal", DB + "-shm"]) if (existsSync(f)) unlinkSync(f);

  const client = new Client({ name: "edit-range", version: "0" });
  await client.connect(new StdioClientTransport({
    command: "node", args: [join(ROOT, "src", "server.mjs")],
    env: { ...process.env, OMA_DB: DB, OMA_VIEWER: "0" },
  }));
  const { randomUUID } = await import("node:crypto");
  const call = async (name, args) => {
    if (name === "edit_app") args = { command_id: randomUUID(), ...args };
    const r = await client.callTool({ name, arguments: args });
    return { err: !!r.isError, s: r.structuredContent, text: r.content?.[0]?.text || "" };
  };

  const html = `<!DOCTYPE html><html><head><style>.a{color:red}</style></head><body><ul data-oma-node="menu"><li>one</li></ul><p>tail</p></body></html>`;
  const saved = await call("save_app", { name: "er-probe", ui: html, description: "range probe" });
  ok("probe app saved", !saved.err, saved.text);

  const win = await call("get_app", { name: "er-probe", node: "menu" });
  ok("node window covers exactly the marked element and carries a hash",
    !win.err && win.s.text === `<ul data-oma-node="menu"><li>one</li></ul>` && /^[0-9a-f]{12}$/.test(win.s.hash),
    JSON.stringify(win.s));

  const edited = await call("edit_app", { app: "er-probe", expected_version: win.s.version,
    edits: [{ offset: win.s.offset, length: win.s.returned, expect_hash: win.s.hash,
      new_string: `<ul data-oma-node="menu"><li>one</li><li>two</li></ul>` }] });
  ok("range edit lands by echoing the window's stamp verbatim", !edited.err && edited.s.applied === 1, edited.text);

  const after = await call("get_app", { name: "er-probe", node: "menu" });
  ok("re-read through the node sees the replacement", after.s.text.includes("<li>two</li>"));

  const stale = await call("edit_app", { app: "er-probe", expected_version: after.s.version,
    edits: [{ offset: win.s.offset, length: win.s.returned, expect_hash: win.s.hash, new_string: "X" }] });
  ok("a stale stamp (old hash, new document) is a hash error — the old window is not there anymore",
    stale.err && stale.text.includes("hash"), stale.text);

  const mixed = await call("edit_app", { app: "er-probe", expected_version: after.s.version,
    edits: [
      { offset: after.s.offset, length: after.s.returned, expect_hash: after.s.hash,
        new_string: `<ul data-oma-node="menu"><li>uno</li></ul>` },
      { old_string: "<p>tail</p>", new_string: "<p>coda</p>" },
    ] });
  ok("mixed call: range first against the original, string after on the result", !mixed.err && mixed.s.applied === 2, mixed.text);

  await client.close();
  for (const f of [DB, DB + "-wal", DB + "-shm"]) if (existsSync(f)) unlinkSync(f);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
