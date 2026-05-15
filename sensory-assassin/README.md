# Sensory Assassin

Chrome MV3 extension for collecting high-resolution images from the current page and reverse-engineering image style prompts through a local Shadow Lantern bridge.

## Features

- Toggle the floating panel with the extension icon or `Alt+Shift+G`.
- Scan `<img>` tags and CSS background images.
- Filter images by minimum dimension.
- Sort by load time or image area.
- Download one image or all matched images.
- Copy an image to the clipboard through the extension background fetch path.
- Paste a reference image and run Shadow Lantern style reverse-engineering.
- Choose granularity:
  - `1`: transferable visual style only.
  - `2`: visual style plus concrete picture content.

## Load In Chrome

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select this folder.

## Shadow Lantern Bridge

The image collection features work without a model service. The style reverse-engineering tab needs the local bridge:

```bash
cd /Users/hq/WorkSpace/tools/sensory-assassin
python3 tools/shadow_lantern_bridge.py
```

Health check:

```bash
curl http://127.0.0.1:8765/health
```

The bridge accepts image data URLs from the extension, saves a temporary image, then calls `codex exec --image` with the local `shadow-lantern` skill.
