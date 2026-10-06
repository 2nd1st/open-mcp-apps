// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// tools/sharing.mjs — the two verbs of cross-account sharing: `share` (make, list, revoke, change
// a share; leave one) and `copy_app` (make a shared app your own). Registered by engine.mjs ONLY on
// a deployment that keeps grant records (the `sharing` option), and after every other tool, so an
// engine without them lists the rest of tools/list byte-identically.
//
// The engine checks what only it can see — the app exists, is the caller's own, is not a system
// app, and what it currently reaches — and hands the record-keeping to the provider
// (src/sharing.mjs SharingProvider). Accepting a share is deliberately NOT here: a claim is a person
// signing in and pressing Accept on the deployment's own page. An AI that could accept would make a
// share a way to put someone else's app and data into this conversation (design §5.2).

import { z } from "zod";
import { WRITE, WRITE_NOT_IDEMPOTENT, cmdArgs, answer, toMcp, SEEDED_APPS, RESERVED_APP_NAMES, LOCKED_APPS, defaultCollectionFor } from "../contracts.mjs";
import { APP_NAME_RE, SETTINGS_COLLECTION, sharedScopeOf } from "../store.mjs";
import { isHandle, parseHandle, handleOf, notShared } from "../sharing.mjs";

// Rows a copy may carry. A copy that would move more is a migration, not a click — and a call this
// size has to finish inside one host's tool-call timeout.
export const COPY_MAX_ROWS = 50_000;
const COPY_CHUNK = 200;

