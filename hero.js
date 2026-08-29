/* Tiny-planet graticule hero. One WebGL2 context, no libraries.
   Inverse stereographic projection of a procedural sphere — the math of an
   equirectangular 360° video pipeline, run in reverse. If anything is missing
   (WebGL2, motion preference, context), the CSS poster stays. */
(() => {
  'use strict';

  const hero = document.querySelector('.hero');
  const canvas = document.getElementById('hero-canvas');
  if (!hero || !canvas) return;

  const VERT = `#version 300 es
void main() {
  vec2 v = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(v * 2.0 - 1.0, 0.0, 1.0);
}`;

  const FRAG = `#version 300 es
precision highp float;

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_pointer;
uniform float u_scroll;

out vec4 outColor;

float hash(vec2 p) {
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

void main() {
  float mn = min(u_resolution.x, u_resolution.y);
  vec2 p = (2.0 * gl_FragCoord.xy - u_resolution) / mn;
  float s = clamp(u_scroll, 0.0, 1.0);

  // planet sits low-right on the page and recedes as you scroll away
  p.x -= 0.5;
  p.y += 0.62;
  p *= 1.35 + 1.7 * s;

  // inverse stereographic projection onto the unit sphere
  float r2 = dot(p, p);
  vec3 q = vec3(2.0 * p.x, 2.0 * p.y, r2 - 1.0) / (r2 + 1.0);

  // slow spin plus pointer parallax
  float yaw = 0.05 * u_time + 0.4 * u_pointer.x;
  float pitch = -0.32 + 0.24 * u_pointer.y;
  float cy = cos(yaw), sy = sin(yaw);
  q.xz = mat2(cy, -sy, sy, cy) * q.xz;
  float cp = cos(pitch), sp = sin(pitch);
  q.yz = mat2(cp, -sp, sp, cp) * q.yz;

  // equirectangular coordinates: 16 meridians, parallels every 22.5 degrees
  float lon = atan(q.z, q.x);
  float lat = asin(clamp(q.y, -1.0, 1.0));
  vec2 g = vec2(lon, lat) * 2.5464791;

  // anti-aliased graticule
  vec2 fw = fwidth(g);
  vec2 gg = abs(fract(g - 0.5) - 0.5) / fw;
  float line = 1.0 - min(min(gg.x, gg.y), 1.0);

  // hashed scatter of survey points riding the sphere
  vec2 cell = floor(g * 3.0);
  vec2 cuv = fract(g * 3.0) - 0.5;
  float h = hash(cell);
  vec2 jit = vec2(hash(cell + 17.1), hash(cell + 9.7)) - 0.5;
  float d = length(cuv - jit * 0.55);
  float pt = step(0.8, h) * (1.0 - smoothstep(0.07, 0.07 + fwidth(d) * 1.5, d));
  float tw = 0.55 + 0.45 * sin(u_time * (0.4 + h) + h * 41.0);

  // fade where the projection compresses the pattern into noise
  float fade = smoothstep(7.0, 1.2, r2);
  fade *= 1.0 - smoothstep(0.22, 0.65, max(fw.x, fw.y));

  vec2 uvn = gl_FragCoord.xy / u_resolution;
  float bgt = length((uvn - vec2(0.5, 1.1)) * vec2(1.0, 1.3));
  vec3 col = mix(vec3(0.086, 0.082, 0.102), vec3(0.039, 0.039, 0.047), smoothstep(0.0, 0.85, bgt));

  vec3 amber = vec3(1.0, 0.706, 0.329);
  col += amber * 0.03 / (0.4 + 0.6 * r2);
  col += amber * line * 0.22 * fade;
  col += amber * pt * tw * 0.9 * fade;

  col = mix(col, vec3(0.039, 0.039, 0.047), 0.8 * s);
  outColor = vec4(col, 1.0);
}`;

  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let gl = null;
  let program = null;
  const uni = {};
  let raf = 0;
  let running = false;
  let live = false;
  let inView = true;
  let width = 0;
  let height = 0;
  const started = performance.now();
  const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
  let scrollNow = 0;
  let scrollTarget = 0;

  function compile(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  }

  function setup() {
    gl = canvas.getContext('webgl2', { antialias: false, alpha: true, powerPreference: 'low-power' });
    if (!gl) return false;
    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return false;
    program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return false;
    for (const name of ['u_time', 'u_resolution', 'u_pointer', 'u_scroll']) {
      uni[name] = gl.getUniformLocation(program, name);
    }
    width = 0;
    height = 0;
    resize();
    window.__hero = { gl };
    return true;
  }

  function resize() {
    if (!gl) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (!w || !h || (w === width && h === height)) return;
    width = w;
    height = h;
    canvas.width = w;
    canvas.height = h;
  }

  function frame(now) {
    raf = 0;
    if (!running || !gl) return;
    pointer.x += (pointer.tx - pointer.x) * 0.06;
    pointer.y += (pointer.ty - pointer.y) * 0.06;
    scrollNow += (scrollTarget - scrollNow) * 0.12;
    gl.viewport(0, 0, width, height);
    gl.useProgram(program);
    gl.uniform1f(uni.u_time, (now - started) / 1000);
    gl.uniform2f(uni.u_resolution, width, height);
    gl.uniform2f(uni.u_pointer, pointer.x, pointer.y);
    gl.uniform1f(uni.u_scroll, scrollNow);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (!live) {
      live = true;
      hero.classList.add('live');
    }
    raf = requestAnimationFrame(frame);
  }

  function updateRunState() {
    const should = !!gl && !!program && inView && !document.hidden && !motion.matches;
    if (should && !running) {
      running = true;
      if (!raf) raf = requestAnimationFrame(frame);
    } else if (!should && running) {
      running = false;
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    }
  }

  function dropLive() {
    live = false;
    hero.classList.remove('live');
  }

  function boot() {
    if (!gl && !setup()) {
      gl = null;
      program = null;
      return;
    }
    updateRunState();
  }

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    program = null;
    updateRunState();
    dropLive();
  });
  canvas.addEventListener('webglcontextrestored', () => {
    if (setup()) updateRunState();
  });

  motion.addEventListener('change', () => {
    if (motion.matches) {
      updateRunState();
      dropLive();
    } else {
      boot();
    }
  });

  new IntersectionObserver((entries) => {
    inView = entries[0].isIntersecting;
    updateRunState();
  }).observe(canvas);

  document.addEventListener('visibilitychange', updateRunState);

  new ResizeObserver(resize).observe(canvas);

  window.addEventListener('pointermove', (e) => {
    pointer.tx = (e.clientX / window.innerWidth) * 2 - 1;
    pointer.ty = (e.clientY / window.innerHeight) * 2 - 1;
  }, { passive: true });

  window.addEventListener('scroll', () => {
    scrollTarget = Math.min(1, Math.max(0, window.scrollY / hero.offsetHeight));
  }, { passive: true });

  // compile after load, off the critical path — the poster covers the gap
  const whenIdle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1));
  function bootSoon() {
    if (motion.matches) return;
    if (document.readyState === 'complete') whenIdle(boot);
    else window.addEventListener('load', () => whenIdle(boot), { once: true });
  }
  bootSoon();
})();
