const videoEl = document.querySelector("video");
const canvasEl = document.querySelector("canvas.draw");

// --- Viewport detection method ---
// "fiducial" — scan screen capture for colour markers (accurate, ~1 frame lag)
// "screenXY"  — use window.screenX / screenY browser APIs (instant, ~15 Hz update)
// const VIEWPORT_METHOD = "screenXY";
const VIEWPORT_METHOD = "fiducial";

const FIDUCIAL_SIZE = 16; // px, width and height

// Browser chrome (tabs, address bar, shadow, etc.) in CSS pixels.
const CHROME_TOP = 96;
const CHROME_BOTTOM = 40;
const CHROME_RIGHT = 16;
const CHROME_LEFT = 16;

let isPlaying = false;
let displayX = 0;
let displayY = 0;

// Cached viewport position from previous frame (pixel coords).
let lastViewportPx = null; // { x, y } in video pixels

// ---------------------------------------------------------------------------
// Fiducial injection (only when using fiducial method)
// ---------------------------------------------------------------------------
if (VIEWPORT_METHOD === "fiducial") {
  const fidStyle =
    "position:fixed;top:0;width:16px;height:16px;z-index:1000;pointer-events:none;";
  const leftFid = document.createElement("div");
  leftFid.style.cssText = fidStyle + "left:0;background:#ffff00;";
  document.body.appendChild(leftFid);

  const rightFid = document.createElement("div");
  rightFid.style.cssText = fidStyle + "right:0;background:#00ff00;";
  document.body.appendChild(rightFid);
}

// ---------------------------------------------------------------------------
// Viewport position strategies
// ---------------------------------------------------------------------------

// Detect whether a pixel looks yellow or green, tolerant of color profiles.
function isYellowPixel(data, i) {
  return data[i] > 150 && data[i + 1] > 150 && data[i + 2] < 100;
}
function isGreenPixel(data, i) {
  return data[i] < 100 && data[i + 1] > 150 && data[i + 2] < 100;
}

// Given a pixel at (x, y) that matches testFn, walk left and up to find
// the exact top-left corner of the colored block.
function walkToCorner(data, vw, vh, x, y, testFn) {
  while (x > 0 && testFn(data, (y * vw + (x - 1)) * 4)) x--;
  while (y > 0 && testFn(data, ((y - 1) * vw + x) * 4)) y--;
  return { x, y };
}

// Find the viewport by checking fiducials at the expected position.
// Uses screenX/Y as a hint, finds a matching pixel, then walks to exact edges.
function findViewportFiducial(snapCtx, vw, vh, dpr) {
  const imageData = snapCtx.getImageData(0, 0, vw, vh);
  const data = imageData.data;

  // Build list of candidate viewport positions to check.
  const candidates = [];

  // 1. Previous frame position (most likely).
  if (lastViewportPx) {
    candidates.push(lastViewportPx);
  }

  // 2. screenX/Y hint.
  const chromeHeight = window.outerHeight - window.innerHeight;
  const hintX = Math.round(window.screenX * dpr);
  const hintY = Math.round((window.screenY + chromeHeight) * dpr);
  candidates.push({ x: hintX, y: hintY });

  // 3. Search nearby offsets around each candidate for a yellow pixel.
  const margin = Math.round(100 * dpr);
  const step = Math.round(4 * dpr);
  const sizePx = Math.round(FIDUCIAL_SIZE * dpr);

  for (const base of candidates) {
    for (let dy = -margin; dy <= margin; dy += step) {
      for (let dx = -margin; dx <= margin; dx += step) {
        const sx = base.x + dx;
        const sy = base.y + dy;
        if (sx < 0 || sx >= vw || sy < 0 || sy >= vh) continue;

        const i = (sy * vw + sx) * 4;
        if (!isYellowPixel(data, i)) continue;

        // Found a yellow pixel — walk to exact top-left corner.
        const yellow = walkToCorner(data, vw, vh, sx, sy, isYellowPixel);

        // Cross-check: green should be at top-right of viewport.
        // Sample a point inside where green fiducial should be.
        const greenProbeX = yellow.x + Math.round(window.innerWidth * dpr) - Math.round(sizePx / 2);
        const greenProbeY = yellow.y + Math.round(sizePx / 2);
        if (greenProbeX < 0 || greenProbeX >= vw || greenProbeY < 0 || greenProbeY >= vh) continue;

        const gi = (greenProbeY * vw + greenProbeX) * 4;
        if (!isGreenPixel(data, gi)) continue;

        lastViewportPx = { x: yellow.x, y: yellow.y };
        return { x: yellow.x / dpr, y: yellow.y / dpr };
      }
    }
  }

  lastViewportPx = null;
  return null;
}

