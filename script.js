const videoEl = document.querySelector("video");
const canvasEl = document.querySelector("canvas.draw");
const canvasBufferEl = document.querySelector("canvas.buffer");

const OFFSET_X = 2560;
const EXTRA_PADDING = 80;

const TOPNAV = 52;

let prevCanvasX = 0;
let prevCanvasY = 0;

let isPlaying = false;

let lastScreenLeft = window.screenLeft;
let lastScreenLeftUpdatedTime = Date.now();

canvasEl.addEventListener(
  "click",
  function () {
    if (isPlaying) {
      // add filter class to canvas
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

        // get stream width and height

        function render() {
          if (videoEl.videoWidth !== canvasEl.width) {
            canvasEl.width = videoEl.videoWidth;
            canvasEl.height = videoEl.videoHeight;
          }

          if (videoEl.videoWidth !== canvasBufferEl.width) {
            canvasBufferEl.width = videoEl.videoWidth;
            canvasBufferEl.height = videoEl.videoHeight;
          }

          // find the red dot in the canvas
          let redDotPosition = undefined;
          try {
            ctxBuffer.drawImage(videoEl, 0, 0);
            const imageData = ctxBuffer.getImageData(
              0,
              0,
              videoEl.videoWidth,
              videoEl.videoHeight
            );
            const data = imageData.data;
            const FIDUCIAL_SIZE = 9;
            for (let i = 0; i < data.length; i += 4 * FIDUCIAL_SIZE) {
              const r = data[i];
              const g = data[i + 1];
              const b = data[i + 2];
              const allowedError = 2;
              if (
                r > 255 - allowedError &&
                g > 255 - allowedError &&
                b < allowedError
              ) {
                redDotPosition = [
                  (i / 4) % canvasEl.width,
                  Math.floor(i / 4 / canvasEl.width),
                ];
                break;
              }
            }
          } catch (e) {
            console.error(e);
          }
          const screenLeft = redDotPosition
            ? redDotPosition[0] / 2
            : window.screenLeft - OFFSET_X;
          const screenTop = redDotPosition
            ? redDotPosition[1] / 2 - TOPNAV
            : window.screenTop;

          // const screenLeft = window.screenLeft - OFFSET_X;
          // const screenTop = window.screenTop;

          const screenWidth = videoEl.videoWidth / window.devicePixelRatio;
          const screenHeight = videoEl.videoHeight / window.devicePixelRatio;

          const holeX = screenLeft * window.devicePixelRatio - EXTRA_PADDING;
          const holeY = screenTop * window.devicePixelRatio - EXTRA_PADDING;
          const holeWidth =
            window.innerWidth * window.devicePixelRatio + EXTRA_PADDING * 2;
          const holeHeight =
            (window.innerHeight + TOPNAV) * window.devicePixelRatio +
            EXTRA_PADDING * 2;

          const newCanvasX = -screenLeft;
          const newCanvasY = -(screenTop + TOPNAV);

          const dx = newCanvasX - prevCanvasX;
          const dy = newCanvasY - prevCanvasY;

          // prevCanvasX = prevCanvasX + dx / 2;
          // prevCanvasY = prevCanvasY + dy / 2;

          prevCanvasX = newCanvasX;
          prevCanvasY = newCanvasY;

          canvasEl.style.width = screenWidth + "px";
          canvasEl.style.height = screenHeight + "px";
          canvasEl.style.transform = `translate(${prevCanvasX}px, ${prevCanvasY}px)`;

          // save everything BUT the whole to the buffer
          ctx.save();
          ctx.beginPath();
          // top part
          ctx.rect(0, 0, screenWidth * 2, holeY);

          // left part
          ctx.rect(0, holeY, holeX, holeHeight);

          // right part
          ctx.rect(
            holeX + holeWidth,
            holeY,
            screenWidth * 2,
            holeHeight + holeY
          );

          // bottom part
          ctx.rect(0, holeY + holeHeight, screenWidth * 2, screenHeight * 2);

          ctx.clip();
          ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
          ctx.drawImage(videoEl, 0, 0);

          ctx.restore();

          // window.requestAnimationFrame(render);
          setTimeout(render, 1000 / 30);
        }
        render();
      });
  },
  false
);
