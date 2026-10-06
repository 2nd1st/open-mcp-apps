// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// test/rig/fake-sharing.mjs — an in-memory stand-in for the deployment's grant records: the
// MountsProvider / SharingProvider pair createEngine takes (src/sharing.mjs, index.d.ts). It is what
// the data plane implements against a real database; this one keeps everything in arrays so the
// engine's half can be tested end to end with two (or three) real stores and no server.
//
// It models the deployment's rules the way the design states them (§2.3, §5, §10): links are
// restricted (named accounts) or anyone-with-link; claiming is a separate step (a person pressing
// Accept), never something an engine call does; one alias per (recipient, owner); revoke / set_role /
// leave take effect on the next grants() read because nothing here is cached.

/** @param {Map<string,{label:string, store:object, tenant:string}>} */
export function makeShareWorld() {
  const accounts = new Map();          // principal → {label, store, tenant}
  const links = [];                    // {id, owner, app, appBirth, role, access, accounts, url, revoked}
  const grants = [];                   // {owner, recipient, app, appBirth, role, status}
  const aliases = new Map();           // `${recipient}|${owner}` → alias
  const ended = [];                    // what engines reported dead
  const copies = [];
  let seq = 0;

  const aliasFor = (recipient, owner) => {
    const k = `${recipient}|${owner}`;
    if (!aliases.has(k)) {
      const base = accounts.get(owner).label.split("@")[0].toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 24) || "owner";
      const taken = new Set([...aliases].filter(([key]) => key.startsWith(recipient + "|")).map(([, a]) => a));
      let a = base;
      for (let i = 2; taken.has(a); i++) a = `${base}-${i}`;
      aliases.set(k, a);
    }
    return aliases.get(k);
  };

  const world = {
    accounts, links, grants, ended, copies,
    addAccount(principal, label, store) { accounts.set(principal, { label, store, tenant: `t_${principal}` }); },
    /** A person pressing Accept on a link — the step no engine call can take. */
    claim(linkId, principal) {
      const l = links.find((x) => x.id === linkId);
      if (!l || l.revoked) return { ok: false, error: "link_gone" };
      const me = accounts.get(principal);
      if (l.access === "restricted" && !l.accounts.includes(me.label.toLowerCase())) return { ok: false, error: "not_on_list" };
      if (principal === l.owner) return { ok: false, error: "self" };
      const live = grants.find((g) => g.owner === l.owner && g.recipient === principal && g.app === l.app && g.status === "active");
      if (live) { live.role = l.role; return { ok: true }; }
      grants.push({ owner: l.owner, recipient: principal, app: l.app, appBirth: l.appBirth, role: l.role, status: "active" });
      aliasFor(principal, l.owner);
      return { ok: true };
    },
    /** Test shortcut: an active grant without a link (as if invited and claimed). */
    grant(owner, recipient, app, role, appBirth) {
      grants.push({ owner, recipient, app, appBirth: appBirth ?? accounts.get(owner).store.appBirth(app), role, status: "active" });
      aliasFor(recipient, owner);
    },
    setAlias(recipient, owner, alias) { aliases.set(`${recipient}|${owner}`, alias); },
    mountsFor(principal) {
      return {
        grants() {
          return grants.filter((g) => g.recipient === principal && g.status === "active").map((g) => ({
            alias: aliasFor(principal, g.owner), owner: accounts.get(g.owner).tenant, ownerLabel: accounts.get(g.owner).label,
            app: g.app, appBirth: g.appBirth, role: g.role, store: () => accounts.get(g.owner).store,
          }));
        },
        ended(dead) {
          for (const d of dead) {
            ended.push(d);
            for (const g of grants)
              if (g.recipient === principal && accounts.get(g.owner).tenant === d.owner && g.app === d.app && g.appBirth === d.appBirth) g.status = "ended";
          }
        },
      };
    },
    sharingFor(principal) {
      const me = accounts.get(principal);
      const ownerOfAlias = (alias) => [...accounts.keys()].find((o) => aliases.get(`${principal}|${o}`) === alias);
      return {
        async invite({ app, appBirth, role, access, accounts: who }) {
          if (access === "restricted" && who.includes(me.label.toLowerCase())) return { ok: false, error: "self_share", detail: "You cannot share an app with yourself." };
          const id = `ln_${++seq}`;
          const link = { id, owner: principal, app, appBirth, role, access, accounts: [...who], url: `https://share.example/invite/${id}`, revoked: false };
          links.push(link);
          return { ok: true, link: { id, app, role, access, accounts: [...who], url: link.url, expires_at: "2026-10-09T00:00:00.000Z" } };
        },
        async list(req) {
          if (req && req.alias) {
            const owner = ownerOfAlias(req.alias);
            const mine = grants.find((g) => g.owner === owner && g.recipient === principal && g.app === req.app && g.status === "active");
            if (!mine) return { ok: false, error: "not_found", detail: "No such share." };
            return { ok: true, links: [], grants: [{ app: req.app, account: accounts.get(owner).label, role: "owner" },
              ...grants.filter((g) => g.owner === owner && g.app === req.app && g.status === "active").map((g) => ({ app: g.app, account: accounts.get(g.recipient).label, role: g.role }))] };
          }
          const own = (x) => x.owner === principal && (!req || !req.app || x.app === req.app);
          return { ok: true,
            links: links.filter(own).map(({ owner, appBirth, ...l }) => l),
            grants: grants.filter((g) => own(g) && g.status === "active").map((g) => ({ app: g.app, account: accounts.get(g.recipient).label, role: g.role })) };
        },
        async revoke({ app, link, accounts: who }) {
          let n = 0;
          for (const l of links) if (l.owner === principal && l.app === app && l.id === link && !l.revoked) { l.revoked = true; n++; }
          for (const g of grants) if (g.owner === principal && g.app === app && g.status === "active" && (who || []).includes(accounts.get(g.recipient).label.toLowerCase())) { g.status = "revoked"; n++; }
          return { ok: true, revoked: n };
        },
        async setRole({ app, accounts: who, role }) {
          let n = 0;
          for (const g of grants) if (g.owner === principal && g.app === app && g.status === "active" && who.includes(accounts.get(g.recipient).label.toLowerCase())) { g.role = role; n++; }
          return { ok: true, changed: n };
        },
        async leave({ alias, app }) {
          const owner = ownerOfAlias(alias);
          const g = grants.find((x) => x.owner === owner && x.recipient === principal && x.app === app && x.status === "active");
          if (!g) return { ok: false, error: "not_found", detail: "No such share." };
          g.status = "left";
          return { ok: true };
        },
        copied(req) { copies.push({ by: principal, ...req }); },
      };
    },
  };
  return world;
}
