const videoEl = document.querySelector("video");
const canvasEl = document.querySelector("canvas.draw");

// Mode toggle: true = fiducial for initial calibration then screenX/Y, false = fiducial every frame
const USE_SCREEN_POSITION = false;

const FIDUCIAL_WIDTH = 120; // px
const FIDUCIAL_HEIGHT = 40; // px
const FIDUCIAL_CANDIDATES = [
  { name: "cyan", r: 3, g: 169, b: 244 },
  { name: "orange", r: 255, g: 152, b: 0 },
  { name: "green", r: 76, g: 175, b: 80 },
  { name: "magenta", r: 255, g: 0, b: 255 },
];
let FIDUCIAL_LEFT = { r: 3, g: 169, b: 244 }; // chosen after first frame
let FIDUCIAL_RIGHT = { r: 255, g: 0, b: 255 }; // chosen after first frame
let fiducialsChosen = false;
const FIDUCIAL_TOLERANCE = 32; // channel threshold — relaxed to handle compression artifacts at edges

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
const FIDUCIAL_BORDER = 1; // px, black border — prevents browser inner-shadow artifacts
const fidStyle = `position:fixed;top:0;width:${FIDUCIAL_WIDTH}px;height:${FIDUCIAL_HEIGHT}px;z-index:1000;border:${FIDUCIAL_BORDER}px solid #000000;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;font-family:system-ui,sans-serif;color:rgba(0,0,0,0.5);text-transform:uppercase;letter-spacing:0.5px;cursor:pointer;`;
const leftFid = document.createElement("div");
leftFid.style.cssText = fidStyle + `left:0;background:black;color:white;`;
leftFid.textContent = "LEARN MORE";
document.body.appendChild(leftFid);

const rightFid = document.createElement("div");
rightFid.style.cssText =
  fidStyle + `right:0;background:black;color:white;display:none;`;
rightFid.textContent = "NEXT EFFECT";
document.body.appendChild(rightFid);

// ---------------------------------------------------------------------------
// Viewport position detection — STABLE, do not modify.
// ---------------------------------------------------------------------------

// Pixel colour matchers — total absolute RGB distance from the fiducial
// background colour.  Text pixels (50 % black over the background) are
// intentionally NOT matched so the detector only sees the contiguous
// background border that surrounds the text on all four sides.
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

