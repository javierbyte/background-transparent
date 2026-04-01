const videoEl = document.querySelector("video");
const canvasEl = document.querySelector("canvas.draw");

// --- Viewport detection method ---
// "fiducial" — scan screen capture for colour markers (accurate, ~1 frame lag)
// "screenXY"  — use window.screenX / screenY browser APIs (instant, ~15 Hz update)
// const VIEWPORT_METHOD = "screenXY";
const VIEWPORT_METHOD = "fiducial";

const FIDUCIAL_SIZE = 64; // px, width and height
const FIDUCIAL_LEFT = { r: 0, g: 255, b: 255 }; // cyan
const FIDUCIAL_RIGHT = { r: 255, g: 0, b: 255 }; // magenta
const FIDUCIAL_TOLERANCE = 50; // channel threshold for detection

// Browser chrome (tabs, address bar, shadow, etc.) in CSS pixels.
const CHROME_TOP = 128;
const CHROME_BOTTOM = 64;
const CHROME_RIGHT = 64;
const CHROME_LEFT = 64;

let isPlaying = false;
let displayX = 0;
let displayY = 0;

// Cached viewport position from previous frame (pixel coords).
let lastViewportPx = null; // { x, y, marker: "left"|"right" } in video pixels

// ---------------------------------------------------------------------------
// Fiducial injection (only when using fiducial method)
// ---------------------------------------------------------------------------
if (VIEWPORT_METHOD === "fiducial") {
  const fidStyle =
    `position:fixed;top:0;width:${FIDUCIAL_SIZE}px;height:${FIDUCIAL_SIZE}px;z-index:1000;pointer-events:none;`;
  const leftFid = document.createElement("div");
  leftFid.style.cssText = fidStyle + `left:0;background:rgb(${FIDUCIAL_LEFT.r},${FIDUCIAL_LEFT.g},${FIDUCIAL_LEFT.b});`;
  document.body.appendChild(leftFid);

  const rightFid = document.createElement("div");
  rightFid.style.cssText = fidStyle + `right:0;background:rgb(${FIDUCIAL_RIGHT.r},${FIDUCIAL_RIGHT.g},${FIDUCIAL_RIGHT.b});`;
  document.body.appendChild(rightFid);
}

// ---------------------------------------------------------------------------
// Viewport position strategies
// ---------------------------------------------------------------------------

// Detect whether a pixel matches a fiducial color, tolerant of color profiles.
// Channels near 255 must be > (255 - tolerance), channels near 0 must be < tolerance.
function isLeftPixel(data, i) {
  const t = FIDUCIAL_TOLERANCE;
  return (
    (FIDUCIAL_LEFT.r > 127 ? data[i] > 255 - t : data[i] < t) &&
    (FIDUCIAL_LEFT.g > 127 ? data[i + 1] > 255 - t : data[i + 1] < t) &&
    (FIDUCIAL_LEFT.b > 127 ? data[i + 2] > 255 - t : data[i + 2] < t)
  );
}
function isRightPixel(data, i) {
  const t = FIDUCIAL_TOLERANCE;
  return (
    (FIDUCIAL_RIGHT.r > 127 ? data[i] > 255 - t : data[i] < t) &&
    (FIDUCIAL_RIGHT.g > 127 ? data[i + 1] > 255 - t : data[i + 1] < t) &&
    (FIDUCIAL_RIGHT.b > 127 ? data[i + 2] > 255 - t : data[i + 2] < t)
  );
}

// Given a pixel at (x, y) that matches testFn, walk left and up to find
// the exact top-left corner of the colored block.
function walkToCorner(data, vw, vh, x, y, testFn) {
  while (x > 0 && testFn(data, (y * vw + (x - 1)) * 4)) x--;
  while (y > 0 && testFn(data, ((y - 1) * vw + x) * 4)) y--;
  return { x, y };
}

// Derive viewport top-left (video px) from the left marker corner.
function viewportFromLeft(corner) {
  return { x: corner.x, y: corner.y };
}
// Derive viewport top-left (video px) from the right marker corner.
function viewportFromRight(corner, dpr) {
  return {
    x:
      corner.x -
      Math.round(window.innerWidth * dpr) +
      Math.round(FIDUCIAL_SIZE * dpr),
    y: corner.y,
  };
}

