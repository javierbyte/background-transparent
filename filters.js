// WebGL CRT shader, inspired by crt-geom and ShaderGlass

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

const float CURVATURE    = 0.20;   // barrel distortion strength
const float CORNER_SIZE  = 0.04;   // rounded corner radius
const float CORNER_SMOOTH = 650.0; // corner edge softness

const float SCANLINE_WEIGHT = 0.65; // how dark the scanlines get
const float SCANLINE_SPEED  = 0.0;  // rolling scanline (0 = off)

const float DOT_MASK   = 0.25;   // RGB phosphor mask strength
const float CHROM_AB   = 0.003;  // chromatic aberration amount

const float VIGNETTE   = 0.5;    // edge darkening strength
const float BRIGHTNESS = 1.45;   // brightness boost to compensate for darkening

vec2 barrel(vec2 uv) {
  vec2 cc = uv - 0.5;
  float r2 = dot(cc, cc);
  return uv + cc * r2 * CURVATURE * (1.0 + r2 * 0.6);
}

float cornerMask(vec2 uv) {
  vec2 q = abs(uv - 0.5) * 2.0;
  vec2 d = max(q - (1.0 - vec2(CORNER_SIZE)), 0.0);
  float dist = length(d);
  return clamp((CORNER_SIZE - dist) * CORNER_SMOOTH, 0.0, 1.0);
}

// Brighter pixels get wider scanlines. Uses pre-distortion UV to avoid moiré.
float scanline(float screenY, float luminance) {
  float width = 0.5 + luminance * 0.3;
  float s = sin(screenY * 3.14159265);
  return 1.0 - SCANLINE_WEIGHT * (1.0 - pow(abs(s), width));
}

void main() {
  vec2 uv = barrel(v_uv);

  if (uv.x < -0.01 || uv.x > 1.01 || uv.y < -0.01 || uv.y > 1.01) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  float cmask = cornerMask(uv);

  vec2 dir = (uv - 0.5) * CHROM_AB;
  float r = texture(u_tex, uv - dir).r;
  float g = texture(u_tex, uv).g;
  float b = texture(u_tex, uv + dir).b;
  vec3 col = vec3(r, g, b);

  // Screen-space Y so scanlines don't moiré with barrel distortion.
  float scanY = gl_FragCoord.y / 8.0 + u_time * SCANLINE_SPEED;
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col *= scanline(scanY, lum);

  // RGB phosphor dot mask
  float px = gl_FragCoord.x;
  int phase = int(mod(px, 3.0));
  vec3 mask = vec3(1.0 - DOT_MASK);
  if (phase == 0)      mask.r = 1.0;
  else if (phase == 1) mask.g = 1.0;
  else                 mask.b = 1.0;
  col *= mask;

  float dist = length(uv - 0.5) * 2.0; // 0 at center, ~1.4 at corners
  col *= 1.0 - VIGNETTE * dist * dist;

  col *= BRIGHTNESS;
  col *= cmask;

  outColor = vec4(col, 1.0);
}`;

// Gameboy DMG shader

const GAMEBOY_FRAG = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_tex;
uniform vec2 u_resolution;

const float DOT_SIZE  = 4.0;
const float CELL_SIZE = 6.0;

const vec3 PAL0 = vec3(0.608, 0.737, 0.059); // #9bbc0f — lightest
const vec3 PAL1 = vec3(0.545, 0.675, 0.059); // #8bac0f — light
const vec3 PAL2 = vec3(0.365, 0.529, 0.122); // #5d871f — mid
const vec3 PAL3 = vec3(0.188, 0.384, 0.188); // #306230 — dark
const vec3 PAL4 = vec3(0.059, 0.220, 0.059); // #0f380f — darkest

const vec3 GAP_COLOR = vec3(0.043, 0.165, 0.043); // dark green gap

const float DITHER_STRENGTH = 0.15; // how much dither to apply per palette step

float bayer4(vec2 pos) {
  ivec2 p = ivec2(mod(pos, 4.0));
  int idx = p.x + p.y * 4;
  float m;
  if      (idx ==  0) m =  0.0; else if (idx ==  1) m =  8.0;
  else if (idx ==  2) m =  2.0; else if (idx ==  3) m = 10.0;
  else if (idx ==  4) m = 12.0; else if (idx ==  5) m =  4.0;
  else if (idx ==  6) m = 14.0; else if (idx ==  7) m =  6.0;
  else if (idx ==  8) m =  3.0; else if (idx ==  9) m = 11.0;
  else if (idx == 10) m =  1.0; else if (idx == 11) m =  9.0;
  else if (idx == 12) m = 15.0; else if (idx == 13) m =  7.0;
  else if (idx == 14) m = 13.0; else                m =  5.0;
  return (m / 16.0) - 0.5; // range: -0.5 to +0.4375
}

void main() {
  vec2 px = gl_FragCoord.xy;
  vec2 cell = mod(px, CELL_SIZE);

  vec2 cellIdx = floor(px / CELL_SIZE);
  vec2 sampleUV = (cellIdx * CELL_SIZE + CELL_SIZE * 0.5) / u_resolution;
  sampleUV.y = 1.0 - sampleUV.y; // flip Y for GL coordinates

  vec3 col = texture(u_tex, sampleUV).rgb;

  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  lum += bayer4(cellIdx) * DITHER_STRENGTH;

  vec3 out_col;
  if (lum > 0.80)      out_col = PAL0;
  else if (lum > 0.60) out_col = PAL1;
  else if (lum > 0.40) out_col = PAL2;
  else if (lum > 0.20) out_col = PAL3;
  else                 out_col = PAL4;

  if (cell.x >= DOT_SIZE || cell.y >= DOT_SIZE) {
    outColor = vec4(GAP_COLOR, 1.0);
    return;
  }

  outColor = vec4(out_col, 1.0);
}`;

