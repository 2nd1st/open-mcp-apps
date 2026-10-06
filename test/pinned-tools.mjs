// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// test/pinned-tools.mjs — an app gets its own open_<name> only when the user pins it.
//
// The pin is a settings row (group = the app's name, key "open_tool", value true), written here
// through data_* exactly as the settings app writes it. What has to hold: nothing pinned ⇒ no
// per-app tool; a pin, an unpin or deleting a pinned app moves the list and announces it ONCE;
// every other write — an ordinary save_app included — leaves tools/list alone, because that list
// is the front of every cached prompt. `dynamicTools: false` ignores pins entirely.
//
// Notifications are counted on the SERVER's side of an in-memory transport, so the number is
// what went on the wire, not what a client chose to surface.
//
// Run: node test/pinned-tools.mjs
import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createEngine } from "../index.mjs";
import { openStore } from "../src/store.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB = join(ROOT, "test", "pinned-tools.db");
const wipe = () => { for (const f of [DB, DB + "-wal", DB + "-shm"]) if (existsSync(f)) unlinkSync(f); };
wipe();

let pass = 0, fail = 0;
const ok = (name, cond, note) => (cond
  ? (pass++, console.log("  ✓ " + name))
  : (fail++, console.log("  ✗ " + name + (note ? "\n      " + note : ""))));
const settle = () => new Promise((r) => setTimeout(r, 20));

const store = openStore(DB);

async function connect(opts = {}) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const sent = [];
  const rawSend = st.send.bind(st);
  st.send = (msg, o) => { if (msg && msg.method === "notifications/tools/list_changed") sent.push(msg.method); return rawSend(msg, o); };
  await createEngine(store, opts).connect(st);
  const client = new Client({ name: "pinned-tools", version: "1.0.0" });
  await client.connect(ct);
  const call = (name, args) => client.callTool({ name, arguments: args });
  const openers = async () => (await client.listTools()).tools.map((t) => t.name).filter((n) => n.startsWith("open_") && n !== "open_app");
  /** Notifications sent since the last call. */
  const drain = async () => { await settle(); return sent.splice(0).length; };
  return { client, call, openers, drain };
}

const HTML = "<!doctype html><html><body><p>pin probe</p></body></html>";
const pinRow = (name, value) => ({ command_id: randomUUID(), collection: "settings", group: name, fields: { key: "open_tool", value } });

const c = await connect();
for (const n of ["alpha", "beta-two", "gamma"]) await c.call("save_app", { name: n, ui: HTML });
await c.drain();

console.log("a. default: no per-app tool for any app");
{
  ok("three saved apps, zero openers", (await c.openers()).length === 0, (await c.openers()).join(", "));
  const listed = await c.call("list_apps", {});
  ok("list_apps points at no opener", !listed.content[0].text.includes("→ open_"), listed.content[0].text);
  ok("…and says pins work here, so the settings switch is drawn", listed.structuredContent?.pinning === true);
}

console.log("b. pin → its tool appears, announced exactly once");
let alphaPin;
{
  const r = await c.call("data_add_item", pinRow("alpha", true));
  alphaPin = r.structuredContent?.item;
  ok("the pin is written", !r.isError && alphaPin?.id, JSON.stringify(r).slice(0, 300));
  ok("exactly one tools/list_changed", (await c.drain()) === 1);
  ok("open_alpha is listed", JSON.stringify(await c.openers()) === '["open_alpha"]', (await c.openers()).join(", "));
  const text = (await c.call("list_apps", {})).content[0].text;
  ok("list_apps shows → open_alpha for alpha only", text.includes("→ open_alpha") && !text.includes("→ open_beta_two"), text);
  const opened = await c.call("open_alpha", {});
  ok("open_alpha opens the app", !opened.isError && opened.structuredContent?.app === "alpha", JSON.stringify(opened).slice(0, 300));

  await c.call("apply_data_writes", { command_id: randomUUID(), commands: [
    { type: "add_item", ...pinRow("beta-two", true) }, { type: "add_item", ...pinRow("gamma", true) },
  ].map(({ command_id, ...cmd }) => cmd) });
  ok("pinning two apps in one batch is still ONE notification", (await c.drain()) === 1);
  ok("…and both openers are there", JSON.stringify((await c.openers()).sort()) === '["open_alpha","open_beta_two","open_gamma"]',
    (await c.openers()).join(", "));
}