// Try to cross-validate a detected marker with its counterpart.
// Returns true if the other marker is found at the expected position.
function crossCheck(data, vw, vh, viewportX, viewportY, dpr) {
  const sizePx = Math.round(FIDUCIAL_SIZE * dpr);
  // Check right marker from left's perspective
  const gx =
    viewportX + Math.round(window.innerWidth * dpr) - Math.round(sizePx / 2);
  const gy = viewportY + Math.round(sizePx / 2);
  if (
    gx >= 0 &&
    gx < vw &&
    gy >= 0 &&
    gy < vh &&
    isRightPixel(data, (gy * vw + gx) * 4)
  )
    return true;
  // Check left marker from right's perspective
  const yx = viewportX + Math.round(sizePx / 2);
  const yy = viewportY + Math.round(sizePx / 2);
  if (
    yx >= 0 &&
    yx < vw &&
    yy >= 0 &&
    yy < vh &&
    isLeftPixel(data, (yy * vw + yx) * 4)
  )
    return true;
  return false;
}

// Scan the full frame for fiducial markers. Only one marker (left or right)
// is needed to determine the viewport position, since we know window.innerWidth.
function findViewportFiducial(snapCtx, vw, vh, dpr) {
  const imageData = snapCtx.getImageData(0, 0, vw, vh);
  const data = imageData.data;
  const sizePx = Math.round(FIDUCIAL_SIZE * dpr);

  // Fast path: check cached position first, but require cross-validation
  // to avoid locking onto ghost markers in the recursive canvas content.
  if (lastViewportPx) {
    const cx = lastViewportPx.x + Math.round(sizePx / 2);
    const cy = lastViewportPx.y + Math.round(sizePx / 2);
    const testFn =
      lastViewportPx.marker === "right" ? isRightPixel : isLeftPixel;
    if (cx >= 0 && cx < vw && cy >= 0 && cy < vh) {
      const ci = (cy * vw + cx) * 4;
      if (testFn(data, ci)) {
        const corner = walkToCorner(data, vw, vh, cx, cy, testFn);
        const vp =
          lastViewportPx.marker === "right"
            ? viewportFromRight(corner, dpr)
            : viewportFromLeft(corner);
        if (crossCheck(data, vw, vh, vp.x, vp.y, dpr)) {
          lastViewportPx = {
            x: corner.x,
            y: corner.y,
            marker: lastViewportPx.marker,
          };
          return { x: vp.x / dpr, y: vp.y / dpr };
        }
      }
    }
  }

  // Full frame scan. Stride = half fiducial pixel size guarantees a hit.
  const stride = Math.max(1, Math.floor(sizePx / 2));
  let bestSingle = null; // fallback: single-marker result without cross-check

  for (let i = 0; i < data.length; i += 4 * stride) {
    const hitX = (i / 4) % vw;
    const hitY = Math.floor(i / 4 / vw);

    if (isLeftPixel(data, i)) {
      const left = walkToCorner(data, vw, vh, hitX, hitY, isLeftPixel);
      const vp = viewportFromLeft(left);
      if (crossCheck(data, vw, vh, vp.x, vp.y, dpr)) {
        lastViewportPx = { x: left.x, y: left.y, marker: "left" };
        return { x: vp.x / dpr, y: vp.y / dpr };
      }
      if (!bestSingle) {
        bestSingle = { vp, corner: left, marker: "left" };
      }
    } else if (isRightPixel(data, i)) {
      const right = walkToCorner(data, vw, vh, hitX, hitY, isRightPixel);
      const vp = viewportFromRight(right, dpr);
      if (crossCheck(data, vw, vh, vp.x, vp.y, dpr)) {
        lastViewportPx = { x: right.x, y: right.y, marker: "right" };
        return { x: vp.x / dpr, y: vp.y / dpr };
      }
      if (!bestSingle) {
        bestSingle = { vp, corner: right, marker: "right" };
      }
    }
  }

  // Accept single-marker result if no cross-validated match was found.
  if (bestSingle) {
    lastViewportPx = {
      x: bestSingle.corner.x,
      y: bestSingle.corner.y,
      marker: bestSingle.marker,
    };
    return { x: bestSingle.vp.x / dpr, y: bestSingle.vp.y / dpr };
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