// CRT filter

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
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    _feedCanvas,
  );

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

// Gameboy filter

let _gb_gl = null;
let _gb_program = null;
let _gb_posBuf = null;
let _gb_texture = null;
let _gb_overlayCanvas = null;
let _gb_feedCanvas = null;
let _gb_feedCtx = null;
let _gb_uRes = null;

function initGameboyFilter(overlayCanvas) {
  _gb_overlayCanvas = overlayCanvas;
  const gl = overlayCanvas.getContext("webgl2", {
    alpha: true,
    premultipliedAlpha: false,
    antialias: false,
  });
  if (!gl) {
    console.error("WebGL2 not available for Gameboy filter");
    return false;
  }
  _gb_gl = gl;

  const vs = _compileShader(gl, gl.VERTEX_SHADER, CRT_VERT);
  const fs = _compileShader(gl, gl.FRAGMENT_SHADER, GAMEBOY_FRAG);
  _gb_program = gl.createProgram();
  gl.attachShader(_gb_program, vs);
  gl.attachShader(_gb_program, fs);
  gl.linkProgram(_gb_program);
  if (!gl.getProgramParameter(_gb_program, gl.LINK_STATUS)) {
    console.error(
      "Gameboy program link error:",
      gl.getProgramInfoLog(_gb_program),
    );
    return false;
  }

  _gb_posBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, _gb_posBuf);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW,
  );

  _gb_texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, _gb_texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  gl.useProgram(_gb_program);
  _gb_uRes = gl.getUniformLocation(_gb_program, "u_resolution");

  _gb_feedCanvas = document.createElement("canvas");
  _gb_feedCtx = _gb_feedCanvas.getContext("2d");
  _gb_feedCtx.imageSmoothingEnabled = false;

  return true;
}

function renderGameboyFrame(sourceCanvas, displayX, displayY, dpr) {
  if (!_gb_gl || !_gb_overlayCanvas) return;
  const gl = _gb_gl;

  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const pxW = Math.round(vw * devicePixelRatio);
  const pxH = Math.round(vh * devicePixelRatio);

  if (_gb_overlayCanvas.width !== pxW || _gb_overlayCanvas.height !== pxH) {
    _gb_overlayCanvas.width = pxW;
    _gb_overlayCanvas.height = pxH;
    _gb_overlayCanvas.style.width = vw + "px";
    _gb_overlayCanvas.style.height = vh + "px";
  }

  const sx = Math.round(displayX * dpr);
  const sy = Math.round(displayY * dpr);
  const sw = Math.round(vw * dpr);
  const sh = Math.round(vh * dpr);

  if (_gb_feedCanvas.width !== sw || _gb_feedCanvas.height !== sh) {
    _gb_feedCanvas.width = sw;
    _gb_feedCanvas.height = sh;
  }
  _gb_feedCtx.drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, sw, sh);

  gl.bindTexture(gl.TEXTURE_2D, _gb_texture);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    _gb_feedCanvas,
  );

  gl.viewport(0, 0, pxW, pxH);
  gl.useProgram(_gb_program);
  gl.uniform2f(_gb_uRes, pxW, pxH);

  const aPos = gl.getAttribLocation(_gb_program, "a_pos");
  gl.bindBuffer(gl.ARRAY_BUFFER, _gb_posBuf);
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

// Liquid diamond filter

let _diamondInstance = null;

function initGlassFilter(overlayEl) {
  _diamondInstance = window.attachLiquidPyramid({ parent: overlayEl });
  return true;
}

function showGlassFilter() {
  if (_diamondInstance) _diamondInstance.show();
}

function hideGlassFilter() {
  if (_diamondInstance) _diamondInstance.hide();
}

function updateDiamondRotation(ox, oy) {
  if (_diamondInstance) _diamondInstance.setRotation(ox, oy);
}
