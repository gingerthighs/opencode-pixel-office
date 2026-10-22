# opencode-pixel-office

opencode-Plugin, das im opencode-Prozess einen kleinen Webserver startet und Orchestrator + Subagents
(oh-my-opencode-slim, oh-my-opencode, opencode built-ins) live in einem Pixel-Art-Büro von oben zeigt.

- Jede Root-Session = eigener Raum (Tabs oben, „folgen“ springt zur aktiven Session)
- Subagents (Child-Sessions mit `parentID`) laufen zur Tür rein, setzen sich an ihren Platz, gehen wieder wenn fertig
- Sprechblasen mit Tool-Icon (read/edit/bash/grep/web/task/todo) oder Text-/Denk-Snippet
- Seitenpanel: Agent-Baum, Status, Tokens/Kosten/Modell, Todos, Aktivitäts-Feed
- Rein lesend, keine Steuerung; keine Runtime-Dependencies, eine einzige JS-Datei

| Agent | Platz |
|---|---|
| orchestrator / sisyphus / atlas / build / plan | Chefbüro (Krone, Whiteboard mit Todos) |
| explorer / explore / librarian | Bibliothek |
| oracle / metis / momus | Orakel-Tisch mit Kristallkugel |
| fixer / sisyphus-junior | Werkstatt |
| designer / frontend-ui-ux-engineer / multimodal-looker | Studio |
| reviewer / observer | Großraum (Lampe) |
| alles andere | Großraum |

## Build

Braucht nur Node ≥ 22.18 (Type-Stripping), kein Bun:

```bash
npm install
npm run build      # → dist/pixel-office.js
npm test           # Store-Reducer Tests
npm run typecheck
npm run mock       # Demo ohne opencode: http://127.0.0.1:4777
```

## Installation auf dem Server

Datei in den globalen Plugin-Ordner kopieren — opencode lädt sie beim nächsten Start automatisch:

```bash
scp dist/pixel-office.js server:~/.config/opencode/plugins/pixel-office.js
```

(Alternativ projektweise nach `.opencode/plugins/`.) opencode danach neu starten — laufende Sessions sind davon betroffen.

## Konfiguration

Env-Variablen (für den opencode-Prozess, z. B. im systemd-Service oder in `.bashrc`):

| Variable | Default | |
|---|---|---|
| `PIXEL_OFFICE_PORT` | `4777` | |
| `PIXEL_OFFICE_HOST` | `0.0.0.0` | `127.0.0.1` für nur lokal / SSH-Tunnel |
| `PIXEL_OFFICE_TOKEN` | – | wenn gesetzt: Aufruf einmal mit `?token=…`, danach Cookie |

Aufruf: `http://<server-ip>:4777/` (bzw. Tailscale-Name). Ohne Token ist die UI für jeden im Netz lesbar —
sie zeigt Prompts, Dateinamen und Befehle. Nur in vertrauenswürdigen Netzen (LAN/Tailscale) ohne Token betreiben.

## Mehrere opencode-Prozesse

Der erste Prozess besitzt den Port. Weitere opencode-Prozesse auf demselben Host merken `EADDRINUSE` und
schicken ihre Events per `POST /api/ingest` (nur Loopback bzw. mit Token) an ihn. Beendet sich der Besitzer,
übernimmt der nächste Prozess den Port beim nächsten Event.

## Aufbau

```
src/plugin.ts   Plugin-Entry (default export { id, server }), Singleton, Snapshot via SDK, Forwarding
src/store.ts    reiner Reducer: opencode-Events → UI-Ops (getestet in test/store.test.ts)
src/server.ts   node:http Server: /, /app.js, /api/state, /api/events (SSE), /api/ingest
web/            Canvas-UI: sprites (prozedural), office (Layout/Pathfinding), characters, bubbles, panel
build.ts        esbuild: Web-Bundle inline → eine Datei dist/pixel-office.js
scripts/mock.ts Demo-Szenario (slim-artiger Lauf in Endlosschleife)
```
