const videoEl = document.querySelector("video");
const canvasEl = document.querySelector("canvas.draw");
const canvasBufferEl = document.querySelector("canvas.buffer");

// Browser chrome (tabs, address bar, shadow, etc.) in CSS pixels.
const CHROME_TOP = 54;
const CHROME_RIGHT = 0;
const CHROME_BOTTOM = 0;
const CHROME_LEFT = 0;

// Extra padding around the hole so slight misalignment doesn't leak the
// browser into the buffer.
const EXTRA_PADDING = 80;

const FIDUCIAL_SIZE = 32;

// Lerp factor per frame (0 = no movement, 1 = instant snap).
const SMOOTHING = 0.3;

let isPlaying = false;
let displayX = 0;
let displayY = 0;
let hasDisplay = false;

// Check if the pixel at (x, y) in the image data matches the given color.
function pixelMatches(data, width, x, y, targetR, targetG, targetB) {
  const i = (y * width + x) * 4;
  const allowedError = 2;
  return (
    Math.abs(data[i] - targetR) < allowedError &&
    Math.abs(data[i + 1] - targetG) < allowedError &&
    Math.abs(data[i + 2] - targetB) < allowedError
  );
}

// Given a candidate pixel inside a fiducial, find the exact top-left corner
// by walking left and up to the edge, then verify the expected size.
// Returns [x, y] in full video-pixel coords, or null if validation fails.
function refineFiducial(data, scaledWidth, scaledHeight, hitX, hitY, r, g, b) {
  // Walk left to find the left edge.
  let left = hitX;
  while (left > 0 && pixelMatches(data, scaledWidth, left - 1, hitY, r, g, b)) {
    left--;
  }
  // Walk up to find the top edge.
  let top = hitY;
  while (top > 0 && pixelMatches(data, scaledWidth, left, top - 1, r, g, b)) {
    top--;
  }

  // Measure the width and height from the top-left corner.
  const expectedSize = Math.round(FIDUCIAL_SIZE / 4);
  const minSize = expectedSize - 2;
  let w = 0;
  while (
    left + w < scaledWidth &&
    pixelMatches(data, scaledWidth, left + w, top, r, g, b)
  ) {
    w++;
  }
  let h = 0;
  while (
    top + h < scaledHeight &&
    pixelMatches(data, scaledWidth, left, top + h, r, g, b)
  ) {
    h++;
  }

  if (w < minSize || h < minSize) return null;

  // Return top-left in full video-pixel coordinates.
  return [left * 4, top * 4];
}

canvasEl.addEventListener(
  "click",
  function () {
    if (isPlaying) {
      canvasEl.classList.toggle("filter");
      return;
    }
    isPlaying = true;

    navigator.mediaDevices
      .getDisplayMedia({
        video: true,
        audio: false,
      })
      .then((stream) => {
        videoEl.srcObject = stream;
        videoEl.play();
        const ctx = canvasEl.getContext("2d");
        const ctxBuffer = canvasBufferEl.getContext("2d");

        // Offscreen canvas to snapshot each video frame, so detection and
        // painting always use the exact same frame. Without this, a live
        // MediaStream can advance between the two drawImage calls.
        const snapCanvas = document.createElement("canvas");
        const snapCtx = snapCanvas.getContext("2d");

        function render() {
          const dpr = window.devicePixelRatio;

          // Resize draw canvas to match the video feed.
          if (videoEl.videoWidth !== canvasEl.width) {
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

          // Resize the detection buffer (1/4 scale for speed).
          const scaledWidth = Math.ceil(videoEl.videoWidth / 4);
          const scaledHeight = Math.ceil(videoEl.videoHeight / 4);
          if (scaledWidth !== canvasBufferEl.width) {
            canvasBufferEl.width = scaledWidth;
            canvasBufferEl.height = scaledHeight;
          }

          // --- Step 2: Locate a fiducial in the screen capture ---
          // Left fiducial (yellow #ffff00) is at viewport (0, 0).
          // Right fiducial (magenta #ff00ff) is at viewport (innerWidth - 32, 0).
          // Either one is enough to determine the viewport position.
          // After finding a candidate pixel, we refine to the exact top-left
          // corner and validate the expected size.
          let detectedX = undefined;
          let detectedY = undefined;
          try {
            ctxBuffer.drawImage(snapCanvas, 0, 0, scaledWidth, scaledHeight);
            const imageData = ctxBuffer.getImageData(
              0,
              0,
              scaledWidth,
              scaledHeight,
            );
            const data = imageData.data;
            const scaledStride = Math.max(1, Math.floor(FIDUCIAL_SIZE / 4));
            const allowedError = 2;
            for (let i = 0; i < data.length; i += 4 * scaledStride) {
              const r = data[i];
              const g = data[i + 1];
              const b = data[i + 2];
              const isYellow =
                r > 255 - allowedError &&
                g > 255 - allowedError &&
                b < allowedError;
              const isMagenta =
                r > 255 - allowedError &&
                g < allowedError &&
                b > 255 - allowedError;
              if (!isYellow && !isMagenta) continue;

              const hitX = (i / 4) % scaledWidth;
              const hitY = Math.floor(i / 4 / scaledWidth);
              const color = isYellow ? [255, 255, 0] : [255, 0, 255];
              const corner = refineFiducial(
                data,
                scaledWidth,
                scaledHeight,
                hitX,
                hitY,
                color[0],
                color[1],
                color[2],
              );
              if (!corner) continue;

              detectedY = corner[1] / dpr;
              if (isYellow) {
                detectedX = corner[0] / dpr;
              } else {
                detectedX = corner[0] / dpr - window.innerWidth + FIDUCIAL_SIZE;
              }
              break;
            }
          } catch (e) {
            console.error(e);
          }

          if (detectedX === undefined) {
            requestAnimationFrame(render);
            return;
          }

          // Smooth the display position with lerp.
          if (!hasDisplay) {
            displayX = detectedX;
            displayY = detectedY;
            hasDisplay = true;
          } else {
            displayX += (detectedX - displayX) * SMOOTHING;
            displayY += (detectedY - displayY) * SMOOTHING;
          }

          // --- Step 3 & 4: Cut the browser window out of the buffer ---
          const holeX = (detectedX - CHROME_LEFT) * dpr - EXTRA_PADDING;
          const holeY = (detectedY - CHROME_TOP) * dpr - EXTRA_PADDING;
          const holeWidth =
            (CHROME_LEFT + window.innerWidth + CHROME_RIGHT) * dpr +
            EXTRA_PADDING * 2;
          const holeHeight =
            (CHROME_TOP + window.innerHeight + CHROME_BOTTOM) * dpr +
            EXTRA_PADDING * 2;

          // Draw the video frame but clip out the hole.
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, 0, canvasEl.width, holeY);
          ctx.rect(0, holeY, holeX, holeHeight);
          ctx.rect(holeX + holeWidth, holeY, canvasEl.width, holeHeight);
          ctx.rect(0, holeY + holeHeight, canvasEl.width, canvasEl.height);
          ctx.clip();
          ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
          ctx.drawImage(snapCanvas, 0, 0);
          ctx.restore();

          // --- Step 5: Translate so the viewport-aligned portion is visible ---
          canvasEl.style.transform = `translate(${-displayX}px, ${-displayY}px)`;

          requestAnimationFrame(render);
        }
        render();
      });
  },
  false,
);
