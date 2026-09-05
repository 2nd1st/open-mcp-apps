// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// test/prompt-surface.mjs — the PROMPT surface is a golden file too, for a different reason than
// the tool surface is one.
//
// tool-surface.mjs guards a RESIDENT cost: tools render into every conversation, so one changed
// character costs every user their prompt cache. Prompts cost nothing resident — `prompts/list`
// is fetched about once per connection and `prompts/get` only when a person picks the menu item.
// So this file is not a budget. It guards two things a budget cannot see:
//
//  1. THE NAME IS PUBLIC CONTRACT. `get_started` appears in a host's menu, in a user's muscle
//     memory, and (Claude Code) as the literal command `/mcp__open-mcp-apps__get_started`.
//     Renaming it is a break with no deprecation path, because a menu has no redirects. Pinning
//     the name — and the ABSENCE of arguments, which is the other half that can break — makes
//     that a decision somebody has to take on purpose.
//  2. THE BODY MUST STAY AN INSTRUCTION. The craft of writing an app lives in exactly one place,
//     `GUIDE` in src/guide.mjs (29 KB, pinned by doc-facts `exportBytes`). The failure this
//     project keeps paying for is one fact with two homes — docs/ still holds 312 mentions of
//     tool names that no longer exist, and copying from them fails. A prompt body that starts
//     explaining HOW to write an app becomes the second guide, and the two will disagree.
//     Two checks stand against that: a byte cap sized to catch a body that has doubled (not to
//     police wording), and a refusal of any long line the body shares verbatim with GUIDE.
//
// And one check the golden cannot make, because a golden only proves the bytes did not move, not
// that they were ever true: every tool name the body mentions must exist in the LIVE tools/list.
//
// Intentional failure: this suite reds on every deliberate wording change. Review the diff, then
// re-bless with UPDATE_GOLDEN=1 in the SAME commit as the change.
// Run: node test/prompt-surface.mjs   ·   bless: UPDATE_GOLDEN=1 node test/prompt-surface.mjs

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { GUIDE } from "../src/guide.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB = join(ROOT, "test", "prompt-surface.db");
const GOLDEN = join(ROOT, "test", "golden", "prompt-surface.json");
const BLESS = process.env.UPDATE_GOLDEN === "1";

// The whole prompt surface on the wire: `prompts/list` (277 B) plus every `prompts/get` body
// (748 B) = 1,025 B measured. The cap has deliberate slack because it is NOT a budget — nothing
// here is resident, so a byte spent on a clearer sentence buys something and costs nothing.
// What it catches is the ONE regression that matters: a body that grew into a copy of the guide.
// The guide is 29 KB; a body twice its current size is already a different kind of document.
const PROMPT_BYTES_CAP = 1_500;

for (const f of [DB, DB + "-wal", DB + "-shm"]) if (existsSync(f)) unlinkSync(f);

let pass = 0, fail = 0;
const ok = (name, cond, note) => (cond
  ? (pass++, console.log("  ✓ " + name))
  : (fail++, console.log("  ✗ " + name + (note ? "\n      " + note : ""))));

/** Same canonicaliser as tool-surface: key order is construction order, which is stable per build
 *  but not a contract we own. Sorting makes a golden diff mean "the surface changed". */
const canon = (v) =>
  Array.isArray(v) ? v.map(canon)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))
  : v;

// DEFAULT env, LEGACY era — the same choices tool-surface makes, for the same reason: this is the
// wire every shipped host speaks today, so the golden pins what those hosts actually receive.
const stdioParams = () => ({
  command: "node",
  args: [join(ROOT, "src", "server.mjs")],
  env: { ...process.env, OMA_DB: DB, OMA_HOST: "prompt-surface", OMA_DYNAMIC_TOOLS: "", OMA_VIEWER: "0" },
});
const client = new Client({ name: "prompt-surface", version: "1.0.0" });
await client.connect(new StdioClientTransport(stdioParams()));

