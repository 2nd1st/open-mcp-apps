// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// prompts.mjs — the MCP prompts this server offers. Registered by engine.mjs, exactly like the
// tool modules, and confined here by the same invariant (test/invariants.mjs §1).
//
// WHY A PROMPT AT ALL, when every prompt is also just a sentence a user could type. Because we
// were already asking them to type it: the README's Usage section opened by telling a brand-new
// user to say "I just installed open-mcp-apps — show me how to use it…". A sentence a project
// prints for people to copy IS a prompt template; it was simply living in a document instead of
// on the wire, where the host could put it in a menu and a click could deliver it.
//
// WHAT A PROMPT CANNOT DO, so nobody re-opens this: it cannot help anyone INSTALL. A server's
// prompts are only listed once that server is connected, so there is no moment at which a
// not-yet-installed engine could offer onboarding. The scene this belongs to is the first minute
// AFTER connecting — which is the one the README was already hand-rolling.
//
// ONE PROMPT, NO ARGUMENTS, on purpose. A prompt's name and its argument names are public
// contract the moment they ship: renaming is a break, and an argument that turns out to be the
// wrong question is a break too. A no-argument prompt can never break on its arguments, and the
// body behind it can be reworded freely — the golden in test/prompt-surface.mjs makes rewording
// deliberate without making it expensive.
//
// THE BODY IS AN INSTRUCTION, NOT A COPY OF THE GUIDE. The craft of writing an app — the HTML
// contract, the runtime API, the layout kit — has exactly one home, `GUIDE` in src/guide.mjs
// (pinned by doc-facts `exportBytes`). This body's job is to route: look first, read the guide
// BEFORE writing anything, ask little, build one real thing. The day it starts explaining how to
// write an app is the day this engine has two guides that disagree.

/** Registers every prompt. Takes the shared engine ctx so it reads like the tool modules; only
 *  `server` is used today, and a prompt that needs the store will find it here. */
export function register(ctx) {
  const { server } = ctx;

  server.registerPrompt(
    // snake_case, like every tool name on this surface. Hosts that surface prompts as commands
    // render it as one — Claude Code spells it `/mcp__open-mcp-apps__get_started` — so the name
    // has to read as a thing to DO, not as a topic.
    "get_started",
    {
      // Title and description are the only words a person sees before choosing this. They are
      // written for someone who has never used the engine and does not know its vocabulary:
      // no tool names, no "widget", no "MCP App" — just what will happen if they pick it.
      title: "Get started with open-mcp-apps",
      description: "First time here? The AI looks at what you already have, checks the built-in App Store, asks you at most a couple of questions, then builds one app that fits how you work and opens it.",
    },
    () => ({
      // One `user` message: a prompt is user-initiated, so what it delivers is the thing the
      // user would otherwise have typed. Keeping it in their voice is not decoration — a system
      // -voiced instruction arriving through a user turn is a mismatch a model has to resolve.
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "I just connected open-mcp-apps and I want to see what it does for me.",
              "",
              "Look before you build: list_apps and data_collections show what I already have here, and app_store_list shows the ready-made apps — if one of those already fits, install_from_app_store beats writing a new one.",
              "",
              "Before you write any HTML, call get_app_guide. The craft lives there, and an app written without it comes out wrong.",
              "",
              "Ask me at most two questions, and only about what you cannot already tell from my memory, this chat, or what you just found. Then set up ONE app that fits how I actually work, give it a little real starting data, and open_app it.",
              "",
              "Show me the app, not a tour of the tools.",
            ].join("\n"),
          },
        },
      ],
    }),
  );
}