// Dispatcher — calls the strategy selected by VIEWPORT_METHOD.
function findViewportPosition(snapCtx, vw, vh, dpr) {
  if (VIEWPORT_METHOD === "screenXY") {
    const chromeHeight = window.outerHeight - window.innerHeight;
    return { x: window.screenX, y: window.screenY + chromeHeight };
  }
  return findViewportFiducial(snapCtx, vw, vh, dpr);
}

const shareBtn = document.getElementById("share-btn");

shareBtn.addEventListener(
  "click",
  function () {
    if (isPlaying) {
      canvasEl.classList.toggle("filter");
      return;
    }
    isPlaying = true;
    shareBtn.style.display = "none";

    navigator.mediaDevices
      .getDisplayMedia({
        video: true,
        audio: false,
      })
      .then((stream) => {
        videoEl.srcObject = stream;
        videoEl.play();
        const ctx = canvasEl.getContext("2d");

        // Offscreen canvas to snapshot each video frame, so detection and
        // painting always use the exact same frame. Without this, a live
        // MediaStream can advance between the two drawImage calls.
        const snapCanvas = document.createElement("canvas");
        const snapCtx = snapCanvas.getContext("2d");

        function render() {
          // Wait until the video has actual frame data.
          if (videoEl.videoWidth === 0 || videoEl.readyState < 2) {
            requestAnimationFrame(render);
            return;
          }

          // Derive the capture scale from actual video size vs screen size.
          // Chrome captures at native resolution (dpr×), Safari captures at 1×.
          const dpr =
            videoEl.videoWidth / screen.width || window.devicePixelRatio;

          // Resize draw canvas to match the full video feed.
          if (
            canvasEl.width !== videoEl.videoWidth ||
            canvasEl.height !== videoEl.videoHeight
          ) {
            canvasEl.width = videoEl.videoWidth;
            canvasEl.height = videoEl.videoHeight;
            canvasEl.style.width = videoEl.videoWidth / dpr + "px";
            canvasEl.style.height = videoEl.videoHeight / dpr + "px";
          }

          // Snapshot the current video frame.
          if (
            snapCanvas.width !== videoEl.videoWidth ||
            snapCanvas.height !== videoEl.videoHeight
          ) {
            snapCanvas.width = videoEl.videoWidth;
            snapCanvas.height = videoEl.videoHeight;
          }
          snapCtx.drawImage(videoEl, 0, 0);

          // --- Step 2: Find the viewport position ---
          const vw = videoEl.videoWidth;
          const vh = videoEl.videoHeight;
          let viewport = null;
          try {
            viewport = findViewportPosition(snapCtx, vw, vh, dpr);
          } catch (e) {
            console.error(e);
          }

          if (!viewport) {
            requestAnimationFrame(render);
            return;
          }

          displayX += (viewport.x - displayX) * 0.5;
          displayY += (viewport.y - displayY) * 0.5;

          // --- Step 3: Draw the capture, cutting out the browser window ---
          const holeX = (viewport.x - CHROME_LEFT) * dpr;
          const holeY = (viewport.y - CHROME_TOP) * dpr;
          const holeW = (CHROME_LEFT + window.innerWidth + CHROME_RIGHT) * dpr;
          const holeH = (CHROME_TOP + window.innerHeight + CHROME_BOTTOM) * dpr;

          ctx.save();
          ctx.beginPath();
          ctx.rect(0, 0, canvasEl.width, holeY);
          ctx.rect(0, holeY, holeX, holeH);
          ctx.rect(holeX + holeW, holeY, canvasEl.width - holeX - holeW, holeH);
          ctx.rect(
            0,
            holeY + holeH,
            canvasEl.width,
            canvasEl.height - holeY - holeH,
          );
          ctx.clip();
          ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
          ctx.drawImage(snapCanvas, 0, 0);
          ctx.restore();

          // --- Step 5: Position canvas and scroll so content extends behind chrome ---
          // Place canvas absolutely so the full capture is in the document.
          // Then scroll so the viewport-aligned portion is visible.
          // Content above the scroll position shows through Safari's translucent chrome.
          const scrollX = displayX;
          const scrollY = displayY;
          canvasEl.style.transform = "none";
          canvasEl.style.left = "0px";
          canvasEl.style.top = "0px";
          // Temporarily allow scrolling to position content
          document.documentElement.style.overflow = "hidden";
          document.body.style.overflow = "visible";
          document.body.style.height = videoEl.videoHeight / dpr + "px";
          document.body.style.width = videoEl.videoWidth / dpr + "px";
          window.scrollTo(scrollX, scrollY);

          requestAnimationFrame(render);
        }
        render();
      })
      .catch((err) => {
        console.error("getDisplayMedia failed:", err);
        isPlaying = false;
      });
  },
  false,
);
