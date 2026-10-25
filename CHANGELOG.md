# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] – 2026-10-25

First public release.

### Added

- opencode plugin (1.x hooks and 2.x `setup(ctx)` API) that serves a web UI from the opencode process.
- Top-down pixel-art office with walled rooms, a permanent named team, temps on laptops, a lounge with TV,
  a game room and a cat corner.
- Paper workflow: assignments from the boss's outbox, pages stack up with every edit, reports go back to the inbox.
- Live speech bubbles with tool icons, streamed text and reasoning.
- Side panel with assignments, activity feed, todos, edited files, tokens and cost.
- Approvals (*Allow once / Always allow / Reject*) and a two-step stop from the UI, routed to the opencode
  process that owns the session.
- Needs-attention queue across all rooms: approvals, questions, failures and inactive agents.
- Threads, an activity timeline with 15/60/120-minute windows and in-memory history.
- Building view with one floor per project and an elevator; day/night lighting; phone layout.
- Multi-process support: additional opencode processes forward their events to the one that owns the port.
- Cross-platform installer (`install.sh`, `install.ps1`) with `pixel-office.json` settings.
- Security: localhost-only default, optional token, DNS-rebinding protection, nonce-protected controls,
  strict CSP, embedded font, opt-in debug sampling.

[0.1.0]: https://github.com/gingerthighs/opencode-pixel-office/releases/tag/v0.1.0
