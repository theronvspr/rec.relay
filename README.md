# rec.relay

> Record on mobile (or pc), land on PC over local network (P2P via WebRTC).

`rec.relay` captures video on your phone's browser and transfers it directly to your PC's local hard drive over your local Wi-Fi network. No accounts, no cloud, no third-party server hosting, and no mobile app installation required.

---

## Why I Made This Project

<!-- Add your personal motivation, backstory, or use-case for creating rec.relay here! -->

---

## Features

- 🔒 **100% Private & Local:** Videos are streamed directly from device to device. No cloud storage, no accounts, and no data is shared with external servers.
- 📱 **No App Install:** Scan the QR code, record video in your mobile browser, and sync immediately.
- 🔄 **Orientation-Aware:** Automatically detects portrait/landscape mode to adjust recording and streaming outputs accordingly.
- 💻 **Terminal User Interface (TUI):** A rich command-line interface with a calendar view, file list, QR code overlays, and quick actions.
- 🌐 **Web Dashboard:** A premium, modern web dashboard for playing back recordings, managing tags, adding custom notes, and playing audio references.
- ⚙️ **Auto-Updater:** Notifies you on startup of new releases and supports interactive update checking and self-updates.

---

## Running It

Requires Node.js v18+.

```bash
npx github:theronvspr/rec.relay
```

This starts the Express server, prints a QR code directly in your terminal, and opens the Web Dashboard at `http://localhost:3000/dashboard`. Recorded videos are saved to `./uploads` in whichever directory you ran the command from.

---

## How to Use

1. **Start rec.relay** on your PC.
2. **Scan the QR Code** displayed in your terminal or web dashboard using your mobile device.
3. **Record a clip** using the recording interface in your phone's browser.
4. **Tap "Send to PC"**. The video stream will transfer over WebRTC directly to your local PC.
5. **Manage your recordings** either directly in the terminal interface or via the modern Web Dashboard.

---

## Terminal User Interface (TUI) Guide

When running `rec.relay` in your console, you can use these shortcuts:

| Key | Action |
| --- | --- |
| `[Tab]` | Switch active pane between **Recordings List** and **Calendar** |
| `[Arrows]` | Navigate lists or calendar days |
| `[Enter]` | Filter recordings by selected calendar date / Open stream in browser |
| `[f]` | Filter search tags and comments in real-time |
| `[c]` | Toggle QR Code connection overlay window |
| `[e]` | Edit recording metadata (notes, tags, music reference) |
| `[d]` | Open the Web Dashboard in your default browser |
| `[u]` | Perform an automatic Git update (only when running inside a git clone) |
| `[Del / Backspace]` | Delete selected recording |
| `[q]` | Shut down the server and exit |

---

## Developer Guide

### Install dependencies
```bash
npm install
```

### Development mode
```bash
npm run dev
```

### Build & Tag Release
```bash
git tag v3.5.0
git push origin v3.5.0
```
*(GitHub Actions will automatically run to create a release draft and populate changelogs based on the tags pushed).*
