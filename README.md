# rec.relay
> Record on mobile (or pc), land on PC over local network (P2P via WebRTC).

`rec.relay` captures video on your phone's browser and transfers it to your PC's local hard drive over Wi-Fi. No accounts, no cloud, no app to install.

---

## Running It

Requires Node.js v18+.

```bash
npx github:theronvspr/rec.relay
```

Starts the Express server, prints a QR code in your terminal, and opens the dashboard at `http://localhost:3000/dashboard`. Videos are saved to `./uploads` in whichever directory you ran the command from.

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
