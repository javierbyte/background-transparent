const videoEl = document.querySelector("video");
const canvasEl = document.querySelector("canvas.draw");

const FIDUCIAL_SIZE = 32; // px, width and height
const FIDUCIAL_LEFT = { r: 255, g: 0, b: 0 }; // cyan
const FIDUCIAL_RIGHT = { r: 255, g: 0, b: 255 }; // magenta
const FIDUCIAL_TOLERANCE = 12; // channel threshold for detection

// Browser chrome (tabs, address bar, shadow, etc.) in CSS pixels.
const CHROME_TOP = 128;
const CHROME_BOTTOM = 64;
const CHROME_RIGHT = 64;
const CHROME_LEFT = 64;

let isPlaying = false;

// Cached marker position from previous frame (video pixels).
let lastMarkerPx = null; // { x, y, which: "left"|"right" }

// ---------------------------------------------------------------------------
// Performance counters
// ---------------------------------------------------------------------------
const perf = {
  lastLog: 0,
  renderCount: 0,
  skipCount: 0,
  videoFrameCount: 0,
  snapshotMs: 0,
  fiducialMs: 0,
  drawMs: 0,
};

function logPerf(now) {
  const dt = now - perf.lastLog;
  if (dt < 1000) return;
  const n = perf.renderCount || 1;
  const processed = perf.renderCount - perf.skipCount;
  const avg = (v) => (v / n).toFixed(1);
  console.log(
    `[perf] fps: render=${perf.renderCount} video=${perf.videoFrameCount} skip=${perf.skipCount} processed=${processed}` +
      ` | snapshot=${avg(perf.snapshotMs)}ms fiducial=${avg(perf.fiducialMs)}ms draw=${avg(perf.drawMs)}ms` +
      ` total=${avg(perf.snapshotMs + perf.fiducialMs + perf.drawMs)}ms`,
  );
  perf.lastLog = now;
  perf.renderCount = 0;
  perf.skipCount = 0;
  perf.videoFrameCount = 0;
  perf.snapshotMs = 0;
  perf.fiducialMs = 0;
  perf.drawMs = 0;
}

// ---------------------------------------------------------------------------
// Fiducial injection & detection — STABLE, do not modify.
// Handles: partial off-screen, single-marker fallback, fast-path caching.
// ---------------------------------------------------------------------------
const fidStyle = `position:fixed;top:0;width:${FIDUCIAL_SIZE}px;height:${FIDUCIAL_SIZE}px;z-index:1000;pointer-events:none;`;
const leftFid = document.createElement("div");
leftFid.style.cssText =
  fidStyle +
  `left:0;background:rgb(${FIDUCIAL_LEFT.r},${FIDUCIAL_LEFT.g},${FIDUCIAL_LEFT.b});`;
document.body.appendChild(leftFid);

const rightFid = document.createElement("div");
rightFid.style.cssText =
  fidStyle +
  `right:0;background:rgb(${FIDUCIAL_RIGHT.r},${FIDUCIAL_RIGHT.g},${FIDUCIAL_RIGHT.b});`;
document.body.appendChild(rightFid);

// ---------------------------------------------------------------------------
// Viewport position detection — STABLE, do not modify.
// ---------------------------------------------------------------------------

// Pixel colour matchers — total absolute RGB distance from the fiducial colour.
function isLeftPixel(data, i) {
  return (
    Math.abs(data[i] - FIDUCIAL_LEFT.r) +
      Math.abs(data[i + 1] - FIDUCIAL_LEFT.g) +
      Math.abs(data[i + 2] - FIDUCIAL_LEFT.b) <
    FIDUCIAL_TOLERANCE
  );
}
function isRightPixel(data, i) {
  return (
    Math.abs(data[i] - FIDUCIAL_RIGHT.r) +
      Math.abs(data[i + 1] - FIDUCIAL_RIGHT.g) +
      Math.abs(data[i + 2] - FIDUCIAL_RIGHT.b) <
    FIDUCIAL_TOLERANCE
  );
}

