const videoEl = document.querySelector("video");
const canvasEl = document.querySelector("canvas.draw");

const FIDUCIAL_SIZE = 32; // px, width and height
const FIDUCIAL_LEFT = { r: 255, g: 0, b: 0 }; // cyan
const FIDUCIAL_RIGHT = { r: 255, g: 0, b: 255 }; // magenta
const FIDUCIAL_TOLERANCE = 4; // channel threshold for detection

// Browser chrome (tabs, address bar, shadow, etc.) in CSS pixels.
const CHROME_TOP = 128;
const CHROME_BOTTOM = 64;
const CHROME_RIGHT = 64;
const CHROME_LEFT = 64;

let isPlaying = false;
let displayX = 0;
let displayY = 0;

// Cached marker position from previous frame (video pixels).
let lastMarkerPx = null; // { x, y, which: "left"|"right" }

// ---------------------------------------------------------------------------
// Fiducial injection
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
// Viewport position detection
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
        const ctx = canvasEl.getContext("2d");
        ctx.imageSmoothingEnabled = false;

        // Offscreen canvas to snapshot each video frame, so detection and
        // painting always use the exact same frame. Without this, a live
        // MediaStream can advance between the two drawImage calls.
        const snapCanvas = document.createElement("canvas");
        const snapCtx = snapCanvas.getContext("2d");
        snapCtx.imageSmoothingEnabled = false;

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

          displayX = Math.round(displayX + (viewport.x - displayX) * 0.5);
          displayY = Math.round(displayY + (viewport.y - displayY) * 0.5);

          // --- Step 3: Draw the capture, cutting out only the viewport ---
          // Draw the full captured screen, then clear just the content area.
          // The browser chrome area keeps the captured image so Safari's
          // translucent toolbar can blur over it instead of showing black.
          ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
          ctx.drawImage(snapCanvas, 0, 0);

          const vpX = Math.max(0, Math.round(viewport.x * dpr));
          const vpY = Math.max(0, Math.round(viewport.y * dpr));
          const vpW = Math.round(window.innerWidth * dpr);
          const vpH = Math.round(window.innerHeight * dpr);
          ctx.clearRect(vpX, vpY, vpW, vpH);

          // Make the body large enough to hold the full capture so content
          // extends behind Safari's translucent chrome (scrollable area).
          document.body.style.width = videoEl.videoWidth / dpr + "px";
          document.body.style.height = videoEl.videoHeight / dpr + "px";

          // Scroll to the viewport position instead of using CSS transforms.
          // This ensures content physically exists behind Safari's toolbar.
          window.scrollTo(displayX, displayY);

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
