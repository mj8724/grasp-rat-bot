# Repository Guidelines

## Project Structure & Module Organization

This is a Node.js ES module project for automating the grasp-rat browser game.

- `index.js` starts the local token server and dashboard.
- `bot.js` coordinates the bot lifecycle, polling, rest recovery, and strategy execution.
- `ws-client.js` manages the game WebSocket connection, decoding, and reconnects.
- `game-state.js` stores entities, bullets, coins, stamina, and state snapshots.
- `strategies.js` contains collect, flee, and rest decision logic.
- `targeting.js` contains target scoring, aiming, and movement helpers.
- `dashboard.js` serves the web control panel.
- `extension/` contains the optional Chrome extension for sending tokens locally.

There is currently no dedicated `tests/` directory.

## Build, Test, and Development Commands

- `npm install` installs the single runtime dependency, `ws`.
- `npm start` runs `node index.js` and starts the dashboard at `http://localhost:38473`.
- `node index.js` is equivalent to `npm start` for local debugging.

No build step is required. There is no configured `npm test` script yet; add one before relying on automated test commands.

## Coding Style & Naming Conventions

Use modern JavaScript with ES module imports and exports. Keep the existing 2-space indentation, semicolon usage, and descriptive camelCase identifiers. Prefer small functions that isolate protocol handling, state updates, strategy decisions, and dashboard rendering. Match existing log style and avoid broad refactors when changing one behavior.

## Testing Guidelines

When adding tests, prefer focused unit tests for pure logic in `targeting.js`, `game-state.js`, and strategy helpers before testing WebSocket or dashboard integration. Name test files after the module under test, for example `targeting.test.js`. Mock network connections and external game state rather than calling the live game server. Cover edge cases such as empty entity lists, exhausted stamina windows, reconnects, and missing token data.

## Commit & Pull Request Guidelines

Recent history uses conventional commit prefixes with Chinese descriptions, such as `feat: ...`, `fix: ...`, and `docs: ...`. Keep commits scoped and use `git add <specific-file>` instead of staging unrelated work.

Pull requests should include a concise behavior summary, manual verification steps, affected files, and screenshots when dashboard or extension UI changes. Link related issues when available.

## Security & Configuration Tips

Tokens are stored in `.token.json`; do not commit real credentials or session tokens. Treat game tokens, user IDs, and captured WebSocket payloads as sensitive. Keep Chrome extension changes limited to `extension/` unless server behavior also changes.
