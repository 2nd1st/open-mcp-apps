---
name: competitor-weekly
description: A weekly brief on the creator accounts the user watches — what actually worked, who posted most versus who earned the response, and what to try, watch and ignore. Use when the user adds or drops an account to watch, or asks for this week's competitor report.
---

# Competitor Weekly

## Accounts to watch — competitor-watchlist

- One row per account: `handle` (required), with `name`, `note` and `status`.
- An account is active unless its `status` is `paused`.

## Each week — competitor-reports

- Gather the public activity of every active account for the week.
- Write ONE `competitor-reports` row per account, with `week_start` = that week's Monday
  (`YYYY-MM-DD`), plus `handle`, `posts_count`, `engagement`, `top_post` (a short quote only),
  `top_post_stats`, `themes` (comma-separated), `formats` and `change_note` (what changed vs last
  week).

## Rules

- The app makes no network requests: gathering public activity is your job, not the app's.
- It studies rivals; it never imitates them.