// Walk left and up from a matching pixel to find the top-left corner of the block.
function walkToCorner(data, vw, x, y, testFn) {
  while (x > 0 && testFn(data, (y * vw + (x - 1)) * 4)) x--;
  while (y > 0 && testFn(data, ((y - 1) * vw + x) * 4)) y--;
  return { x, y };
}

// Given a marker corner in video pixels, return the viewport top-left in CSS pixels.
function viewportFromMarker(cornerX, cornerY, which, dpr) {
  if (which === "left") {
    return { x: cornerX / dpr, y: cornerY / dpr };
  }
  // Right marker: its left edge is at viewport.x + innerWidth - FIDUCIAL_SIZE
  return {
    x: cornerX / dpr - window.innerWidth + FIDUCIAL_SIZE,
    y: cornerY / dpr,
  };
}

// Find viewport top-left (CSS px) by locating any one fiducial marker.
function findViewportFiducial(snapCtx, vw, vh, dpr) {
  const data = snapCtx.getImageData(0, 0, vw, vh).data;
  const sizePx = Math.round(FIDUCIAL_SIZE * dpr);

  // Fast path — re-check last marker position.
  if (lastMarkerPx) {
    const cx = lastMarkerPx.x + Math.round(sizePx / 2);
    const cy = lastMarkerPx.y + Math.round(sizePx / 2);
    if (cx >= 0 && cx < vw && cy >= 0 && cy < vh) {
      const testFn =
        lastMarkerPx.which === "right" ? isRightPixel : isLeftPixel;
      if (testFn(data, (cy * vw + cx) * 4)) {
        const corner = walkToCorner(data, vw, cx, cy, testFn);
        lastMarkerPx = { x: corner.x, y: corner.y, which: lastMarkerPx.which };
        return viewportFromMarker(corner.x, corner.y, lastMarkerPx.which, dpr);
      }
    }
  }

  // Full scan — find the first left or right marker.
  const stride = Math.max(1, Math.floor(sizePx / 2));
  for (let i = 0; i < data.length; i += 4 * stride) {
    let which = null;
    let testFn = null;
    if (isLeftPixel(data, i)) {
      which = "left";
      testFn = isLeftPixel;
    } else if (isRightPixel(data, i)) {
      which = "right";
      testFn = isRightPixel;
    } else continue;

    const px = (i / 4) % vw;
    const py = Math.floor(i / 4 / vw);
    const corner = walkToCorner(data, vw, px, py, testFn);
    lastMarkerPx = { x: corner.x, y: corner.y, which };
    return viewportFromMarker(corner.x, corner.y, which, dpr);
  }

  lastMarkerPx = null;
  return null;
}

