// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// guide.mjs — the app authoring contract, returned by the get_app_guide tool.
// This is what an AI reads BEFORE writing an app. Keep it tight, exact, example-led.

export const GUIDE = `# open-mcp-apps — app authoring guide

An app is ONE self-contained HTML document. The engine wraps it with a shell that
provides \`window.oma\` (data + persistence + host theming). Your app only renders
UI and calls \`window.oma\`. Rules:

- NO external resources (no CDN scripts, no remote CSS/images/fonts, no fetch). The sandbox
  CSP blocks them. Inline everything. This is NOT claude.ai Artifacts: there is no React
  runtime, no JSX compiler, and no CDN allowlist here — <div className=...> and
  <script src="https://cdnjs..."> will NOT work. Write plain HTML + vanilla DOM against
  window.oma (the pattern below is all you need).
- Do NOT import any SDK and do NOT touch postMessage — the shell owns the MCP bridge.
- Put your logic in <script type="module"> (the shell's module runs first, so window.oma exists).
- **Your app is CODE, not a database.** Anything that is DATA — rows, entries, a question
  bank, a catalogue, a month of expenses — goes into the collection with \`data_batch\`, never into
  a literal in your source. See "Seeding data" below. This one is a rule, not a preference.
- **Write it like source, not like a bundle**: one statement per line, real indentation, normal
  spacing. Never minify or pack lines. Every later change goes through \`edit_app\`, which
  matches EXACT strings — a 300-character line has no small edit inside it, so a compressed
  app can only ever be rewritten whole, at full price, for the rest of its life.
- Keep it under ~100KB — and if you are near that, the reason is almost always data in the source.
  (Reads are WINDOWED for a reason: some hosts silently drop the middle of a tool result past
  roughly 45KB, so source travels in windows and edits go through edit_app — a lean
  app is one you can still read in a couple of windows.)

## Data model

Each app is bound at open-time to ONE *collection* — the single collection its manifest
declares, else its own name (several declared → see \`Multi-collection apps\` below).
A collection is a flat list of items:

  item = { id: string, group: string, position: number, fields: object, version: number }

- \`group\`  — YOUR app defines its meaning (kanban column, list section, "" if unused).
  Show rows with an unrecognized group in a fallback section — never counted but invisible.
- \`fields\` — YOUR app defines the shape (e.g. {title, done, notes, due, color}).
- \`version\`/\`position\`/\`id\` — managed by the engine. Never invent them.

### Seeding data (what keeps an app cheap to own)

Building an app that starts with content — 30 practice questions, a reading list, last month's
expenses? The content goes into the COLLECTION first, with \`data_batch\` (up to 200 commands in
one transaction), and the app renders whatever it finds there:

  data_batch { command_id: "<one fresh uuid>", commands: [
    { type: "add_item", collection: "quiz", fields: { q: "…", options: ["…","…"], answer: 0 } },
    { type: "add_item", collection: "quiz", fields: { q: "…", options: ["…","…"], answer: 2 } }
  ]}

Two things that example is showing you: every command carries its OWN \`collection\` (there is no
batch-level one, and a command missing it fails, which rolls the whole batch back), and ONE
\`command_id\` covers the batch — the per-command ids are derived from it, so don't generate 200.

Do NOT put those rows in your HTML as a JS array, however convenient it looks. If you do:
- the app grows with the data, and every later edit re-sends all of it;
- "add ten more" becomes a full rewrite instead of one \`data_batch\` call;
- nothing can search, filter, export or share the data, and no other app can read it;
- the user cannot add a row themselves without you editing code;
- the data dies with the app, which defeats the entire point of this engine.
Data in a source literal is the one mistake that makes an app expensive to keep.

**When the data is THEIRS and you don't have it.** This is the common case, and it is the one that
goes wrong: someone says "track my subscriptions" or "what's in the freezer", the rows live in
their head or a drawer, and the app ships empty and stays empty. Measured: of eleven first
attempts, ELEVEN opened with zero rows and eight had not even created their collection — for
requests where an empty app is worth nothing.

Build it anyway — the collection has to exist before anything can go into it — and make getting
their content in the app's job, not the chat's:

- The empty state is a WORKING part of the app, not a "no items yet" line. It is the first thing
  this person sees, so it says what goes here and gives them the way to put it in.
- Include a **paste-many box**: a textarea, one item per line, that splits on newlines and calls
  \`oma.addItem\` per line. Twenty rows in one paste, no round trip through you. It costs about
  fifteen lines and it is the difference between an app they fill and an app they abandon.
- Seed whatever you genuinely know — from the conversation, from what they told you earlier. Real
  rows only. Never invent plausible-looking content to make it look alive; a tracker with fake
  entries in it is worse than an empty one, because now they have to find and delete them.

## window.oma API

  oma.state                          // {collection, items, version} — current snapshot
  oma.ready(cb)                      // cb(state) once connected + initial data loaded. START HERE.
  oma.onChange(cb)                   // cb(state) after EVERY data change (incl. your own writes)
  oma.addItem({group, fields})       // returns Promise; state auto-refreshes via onChange
  oma.updateItem(id, fields)         // shallow-merge; set a key to null to delete it
  oma.moveItem(id, group, position?) // position defaults to end of target group
  oma.deleteItem(id)
  oma.refresh()

Pattern: render everything from state inside ONE render(state) function; register it with
both ready() and onChange(); mutations just call oma.* and DON'T touch local state
(the runtime applies the write and re-triggers render with fresh state — a write's reply is
an acknowledgement, not a snapshot).

The shell auto-refreshes while visible (~20s poll + on tab refocus) and only fires onChange
when data actually changed — so external edits (the AI, another host) appear on their own;
you never need your own polling. Because a re-render CAN arrive at any time, keep transient
UI state (an open input, a drag) in variables outside render().

## Refresh semantics (one ledger, one \`seq\`)

Every store write — item edits in ANY collection, app saves/installs, file writes —
appends to a single ledger and bumps one global \`seq\`. Three consequences:
- \`state.version\` IS that global seq, not a per-collection counter: it can move while your
  items are identical (another app wrote, an app was installed), and a re-render with
  unchanged items is normal. Treat version as "something changed somewhere"; diff items if
  you need "did MY data change".
- onChange only ever carries YOUR bound collection's snapshot — other collections' contents
  never arrive through it, and it does not even FIRE for a change that touched only other
  collections (the poll advances its bookmark silently).
- An unmoved seq means nothing changed anywhere — that one cheap check (the \`data_version\`
  tool) is how the shell's poll decides to refetch, and why you never poll yourself.

## Multi-collection apps (fetch what you render)

Several declared collections ⇒ the widget binds to the app's NAME (usually an empty
collection): \`oma.state.items\` is NOT your data, and \`onChange\` stays SILENT about the
collections you render — the staleness poll checks the BOUND one only. "Never poll yourself"
is its privilege alone. So fetch what you render, and own the staleness:

  const DATA = { "trip-days": [], "trip-costs": [] };
  async function pull() {
    const reads = await Promise.all(Object.keys(DATA).map((c) => oma.readCollection(c)));
    for (const r of reads) DATA[r.collection] = r.items;
    render();
  }
  oma.ready(pull); oma.onChange(pull);
  setInterval(() => { if (!document.hidden) pull(); }, 30_000);

\`oma.readCollection\` walks every page (\`data_list\` via callTool returns one) and is
tier-gated — first-party apps only; shared/unreviewed ones keep to their bound collection.
\`oma.addItem\`/… write the BOUND collection; cross-collection writes use
\`oma.callTool("data_add_item", {command_id: crypto.randomUUID(), collection, fields,
actor: "human"})\`, then \`pull()\` — no onChange will come. Declarations stay the field
contract either way.

## Time — compute it at render, never store the answer

The single largest defect class measured in shipped apps (audited at +45 days: ~1 in 5 apps
was lying): a value that is a FUNCTION OF NOW, stored as a string. "due soon" saved into a
field, a next_due copied once and never advanced, a countdown baked at build time — correct
on the day it was written, wrong within weeks, and invisible to you because YOU only ever see
day zero. The user finds out later, alone.

Rules:

1. Store the FACT (an ISO date, an anchor + frequency). Render the JUDGMENT (days left,
   overdue, next occurrence) inside render(state), from the clock, every time.
2. Recurrence: NEVER store a next_due you don't advance — derive it. No stored value means
   nothing to go stale.
3. A past date is DATA, not an error: render "overdue by N days", never clamp to "due today".
4. Date-only strings parse as UTC in JS (new Date("2026-08-01")) — build local dates from
   apps or your "today" boundary lands a day off for half the planet.

Copy these two — they carry the traps (UTC parse, DST, ceil-vs-floor) so you don't:

\`\`\`js
const dateOnly = (iso) => { const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number); return new Date(y, m - 1, d); };
const today    = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); };
const daysUntil = (iso) => Math.round((dateOnly(iso) - today()) / 86400000);   // negative = overdue
// Next occurrence of an anchor repeating every N days — derived, nothing stored, DST-safe:
const nextOccurrence = (anchorIso, everyDays) => {
  const a = dateOnly(anchorIso);
  const k = Math.max(0, Math.ceil((today() - a) / (everyDays * 86400000)));
  return new Date(a.getFullYear(), a.getMonth(), a.getDate() + k * everyDays);
};
\`\`\`

Self-check before you save: set the clock forward 45 days in your head — does every row still
render the truth? Every "N days left", every recurring item, every "overdue" flag.

## Replying to the AI from the UI

  oma.sendMessage(text)   // PROPOSES text into the chat — a suggestion, NOT an authorization: the
                            // host may run it, confirm it with the user, or refuse it (an app
                            // cannot speak with the user's authority). Word it as a proposal and
                            // never render "sent!" as if it happened. Can your app just DO the
                            // thing? Do that — oma.openLink(url) opens a URL without the AI.

This is how an app closes the loop without typing: let the user act in the UI, then
offer one button that reports the outcome, e.g.
  btn.onclick = () => oma.sendMessage("Decisions ready: " + summary + " — please proceed.");

## User preferences (oma.pref)

Users configure apps in the central "settings" app. Read preferences with the
SYNC getter (never fetch the settings collection yourself):

  oma.pref(key, fallback)   // merged: your app's override ▸ global ▸ fallback.
                              // The FALLBACK'S TYPE drives coercion — pass a boolean/
                              // number/string fallback and junk stored values fall back
                              // safely instead of reaching your code.
  oma.onPrefChange(cb)      // cb({key, value, oldValue, scope}) when a pref changes;
                              // a normal onChange re-render also fires, so a single
                              // render(state) that calls oma.pref() stays correct free.
  oma.setPref(key, value)   // persist one of YOUR OWN settings (scalar values only).
                              // You can only write your own app's namespace.

Standard shared keys — use these, do NOT invent near-duplicates:

  locale ("auto")            week_start ("monday"|"sunday"|"saturday")
  date_format ("auto"|"yyyy-mm-dd"|"dd/mm/yyyy"|"mm/dd/yyyy")
  currency ("USD")           density ("comfortable"|"compact")
  confirm_delete (true)      widget_poll_seconds (20; read by the shell, not you)

Example: const l = oma.pref("locale","auto");
         const fmt = new Intl.DateTimeFormat(l === "auto" ? navigator.language : l);

Deletes: just call oma.deleteItem(id). confirm_delete is ENFORCED BY THE ENGINE — when it is
on, the shell shows its own confirmation and your await resolves after the user answers (or
with ok:false if they cancel). Do NOT build your own confirm step; a second one just
double-asks. (And NEVER confirm() — see Sandbox limits.)

### Declaring what your app is (the manifest slot)

An app is TWO slots, saved together as one version: \`ui\` (the document) and \`manifest\` (what the
app says about itself). The manifest is a plain JSON object passed to \`save_app\` — it does NOT
live inside the html (a document carrying an old-style \`#oma-manifest\` script block is refused,
loudly, with the fix in the message):

  save_app { "name": "pomodoro", "ui": "<!DOCTYPE html>…", "manifest": {
    "manifest_version": 2,
    "settings": [
      { "key": "work_minutes", "type": "number", "label": "Work session (minutes)",
        "default": 25, "min": 5, "max": 120, "step": 5 },
      { "key": "chime", "type": "enum", "label": "Sound", "options": ["none","bell"], "default": "bell" }
    ],
    "uses_shared": ["confirm_delete"],
    "collections": { "trips": { "label_field": "title" } },
    "kind": "app" } }

Keys, all optional — declare what you use:

- \`settings\` — your own options; the settings app renders a form for them (keys lowercase
  snake_case; types boolean | number | enum | string). Read them with \`oma.pref(key, fallback)\`.
- \`uses_shared\` — which SHARED preferences you honour, so the settings app groups them with you.
- \`collections\` — which collections this app looks after. Naming one claims it for the
  lifecycle side (export, archive views, retention) and costs nothing else. Add \`fields\` and the
  ENGINE validates every write to that collection — from you, from the AI, from anywhere:
  \`{ "trips": { "fields": { "title": {"type":"string","required":true} }, "strict": true } }\`.
  \`label_field\` says which field names a row, so summaries stop guessing.
- \`kind\` — \`app\` (a person opens it and comes back), \`visual\` (opened once, looked at, done).
  A visual that turns out to be a keeper upgrades in place: \`promote_app {name}\` flips this key
  in the stored manifest and saves a new version — nothing re-transmitted, history kept.
- \`scene\` — App Store filing: \`{ "category_id": "local-tools" }\`.

Slot rules, because the engine enforces them:

- **Omitted = kept.** A \`save_app\` without \`manifest\` keeps the declaration exactly as it was;
  an \`edit_app\` never touches it. Same for \`ui\` — a manifest-only save re-declares without
  re-sending the document.
- **\`manifest: null\` = cleared**, including the App Store filing (\`scene\`) and \`kind\` (back to
  \`app\`). Clearing is something you SAY — \`manifest: {}\` is refused as ambiguous.
- **An object = the whole declaration.** There is no key-merge: read it first
  (\`get_app {name, slot: "manifest"}\`), change what you mean, send it back whole — a key you
  drop is a key you deleted (kind flips have \`promote_app\` so you never hand-carry the rest).
- Every save snapshots BOTH slots as one version: restore and undo bring back the pair.

## Security & capabilities

Short notes — this guide is your contract, not a sandbox:

- oma.sendMessage proposes. Call it only on an explicit user click — never from load,
  a timer, an observer, or a data change.
- Reserved settings keys are off-limits: oma.setPref rejects keys starting with
  "security_" or "_", and the store rejects security:* / policy:* on the data_* path.
  oma.callTool is an unscoped escape hatch that is not yet capability-gated (the v0.2
  runner caps close it) — treat every reserved namespace as off-limits regardless.
- Stay inside window.oma. Apps shared through a future app store run sandboxed with
  filtered capabilities: cross-collection reads/writes and arbitrary oma.callTool are
  denied when packaged, so build against your own bound collection only.

## Environment awareness (optional)

  oma.host        // who is rendering: "claude-ai", a ChatGPT client name, "browser-viewer", …
  oma.standalone  // true in a plain browser tab (no chat attached): sendMessage will
                    // show a notice instead of sending — data operations all still work.

Apps run unchanged across hosts; use these only to fine-tune (e.g. hide a
"Send to AI" button when oma.standalone).

## Sandbox limits (these fail SILENTLY — never use them)

The widget runs inside the host's sandboxed iframe:
- confirm() / alert() / prompt() are BLOCKED — they return false / do nothing, with no error.
  NEVER gate an action on confirm(). Deletes need no gate of yours at all: the engine enforces
  confirm_delete and the shell renders the confirmation (see Example above).
- target="_blank" and window.open() are BLOCKED (no allow-popups) — an external link may not
  open on click. Show the URL as selectable text so the user can copy it; adding
  <a href target="_blank" rel="noopener"> is fine, but never make click-to-open the ONLY way to
  reach a URL.
- No network: fetch / XHR / WebSocket and external <script>/<img>/<link>/@import are all denied
  by CSP. Inline everything; all data flows through window.oma.

## Styling — host design tokens

The shell injects the host's design tokens as CSS variables (with fallbacks), so use them
to match Claude's light/dark theme automatically:

  var(--color-background-primary|secondary|tertiary|inverse|danger|success)
  var(--color-text-primary|secondary|tertiary|inverse|danger|success)
  var(--color-border-primary|secondary)   var(--color-ring-primary)
  var(--font-sans) var(--font-mono) var(--font-text-sm-size) var(--font-text-md-size)
  var(--border-radius-sm|md|lg|full)      var(--shadow-sm)

Don't hardcode white/black backgrounds. Root on transparent or var(--color-background-primary).

## House style (make it feel built-in, but alive)
- Accent: use var(--color-text-info, var(--color-ring-primary, #3b6cf6)) — never hardcoded
  brand colors. (The chain ends in a guaranteed shell fallback; the first token is used
  only when the host provides it.)
- Tinted backgrounds: color-mix(in oklab, <token> 10-12%, transparent); hover wash:
  color-mix(in oklab, var(--color-text-primary) 4%, transparent). These flip with the theme.
- Micro-motion: transitions 120-260ms with cubic-bezier(.2,.8,.3,1); one springy confirmation
  (cubic-bezier(.34,1.56,.64,1)) on the action that saves. Wrap ALL motion in
  @media (prefers-reduced-motion: no-preference) { }.
- Interactive things respond: hover translateY(-1px), press scale(.96-.985).
- Empty state: a friendly one-liner + what to say to the AI to fill it — never a bare "no data".
- Counts/amounts: font-variant-numeric: tabular-nums.

## The system kit — already in your document

The engine injects a small class kit into EVERY app it renders. You do not import it, paste
it or declare it; the classes below simply work, they are all built from the tokens above, and
they follow the user's theme automatically. Reach for them first — CSS was measured at a third of
every hand-written app, and most of that third was these same classes written again.

  layout    .k-row (flex row + gap)  .k-grow (fill)  .k-grid (auto card grid)  .k-li (list line)
  text      .k-h1  .k-sub  .k-mut  .k-num (tabular)  .k-code  .k-ellip / .k-ellip2 (clamp)
  surfaces  .k-card (+ .is-click for the hover lift)   .k-empty (empty state)
  controls  .k-btn (+ .sec .ghost .danger)   .k-chip (+ .on .static)   .k-field (input/select)
            .k-switch (styled checkbox)      .k-tabs > .k-tab (+ .on)
  status    .k-badge (+ .info .ok .warn .bad)   .k-dot (group colour)   .k-icon (16px inline SVG)
  motion    .k-stagger (list entrance; set style="--i:N")   .k-pop   .k-skel (loading shimmer)
  spacing   var(--k-s1..--k-s4) = 4/8/12/16px      timing  var(--k-t-fast|--k-t|--k-t-slow)
  easing    var(--k-ease) standard, var(--k-spring) for the one confirming action

Kit rules already include \`*{box-sizing:border-box}\`, a sensible \`body\` and reduced-motion
handling, so don't re-declare those. Write your OWN CSS for what makes THIS app different from
every other one. If you catch yourself styling a button, chip, card, input or empty state from
scratch, use the class instead — and if you need a variant, override the kit class rather than
inventing a parallel one.

## App shell (the frame every app shares)

Apps also read as a family because they share BONES. Build these out of the kit classes; keep the
shape and the treatment:

- **App bar** — a ~42px square mark holding one inline SVG glyph (1px token border, radius-lg,
  aria-hidden), then the identity block, then any action pushed right with margin-left: auto.
- **Identity** — an EYEBROW line above the app's name: var(--font-mono), ~10px, weight 700,
  letter-spacing .11em, uppercase, var(--color-text-tertiary). It names the beat this app keeps —
  "PERSONAL LEDGER", "DAILY RHYTHM", "WEEKLY MEAL MAP" — not a tagline. The app's own name sits
  under it at heading size.
- **AI hand-off** — where the AI can do something the UI can't (plan the week, explain the spend),
  a QUIET secondary button (\`.k-btn.sec\`) in the bar calling oma.sendMessage. Same weight in every app, so it
  reads as the same affordance wherever a user meets it. If the app also has a bar-level primary
  action it goes to its right and carries the solid fill; the AI button never competes with it.
- **Overview band** — right under the bar, on a faintly tinted ground: the one number that matters
  at display size, then two to four small stats beside it. Tabular numerals, no chart. This is
  where the app's live state goes — the bar stays static so the app is recognisable at a glance.
- **Content** — the app's actual thing, in its own scroll region (see Layout below).
- Rhythm: 12px inside a group, 16px between groups, 15px 17px on the bar (var(--k-s3)/var(--k-s4)).

Keep the frame LEAN. Built on the kit it is a handful of rules — spend what you save on whatever
makes this app different from every other one.

## Layout — fit the first screen
The host sizes the widget to its CONTENT, so an unbounded app grows very tall and the user has to
scroll to see it — the header, key numbers, and main action can end up below the fold. Keep the
important things visible:
- Give the SCROLLING part (a long list, a board column, a feed) its own \`max-height\` +
  \`overflow: auto\`, so it scrolls INSIDE the widget instead of stretching the whole page.
- Keep the header — title, a progress ring / stat row, the primary input or action — ABOVE that
  scroll region, so it lands on the first screen without scrolling.
- Aim for a comfortable one-screen default and let content scroll WITHIN it. Don't hard-code a
  fixed pixel body height that clips on small windows — cap the scroll AREA, not the body.

## Minimal working app (copy this shape)

\`\`\`html
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  /* Only what the kit does NOT already give you. */
  #list { list-style: none; margin: 0 0 var(--k-s3); padding: 0; }
  .done { text-decoration: line-through; color: var(--color-text-tertiary); }
</style>
</head>
<body>
  <ul id="list"></ul>
  <form id="f" class="k-row">
    <input id="t" class="k-field k-grow" placeholder="Add…">
    <button class="k-btn">Add</button>
  </form>
  <script type="module">
    const render = (state) => {
      const ul = document.getElementById("list");
      ul.innerHTML = "";
      for (const item of state.items) {
        const li = document.createElement("li");
        li.className = "k-li";
        const cb = Object.assign(document.createElement("input"), { type: "checkbox", checked: !!item.fields.done });
        cb.onchange = () => oma.updateItem(item.id, { done: !item.fields.done });
        const span = Object.assign(document.createElement("span"), { textContent: item.fields.title });
        if (item.fields.done) span.className = "done";
        li.append(cb, span);
        ul.appendChild(li);
      }
    };
    oma.ready(render);
    oma.onChange(render);
    document.getElementById("f").onsubmit = (e) => {
      e.preventDefault();
      const t = document.getElementById("t");
      if (t.value.trim()) oma.addItem({ fields: { title: t.value.trim() } });
      t.value = "";
    };
  </script>
</body>
</html>
\`\`\`

## Workflow — skeleton first, then grow it

Ship a SMALL working app, open it, then add to it. This is not a matter of taste: a first
save that tries to be the finished app is where the expensive failures happen — the user waits
through a long generation, and a defect anywhere means paying for the whole document again. After
the skeleton, each addition is an \`edit_app\` of a few lines that the user can see land.

1. **list_apps** — does something suitable already exist? Reuse it. \`open_app
   {app, collection}\` re-points an existing app at different data, which costs almost nothing.
2. **Seed the data** if the app starts with content: \`data_batch\` first (see "Seeding data").
   The app is then written against real rows instead of guessing at a shape.
3. **Write the skeleton** — the app bar, one \`render(state)\` that draws the collection, and the
   single most important interaction. Save it with \`save_app {name, ui, manifest, description}\`
   and open it with \`open_app {app}\`; it renders immediately after saving.
4. **Grow it** with \`edit_app {app, expected_version, edits: [{old_string, new_string}]}\`
   — exact-match replacements, no whole-source round trip. One feature per call, each one openable.
   This is the MAIN path, not a repair tool. Say what you added and let the user steer the next one.
   **Do not re-read before editing what you just saved**: a successful save means your copy IS the
   stored source, byte for byte, and every save/edit receipt carries the version the next edit needs.
   \`get_app\` is for source you did not write this conversation — or after a version conflict
   tells you someone else changed it.
   **Anchor on the SMALLEST string that is unique** — a line or two, not a whole function. You pay
   for old_string AND new_string on every edit, so a small change wrapped in a big anchor costs what
   a big change costs. (Measured: an author whose real change was 2.9KB sent 13KB, because 78% of it
   was surrounding context it did not need to touch.) If a short anchor is ambiguous, make it unique
   by extending it a line at a time — not by pasting the whole block around it.
   **When you DID read (get_app), edit by RANGE instead of anchor**: the window comes back
   stamped \`{offset, returned, hash}\` — echo them as \`{offset, length: returned, expect_hash:
   hash, new_string}\` and NO anchor text travels at all. The hash means a mis-copied offset is
   a clean error, never a silent mis-splice. Mark stable regions \`data-oma-node="name"\`
   (unique per document) and \`get_app {name, node}\` jumps straight to that element's window —
   read one node, replace one node, whole-document arithmetic never enters.
5. **Full rewrites are the exception**: get_app (windowed — note its version) →
   save_app WITH expected_version (an overwrite without it is refused: a save that never read
   the current source is how a live app gets eaten). Every save keeps history.

\`data_batch\` details: up to 200 write commands in ONE transaction; each is
{type: "add_item" | "update_item" | "move_item" | "delete_item", …} with exactly the arguments of
the matching single tool — no other command types exist in a batch. All or nothing; one {id, seq}
receipt per command.

## Before you save: read their sentence back

Take what the person actually said and check it against what you built, thing by thing. Every noun
they NAMED has to be somewhere in the app — a field, a column, a control, a view. If they named it,
they will look for it. This is not about guessing what they want; the words are right there in the
request, and dropping one fails in the one direction users notice — the thing they asked for, missing.

This check is against the app you are HANDING OVER, not the first save: a skeleton that grows the
named thing two edits later (the workflow above) has dropped nothing. One pass over one sentence
before your last save is the cheapest correctness you will buy all day.
`;

