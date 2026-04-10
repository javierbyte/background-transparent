const videoEl = document.querySelector("video");
const canvasEl = document.querySelector("canvas.draw");

// Mode toggle: true = fiducial for initial calibration then screenX/Y, false = fiducial every frame
const USE_SCREEN_POSITION = false;

const FIDUCIAL_SIZE = 16; // px, width and height
const FIDUCIAL_LEFT = { r: 3, g: 169, b: 244 }; // cyan
const FIDUCIAL_RIGHT = { r: 255, g: 0, b: 255 }; // magenta
const FIDUCIAL_TOLERANCE = 12; // channel threshold — relaxed to handle compression artifacts at edges

// Browser chrome (tabs, address bar, shadow, etc.) in CSS pixels.
const CHROME_TOP = 128;
const CHROME_BOTTOM = 64;
const CHROME_RIGHT = 64;
const CHROME_LEFT = 64;

let isPlaying = false;

// Cached marker position from previous frame (video pixels).
let lastMarkerPx = null; // { x, y, which: "left"|"right" }

// Calibration state for USE_SCREEN_POSITION mode.
let calibrated = false;
let baseViewportX = 0;
let baseViewportY = 0;
let baseScreenX = 0;
let baseScreenY = 0;

// ---------------------------------------------------------------------------
// Fiducial injection & detection — STABLE, do not modify.
// Handles: partial off-screen, single-marker fallback, fast-path caching.
// ---------------------------------------------------------------------------
const FIDUCIAL_BORDER = 1; // px, solid black border around each fiducial
const fidStyle = `position:fixed;top:0;width:${FIDUCIAL_SIZE}px;height:${FIDUCIAL_SIZE}px;z-index:1000;pointer-events:none;border:${FIDUCIAL_BORDER}px solid black;`;
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

// From a corner, find the fiducial center via weighted centroid of all matching pixels.
// Much more stable than edge-walking: interior pixels dominate, so ±1px edge noise averages out.
function fiducialCenter(data, vw, vh, cx, cy, testFn) {
  // First, find the bounding box by walking edges (cheap).
  let rx = cx;
  while (rx < vw - 1 && testFn(data, (cy * vw + (rx + 1)) * 4)) rx++;
  let by = cy;
  while (by < vh - 1 && testFn(data, ((by + 1) * vw + cx) * 4)) by++;

  // Compute centroid of all matching pixels in the bounding box.
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  for (let y = cy; y <= by; y++) {
    for (let x = cx; x <= rx; x++) {
      if (testFn(data, (y * vw + x) * 4)) {
        sumX += x;
        sumY += y;
        count++;
      }
    }
  }

  if (count === 0) return { x: (cx + rx) / 2, y: (cy + by) / 2 };
  return { x: Math.round(sumX / count), y: Math.round(sumY / count) };
}

// Given the fiducial center in video pixels, return the viewport top-left in CSS pixels.
function viewportFromMarker(centerX, centerY, which, dpr) {
  const halfCSS = FIDUCIAL_SIZE / 2;
  if (which === "left") {
    return {
      x: centerX / dpr - FIDUCIAL_BORDER - halfCSS,
      y: centerY / dpr - FIDUCIAL_BORDER - halfCSS,
    };
  }
  // Right marker: colored center is at viewport.x + innerWidth - FIDUCIAL_BORDER - halfCSS
  return {
    x: centerX / dpr - window.innerWidth + FIDUCIAL_BORDER + halfCSS,
    y: centerY / dpr - FIDUCIAL_BORDER - halfCSS,
  };
}

// Read a small region around a point and detect within it.
// Returns { corner, center, which } or null.
function detectInRegion(snapCtx, vw, vh, cx, cy, sizePx, testFn, which) {
  const margin = sizePx + 4; // enough room for walkToCorner + fiducialCenter
  const rx = Math.max(0, cx - margin);
  const ry = Math.max(0, cy - margin);
  const rw = Math.min(vw - rx, margin * 2 + sizePx);
  const rh = Math.min(vh - ry, margin * 2 + sizePx);
  const data = snapCtx.getImageData(rx, ry, rw, rh).data;
  const lx = cx - rx;
  const ly = cy - ry;
  if (lx < 0 || lx >= rw || ly < 0 || ly >= rh) return null;
  if (!testFn(data, (ly * rw + lx) * 4)) return null;
  const corner = walkToCorner(data, rw, lx, ly, testFn);
  const center = fiducialCenter(data, rw, rh, corner.x, corner.y, testFn);
  return {
    corner: { x: corner.x + rx, y: corner.y + ry },
    center: { x: center.x + rx, y: center.y + ry },
    which,
  };
}