console.log("1. the capability, and the claim it makes");
{
  const caps = client.getServerCapabilities();
  // Declared, or the SDK refuses prompts/list outright. Pinned as an exact object because the
  // interesting half is `false`: registering a prompt makes the SDK declare the capability by
  // itself and fill the bit in with `?? true`, so deleting the explicit line in engine.mjs would
  // silently start advertising list-change notifications this server never sends.
  ok("prompts capability is declared, and declares listChanged: false",
    JSON.stringify(caps?.prompts) === JSON.stringify({ listChanged: false }),
    `got ${JSON.stringify(caps?.prompts)} — an engine that says listChanged:true is inviting hosts ` +
    `to re-list a list that is fixed at construction and cannot move.`);
}

console.log("2. prompts/list");
const { prompts } = await client.listPrompts();
const names = prompts.map((p) => p.name);
ok(`${prompts.length} prompt registered`, prompts.length >= 1);
ok("get_started is on the list", names.includes("get_started"), names.join(", "));
ok("no duplicate prompt names", new Set(names).size === names.length);
{
  // The name is one breaking surface; the ARGUMENTS are the other, and the only shape that can
  // never break on them is the one that has none. A prompt that grows an argument grows a way to
  // be called wrong, so the absence is pinned rather than merely true today.
  const withArgs = prompts.filter((p) => Array.isArray(p.arguments) && p.arguments.length > 0);
  ok("every prompt is argument-free — nothing here can break on an argument name",
    withArgs.length === 0,
    `declares arguments: ${withArgs.map((p) => `${p.name}(${p.arguments.map((a) => a.name).join(",")})`).join(", ")}`);
  // Title and description are the only words a person reads before choosing. A prompt with
  // neither is a bare snake_case name in a menu.
  for (const p of prompts) {
    ok(`${p.name} carries a title and a description a stranger can act on`,
      typeof p.title === "string" && p.title.length > 0 &&
      typeof p.description === "string" && p.description.length > 20);
  }
}

console.log("3. prompts/get returns messages a host can send");
const bodies = new Map();
for (const p of prompts) {
  const got = await client.getPrompt({ name: p.name });
  ok(`${p.name}: messages[] is non-empty`, Array.isArray(got.messages) && got.messages.length > 0);
  // User-initiated by definition (the person picked it), so what it delivers is what they would
  // otherwise have typed. A prompt that speaks in the assistant's voice through a user turn is a
  // mismatch the model has to resolve before it can do anything.
  ok(`${p.name}: every message is role "user"`, got.messages.every((m) => m.role === "user"));
  ok(`${p.name}: every message carries text content`,
    got.messages.every((m) => m.content?.type === "text" && typeof m.content.text === "string" && m.content.text.length > 0));
  bodies.set(p.name, got.messages);
}

console.log("4. the get_started body actually says the things it exists to say");
{
  const text = bodies.get("get_started").map((m) => m.content.text).join("\n");
  // Each of these is a routing instruction the prompt exists to deliver. They are asserted by
  // the behaviour they name, not by a phrase, so the sentence around them can be reworded.
  ok("it says to look at what the user already has before building",
    /list_apps/.test(text) && /list_data_collections/.test(text));
  ok("it points at the built-in App Store rather than defaulting to writing something new",
    /app_store_list/.test(text) && /install_from_app_store/.test(text));
  ok("it puts get_app_guide BEFORE writing anything — the one ordering that makes apps come out right",
    /before you write[^.]*get_app_guide/i.test(text));
  ok("it caps the interrogation at two questions", /at most two questions/i.test(text));
  ok("it ends with an app on screen, not a description of one", /open_app/.test(text));
}

console.log("5. the body names only tools that exist, and is not a copy of the guide");
{
  const { tools } = await client.listTools();
  const toolNames = new Set(tools.map((t) => t.name));
  const surface = [...prompts.flatMap((p) => [p.title ?? "", p.description ?? ""]),
    ...[...bodies.values()].flat().map((m) => m.content.text)].join("\n");
  // Every snake_case token in anything a host shows or sends. This is the sharpest way a doc in
  // this repo does damage — an agent copies a name that no longer exists and the call just fails
  // — and the join is only possible here, where the live tools/list is one await away.
  // A snake_case word that is NOT a tool reds this too, and that is intended: there is no reason
  // for one to appear in prose, so its appearance means somebody should look.
  const tokens = [...new Set(surface.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? [])];
  const dead = tokens.filter((t) => !toolNames.has(t));
  ok(`${tokens.length} tool name(s) mentioned, all of them live: ${tokens.join(", ")}`,
    dead.length === 0,
    `not in tools/list: ${dead.join(", ")} — a prompt that names a tool the server does not have ` +
    `hands the model a call that fails on its first move.`);

  // The guide has one home. A line long enough to be a sentence, shared verbatim with GUIDE, is
  // the visible edge of a second copy starting — check the shape, not a wording.
  const shared = [...bodies.values()].flat()
    .flatMap((m) => m.content.text.split("\n"))
    .map((l) => l.trim())
    .filter((l) => l.length >= 40 && GUIDE.includes(l));
  ok("no long line is shared verbatim with the authoring guide",
    shared.length === 0,
    `these lines exist in src/guide.mjs too: ${shared.join(" | ")}\n` +
    `      The prompt routes TO the guide (get_app_guide); it must not restate it.`);
}

