# igbot

An Instagram bot (Node.js, ES modules) that answers `!` commands sent as direct messages.

## Setup

Requirements: Node.js 22 or newer (tested on v22.22.3 here; the project targets v26 as well), npm 10 or newer.

```bash
npm install
cp .env.example .env        # then edit .env
```

Set `SESSION_SECRET` in `.env`. Generate one with `openssl rand -hex 32`, or with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

## Run

```bash
npm start
```

The bot logs in (or restores its saved session), then polls the direct inbox and answers commands. Stop it with Ctrl+C. It saves the session on shutdown.

Other scripts:

| Command | Purpose |
| --- | --- |
| `npm test` | Run the unit tests (no Instagram credentials needed) |
| `npm run lint` | Run ESLint |
| `npm run auth:reset` | Delete the saved session and login cooldown, so the next start logs in fresh. Use after you fix an account issue in the official app. |

## Commands

| Command | Description |
| --- | --- |
| `!help [command]` | List commands or show details for one |
| `!ping` | Show response time |
| `!uptime` | Show how long the bot has been running |
| `!info` | Show version, runtime, prefix and connection state |

To add a command, create `src/commands/<name>.js` that default-exports `{ name, aliases?, description, usage?, execute(ctx) }`, then add it to `src/commands/index.js`. `execute` returns the reply text.

## Layout

```
src/index.js          entry point: config, logging, lifecycle, wiring
src/instagram.js      Instagram connection: login, session restore, polling, sending
src/handler.js        command parsing, validation, registry, dispatch (no Instagram dependency)
src/commands/         built-in commands
src/lib/              config, logger, encrypted session store, auth cooldown guard, helpers
test/                 vitest unit tests
scripts/reset-auth.js auth:reset script
data/                 runtime state (session.enc, auth-state.json). Git-ignored.
```

## Authentication behaviour

- The saved session is encrypted (AES-256-GCM, key derived from `SESSION_SECRET`) in `data/session.enc`, with mode 0600.
- On start, the bot restores the saved session and verifies it. If the session has expired, it logs in once.
- Every authentication failure is recorded in `data/auth-state.json` with a cooldown (`LOGIN_COOLDOWN_MINUTES`, longer for bad passwords and blocks). While the cooldown runs, the bot does not try to log in, even after a restart.
- **Not automated, by design:** CAPTCHA, two-factor codes, and Instagram checkpoints or challenges. When one of these appears, the bot stops with exit code 2 and logs what happened. Resolve it in the official Instagram app, then run `npm run auth:reset`.
- Passwords, cookies and session contents are never logged. The logger redacts sensitive keys.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Normal shutdown |
| 1 | Configuration error or fatal error |
| 2 | Instagram needs manual action or is in a cooldown. Do not restart automatically. |
| 3 | Transient network error during startup. Safe to retry later. |

## Limits

- Incoming messages are read by polling the direct inbox (every `POLL_INTERVAL_MS`). The installed `instagram-private-api` build (1.46.1) does not include its realtime module, so push delivery is not used. If more than 10 messages arrive in one thread between polls, the extra ones are missed.
- Only plain text messages are handled. Replies are truncated to 1000 characters.
- This uses an unofficial API. Instagram may change it or restrict the account. Use a dedicated account and keep request volume low.

## Platform notes

- **Termux (Android):** install Node.js with `pkg install nodejs`. `sharp` and `better-sqlite3` use native code. If their prebuilt binaries don't match your device, build them from source with build tools installed (`pkg install build-essential python`). The current code does not use `sharp` or `better-sqlite3` at runtime.
- **Linux VPS:** nothing special is needed. For a service, run `npm start` under systemd and set `RestartPreventExitStatus=2` so the bot does not retry against a checkpoint.
