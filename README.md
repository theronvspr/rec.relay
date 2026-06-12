# rec.relay
> Record on mobile (or pc), land on PC over local network (P2P via WebRTC).

`rec.relay` captures video on your phone's browser and transfers it to your PC's local hard drive over Wi-Fi. No accounts, no cloud, no app to install.

---

## Running It

### Option 1: Terminal CLI

Requires Node.js v18+.

```bash
npx github:theronvspr/rec.relay
```

Starts the Express server, prints a QR code in your terminal, and opens the dashboard at `http://localhost:3000/dashboard`. Videos are saved to `./uploads` in whichever directory you ran the command from.

---

### Option 2: Desktop App

1. Go to the [GitHub Releases](https://github.com/theronvspr/rec.relay/releases) page.
2. Download one of:
   - **Portable**: `rec.relay 3.0.0.exe` — run directly, no setup.
   - **Installer**: `rec.relay Setup 3.0.0.exe` — installs the app and adds desktop shortcuts.
3. Open the app. The dashboard and QR code appear in a window.

Videos are saved to:
- **Windows**: `C:\Users\<Name>\AppData\Roaming\rec.relay\uploads`

---

## How to Use

1. Start rec.relay.
2. Scan the QR code with your phone camera.
3. Your phone's browser loads the recording client.
4. Record a clip.
5. Tap **Send to PC**. The file transfers over WebRTC to your local disk.
6. The dashboard refreshes and shows the new file in the calendar grid, where you can preview, stream, download, or delete it.

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

### Run Electron locally
```bash
npm run electron:start
```

### Build Windows executables
Outputs to `dist/`:
```bash
npm run electron:build
```
