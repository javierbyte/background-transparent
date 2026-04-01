const videoEl = document.querySelector("video");
const canvasEl = document.querySelector("canvas.draw");

// --- Viewport detection method ---
// "fiducial" — scan screen capture for colour markers (accurate, ~1 frame lag)
// "screenXY"  — use window.screenX / screenY browser APIs (instant, ~15 Hz update)
// const VIEWPORT_METHOD = "screenXY";
const VIEWPORT_METHOD = "fiducial";

const FIDUCIAL_HEIGHT = 8;
const FIDUCIAL_WIDTH_PCT = 0.5; // fraction of viewport width

// Browser chrome (tabs, address bar, shadow, etc.) in CSS pixels.
const CHROME_TOP = 96;
const CHROME_BOTTOM = 40;
const CHROME_RIGHT = 16;
const CHROME_LEFT = 16;

let isPlaying = false;
let displayX = 0;
let displayY = 0;

// ---------------------------------------------------------------------------
// Fiducial injection (only when using fiducial method)
// ---------------------------------------------------------------------------
if (VIEWPORT_METHOD === "fiducial") {
  const leftFid = document.createElement("div");
  leftFid.className = "fiducial fiducial-left";
  document.body.appendChild(leftFid);

  const rightFid = document.createElement("div");
  rightFid.className = "fiducial fiducial-right";
  document.body.appendChild(rightFid);
}

// ---------------------------------------------------------------------------
// Viewport position strategies
// ---------------------------------------------------------------------------

// Scan the screen-capture frame for a yellow/magenta fiducial marker and
// return the viewport top-left in CSS pixels, or null if not found.
function findViewportFiducial(snapCtx, vw, vh, dpr) {
  const imageData = snapCtx.getImageData(0, 0, vw, vh);
  const data = imageData.data;
  // The strips are 50% of screen width, so a stride of ~25% guarantees a hit.
  const stride = Math.max(1, Math.floor(vw * 0.25));
  const fiducialWidthCSS = window.innerWidth * FIDUCIAL_WIDTH_PCT;

  for (let i = 0; i < data.length; i += 4 * stride) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    // Relaxed thresholds for Safari color management
    const isYellow = r > 180 && g > 180 && b < 80;
    const isMagenta = r > 180 && g < 80 && b > 180;
    if (!isYellow && !isMagenta) continue;

    const hitX = (i / 4) % vw;
    const hitY = Math.floor(i / 4 / vw);
    const corner = refineFiducial(data, vw, vh, hitX, hitY, r, g, b);
    if (!corner) continue;

    const y = corner[1] / dpr;
    const x = isYellow
      ? corner[0] / dpr
      : corner[0] / dpr - window.innerWidth + fiducialWidthCSS;
    return { x, y };
  }
  return null;
}

// Use the browser's window-position APIs to derive the viewport top-left
// in CSS pixels.  Instant but updates at a lower frequency (~15 Hz).
// NOTE: only accurate when the browser is on the captured display.
function findViewportScreenXY() {
  const chromeHeight = window.outerHeight - window.innerHeight;
  return {
    x: window.screenX,
    y: window.screenY + chromeHeight,
  };
}

// Dispatcher — calls the strategy selected by VIEWPORT_METHOD.
function findViewportPosition(snapCtx, vw, vh, dpr) {
  if (VIEWPORT_METHOD === "screenXY") {
    return findViewportScreenXY();
  }
  return findViewportFiducial(snapCtx, vw, vh, dpr);
}

// Check if the pixel at (x, y) in the image data matches the given color.
function pixelMatches(data, width, x, y, targetR, targetG, targetB) {
  const i = (y * width + x) * 4;
  const allowedError = 30;
  return (
    Math.abs(data[i] - targetR) < allowedError &&
    Math.abs(data[i + 1] - targetG) < allowedError &&
    Math.abs(data[i + 2] - targetB) < allowedError
  );
}

// Given a candidate pixel inside a fiducial, find the exact top-left corner
// by walking left and up to the edge, then verify the expected size.
// Returns [x, y] in full video-pixel coords, or null if validation fails.
function refineFiducial(data, width, height, hitX, hitY, r, g, b) {
  let left = hitX;
  while (left > 0 && pixelMatches(data, width, left - 1, hitY, r, g, b)) {
    left--;
  }
  let top = hitY;
  while (top > 0 && pixelMatches(data, width, left, top - 1, r, g, b)) {
    top--;
  }

  // Measure the width and height from the top-left corner.
  const minW = Math.floor(width * FIDUCIAL_WIDTH_PCT * 0.5); // at least half expected width
  const minH = 1;
  let w = 0;
  while (
    left + w < width &&
    pixelMatches(data, width, left + w, top, r, g, b)
  ) {
    w++;
  }
  let h = 0;
  while (
    top + h < height &&
    pixelMatches(data, width, left, top + h, r, g, b)
  ) {
    h++;
  }

  if (w < minW || h < minH) return null;

  return [left, top];
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