console.log("6. both eras deliver the same prompt");
{
  // A pinned modern connection, no probe-and-fallback: if the server stops offering 2026-07-28,
  // connect() throws and this reds. The eras must agree, because the golden below is pinned on
  // the legacy wire and this line is what entitles it to stand for both.
  const modern = new Client({ name: "prompt-surface", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await modern.connect(new StdioClientTransport(stdioParams()));
  const ml = await modern.listPrompts();
  ok("modern-era prompts[] byte-identical to the legacy-era list",
    JSON.stringify(canon(ml.prompts)) === JSON.stringify(canon(prompts)));
  for (const p of prompts) {
    const mg = await modern.getPrompt({ name: p.name });
    ok(`${p.name}: modern-era messages byte-identical to legacy`,
      JSON.stringify(canon(mg.messages)) === JSON.stringify(canon(bodies.get(p.name))));
  }
  await modern.close();
}

console.log("7. wire size");
const wire = { prompts: canon(prompts), messages: Object.fromEntries([...bodies].map(([n, m]) => [n, canon(m)])) };
const wireBytes = Buffer.byteLength(JSON.stringify(canon(prompts)), "utf8")
  + [...bodies.values()].reduce((n, m) => n + Buffer.byteLength(JSON.stringify(canon(m)), "utf8"), 0);
ok(`the whole prompt surface is ${wireBytes} B (cap ${PROMPT_BYTES_CAP} B)`,
  wireBytes <= PROMPT_BYTES_CAP,
  "a prompt body this size has stopped being an instruction. If it is genuinely all routing,\n" +
  "      raise the cap WITH a reason in the commit message — but read it first.");

console.log("8. golden file");
const actual = JSON.stringify(wire, null, 2) + "\n";
// A MISSING golden is a failure, not a licence to mint one — same ruling as tool-surface.
if (!BLESS && !existsSync(GOLDEN)) {
  ok(`the golden exists (${GOLDEN.slice(ROOT.length + 1)})`, false,
    `no baseline to compare against, so this file is currently guarding nothing.\n` +
    `      If the prompt surface is genuinely correct right now, record it ON PURPOSE:\n` +
    `        UPDATE_GOLDEN=1 node test/prompt-surface.mjs\n` +
    `      then READ THE DIFF before committing.`);
} else if (BLESS) {
  mkdirSync(dirname(GOLDEN), { recursive: true });
  writeFileSync(GOLDEN, actual);
  console.log(`  ⟳ blessed ${GOLDEN.slice(ROOT.length + 1)} (${actual.length} bytes, ${prompts.length} prompt(s))`);
  pass++;
} else {
  const golden = readFileSync(GOLDEN, "utf-8");
  const goldenNames = Object.keys(JSON.parse(golden).messages);
  // Name first: a rename is the one change here with no deprecation path, and "byte mismatch"
  // would bury it under a wall of text diff.
  ok("prompt names unchanged", JSON.stringify(goldenNames.sort()) === JSON.stringify([...names].sort()),
    `golden: ${goldenNames.join(", ")}\n      actual: ${names.join(", ")}`);
  ok("prompt surface byte-identical to golden", golden === actual,
    "a name, title, description or body changed.\n" +
    "      Review `git diff test/golden/prompt-surface.json` after: UPDATE_GOLDEN=1 node test/prompt-surface.mjs");
}

await client.close();
for (const f of [DB, DB + "-wal", DB + "-shm"]) if (existsSync(f)) unlinkSync(f);

console.log(`\nprompt-surface: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
