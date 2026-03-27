# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Popcorn Meet is a Chrome Extension (Manifest V3) that tracks speaking order during Google Meet standups. It detects the active speaker by observing rapid CSS class mutations on participant tiles via MutationObserver — no microphone or audio access needed.

## Architecture

- **No build step** — edit JS/CSS files directly. To test, reload the unpacked extension in `chrome://extensions` and refresh the Meet tab.
- **content.js** — single IIFE containing all logic: speaker detection, participant tracking, state management, and the full panel UI (built programmatically via DOM APIs).
- **panel.css** — panel styles loaded into a closed Shadow DOM to prevent style conflicts with Meet's page.
- **background.js** — minimal service worker; only handles extension icon click to toggle the panel.
- **manifest.json** — MV3 manifest. Only permission is `storage` (for `chrome.storage.sync`).

## Key technical details

- Speaker detection uses a 2-second sliding window counting class mutations per tile. A tile with 6+ mutations spread across 800ms+ is considered the active speaker.
- Participant names are extracted from the `"More options for <Name>"` aria-label pattern on buttons inside tiles.
- All UI is injected into Meet's page inside a closed Shadow DOM — CSS variables must be on `.panel`, not `:root`/`:host`.
- Settings are persisted via `chrome.storage.sync` under the key `popcornSettings`.
- Detection relies on Meet's current DOM structure and may break if Google changes Meet's UI.

## Testing

Manual only — load unpacked in Chrome, join a Meet call, and verify behavior. No automated test framework.