// Find viewport top-left (CSS px) by locating any one fiducial marker.
function findViewportFiducial(snapCtx, vw, vh, dpr) {
  const sizePx = Math.round(FIDUCIAL_SIZE * dpr);

  // Fast path — read only a small region around the last known marker.
  if (lastMarkerPx) {
    const cx = lastMarkerPx.x + Math.round(sizePx / 2);
    const cy = lastMarkerPx.y + Math.round(sizePx / 2);
    if (cx >= 0 && cx < vw && cy >= 0 && cy < vh) {
      const testFn =
        lastMarkerPx.which === "right" ? isRightPixel : isLeftPixel;
      const hit = detectInRegion(
        snapCtx,
        vw,
        vh,
        cx,
        cy,
        sizePx,
        testFn,
        lastMarkerPx.which,
      );
      if (hit) {
        lastMarkerPx = { x: hit.corner.x, y: hit.corner.y, which: hit.which };
        return viewportFromMarker(hit.center.x, hit.center.y, hit.which, dpr);
      }
    }
  }

  // Full scan fallback — read entire frame.
  const data = snapCtx.getImageData(0, 0, vw, vh).data;
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
    const center = fiducialCenter(data, vw, vh, corner.x, corner.y, testFn);
    lastMarkerPx = { x: corner.x, y: corner.y, which };
    return viewportFromMarker(center.x, center.y, which, dpr);
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

        // Track new video frames to avoid redundant processing.
        let hasNewVideoFrame = true; // process the first frame immediately
        if ("requestVideoFrameCallback" in HTMLVideoElement.prototype) {
          hasNewVideoFrame = false;
          function onVideoFrame() {
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
          snapCtx.drawImage(videoEl, 0, 0);

          // --- Find browser viewport position on screen ---
          const vw = videoEl.videoWidth;
          const vh = videoEl.videoHeight;

          // Always use fiducial for buffer cutting.
          let viewport = null;
          try {
            viewport = findViewportPosition(snapCtx, vw, vh, dpr);
          } catch (e) {
            console.error(e);
          }

          if (!viewport) {
            requestAnimationFrame(captureLoop);
            return;
          }

          latestViewport = viewport;

          // Calibrate screen position baseline on first fiducial hit.
          if (USE_SCREEN_POSITION && !calibrated) {
            baseViewportX = viewport.x;
            baseViewportY = viewport.y;
            baseScreenX = window.screenX;
            baseScreenY = window.screenY;
            calibrated = true;
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

          requestAnimationFrame(captureLoop);
        }

        // --- Loop 2: Display — translate viewport at rAF speed ---
        let displayX = null;
        let displayY = null;
        let prevDisplayX = null;
        let prevDisplayY = null;

        function displayLoop() {
          if (latestViewport) {
            // In screen position mode, compute from screenX/Y at full rAF rate.
            const targetX =
              USE_SCREEN_POSITION && calibrated
                ? baseViewportX + (window.screenX - baseScreenX)
                : latestViewport.x;
            const targetY =
              USE_SCREEN_POSITION && calibrated
                ? baseViewportY + (window.screenY - baseScreenY)
                : latestViewport.y;

            if (displayX === null) {
              displayX = targetX;
              displayY = targetY;
            } else {
              const dx = targetX - displayX;
              const dy = targetY - displayY;
              if (Math.abs(dx) + Math.abs(dy) < 2) {
                displayX = targetX;
                displayY = targetY;
              } else {
                const displayWeight = 0.5; // more inertia = smoother but more lag
                displayX =
                  displayX * displayWeight + targetX * (1 - displayWeight);
                displayY =
                  displayY * displayWeight + targetY * (1 - displayWeight);
              }
            }

            // Motion blur based on speed.
            const speed =
              prevDisplayX !== null
                ? Math.abs(displayX - prevDisplayX) +
                  Math.abs(displayY - prevDisplayY)
                : 0;
            prevDisplayX = displayX;
            prevDisplayY = displayY;

            if (speed > 0.5) {
              canvasEl.style.filter = `blur(${speed * 1}px)`;
            } else {
              canvasEl.style.filter = "";
            }

            const dpr =
              videoEl.videoWidth / screen.width || window.devicePixelRatio;
            const padX = screen.width;
            const padY = screen.height;
            canvasEl.style.marginLeft = padX + "px";
            canvasEl.style.marginTop = padY + "px";
            document.body.style.width =
              videoEl.videoWidth / dpr + padX * 2 + "px";
            document.body.style.height =
              videoEl.videoHeight / dpr + padY * 2 + "px";
            window.scrollTo(
              Math.round(displayX) + padX,
              Math.round(displayY) + padY,
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