// ---------------------------------------------------------------------------- chapters
// Why chapters: every byte of an inputSchema is resident in tools/list for every conversation,
// but a byte of the guide is paid only by the author who asks for it. The guide is about to grow
// (functions, embedding), so it grows on the pull end. The enum is frozen at first publish —
// values cannot be added later without changing tools/list for everyone — so all four names exist
// from day one, and a chapter whose capability is still behind a flag says exactly that.
//
// Each chapter STANDS ALONE: an author who pulls `style` must not be missing a prerequisite from
// `basics`. That is why the shared header (what an app is, the hard rules) rides on all of them.
const HEAD_END = GUIDE.indexOf("## Data model");
const PREAMBLE = GUIDE.slice(0, HEAD_END);

function sections(md) {
  const out = new Map();
  const re = /^## (.+)$/gm;
  const hits = [...md.matchAll(re)];
  for (let i = 0; i < hits.length; i++) {
    const start = hits[i].index;
    const end = i + 1 < hits.length ? hits[i + 1].index : md.length;
    out.set(hits[i][1].trim(), md.slice(start, end));
  }
  return out;
}
const SECTIONS = sections(GUIDE);
const pick = (...titles) => titles.map((t) => SECTIONS.get(t) || "").filter(Boolean).join("\n");

const STYLE_TITLES = ["Styling — host design tokens", "The system kit — already in your document",
  "House style (make it feel built-in, but alive)",
  "App shell (the frame every app shares)", "Layout — fit the first screen"];

