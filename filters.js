// ---------------------------------------------------------------------------
// filters.js — WebGL CRT shader overlay
// Inspired by crt-geom (cgwg, Themaister, DOLLS) and ShaderGlass (mausimus)
// ---------------------------------------------------------------------------

const CRT_VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  v_uv.y = 1.0 - v_uv.y;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const CRT_FRAG = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_tex;
uniform vec2 u_resolution;
uniform float u_time;

// --- CRT parameters (tuned to look like a nice curved monitor) ---
const float CURVATURE    = 0.18;   // barrel distortion strength
const float CORNER_SIZE  = 0.04;   // rounded corner radius
const float CORNER_SMOOTH = 600.0; // corner edge softness

const float SCANLINE_WEIGHT = 0.65; // how dark the scanlines get
const float SCANLINE_SPEED  = 0.0;  // rolling scanline (0 = off)

const float DOT_MASK   = 0.25;   // RGB phosphor mask strength
const float CHROM_AB   = 0.003;  // chromatic aberration amount

const float VIGNETTE   = 0.5;    // edge darkening strength
const float BRIGHTNESS = 1.45;   // brightness boost to compensate for darkening

// Barrel distortion — attempt to simulate a curved glass surface
vec2 barrel(vec2 uv) {
  vec2 cc = uv - 0.5;
  float r2 = dot(cc, cc);
  // Cubic distortion for a more natural CRT curve
  return uv + cc * r2 * CURVATURE * (1.0 + r2 * 0.6);
}

// Smooth rounded-corner mask
float cornerMask(vec2 uv) {
  vec2 q = abs(uv - 0.5) * 2.0;
  vec2 d = max(q - (1.0 - vec2(CORNER_SIZE)), 0.0);
  float dist = length(d);
  return clamp((CORNER_SIZE - dist) * CORNER_SMOOTH, 0.0, 1.0);
}

// Scanline profile — brighter pixels have slightly wider lines (like crt-geom)
// Uses pre-distortion v_uv to avoid moiré from warped coordinates
float scanline(float screenY, float luminance) {
  float width = 0.5 + luminance * 0.3;
  float s = sin(screenY * 3.14159265);
  return 1.0 - SCANLINE_WEIGHT * (1.0 - pow(abs(s), width));
}

void main() {
  // Apply barrel distortion
  vec2 uv = barrel(v_uv);

  // Black outside the curved screen
  if (uv.x < -0.01 || uv.x > 1.01 || uv.y < -0.01 || uv.y > 1.01) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  // Corner mask
  float cmask = cornerMask(uv);

  // Chromatic aberration — shift R and B channels outward from center
  vec2 dir = (uv - 0.5) * CHROM_AB;
  float r = texture(u_tex, uv - dir).r;
  float g = texture(u_tex, uv).g;
  float b = texture(u_tex, uv + dir).b;
  vec3 col = vec3(r, g, b);

  // Scanlines — use screen-space Y (not distorted UV) to avoid moiré.
  // Divide by 4.0 so each line spans ~4 physical pixels (~2 CSS px on Retina).
  // Thick enough to survive video compression in screen recordings.
  float scanY = gl_FragCoord.y / 8.0 + u_time * SCANLINE_SPEED;
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col *= scanline(scanY, lum);

  // RGB phosphor dot mask — cycles every 3 pixels horizontally
  float px = gl_FragCoord.x;
  int phase = int(mod(px, 3.0));
  vec3 mask = vec3(1.0 - DOT_MASK);
  if (phase == 0)      mask.r = 1.0;
  else if (phase == 1) mask.g = 1.0;
  else                 mask.b = 1.0;
  col *= mask;

  // Vignette — simple radial darkening from center
  float dist = length(uv - 0.5) * 2.0; // 0 at center, ~1.4 at corners
  col *= 1.0 - VIGNETTE * dist * dist;

  // Brightness boost
  col *= BRIGHTNESS;

  // Corner fade to black
  col *= cmask;

  outColor = vec4(col, 1.0);
}`;

// ---------------------------------------------------------------------------
// WebGL setup & render
// ---------------------------------------------------------------------------

let _gl = null;
let _program = null;
let _posBuf = null;
let _texture = null;
let _overlayCanvas = null;
let _feedCanvas = null; // offscreen canvas to grab visible portion
let _feedCtx = null;
let _uRes = null;
let _uTime = null;
let _startTime = 0;

function _compileShader(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.error("Shader compile error:", gl.getShaderInfoLog(s));
    gl.deleteShader(s);
    return null;
  }
  return s;
}

function initCRTFilter(overlayCanvas) {
  _overlayCanvas = overlayCanvas;
  const gl = overlayCanvas.getContext("webgl2", {
    alpha: true,
    premultipliedAlpha: false,
    antialias: false,
  });
  if (!gl) {
    console.error("WebGL2 not available");
    return false;
  }
  _gl = gl;
  _startTime = performance.now();

  // Compile program
  const vs = _compileShader(gl, gl.VERTEX_SHADER, CRT_VERT);
  const fs = _compileShader(gl, gl.FRAGMENT_SHADER, CRT_FRAG);
  _program = gl.createProgram();
  gl.attachShader(_program, vs);
  gl.attachShader(_program, fs);
  gl.linkProgram(_program);
  if (!gl.getProgramParameter(_program, gl.LINK_STATUS)) {
    console.error("Program link error:", gl.getProgramInfoLog(_program));
    return false;
  }

  // Fullscreen quad (two triangles)
  _posBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, _posBuf);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW,
  );

  // Texture for the source feed
  _texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, _texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  // Uniform locations
  gl.useProgram(_program);
  _uRes = gl.getUniformLocation(_program, "u_resolution");
  _uTime = gl.getUniformLocation(_program, "u_time");

  // Offscreen canvas for grabbing the visible portion
  _feedCanvas = document.createElement("canvas");
  _feedCtx = _feedCanvas.getContext("2d");
  _feedCtx.imageSmoothingEnabled = false;

  return true;
}

function renderCRTFrame(sourceCanvas, displayX, displayY, dpr) {
  if (!_gl || !_overlayCanvas) return;
  const gl = _gl;

  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Size the overlay to fill the viewport at device pixel ratio
  const pxW = Math.round(vw * devicePixelRatio);
  const pxH = Math.round(vh * devicePixelRatio);

  if (_overlayCanvas.width !== pxW || _overlayCanvas.height !== pxH) {
    _overlayCanvas.width = pxW;
    _overlayCanvas.height = pxH;
    _overlayCanvas.style.width = vw + "px";
    _overlayCanvas.style.height = vh + "px";
  }

  // Copy the visible portion of the source canvas into the feed canvas
  const sx = Math.round(displayX * dpr);
  const sy = Math.round(displayY * dpr);
  const sw = Math.round(vw * dpr);
  const sh = Math.round(vh * dpr);

  if (_feedCanvas.width !== sw || _feedCanvas.height !== sh) {
    _feedCanvas.width = sw;
    _feedCanvas.height = sh;
  }
  _feedCtx.drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, sw, sh);

  // Upload to GPU
  gl.bindTexture(gl.TEXTURE_2D, _texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, _feedCanvas);

  // Render
  gl.viewport(0, 0, pxW, pxH);
  gl.useProgram(_program);
  gl.uniform2f(_uRes, pxW, pxH);
  gl.uniform1f(_uTime, (performance.now() - _startTime) / 1000.0);

  const aPos = gl.getAttribLocation(_program, "a_pos");
  gl.bindBuffer(gl.ARRAY_BUFFER, _posBuf);
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  gl.drawArrays(gl.TRIANGLES, 0, 6);
}