export function register(ctx) {
  const { server, store, fileChannel, hostName, fail, registerApp } = ctx;
  const { route, sharing } = ctx;

  const failWith = (reason, text, body = {}) => toMcp(answer.fail(reason, body, text), { isError: true });
  const providerFailed = (r) => failWith(r && r.error ? String(r.error) : "share_failed",
    `${r && r.error ? r.error : "share_failed"} — ${r && r.detail ? r.detail : "the sharing service refused this; nothing changed."}`);
  const roleWords = (role) => (role === "editor" ? "can EDIT DATA" : "READ-ONLY");
  const accountsOf = (v) => [...new Set((Array.isArray(v) ? v : []).map((x) => String(x ?? "").trim().toLowerCase()).filter(Boolean))];

  server.registerTool(
    "share",
    {
      title: "Share an app",
      // No idempotency key: two invites are two links. Not destructive: every revoke or role change
      // is undone by the same tool (invite again, set_role back).
      annotations: WRITE_NOT_IDEMPOTENT,
      description: "Share one of the user's apps with other accounts — the app, the collections it binds (now and later) and its files — or manage shares. invite: a claim link; role REQUIRED, ask the user (viewer = read-only, editor = may change data, never code); access restricted (default: only `accounts` may claim) or anyone (anyone with the link — tell the user). Claimants sign in; nothing is emailed, hand the link to the user. list: links and people (for an @owner/app: its participants). revoke: a link (stops new claims) or accounts. set_role: accounts' role. leave: give up an @owner/app shared with the user.",
      inputSchema: {
        action: z.enum(["invite", "list", "revoke", "set_role", "leave"]),
        app: z.string().optional().describe("the user's app, or an @owner/app (list, leave)"),
        role: z.enum(["viewer", "editor"]).optional(),
        access: z.enum(["restricted", "anyone"]).optional(),
        accounts: z.array(z.string()).optional().describe("emails"),
        link: z.string().optional().describe("link id (revoke)"),
      },
    },
    async (a) => {
      const action = a.action;
      if (action === "leave" || (action === "list" && isHandle(a.app))) {
        const p = parseHandle(a.app);
        const sa = p ? await route.session().app(a.app) : null;
        if (!sa) return notShared(a.app ?? "");
        if (action === "leave") {
          const r = await sharing.leave({ alias: p.alias, app: sa.app });
          if (!r || r.ok !== true) return providerFailed(r);
          return toMcp(answer.ack({ ok: true, app: a.app, left: true },
            `Left "${a.app}" — it is no longer shared with you. Anything you copied from it (copy_app) is yours and stays.`));
        }
        const r = await sharing.list({ alias: p.alias, app: sa.app });
        if (!r || r.ok !== true) return providerFailed(r);
        const people = (r.grants || []).map((g) => `- ${g.account} (${g.role})`).join("\n") || "- (nobody else)";
        return toMcp(answer.ack({ ok: true, app: a.app, grants: r.grants || [] },
          `"${a.app}" — shared by ${sa.m.ownerLabel}; you ${roleWords(sa.role)}. Participants:\n${people}`));
      }
      // Everything else is about the caller's OWN app. A handle here is someone else's app, and a
      // share is not the recipient's to pass on.
      if (a.app != null && isHandle(a.app))
        return failWith("not_yours", `not_yours — "${a.app}" was shared WITH you; only its owner can share it or change who has it. "leave" gives it up.`);
      if (action === "list") {
        if (a.app != null && !store.getApp(a.app)) return fail(`No app "${a.app}". list_apps shows what exists.`);
        const r = await sharing.list(a.app != null ? { app: a.app } : {});
        if (!r || r.ok !== true) return providerFailed(r);
        const links = (r.links || []).map((l) => `- link ${l.id}: ${l.app} · ${l.role} · ${l.access === "anyone" ? "ANYONE with the link" : `only ${(l.accounts || []).join(", ")}`}${l.revoked ? " · revoked" : l.url ? ` · ${l.url}` : ""}`);
        const grants = (r.grants || []).map((g) => `- ${g.app}: ${g.account} (${g.role})`);
        return toMcp(answer.ack({ ok: true, links: r.links || [], grants: r.grants || [] },
          (links.length || grants.length)
            ? [links.length ? "Links:" : null, ...links, grants.length ? "People:" : null, ...grants].filter(Boolean).join("\n")
            : a.app != null ? `"${a.app}" is not shared with anyone.` : "Nothing is shared."));
      }
      if (a.app == null) return fail(`"${action}" needs app — the name of the user's app.`);
      const comp = store.getApp(a.app);
      if (!comp) return fail(`No app "${a.app}". list_apps shows what exists.`);

      if (action === "invite") {
        if (SEEDED_APPS.has(a.app)) return fail(`"${a.app}" ships with the engine and is not the user's to share.`);
        if (!a.role) return fail("invite needs role — ask the user: viewer (read-only) or editor (can change data, never the app's code).");
        const access = a.access || "restricted";
        const accounts = access === "restricted" ? accountsOf(a.accounts) : [];
        if (access === "restricted" && !accounts.length)
          return fail('A restricted link needs accounts — the email(s) allowed to claim it. (access: "anyone" makes a link anyone holding it can claim; say that risk to the user first.)');
        const birth = store.appBirth(a.app);
        const scope = sharedScopeOf(store, a.app, birth);
        const r = await sharing.invite({ app: a.app, appBirth: birth, role: a.role, access, accounts });
        if (!r || r.ok !== true || !r.link) return providerFailed(r);
        const rows = scope.collections.map((c) => `"${c}" (${store.countItems(c)} rows)`).join(", ") || "no collection yet";
        const files = store.fileUsage(a.app).count;
        const who = access === "anyone"
          ? "ANYONE who has this link can claim it (after signing in) and then " + (a.role === "editor" ? "read AND change" : "read") + " this data — revoke the link to stop new claims."
          : `Only ${accounts.join(", ")} can claim it, after signing in.`;
        return toMcp(answer.ack({ ok: true, app: a.app, link: r.link },
          `Share link for "${a.app}" (${a.role === "editor" ? "can edit data" : "read-only"}): ${r.link.url ?? "(see list)"}${r.link.expires_at ? ` — expires ${r.link.expires_at}` : ""}\n` +
          `${who} Nothing was emailed: give the link to the user to send.\n` +
          `It shares the app, ${rows} and ${files} file(s). It follows the app: a collection the app binds later is shared too. ` +
          `They run it sandboxed and can never change its code (they can copy it).`));
      }
      if (action === "revoke") {
        const accounts = accountsOf(a.accounts);
        if (!a.link && !accounts.length) return fail("revoke needs link (stop a link) or accounts (end those people's access).");
        const r = await sharing.revoke({ app: a.app, ...(a.link ? { link: String(a.link) } : {}), ...(accounts.length ? { accounts } : {}) });
        if (!r || r.ok !== true) return providerFailed(r);
        return toMcp(answer.ack({ ok: true, app: a.app, revoked: r.revoked ?? 0 },
          `Revoked ${r.revoked ?? 0} for "${a.app}" — in force on their next call. What they already saw or copied stays with them.`));
      }
      if (action === "set_role") {
        const accounts = accountsOf(a.accounts);
        if (!a.role || !accounts.length) return fail("set_role needs role and accounts.");
        const r = await sharing.setRole({ app: a.app, accounts, role: a.role });
        if (!r || r.ok !== true) return providerFailed(r);
        return toMcp(answer.ack({ ok: true, app: a.app, changed: r.changed ?? 0 },
          `${accounts.join(", ")} now ${roleWords(a.role)} on "${a.app}" (from their next call).`));
      }
      return fail(`Unknown action "${action}".`);
    },
  );

  server.registerTool(
    "copy_app",
    {
      title: "Copy a shared app",
      annotations: WRITE,
      description: "Copy an app another account shared with the user (@owner/app) into an app of the user's own — editable, independent of the original from then on. with_data also copies its rows and files, into the user's own collections (named in the reply).",
      inputSchema: {
        ...cmdArgs,
        app: z.string().describe("@owner/app"),
        name: z.string().optional().describe("the copy's name (default: the original's)"),
        with_data: z.boolean(),
      },
    },
    async (a) => {
      const sa = await route.session().app(a.app);
      if (!sa) return notShared(a.app);
      const src = sa.m.face.getApp(sa.app);
      if (!src) return notShared(a.app);
      const name = String(a.name ?? sa.app).trim();
      if (!APP_NAME_RE.test(name)) return fail("Invalid name: must match ^[a-z][a-z0-9-]{0,31}$ (lowercase, digits, hyphens).");
      if (RESERVED_APP_NAMES.has(name) || LOCKED_APPS.has(name) || SEEDED_APPS.has(name))
        return fail(`"${name}" is reserved — pass name to pick another.`);
      const cid = a.command_id;
      // A RETRY of this very copy reads its own first run back off the ledger — same name, same
      // collection mapping — so a lost reply never produces a second, differently-named copy.
      const prior = store.priorReceipt(`${cid}:app`);
      if (prior && (prior.event_type !== "component_saved" || prior.aggregate_id !== name))
        return fail("That command_id was already used by a DIFFERENT command — nothing was done. Use a fresh uuid per action.");
      if (!prior && store.getApp(name)) return fail(`"${name}" already exists in the user's registry — pass name to copy under another one.`);
      // Collection mapping: each shared collection → a local name. The one the app OPENS on by its
      // own name follows the copy's name; the rest keep theirs. A name that already holds rows here
      // gets `-copy`, `-copy-2`, … — never a merge into the user's existing data.
      const scope = sa.row.collections;
      const declared = (() => { try { return Object.keys(JSON.parse(src.manifest || "{}").collections || {}); } catch { return []; } })();
      const byName = defaultCollectionFor(src);
      let mapping = prior?.payload?.copied_from?.collections;
      if (!mapping) {
        mapping = {};
        // Taken = holds rows here, OR is what one of the user's apps opens on or declares (an empty
        // collection an app is bound to is still that app's: two copies must not share one).
        const taken = new Set();
        for (const row of store.listApps()) {
          const app = store.getApp(row.name);
          taken.add(defaultCollectionFor(app));
          try { for (const k of Object.keys(JSON.parse(app.manifest || "{}").collections || {})) taken.add(k); } catch { /* declares nothing */ }
        }
        const free = (n) => n !== SETTINGS_COLLECTION && !taken.has(n) && store.countItems(n) === 0;
        for (const c of scope) {
          const want = c === byName && !declared.includes(c) ? name : c;
          let pick = want;
          for (let i = 1; !free(pick); i++) pick = `${want}-copy${i === 1 ? "" : `-${i}`}`;
          taken.add(pick);
          mapping[c] = pick;
        }
      }
      if (a.with_data) {
        let rows = 0;
        for (const c of scope) rows += sa.m.face.countItems(c) ?? 0;
        if (rows > COPY_MAX_ROWS)
          return fail(`"${a.app}" holds ${rows} rows across its collections — more than one copy carries (${COPY_MAX_ROWS}). Copy it without data, then move rows in batches with data_list + apply_data_writes.`);
      }

      // The manifest, with its collections renamed. An app that binds by its own name declares
      // nothing; if its collection could not keep the copy's name, the copy declares the one it got,
      // or it would open on an empty collection.
      let manifest = null;
      try { manifest = src.manifest ? JSON.parse(src.manifest) : null; } catch { manifest = null; }
      if (manifest && manifest.collections && typeof manifest.collections === "object") {
        const renamed = {};
        for (const [k, spec] of Object.entries(manifest.collections)) renamed[mapping[k] ?? k] = spec;
        manifest = { ...manifest, collections: renamed };
      } else if (byName in mapping && mapping[byName] !== name) {
        manifest = { ...(manifest || {}), collections: { [mapping[byName]]: {} } };
      }
      const saved = store.execute({
        // The skill comes along verbatim — a copy is all three slots — and so does WHOSE it is:
        // skill_from names the original author (a copy of a copy keeps the first one), so the copier's
        // AI never reads another account's guide as the user's own words. The user rewriting it
        // (save_app {skill}) is what makes it theirs.
        type: "save_app", command_id: `${cid}:app`, name, ui: src.ui, manifest, skill: src.skill ?? null,
        ...(src.skill != null ? { skill_from: src.skill_from || sa.m.ownerLabel } : {}),
        description: src.description || "", actor: a.actor || "agent", host: hostName(),
        copied_from: { owner: sa.m.ownerLabel, app: a.app, version: src.version, collections: mapping },
      });
      if (!saved.ok) return fail(`The copy could not be saved: ${saved.error}${saved.detail ? ` — ${saved.detail}` : ""}. Nothing else was copied.`);
      registerApp(name);

      let copied = 0, reminted = 0, files = 0;
      if (a.with_data) {
        // Rows keep their ids, so ids stored inside fields still point at the right rows. An id
        // that already lives in this store (an earlier copy) gets a fresh one — said in the reply.
        for (const c of scope) {
          let cursor = null;
          do {
            const page = sa.m.face.queryItems(c, { limit: 500, cursor });
            if (page.error) break;
            for (let i = 0; i < page.items.length; i += COPY_CHUNK) {
              const chunk = page.items.slice(i, i + COPY_CHUNK);
              store.db.transaction(() => {
                for (const it of chunk) {
                  const command_id = `${cid}:row:${c}:${it.id}`;
                  if (store.priorReceipt(command_id)) { copied++; continue; }
                  const fresh = store.itemCollection(it.id) != null;
                  if (fresh) reminted++;
                  const r = store.execute({ type: "add_item", command_id, ...(fresh ? {} : { id: it.id }), collection: mapping[c],
                    group: it.group, position: it.position, fields: it.fields, actor: a.actor || "agent", host: hostName() });
                  if (r.ok) copied++;
                }
              })();
            }
            cursor = page.next_cursor;
          } while (cursor);
        }
        const listed = sa.m.face.files.list(sa.app);
        for (const f of listed ? listed.files : []) {
          const got = await sa.m.face.files.get(sa.app, f.path);
          if (!got) continue;
          const r = await fileChannel.put(name, f.path, got.bytes, { mime: f.mime, command_id: `${cid}:file:${f.path}` });
          if (r.ok) files++;
        }
      }
      try { sharing.copied?.({ alias: sa.m.alias, owner: sa.m.owner, app: sa.app, as: name, with_data: !!a.with_data }); } catch { /* audit is best-effort */ }

      const map = Object.entries(mapping).map(([c, to]) => `${handleOf(sa.m.alias, c)} → ${to}`).join(", ") || "(no collections)";
      return toMcp(answer.ack(
        { ok: true, name, version: saved.version, collections: mapping, ...(a.with_data ? { rows: copied, files, reminted } : {}) },
        `Copied "${a.app}" → "${name}" — the user's own app now: editable, and independent of the original (changes on either side no longer reach the other). ` +
        `Collections: ${map}.` +
        (a.with_data ? ` Copied ${copied} row(s) and ${files} file(s).${reminted ? ` ${reminted} row(s) got new ids because theirs already exist here — references to them inside fields will not follow.` : ""}` : " No data was copied.") +
        `\nThis code was written by ${sa.m.ownerLabel} and now runs with the user's own permissions. If it hard-codes collection names, check them against the mapping above (get_app)${src.skill != null ? " — its skill (get_app_skill) was written for the original's names too" : ""}. Open it with open_app {app: "${name}"}.`));
    },
  );
}