console.log("b2. every other write leaves tools/list alone");
{
  await c.call("save_app", { name: "alpha", ui: HTML.replace("probe", "probe v2"),
    expected_version: (await c.call("list_apps", { name: "alpha" })).structuredContent.apps[0].version });
  await c.call("save_app", { name: "delta", ui: HTML });
  await c.call("data_add_item", { command_id: randomUUID(), collection: "settings", fields: { key: "locale", value: "en" } });
  await c.call("data_add_item", { command_id: randomUUID(), collection: "notes", fields: { title: "x" } });
  ok("re-save, new unpinned app, a settings write and a data write: zero notifications", (await c.drain()) === 0);
  ok("…and the opener set did not move", (await c.openers()).length === 3);
}

console.log("c. unpin → its tool is removed");
{
  const r = await c.call("data_update_item", { command_id: randomUUID(), id: alphaPin.id, fields: { value: false } });
  ok("the pin row is updated to false", !r.isError, JSON.stringify(r).slice(0, 300));
  ok("one tools/list_changed", (await c.drain()) === 1);
  ok("open_alpha is gone", !(await c.openers()).includes("open_alpha"), (await c.openers()).join(", "));
  const gone = await c.call("open_alpha", {}).catch((e) => e);
  ok("…and no longer callable", gone instanceof Error || gone?.isError === true, String(gone?.message ?? JSON.stringify(gone)).slice(0, 200));
}

console.log("d. deleting a pinned app removes its tool");
{
  const r = await c.call("delete_app", { name: "gamma", command_id: randomUUID() });
  ok("gamma is deleted", !r.isError, JSON.stringify(r).slice(0, 300));
  ok("one tools/list_changed", (await c.drain()) === 1);
  ok("open_gamma is gone, open_beta_two stays", JSON.stringify(await c.openers()) === '["open_beta_two"]', (await c.openers()).join(", "));
}

console.log("e. dynamicTools:false ignores pins");
{
  const off = await connect({ dynamicTools: false });
  ok("tools.listChanged is false", off.client.getServerCapabilities()?.tools?.listChanged === false,
    JSON.stringify(off.client.getServerCapabilities()?.tools));
  ok("the pinned beta-two gets no opener", (await off.openers()).length === 0, (await off.openers()).join(", "));
  await off.call("data_add_item", pinRow("delta", true));
  ok("pinning on that connection sends nothing", (await off.drain()) === 0);
  ok("…and adds nothing", (await off.openers()).length === 0);
  const listed = await off.call("list_apps", {});
  ok("list_apps points at no opener", !listed.content[0].text.includes("→ open_"), listed.content[0].text);
  ok("…and does not claim pins work, so no dead switch is drawn", !("pinning" in (listed.structuredContent ?? {})));
  await off.client.close();
  // The default connection on the same store did see that pin.
  await c.drain();
  ok("(the default connection on the same store picked the delta pin up)", (await c.openers()).includes("open_delta"));
}

console.log("f. open_tool is the engine's key — a manifest may not declare it");
{
  const r = await c.call("save_app", { name: "epsilon", ui: HTML,
    manifest: { settings: [{ key: "open_tool", type: "boolean", label: "Mine", default: false }] } });
  ok("save_app refuses it", r.isError === true && /open_tool/.test(r.content?.[0]?.text ?? ""), JSON.stringify(r).slice(0, 300));
  const fine = await c.call("save_app", { name: "epsilon", ui: HTML,
    manifest: { settings: [{ key: "open_tools", type: "boolean", label: "Mine", default: false }] } });
  ok("…while a neighbouring key saves", !fine.isError, JSON.stringify(fine).slice(0, 300));
}

await c.client.close();
store.close();
wipe();
console.log(`\n${fail === 0 ? "ALL PASS" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