// Find the fiducial center by scanning a bounded region around a hit pixel
// for the outermost matching (background-colour) pixels.  The background
// forms a contiguous border on all four sides of the text, so the bounding
// box extremes give the true fiducial edges and the midpoint is rock-solid.
function fiducialCenter(data, vw, vh, hitX, hitY, testFn, searchW, searchH) {
  const l = Math.max(0, hitX - searchW);
  const r = Math.min(vw - 1, hitX + searchW);
  const t = Math.max(0, hitY - searchH);
  const b = Math.min(vh - 1, hitY + searchH);

  let minX = vw,
    maxX = 0,
    minY = vh,
    maxY = 0;
  for (let y = t; y <= b; y++) {
    const row = y * vw;
    for (let x = l; x <= r; x++) {
      if (testFn(data, (row + x) * 4)) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (minX > maxX) return { x: hitX, y: hitY };
  return {
    x: Math.round((minX + maxX) / 2),
    y: Math.round((minY + maxY) / 2),
  };
}

// Given the fiducial center in video pixels, return the viewport top-left in CSS pixels.
function viewportFromMarker(centerX, centerY, which, dpr) {
  const halfW = FIDUCIAL_WIDTH / 2;
  const halfH = FIDUCIAL_HEIGHT / 2;
  if (which === "left") {
    return {
      x: centerX / dpr - FIDUCIAL_BORDER - halfW,
      y: centerY / dpr - FIDUCIAL_BORDER - halfH,
    };
  }
  // Right marker: colored center is at viewport.x + innerWidth - FIDUCIAL_BORDER - halfW
  return {
    x: centerX / dpr - window.innerWidth + FIDUCIAL_BORDER + halfW,
    y: centerY / dpr - FIDUCIAL_BORDER - halfH,
  };
}

// Read a small region around a point and detect within it.
// Returns { center, which } or null.
function detectInRegion(
  snapCtx,
  vw,
  vh,
  cx,
  cy,
  searchW,
  searchH,
  testFn,
  which,
) {
  const margin = Math.max(searchW, searchH) + 4;
  const rx = Math.max(0, cx - margin);
  const ry = Math.max(0, cy - margin);
  const rw = Math.min(vw - rx, margin * 2 + 1);
  const rh = Math.min(vh - ry, margin * 2 + 1);
  const data = snapCtx.getImageData(rx, ry, rw, rh).data;
  const lx = cx - rx;
  const ly = cy - ry;
  if (lx < 0 || lx >= rw || ly < 0 || ly >= rh) return null;
  if (!testFn(data, (ly * rw + lx) * 4)) return null;
  const center = fiducialCenter(data, rw, rh, lx, ly, testFn, searchW, searchH);
  return {
    center: { x: center.x + rx, y: center.y + ry },
    which,
  };
}

// Find viewport top-left (CSS px) by locating any one fiducial marker.
function findViewportFiducial(snapCtx, vw, vh, dpr) {
  const widthPx = Math.round(FIDUCIAL_WIDTH * dpr);
  const heightPx = Math.round(FIDUCIAL_HEIGHT * dpr);

  // Fast path — read only a small region around the last known centre.
  if (lastMarkerPx) {
    const cx = lastMarkerPx.x;
    const cy = lastMarkerPx.y;
    if (cx >= 0 && cx < vw && cy >= 0 && cy < vh) {
      const testFn =
        lastMarkerPx.which === "right" ? isRightPixel : isLeftPixel;
      const hit = detectInRegion(
        snapCtx,
        vw,
        vh,
        cx,
        cy,
        widthPx,
        heightPx,
        testFn,
        lastMarkerPx.which,
      );
      if (hit) {
        lastMarkerPx = { x: hit.center.x, y: hit.center.y, which: hit.which };
        return viewportFromMarker(hit.center.x, hit.center.y, hit.which, dpr);
      }
    }
  }

  // Full scan fallback — read entire frame.
  const data = snapCtx.getImageData(0, 0, vw, vh).data;
  const stride = Math.max(1, Math.floor(heightPx / 2));
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
    const center = fiducialCenter(
      data,
      vw,
      vh,
      px,
      py,
      testFn,
      widthPx,
      heightPx,
    );
    lastMarkerPx = { x: center.x, y: center.y, which };
    return viewportFromMarker(center.x, center.y, which, dpr);
  }

  lastMarkerPx = null;
  return null;
}

// Scan a frame and pick the 2 candidate colors least present on screen.
function chooseFiducialColors(snapCtx, vw, vh) {
  const data = snapCtx.getImageData(0, 0, vw, vh).data;
  const stride = Math.max(1, Math.floor((vw * vh) / 10000)); // ~10k samples
  const scores = FIDUCIAL_CANDIDATES.map((c) => {
    let count = 0;
    for (let i = 0; i < data.length; i += 4 * stride) {
      if (
        Math.abs(data[i] - c.r) +
          Math.abs(data[i + 1] - c.g) +
          Math.abs(data[i + 2] - c.b) <
        FIDUCIAL_TOLERANCE
      ) {
        count++;
      }
    }
    return { candidate: c, count };
  });
  scores.sort((a, b) => a.count - b.count);
  return [scores[0].candidate, scores[1].candidate];
}

function applyFiducialColors(left, right) {
  FIDUCIAL_LEFT = left;
  FIDUCIAL_RIGHT = right;
  leftFid.style.background = `rgb(${left.r},${left.g},${left.b})`;
  leftFid.style.color = "rgba(0,0,0,0.5)";
  rightFid.style.display = "flex";
  rightFid.style.background = `rgb(${right.r},${right.g},${right.b})`;
  rightFid.style.color = "rgba(0,0,0,0.5)";
  fiducialsChosen = true;
}

function findViewportPosition(snapCtx, vw, vh, dpr) {
  return findViewportFiducial(snapCtx, vw, vh, dpr);
}

const shareBtn = document.getElementById("share-btn");
const crtOverlay = document.getElementById("crt-overlay");
const gbOverlay = document.getElementById("gb-overlay");
const glassOverlay = document.getElementById("glass-overlay");

let activeFilter = "none"; // "none" | "crt" | "gameboy" | "glass"
let crtInited = false;
let gbInited = false;
let glassInited = false;
let diamondFrameCount = 0;
let diamondBaseX = null;
let diamondBaseY = null;

const FILTER_CYCLE = ["none", "crt", "gameboy", "glass"];
const FILTER_LABELS = {
  none: "CRT",
  crt: "Gameboy",
  gameboy: "Glass",
  glass: "No FX",
};

// Right fiducial doubles as the "Next Effect" button.
rightFid.addEventListener("click", function () {
  const idx = FILTER_CYCLE.indexOf(activeFilter);
  activeFilter = FILTER_CYCLE[(idx + 1) % FILTER_CYCLE.length];

  if (activeFilter === "crt" && !crtInited) {
    crtInited = initCRTFilter(crtOverlay);
  }
  if (activeFilter === "gameboy" && !gbInited) {
    gbInited = initGameboyFilter(gbOverlay);
  }
  if (activeFilter === "glass" && !glassInited) {
    glassInited = initGlassFilter(glassOverlay);
  }

  crtOverlay.classList.toggle("active", activeFilter === "crt");
  gbOverlay.classList.toggle("active", activeFilter === "gameboy");
  glassOverlay.classList.toggle("active", activeFilter === "glass");

  if (activeFilter === "glass") {
    showGlassFilter();
    diamondFrameCount = 0;
    diamondBaseX = null;
    diamondBaseY = null;
  } else {
    hideGlassFilter();
  }
});

shareBtn.addEventListener(
  "click",
  function () {
    if (isPlaying) return;
    isPlaying = true;
    document.getElementById("intro").style.display = "none";

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

          // On first frame, pick the two least-problematic fiducial colors.
          if (!fiducialsChosen) {
            const [best1, best2] = chooseFiducialColors(
              snapCtx,
              videoEl.videoWidth,
              videoEl.videoHeight,
            );
            applyFiducialColors(best1, best2);
            // Re-snapshot after colors are applied so detection sees the new fiducials.
            requestAnimationFrame(captureLoop);
            return;
          }

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
              if (Math.abs(dx) + Math.abs(dy) < 4) {
                displayX = targetX;
                displayY = targetY;
              } else {
                const displayWeight = 0.333; // more inertia = smoother but more lag
                displayX =
                  displayX * displayWeight + targetX * (1 - displayWeight);
                displayY =
                  displayY * displayWeight + targetY * (1 - displayWeight);
              }
            }

            // Motion blur based on speed.
            const speed =
              prevDisplayX !== null
                ? Math.hypot(displayX - prevDisplayX, displayY - prevDisplayY)
                : 0;

            prevDisplayX = displayX;
            prevDisplayY = displayY;

            // if (speed > 0.1) {
            //   canvasEl.style.filter = `blur(${speed * 2}px)`;
            // } else {
            //   canvasEl.style.filter = "";
            // }

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

            // Render shader overlay when active
            if (activeFilter === "crt" && crtInited) {
              renderCRTFrame(canvasEl, displayX, displayY, dpr);
            } else if (activeFilter === "gameboy" && gbInited) {
              renderGameboyFrame(canvasEl, displayX, displayY, dpr);
            } else if (activeFilter === "glass" && glassInited) {
              if (diamondBaseX === null) {
                diamondBaseX = displayX;
                diamondBaseY = displayY;
              }
              if (diamondFrameCount++ % 2 === 0) {
                updateDiamondRotation(
                  displayX - diamondBaseX,
                  displayY - diamondBaseY,
                );
              }
            }
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
