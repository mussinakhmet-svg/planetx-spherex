// planet.js — the backdrop: a slowly turning, procedurally shaded ice giant with a question mark
// on it (the planet nobody has seen yet) and a sparse star field. Pure WebGL, no libraries,
// no image files: everything is computed in the fragment shader.
// Code written with AI assistance (Claude), reviewed by team Sigma Boys.

const VERT = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAG = `
precision highp float;
uniform vec2 uRes; uniform float uTime; uniform vec2 uCenter; uniform float uRadius; uniform sampler2D uMark;

float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y); }
float fbm(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }

vec3 stars(vec2 uv){
  vec3 c = vec3(0.0);
  for (int l = 0; l < 2; l++) {
    float sc = l == 0 ? 90.0 : 190.0;
    vec2 g = uv * sc, id = floor(g), f = fract(g) - 0.5;
    float h = hash(id + float(l) * 31.7);
    if (h > 0.965) {
      vec2 o = (vec2(hash(id + 1.3), hash(id + 2.7)) - 0.5) * 0.6;
      float d = length(f - o), tw = 0.75 + 0.25 * sin(uTime * (0.4 + h * 1.3) + h * 40.0);
      float b = smoothstep(0.09, 0.0, d) * tw * (l == 0 ? 0.9 : 0.5);
      c += b * mix(vec3(0.75, 0.85, 1.0), vec3(1.0, 0.86, 0.72), hash(id + 9.1));
    }
  }
  return c;
}

void main(){
  vec2 px = gl_FragCoord.xy;
  vec2 uv = px / uRes.y;
  vec3 col = vec3(0.024, 0.035, 0.078);
  col += vec3(0.02, 0.03, 0.07) * fbm(uv * 1.6 + 3.0);            // faint depth in the sky
  col += stars(uv);

  vec2 q = (px - uCenter) / uRadius;
  float r = length(q);
  // glow around the limb
  col += vec3(0.20, 0.38, 0.62) * 0.55 * exp(-max(r - 1.0, 0.0) * 9.0) * step(1.0, r);
  if (r < 1.0) {
    float z = sqrt(1.0 - r * r);
    vec3 n = vec3(q, z);
    vec3 L = normalize(vec3(-0.62, 0.48, 0.62));
    float diff = max(dot(n, L), 0.0);
    // spin about a tilted axis: longitude drifts with time
    float tilt = 0.38;
    vec3 m = vec3(n.x * cos(tilt) - n.y * sin(tilt), n.x * sin(tilt) + n.y * cos(tilt), n.z);
    float lat = asin(clamp(m.y, -1.0, 1.0)), lon = atan(m.x, m.z) + uTime * 0.035;
    float bands = fbm(vec2(lon * 1.4, lat * 7.0) + fbm(vec2(lon * 3.0, lat * 3.0)) * 0.9);
    float fine = fbm(vec2(lon * 9.0, lat * 22.0));
    vec3 a = vec3(0.10, 0.20, 0.42), b = vec3(0.32, 0.56, 0.80), c2 = vec3(0.70, 0.86, 0.95);
    vec3 surf = mix(a, b, smoothstep(0.25, 0.75, bands));
    surf = mix(surf, c2, smoothstep(0.62, 0.9, bands) * 0.5);
    surf *= 0.86 + 0.28 * fine;
    // the question mark, pressed into the cloud tops and wrapped over the sphere
    vec2 mk = vec2(asin(clamp(q.x, -1.0, 1.0)), asin(clamp(q.y, -1.0, 1.0))) / 1.5708;
    float mark = texture2D(uMark, vec2(0.5 + mk.x * 0.62, 0.5 - mk.y * 0.62)).r;
    surf = mix(surf, vec3(0.93, 0.96, 1.0), mark * 0.5);
    float term = smoothstep(-0.05, 0.55, diff);
    vec3 lit = surf * (0.05 + 1.05 * term);
    lit += vec3(0.35, 0.6, 0.95) * pow(1.0 - z, 3.0) * 0.5 * term;      // atmosphere at the limb
    lit += vec3(1.0, 0.54, 0.3) * pow(1.0 - z, 5.0) * 0.10 * (1.0 - term); // a breath of infrared on the night side
    float edge = smoothstep(1.0, 0.985, r);
    col = mix(col, lit, edge);
  }
  // keep the area behind the text calm
  col *= 0.96;
  gl_FragColor = vec4(col, 1.0);
}`;

function markTexture(gl) {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const x = c.getContext('2d');
  x.fillStyle = '#000'; x.fillRect(0, 0, 256, 256);
  x.fillStyle = '#fff'; x.font = '700 210px "Unbounded", "Arial Black", Arial, sans-serif';
  x.textAlign = 'center'; x.textBaseline = 'middle'; x.filter = 'blur(1.5px)';
  x.fillText('?', 128, 138);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

export function startPlanet(canvas) {
  const gl = canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'low-power' });
  if (!gl) { canvas.style.background = 'radial-gradient(circle at 85% 12%, #1c3a66 0, #0b1020 38%, #060914 70%)'; return; }
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.warn(gl.getShaderInfoLog(s)); return s; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG)); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { console.warn(gl.getProgramInfoLog(prog)); return; }
  gl.useProgram(prog);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const U = n => gl.getUniformLocation(prog, n);
  const uRes = U('uRes'), uTime = U('uTime'), uCenter = U('uCenter'), uRadius = U('uRadius');
  let tex = markTexture(gl);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { tex = markTexture(gl); draw(last); });
  gl.uniform1i(U('uMark'), 0);

  let w = 0, h = 0, last = 0;
  const resize = () => {
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    w = Math.round(canvas.clientWidth * dpr); h = Math.round(canvas.clientHeight * dpr);
    canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h);
  };
  const draw = tsec => {
    last = tsec;
    const wide = w > h * 0.9;
    const radius = (wide ? 0.36 : 0.30) * Math.min(w, h * 1.3);
    // top right, partly off-screen; GL origin is bottom-left
    const cx = w - radius * (wide ? 0.55 : 0.2), cy = h - radius * (wide ? 0.30 : 0.05);
    gl.uniform2f(uRes, w, h); gl.uniform1f(uTime, tsec); gl.uniform2f(uCenter, cx, cy); gl.uniform1f(uRadius, radius);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };
  resize();
  window.addEventListener('resize', () => { resize(); draw(last); });
  const still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (still) { draw(40); return; }
  let prev = 0;
  const loop = ms => {
    requestAnimationFrame(loop);
    if (document.hidden || ms - prev < 50) return;      // about 20 fps is plenty for a slow planet
    prev = ms; draw(40 + ms / 1000);
  };
  requestAnimationFrame(loop);
}
