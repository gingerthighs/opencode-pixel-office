# opencode-pixel-office

opencode-Plugin, das im opencode-Prozess einen kleinen Webserver startet und Orchestrator + Subagents
(oh-my-opencode-slim, oh-my-opencode, opencode built-ins) live in einem Pixel-Art-Büro von oben zeigt.

- Jede Root-Session = eigener Raum (Tabs oben, „folgen“ springt zur aktiven Session)
- Subagents (Child-Sessions mit `parentID`) laufen zur Tür rein, setzen sich an ihren Platz, gehen wieder wenn fertig
- Sprechblasen mit Tool-Icon (read/edit/bash/grep/web/task/todo) oder Text-/Denk-Snippet
- Seitenpanel: Agent-Baum, Status, Tokens/Kosten/Modell, Todos, Aktivitäts-Feed
- Tag/Nacht nach lokaler Uhrzeit mit Licht-Pools (erzwingbar per `?time=day` / `?time=night`),
  Wand-TV mit aktiven Agents + Tokens, echte Uhr, Whiteboard mit Todo-Fortschritt, Büro-Katze
- Bereichsschilder auf dem Boden (3×5-Pixelfont, beim Rauszoomen UI-Font); Namen und Bubbles werden
  kollisionsfrei nach Priorität platziert
- **Festes Personal** mit Namen (Otto, Ella, Emil, Lotte, Orla, Fritz, Frieda, Dani, Rita): Aufträge gehen an
  das passende Team-Mitglied, bei Engpass kommt eine Aushilfe durch die Tür. Wer frei hat, macht Pause –
  Kaffee, Fernsehen, Sitzsack, Arcade, Tischtennis, Handy, Surfen oder Katze streicheln
- **Papierkram**: Arbeiter holen ihren Auftrag in der Ablage des Chefs ab, legen ihn auf den Schreibtisch, jede
  Datei-Änderung wächst als Papierstapel (Klick → Dateiliste), fertige Berichte landen im Eingangskorb des Chefs
- **Freigaben im UI** (Einmal / Immer / Ablehnen) und **Stopp** pro Agent; Rückfragen werden angezeigt, Antworten
  gehen weiterhin im Terminal (die Plugin-API kann keine Antworten senden)
- **Fäden** (wer hat wen beauftragt), **Zeitleiste** (wer arbeitete wann), **Gebäude** mit einer Etage pro Projekt
  und Aufzug zwischen den Büros
- Keine Runtime-Dependencies, eine einzige JS-Datei

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

(Alternativ projektweise nach `.opencode/plugins/`.) opencode 2.x lädt die Datei beim Kopieren automatisch neu;
bei 1.x opencode neu starten.

## Konfiguration

Env-Variablen (für den opencode-Prozess, z. B. im systemd-Service oder in `.bashrc`):

| Variable | Default | |
|---|---|---|
| `PIXEL_OFFICE_PORT` | `4777` | |
| `PIXEL_OFFICE_HOST` | `127.0.0.1` | `0.0.0.0` für Zugriff aus LAN/Tailscale |
| `PIXEL_OFFICE_TOKEN` | – | wenn gesetzt: Aufruf einmal mit `?token=…`, danach Cookie |

Aufruf lokal: `http://127.0.0.1:4777/`, auf einem Server mit `PIXEL_OFFICE_HOST=0.0.0.0`: `http://<server-ip>:4777/`.
Ohne Token ist die UI für jeden im Netz lesbar — sie zeigt Prompts, Dateinamen und Befehle.
Nur in vertrauenswürdigen Netzen (LAN/Tailscale) ohne Token betreiben.

Die Env-Variablen müssen im Prozess ankommen, der die Plugins lädt. Bei opencode 2.x ist das der
Hintergrund-Service (`opencode serve --service`), nicht die TUI — nach dem Setzen den Service neu starten.

## opencode-Versionen

- **1.x**: klassische Hooks (`server` → `event`), Snapshot über `client.session.list/status`.
- **2.x**: `setup(ctx)` mit `ctx.event.subscribe()` + `ctx.tool.hook("execute.before/after")`.
  Die v2-Events (`session.execution.*`, `session.text/reasoning.*`, `session.tool.*`, `session.usage.updated`,
  `form.*`, …) werden in `src/v2.ts` auf das v1-Format übersetzt. Sessions, die nur indirekt auftauchen
  (z. B. per `task_revive` wiederbelebte Subagents), werden einmal per `ctx.session.get` nachgeschlagen.
- Ändert sich `pixel-office.js`, lädt opencode das Plugin neu; der neue Build löst den Server des alten ab
  (In-Memory-Feeds gehen dabei verloren, Sessions werden neu eingelesen).
- Zur Diagnose landen von jedem Event-Typ die ersten zwei Beispiele (Strings gekürzt) in
  `~/.local/share/opencode/log/pixel-office-events.jsonl`.

## Steuerung (Freigaben, Stopp)

Schreibende Aktionen gehen über `POST /api/control` und brauchen den Nonce aus der ausgelieferten Seite
(gegen Cross-Site-Requests). Ohne `PIXEL_OFFICE_TOKEN` ist Steuerung nur erlaubt, wenn der Server auf
Loopback lauscht und die Anfrage an `localhost`/`127.0.0.1` geht (gegen DNS-Rebinding); im Netz (`0.0.0.0`)
nur mit Token.

## Mehrere opencode-Prozesse

Der erste Prozess besitzt den Port. Weitere opencode-Prozesse auf demselben Host merken `EADDRINUSE` und
schicken ihre Events per `POST /api/ingest` (nur Loopback bzw. mit Token) an ihn. Beendet sich der Besitzer,
übernimmt der nächste Prozess den Port beim nächsten Event.

## Aufbau

```
src/plugin.ts   Plugin-Entry (default export { id, server, setup }), Singleton, Snapshot, Forwarding
src/v2.ts       opencode-2.x-Adapter: v2-Events + Tool-Hooks → v1-Events
src/store.ts    reiner Reducer: opencode-Events → UI-Ops (getestet in test/store.test.ts)
src/server.ts   node:http Server: /, /app.js, /api/state, /api/events (SSE), /api/ingest
web/            Canvas-UI: sprites (prozedural), office (Layout/Pathfinding), characters, bubbles, panel
build.ts        esbuild: Web-Bundle inline → eine Datei dist/pixel-office.js
scripts/mock.ts Demo-Szenario (slim-artiger Lauf in Endlosschleife)
```
