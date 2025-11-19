# CastToTV Media Hub Extension

## Components
- **Manifest (manifest.json)** – Declares MV3 config, permissions (`tabs`, `scripting`, `activeTab`, `storage`) and wires popup, background worker, and content scripts.
- **Background service worker (background.js)** – Keeps canonical list of observed media sessions keyed by `tabId + elementId`, forwards commands between popup and content, and cleans up closed tabs.
- **Content script (content/mediaTracker.js)** – Injected into every page containing `<audio>`/`<video>` elements. Watches DOM for media nodes, extracts metadata (title, artist, artwork), listens for playback changes, and exposes control handlers (play/pause, +/-10s, seek slider).
- **Popup UI (popup/index.html + popup/popup.js + popup/popup.css)** – Renders sessions in a stacked card layout inspired by Chrome’s media hub. Uses a persistent runtime port to receive live updates and dispatches user commands back to the worker.
- **Shared helpers (content/mediaHelpers.js, utils/messageTypes.js)** – Provide serialization helpers and constants so background, popup, and content stay in sync.

## Data Model
Each media session snapshot sent from the content script contains:
```
{
  elementId: string,
  tabId: number,
  sessionId: string, // `${tabId}:${elementId}` assigned in background
  origin: string, // e.g., youtube.com
  title: string,
  artist: string,
  artwork: string | null,
  sourceUrl: string,
  isPlaying: boolean,
  duration: number,
  currentTime: number,
  volume: number,
  canPlay: boolean,
  lastUpdated: number
}
```
The background worker persists sessions in-memory and sorts by `lastUpdated` so the popup highlights the most recent media.

## Messaging Contract
- `MEDIA_UPDATE` – content → background (payload snapshot).
- `MEDIA_REMOVED` – content → background to prune entries when DOM nodes disappear.
- `POPUP_CONNECT` – popup opens a persistent `chrome.runtime.connect` port named `popup`.
- `SESSIONS_UPDATED` – background → popup broadcast containing serialized session array.
- `MEDIA_COMMAND` – popup → background → content conveying actions: `toggle-play`, `seek-relative`, `seek-absolute`.

## Popup Interaction Flow
1. User opens popup → script establishes runtime port → receives initial `SESSIONS_UPDATED` payload.
2. User clicks control → popup sends `{type:'MEDIA_COMMAND', command:'seek-relative', delta: +10, sessionId}` via port.
3. Background resolves `sessionId` → `chrome.tabs.sendMessage(tabId, {...})` to correct frame.
4. Content script applies command to underlying media element and emits a new `MEDIA_UPDATE` to refresh UI state.
