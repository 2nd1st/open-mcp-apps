// guide.mjs — the component authoring contract, returned by the get_component_guide tool.
// This is what an AI reads BEFORE writing a component. Keep it tight, exact, example-led.

export const GUIDE = `# open-mcp-apps — component authoring guide

A component is ONE self-contained HTML document. The engine wraps it with a shell that
provides \`window.oma\` (data + persistence + host theming). Your component only renders
UI and calls \`window.oma\`. Rules:

- NO external resources (no CDN scripts, no remote CSS/images/fonts, no fetch). The sandbox
  CSP blocks them. Inline everything. This is NOT claude.ai Artifacts: there is no React
  runtime, no JSX compiler, and no CDN allowlist here — <div className=...> and
  <script src="https://cdnjs..."> will NOT work. Write plain HTML + vanilla DOM against
  window.oma (the pattern below is all you need).
- Do NOT import any SDK and do NOT touch postMessage — the shell owns the MCP bridge.
- Put your logic in <script type="module"> (the shell's module runs first, so window.oma exists).
- Keep it under ~100KB.

## Data model

Each component is bound at open-time to a *collection* (default: same name as the component).
A collection is a flat list of items:

  item = { id: string, group: string, position: number, fields: object, version: number }

- \`group\`  — YOUR component defines its meaning (kanban column, list section, "" if unused).
- \`fields\` — YOUR component defines the shape (e.g. {title, done, notes, due, color}).
- \`version\`/\`position\`/\`id\` — managed by the engine. Never invent them.

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
(the engine echoes back the new snapshot, which re-triggers render).

The shell auto-refreshes while visible (~20s poll + on tab refocus) and only fires onChange
when data actually changed — so external edits (the AI, another host) appear on their own;
you never need your own polling. Because a re-render CAN arrive at any time, keep transient
UI state (an open input, a drag) in variables outside render(), like the kanban seed does.

## Replying to the AI from the UI

  oma.sendMessage(text)   // sends text into the chat AS THE USER — the AI will respond.
                            // Use ONLY on an explicit user click (e.g. a "Send to AI" /
                            // "Done, continue" button). NEVER call it automatically.
  oma.updateContext(text) // silently updates the AI's context (no chat message; the AI
                            // sees it next turn; each call REPLACES the previous context).

This is how a component closes the loop without typing: let the user act in the UI, then
offer one button that reports the outcome, e.g.
  btn.onclick = () => oma.sendMessage("Decisions ready: " + summary + " — please proceed.");

## User preferences (oma.pref)

Users configure components in the central "settings" app. Read preferences with the
SYNC getter (never fetch the settings collection yourself):

  oma.pref(key, fallback)   // merged: your component's override ▸ global ▸ fallback.
                              // The FALLBACK'S TYPE drives coercion — pass a boolean/
                              // number/string fallback and junk stored values fall back
                              // safely instead of reaching your code.
  oma.onPrefChange(cb)      // cb({key, value, oldValue, scope}) when a pref changes;
                              // a normal onChange re-render also fires, so a single
                              // render(state) that calls oma.pref() stays correct free.
  oma.setPref(key, value)   // persist one of YOUR OWN settings (scalar values only).
                              // You can only write your own component's namespace.

Standard shared keys — use these, do NOT invent near-duplicates:

  locale ("auto")            week_start ("monday"|"sunday"|"saturday")
  date_format ("auto"|"yyyy-mm-dd"|"dd/mm/yyyy"|"mm/dd/yyyy")
  currency ("USD")           density ("comfortable"|"compact")
  confirm_delete (true)      widget_poll_seconds (20; read by the shell, not you)

Example: const l = oma.pref("locale","auto");
         const fmt = new Intl.DateTimeFormat(l === "auto" ? navigator.language : l);
         // Delete honoring confirm_delete — inline, NEVER confirm() (see Sandbox limits):
         btn.onclick = () => {
           if (oma.pref("confirm_delete", true) && btn.dataset.armed !== "1") {
             btn.dataset.armed = "1"; btn.textContent = "Sure?";
             setTimeout(() => { if (btn.dataset.armed) { btn.dataset.armed = ""; btn.textContent = "×"; } }, 3000);
             return;
           }
           oma.deleteItem(id);
         };

### Declaring your settings (so the settings app renders a form for them)

If your component has its own options, declare them in ONE inline block (settings keys:
lowercase snake_case; types: boolean | number | enum | string):

  <script type="application/json" id="oma-manifest">
  { "manifest_version": 1,
    "settings": [
      { "key": "work_minutes", "type": "number", "label": "Work session (minutes)",
        "default": 25, "min": 5, "max": 120, "step": 5 },
      { "key": "chime", "type": "enum", "label": "Sound", "options": ["none","bell"], "default": "bell" }
    ],
    "uses_shared": ["confirm_delete"] }
  </script>

Then just read them: oma.pref("work_minutes", 25) — the default in the manifest is for
the settings form; the fallback at the call site should repeat it. Don't build your own
settings UI for declared keys; the settings app renders one automatically. Reserved: keys
starting with "security_" or "_", keys matching security:*/policy:* (store-enforced), and
the setting groups security/engine/host/system/shell/oma.

## Security & capabilities

Short notes — this guide is your contract, not a sandbox:

- oma.sendMessage is an IDENTITY capability (it speaks to the chat as the user) and
  oma.updateContext is a MODEL-CONTROL capability (it steers the AI silently). Call BOTH
  only on an explicit user click — never from load, a timer, an observer, or a data change.
- Reserved settings keys are off-limits: oma.setPref rejects keys starting with
  "security_" or "_", and the store rejects security:* / policy:* on the data_* path.
  oma.callTool is an unscoped escape hatch that is not yet capability-gated (the v0.2
  runner caps close it) — treat every reserved namespace as off-limits regardless.
- Stay inside window.oma. Components shared through a future library run sandboxed with
  filtered capabilities: cross-collection reads/writes and arbitrary oma.callTool are
  denied when packaged, so build against your own bound collection only.

## Environment awareness (optional)

  oma.host        // who is rendering: "claude-ai", a ChatGPT client name, "browser-viewer", …
  oma.standalone  // true in a plain browser tab (no chat attached): sendMessage will
                    // show a notice instead of sending — data operations all still work.

Components run unchanged across hosts; use these only to fine-tune (e.g. hide a
"Send to AI" button when oma.standalone).

## Sandbox limits (these fail SILENTLY — never use them)

The widget runs inside the host's sandboxed iframe:
- confirm() / alert() / prompt() are BLOCKED — they return false / do nothing, with no error.
  NEVER gate an action on confirm(). For a destructive action honoring confirm_delete, do an
  inline two-step confirm (button → "Sure?" → act; revert after ~3s, shown above) — or delete
  and offer an undo.
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

## Minimal working component (copy this shape)

\`\`\`html
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  body { margin: 0; padding: 12px; font-family: var(--font-sans); color: var(--color-text-primary); }
  li { display: flex; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--color-border-secondary); }
  .done { text-decoration: line-through; color: var(--color-text-tertiary); }
</style>
</head>
<body>
  <ul id="list"></ul>
  <form id="f"><input id="t" placeholder="Add…"><button>Add</button></form>
  <script type="module">
    const render = (state) => {
      const ul = document.getElementById("list");
      ul.innerHTML = "";
      for (const item of state.items) {
        const li = document.createElement("li");
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

## Workflow

1. list_components — does something suitable already exist? Reuse it.
2. If not: write the HTML per this guide → save_component {name, html, description}.
3. Render it with open_component {component: name} — works IMMEDIATELY after saving, and
   is the one tool that opens ANY component (optionally bound to a specific collection).
4. To improve later: get_component {name} → edit → save_component (new version, history kept).
`;
