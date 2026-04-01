# background-transparent

Fake `background: transparent` for a browser window using a screen sharing video feed.

## How it works

1. **Screen capture.** The page asks to share the full screen that the browser window is on.
2. **Find the viewport.** The page determines the browser viewport's position on screen. Two strategies are available, controlled by the `VIEWPORT_METHOD` variable at the top of `script.js`:
   - **`"screenXY"`** (default) — uses `window.screenX`, `window.screenY`, and `window.outerHeight` to compute the viewport origin instantly. Simple and free of visual artifacts, but the browser only updates these values ~15 times per second.
   - **`"fiducial"`** — injects two 64×64 colour markers at the top corners of the viewport (yellow left, magenta right) and scans the screen-capture feed each frame to locate them. More precise per-frame, but adds a one-frame lag and the markers are briefly visible.
3. **Estimate browser chrome.** The program estimates the height of the browser's top UI (tabs, address bar) and any OS window shadow so it can map viewport coordinates to screen coordinates.
4. **Build a background buffer.** Each frame, the captured screen image is drawn to a canvas — but the area covering the browser window (viewport + chrome + a small padding) is cut out. Over time this accumulates the content behind the browser.
5. **Render.** The canvas is translated so the portion behind the viewport is shown, simulating a transparent background. As the window moves, the offset updates and the illusion follows.

# Design

It is all communicated through the video buffer. It all starts with a video buffer all black of the size of the screen, with centered text.
"Please click to share the screen this browser is on":
Once that is done, it changes to "Please move the browser" if the browser is less than 1/2 of the area of the screen, or "Make the browser smaller to continue" if not.
