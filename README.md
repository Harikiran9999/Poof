# Poof 💨

**Disappear from Google Meet with a single clap.**

Poof is a lightweight Chrome extension that makes you vanish from your webcam feed during a Google Meet call — your image dissolves into a cloud of particles, revealing an empty room, while you remain fully connected to the conversation. Clap again (or press a hotkey) and you rematerialise.

No servers. No cloud processing. No data leaves your machine. Everything — video compositing, background subtraction, audio detection — runs entirely in-browser using the Canvas API and Web Audio.

---

## 🚀 Getting Started

### Prerequisites

- **Google Chrome** (version 102 or later recommended)
- A webcam and microphone
- ~3 minutes of setup time

### Installation

> Poof is distributed as an unpacked extension. This is Chrome's standard mechanism for sideloading extensions that aren't on the Web Store — it's completely safe and requires no terminal or command-line knowledge.

1. **Download** — click the green **Code** button at the top of this page, then select **Download ZIP**.
2. **Extract** — unzip the archive. You'll get a folder named something like `Poof-main`. Move it somewhere permanent (e.g. `Documents/Poof`). The extension loads from this folder at runtime, so don't delete or relocate it later.
3. **Load into Chrome**
   - Navigate to `chrome://extensions` in your address bar.
   - Enable **Developer mode** using the toggle in the top-right corner.
   - Click **Load unpacked** and select the extracted folder.
4. **Verify** — the Poof extension card should now appear in the list with a coral-pink icon. If a Google Meet tab is already open, refresh it.

---

## 🎯 Usage

### Quick Start (30 seconds)

1. **Join a Google Meet call** and grant camera + microphone permissions when prompted.
2. A small floating **status orb** appears in the top-left of the page — click the status text to expand the control panel.
3. **Capture your background** — step out of frame, click `✨ capture empty room`, and hold still for 3 seconds while the extension photographs the empty scene.
4. **Sit back down.** The orb will show `✨ ready` — the extension is now armed.
5. **Clap, snap your fingers, or make any short percussive sound.** Your video feed will dissolve into a swirling cloud of particles, leaving the empty room behind. Trigger it again to reappear.

### Controls

| Action | Method |
|---|---|
| Toggle vanish / return | Clap or snap · Panel button · `Cmd/Ctrl + Shift + X` |
| Recapture background | Panel button `✨ capture empty room` |
| Show / hide the orb | `Cmd/Ctrl + Shift + H` |
| Adjust sound sensitivity | Slider in the panel |

### Tips for Best Results

- **Lighting matters.** Capture your background under the same lighting you'll use during the call. If the light changes significantly (sunset, overhead light toggled), recapture.
- **Keep the camera stationary.** Even a small bump shifts the reference frame and degrades the mask quality.
- **Sensitivity tuning.** If Poof triggers from speech or keyboard sounds, drag the sensitivity slider left. If it ignores your claps, drag it right.
- **Multiple monitors.** The orb renders inside the Meet tab, so it won't interfere with screen sharing on a different monitor.

---

## 🔧 How It Works

Poof operates as a three-stage pipeline that intercepts your camera feed before Google Meet sees it:

### 1. Background Capture & Subtraction
When you click "capture empty room", Poof averages 14 consecutive frames to build a noise-reduced reference image of the scene. During a call, each live frame is compared against this reference at a reduced resolution (480px wide) using per-pixel colour differencing with adaptive brightness compensation to handle gradual lighting drift.

### 2. Person Segmentation
The raw difference map goes through a multi-step cleanup: box-blur denoising → binary thresholding → connected-component analysis (flood-fill) to discard small noise blobs → hole-filling to patch gaps inside the silhouette → temporal smoothing across frames to suppress flicker. The result is a soft-edged alpha mask isolating you from the background.

### 3. Dissolve & Particle System
On trigger, a radial threshold sweep expands outward from the centre of the frame. Pixels whose threshold value falls within the current sweep band dissolve — their alpha drops to zero and a particle is spawned at that location with the pixel's original colour, plus a slight warm-glow tint. Particles drift outward with per-particle spin and deceleration, fading over ~1 second. The composited output (background plate + masked live feed + particle overlay) is rendered to an offscreen canvas and fed back to Meet via `captureStream()`.

### Audio Trigger
A high-pass filtered (2.5 kHz cutoff) audio stream is analysed in real-time via `ScriptProcessorNode`. The detector looks for a sharp transient — RMS energy that spikes above a sensitivity-scaled noise floor and decays within 140 ms — characteristic of a clap or finger snap. Sustained sounds (speech, music) are explicitly rejected.

---

## 🔒 Privacy & Security

- **Zero network traffic.** Poof declares no `host_permissions` beyond `meet.google.com` (required to inject the content script). It makes no HTTP requests, opens no WebSockets, and has no background service worker phoning home.
- **No data storage.** The background reference frame lives only in memory (as a canvas element) and is discarded when the tab is closed. The only persisted value is your sensitivity preference in `localStorage`.
- **Microphone usage.** Audio is processed exclusively on-device for transient detection. Raw audio buffers are never recorded, stored, or transmitted. The audio pipeline connects through a zero-gain node, so it is inaudible.
- **Manifest V3.** Poof uses Chrome's latest extension platform with the strictest default Content Security Policy. All code runs in the `MAIN` world of the Meet page — there is no background page, no remote code loading, and no `eval`.

---

## 🐛 Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Orb never appears | Extension not loaded or Meet tab predates installation | Verify the extension is enabled (blue toggle) on `chrome://extensions`, then **hard-refresh** the Meet tab (`Cmd/Ctrl + Shift + R`) |
| Doesn't react to claps | Sensitivity too low, or browser hasn't been granted mic access | Open the panel and drag the sensitivity slider rightward. Also check `chrome://settings/content/microphone` |
| Triggers from typing or talking | Sensitivity too high | Drag the slider leftward until false positives stop |
| Ghostly outline remains after vanishing | Background has changed since last capture (lighting shift, object moved) | Click `✨ capture empty room` again — step out, wait 3 s, sit back down |
| Video looks laggy or stuttery | High-resolution camera on a slower machine | Poof caps internal resolution at 1280px wide. If still slow, lower your camera resolution in Meet settings |
| Extension shows an error badge | File was moved or renamed after loading | Re-point Chrome at the correct folder via `Load unpacked` on `chrome://extensions` |

---

## 📁 Project Structure

```
poof/
├── manifest.json        # Extension manifest (Manifest V3)
├── effect.js            # Canvas rendering pipeline, background subtraction, particle system
├── poofdetect.js        # Web Audio–based percussive sound detector
├── inject.js            # getUserMedia hook, UI overlay, keyboard shortcuts
├── README.md
└── icons/
    ├── poof-16.png      # Toolbar icon
    ├── poof-48.png      # Extensions page icon
    └── poof-128.png     # Detail / Web Store icon
```

---

## 📝 License

This project is provided as-is for personal and educational use.
