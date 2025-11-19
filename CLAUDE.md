# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CastToTV Media Hub is a Chrome Extension (Manifest V3) that provides centralized media control for audio/video playback across browser tabs. It detects media elements on all pages, aggregates them in a popup UI, and enables remote playback control.

## Development Commands

**No build system required** - This is a pure JavaScript Chrome Extension.

**Load Extension:**
1. Open `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" → select this `extension/` folder
4. Reload extension after code changes using the refresh button

**Test Sites:** YouTube, Bilibili, Netease Music, or any site with `<audio>`/`<video>` elements

**Debug:**
- Service worker: `chrome://extensions` → "Inspect views: service worker"
- Content script: Regular DevTools on any page
- Popup: Right-click extension icon → "Inspect popup"

## Architecture

### Component Communication Flow

```
Content Script (each page) → chrome.runtime.sendMessage → Background Service Worker
                                                              ↓
Popup ←─────────────── chrome.runtime.connect (persistent port) ←┘
  ↓
chrome.tabs.sendMessage → Content Script (targeted tab)
```

### Core Files

- **background.js** - Service worker maintaining in-memory Map of all media sessions (keyed by `sessionId = tabId:elementId`), routing messages between content scripts and popup
- **content/mediaTracker.js** - Injected into every page; observes DOM for media elements, extracts metadata with fallback chains, handles playback commands
- **popup/popup.js** - UI controller maintaining persistent port connection; renders media cards, dispatches user commands
- **utils/messageTypes.js** - Shared constants (MESSAGE_TYPES, MEDIA_COMMANDS, PORT_NAMES)

### Key Data Model

Session snapshot (passed between components):
```javascript
{
  sessionId: "tabId:elementId",  // Unique identifier
  title: string,                  // Multiple fallback sources
  artist: string,
  artwork: string | null,
  isPlaying: boolean,
  duration: number,
  currentTime: number,
  mediaKind: "audio" | "video",
  // ... other playback state
}
```

### Important Patterns

**Message Types:**
- `MEDIA_UPDATE` / `MEDIA_REMOVED` - Content script → Background (fire-and-forget)
- `MEDIA_COMMAND` - Popup → Background → Content script (with command payload)
- `SESSIONS_UPDATED` - Background → Popup (broadcasts current sessions)

**Metadata Extraction Priority (content script):**
1. `navigator.mediaSession.metadata` (if available)
2. Element attributes (`aria-label`, `title`, `data-title`, `poster`)
3. DOM context (nearby images, page title)
4. URL parsing (filename from `currentSrc`)

**Update Batching:**
- Uses `requestAnimationFrame` to debounce frequent `timeupdate` events
- Prevents message flooding while keeping UI responsive

**Error Handling:**
- All `chrome.runtime.sendMessage` wrapped in try-catch with `lastError` checking
- Safe DOM queries use optional chaining
- Port auto-reconnects on disconnect (600ms retry)

## Code Conventions

- Strict mode in all files
- IIFE pattern to scope variables
- Console logging prefix: `[CastToTV]`
- Kebab-case for command names: `toggle-play`, `seek-relative`, `seek-absolute`
- PascalCase for constants: `MESSAGE_TYPES`, `MEDIA_COMMANDS`
- Defensive null checks with optional chaining

## Permissions (manifest.json)

- `tabs` - Tab info and switching
- `scripting` - Content script injection
- `activeTab` - Active tab access
- `storage` - Future use (not currently implemented)
- `windows` - Window focus on tab switch
- Host permissions: All HTTP/HTTPS sites for universal media detection