function findViewportPosition(snapCtx, vw, vh, dpr) {
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
        video: {
          width: { ideal: screen.width * window.devicePixelRatio },
          height: { ideal: screen.height * window.devicePixelRatio },
          frameRate: { ideal: 60 },
        },
        audio: false,
      })
      .then((stream) => {
        videoEl.srcObject = stream;
        videoEl.play();

        // Track true video source FPS and flag new frames.
        let hasNewVideoFrame = true; // process the first frame immediately
        if ("requestVideoFrameCallback" in HTMLVideoElement.prototype) {
          hasNewVideoFrame = false;
          function onVideoFrame() {
            perf.videoFrameCount++;
            hasNewVideoFrame = true;
            videoEl.requestVideoFrameCallback(onVideoFrame);
          }
          videoEl.requestVideoFrameCallback(onVideoFrame);
        }

        const ctx = canvasEl.getContext("2d");
        ctx.imageSmoothingEnabled = false;

        // Offscreen canvas to snapshot each video frame, so detection and
        // painting always use the exact same frame. Without this, a live
        // MediaStream can advance between the two drawImage calls.
        const snapCanvas = document.createElement("canvas");
        const snapCtx = snapCanvas.getContext("2d");
        snapCtx.imageSmoothingEnabled = false;

        // Shared viewport position written by the capture loop,
        // read by the display loop.
        let latestViewport = null;

        // --- Loop 1: Capture — snapshot, fiducial, draw with hole ---
        function captureLoop() {
          // Wait until the video has actual frame data.
          if (videoEl.videoWidth === 0 || videoEl.readyState < 2) {
            requestAnimationFrame(captureLoop);
            return;
          }

          // Skip if the video source hasn't delivered a new frame.
          if (!hasNewVideoFrame) {
            requestAnimationFrame(captureLoop);
            return;
          }
          hasNewVideoFrame = false;

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
          const t0 = performance.now();
          snapCtx.drawImage(videoEl, 0, 0);
          const t1 = performance.now();

          // --- Find browser viewport position on screen ---
          const vw = videoEl.videoWidth;
          const vh = videoEl.videoHeight;
          let viewport = null;
          try {
            viewport = findViewportPosition(snapCtx, vw, vh, dpr);
          } catch (e) {
            console.error(e);
          }
          const t2 = performance.now();

          perf.renderCount++;
          perf.snapshotMs += t1 - t0;
          perf.fiducialMs += t2 - t1;

          if (!viewport) {
            perf.skipCount++;
            logPerf(t2);
            requestAnimationFrame(captureLoop);
            return;
          }

          // --- Draw the capture, cutting out the browser window --- STABLE
          const rawHoleX = (viewport.x - CHROME_LEFT) * dpr;
          const rawHoleY = (viewport.y - CHROME_TOP) * dpr;
          const rawHoleW =
            (CHROME_LEFT + window.innerWidth + CHROME_RIGHT) * dpr;
          const rawHoleH =
            (CHROME_TOP + window.innerHeight + CHROME_BOTTOM) * dpr;
          const holeX = Math.max(0, rawHoleX);
          const holeY = Math.max(0, rawHoleY);
          const holeR = Math.min(canvasEl.width, rawHoleX + rawHoleW);
          const holeB = Math.min(canvasEl.height, rawHoleY + rawHoleH);
          const holeW = Math.max(0, holeR - holeX);
          const holeH = Math.max(0, holeB - holeY);

          const t3 = performance.now();
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, 0, canvasEl.width, holeY);
          ctx.rect(0, holeY, holeX, holeH);
          ctx.rect(holeX + holeW, holeY, canvasEl.width - holeX - holeW, holeH);
          ctx.rect(0, holeY + holeH, canvasEl.width, canvasEl.height - holeY - holeH);
          ctx.clip();
          ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
          ctx.drawImage(snapCanvas, 0, 0);
          ctx.restore();
          const t4 = performance.now();

          perf.drawMs += t4 - t3;

          // Store viewport for the display loop.
          latestViewport = viewport;

          logPerf(t4);
          requestAnimationFrame(captureLoop);
        }

        // --- Loop 2: Display — translate viewport at rAF speed ---
        function displayLoop() {
          if (latestViewport) {
            const dpr =
              videoEl.videoWidth / screen.width || window.devicePixelRatio;
            const padX = screen.width;
            const padY = screen.height;
            canvasEl.style.marginLeft = padX + "px";
            canvasEl.style.marginTop = padY + "px";
            document.body.style.width = videoEl.videoWidth / dpr + padX * 2 + "px";
            document.body.style.height = videoEl.videoHeight / dpr + padY * 2 + "px";
            window.scrollTo(
              Math.round(latestViewport.x) + padX,
              Math.round(latestViewport.y) + padY,
            );
          }
          requestAnimationFrame(displayLoop);
        }

        captureLoop();
        displayLoop();
      })
      .catch((err) => {
        console.error("getDisplayMedia failed:", err);
        isPlaying = false;
      });
  },
  false,
);
