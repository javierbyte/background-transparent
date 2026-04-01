# background-transparent

Fake `background: transparent` for a browser window using a screen sharing video feed.

## How it works

1. **Screen capture.** The page asks to share the full screen that the browser window is on.
2. **Locate the window.** Two 32×32 fiducial markers are rendered at the top corners of the viewport — yellow (#ffff00) on the left, magenta (#ff00ff) on the right. The screen capture feed is scanned each frame to find either marker, giving the browser's position on the screen. Two markers provide redundancy (e.g. if one is off-screen). This is faster than using `window.screenX`/`screenY`, which only update ~15 times per second.
3. **Estimate browser chrome.** The program estimates the height of the browser's top UI (tabs, address bar) and any OS window shadow so it can map viewport coordinates to screen coordinates.
4. **Build a background buffer.** Each frame, the captured screen image is drawn to a canvas — but the area covering the browser window (viewport + chrome + a small padding) is cut out. Over time this accumulates the content behind the browser.
5. **Render.** The canvas is translated so the portion behind the viewport is shown, simulating a transparent background. As the window moves, the offset updates and the illusion follows.