const CHAPTERS = {
  // Everything needed to write a working app, minus the purely visual chapters. The kit table is
  // the one style section that also rides here: `basics` is the default pull, the minimal template
  // below now uses kit classes, and an author who never sees the table writes all of it again —
  // which is precisely the 32-47%-CSS measurement this whole change exists to fix.
  basics: () => PREAMBLE + pick("Data model", "window.oma API", "Refresh semantics (one ledger, one `seq`)",
    "Multi-collection apps (fetch what you render)",
    "Time — compute it at render, never store the answer",
    "Replying to the AI from the UI",
    "User preferences (oma.pref)", "Security & capabilities", "Environment awareness (optional)",
    "Sandbox limits (these fail SILENTLY — never use them)", "The system kit — already in your document",
    "Minimal working app (copy this shape)",
    "Workflow — skeleton first, then grow it",
    // Last on purpose: it is the check you run at the END, and an author reading straight through
    // meets it exactly where it applies — after the workflow, before the save.
    "Before you save: read their sentence back") +
    `\n## More chapters\n\nget_app_guide {topic: "style"} — design tokens, house style, app shell, first-screen layout.\n` +
    `{topic: "embed"} — putting one app inside another, and the \`@live\` region for an always-on screen.\n{topic: "functions"} — exposing callable functions (data-in/data-out, no UI).\n`,
  style: () => PREAMBLE + pick(...STYLE_TITLES) +
    `\n## Related\n\nget_app_guide {topic: "basics"} for the API contract and a working template.\n`,
  embed: () => PREAMBLE + `## Embedding one app inside another

\`oma.embed(name, opts)\` mounts another app INSIDE yours — sandboxed, depth 1 (an embedded
child cannot embed further). DIRECT mode only: in a sandboxed app \`oma.embed\` reads \`undefined\`.

\`\`\`js
const h = await oma.embed("habit-streaks", { into: document.getElementById("slot") });
// later: h.refresh();  h.unmount();
\`\`\`

opts: \`into\` (required — the element to mount in) · \`preset\`: \`"live"\` (default — the child gets
the full data loop, writes allowed per its own caps) | \`"inert"\` (renders provided \`html\`, calls
nothing) · \`collection\` (bind the child to a collection; defaults to its own) · \`html\`/\`snapshot\`
(supply source/rows yourself — otherwise the engine's stored source, tier and caps are resolved
for you) · \`heights: {min,max}\`, or \`false\` to hand sizing to your CSS (thumbnails, previews).
Returns \`{ el, unmount, refresh }\`.

The child runs behind the same runner machine the loader uses: its trust tier and capability
grants are the ENGINE's answer for that app — embedding does not widen them. Before reaching
for embed, remember several apps can read the SAME collection; that is still the cheapest
"one view inside another" and needs no mounting at all.

## \`@live\` — a region that shows whatever the AI just opened

One reserved name: \`oma.embed("@live", {into})\` mounts the app the AI opened LAST, and swaps it
by itself when the AI opens another. It is how you build an always-on screen — a spare tablet on
a wall, a second monitor — as an ORDINARY app you design, opened at \`/view/<your app>\`.

\`\`\`js
oma.embed("@live", {
  into: document.getElementById("region"),
  heights: false,                       // a wall fills its CSS box; the app inside scrolls
  onApp: (name) => label(name),         // name = what is on screen now, null while waiting
});
\`\`\`

Two faces, and you write for both because one document serves both. On a STANDALONE page it
follows: mount, unmount, mount the next one. In a CHAT it is a quiet tile that reads nothing at
all — a region that swapped apps under someone's conversation would be wrong, so it does not.
Test it in the browser view; a chat shows you the tile.

The switch arrives on ONE channel — the engine's \`/events\` stream (SSE) — and there is no poll
behind it. While the feed is down the region simply keeps showing the app it already has, rather
than blanking; \`EventSource\` reconnects on its own, and the first frame after it does carries the
current pointer, so a display that missed a switch catches up without a reload. (The data inside a
mounted app is a different axis and does have the adaptive poll behind it — this is about WHICH
app is on screen.)

\`\`\`json
{"stage": {"width": "fluid", "display": true}}
\`\`\`

**Declare \`stage.display\` on any app that carries an \`@live\` region.** It says "I am the frame,
not the picture", and it is what keeps the wall from being aimed at itself: an app that declares
it is never recorded as the last-opened one, and the region refuses to mount an app that declares
it. Without the declaration, opening your wall points the wall at your wall.

The shipped \`live\` app in the App Store is the reference: a full-bleed region, a \`.k-appbar\`
naming what is on screen, and nothing else. Copy it and make it yours.

get_app_guide {topic: "basics"} for the API contract.
`,
  functions: () => PREAMBLE + `## Exposing callable functions

A function is your app acting WITHOUT its UI on screen: data in, data out, running engine-side —
so it works from a bare chat ("RSVP yes for Sam") with no widget mounted. Two rules are absolute:
a function never touches UI (widgets react to its writes through the normal data loop), and its
body is SYNCHRONOUS — no await, no timers, no network. The store is synchronous, so nothing a
function is for needs async; a returned Promise is an error.

Declare the signature in \`manifest.functions\`, carry the body in your document, and the two must match —
a save with a declared function and no body block (or a body block you forgot to declare) is
refused with a message saying which. Params reuse the field grammar (type: string|number|boolean|
object|array, required, enum).

manifest: \`{"functions": {"rsvp": {"description": "record one RSVP", "params": {"name": {"type": "string", "required": true}, "coming": {"type": "boolean", "required": true}}}}\`

In your document:
\`\`\`html
<script type="text/oma-function" data-fn="rsvp">
const existing = api.list({ match: { name: args.name } })[0];
if (existing) api.update({ id: existing.id, fields: { coming: args.coming } });
else api.add({ fields: { name: args.name, coming: args.coming } });
return { total: api.count() };
</script>
\`\`\`

The body sees exactly two names: \`args\` (validated against your params) and \`api\`:
\`api.list({collection?, group?, match?, limit?})\` · \`api.count(collection?)\` ·
\`api.add({collection?, group?, fields, position?})\` → \`{id, seq}\` ·
\`api.update({collection?, id, fields})\`. Collections reachable: the app's own binding plus what
its manifest declares — nothing else, never settings. There is deliberately NO api.delete
(destructive verbs keep the engine's confirmation door). Budgets per call: 2s wall time,
100 writes, 200 reads, 32KB returned. Whatever you \`return\` (JSON-serializable) is the reply.

Calling: the AI calls \`call_function {app, function, args, command_id}\`; your own widget calls
\`oma.callFunction("rsvp", {...})\` — same dispatcher, and a widget can only reach its OWN app's
functions. Every write a function makes is stamped \`via: {app, function}\` in the ledger.

get_app_guide {topic: "basics"} for the API contract.
`,
};

export function guideChapter(topic) {
  const c = CHAPTERS[topic || "basics"];
  return c ? c() : GUIDE;
}
