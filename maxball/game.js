import * as THREE from 'three';

// =============================================================
// CONSTANTS
// =============================================================
const GRAVITY = -22;
const BALL_RADIUS = 0.3;
const RIM_Y = 3.05;
const RIM_RADIUS = 0.56;
const RIM_TUBE = 0.045;
const BACKBOARD_W = 1.95;
const BACKBOARD_H = 1.25;
const BACKBOARD_THICK = 0.06;
const BACKBOARD_Y_OFFSET = 0.55;      // backboard center above rim
const BACKBOARD_Z_OFFSET = -0.36;     // backboard behind rim center

const BALL_START = new THREE.Vector3(0, 1.1, 1.4);
const CAMERA_POS = new THREE.Vector3(0, 1.85, 2.6);
const CAMERA_LOOK = new THREE.Vector3(0, 2.4, -7);

// Level config — friendlier difficulty curve
const LEVELS = [
  { name: 'Warm-up',      target: 2, balls: 8,  dist: 6.5, motion: 'none' },
  { name: 'Slide Show',   target: 2, balls: 8,  dist: 6.8, motion: 'horizontal', speed: 0.6, range: 1.0 },
  { name: 'Long Range',   target: 2, balls: 8,  dist: 7.7, motion: 'horizontal', speed: 0.7, range: 1.3 },
  { name: 'Bobbing',      target: 3, balls: 8,  dist: 7.2, motion: 'vertical',   speed: 0.9, range: 0.45 },
  { name: 'Figure Eight', target: 3, balls: 9,  dist: 7.8, motion: 'figure8',    speed: 1.0, range: 1.6 },
  { name: 'Pro Shot',     target: 4, balls: 10, dist: 8.5, motion: 'horizontal', speed: 1.3, range: 2.0 },
  { name: 'Endless',      target: 9999, balls: 999, dist: 7.5, motion: 'random' }
];

// =============================================================
// THREE.JS SETUP
// =============================================================
const canvas = document.getElementById('three-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
// Sky gradient via large back sphere
{
  const skyGeo = new THREE.SphereGeometry(60, 32, 16);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: {
      topColor:    { value: new THREE.Color('#1a3a8a') },
      bottomColor: { value: new THREE.Color('#ffb27a') }
    },
    vertexShader: `
      varying vec3 vWorldPos;
      void main() {
        vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vWorldPos;
      uniform vec3 topColor;
      uniform vec3 bottomColor;
      void main() {
        float t = clamp((vWorldPos.y + 10.0) / 40.0, 0.0, 1.0);
        gl_FragColor = vec4(mix(bottomColor, topColor, t), 1.0);
      }
    `
  });
  scene.add(new THREE.Mesh(skyGeo, skyMat));
}

const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.copy(CAMERA_POS);
camera.lookAt(CAMERA_LOOK);

// Lights
scene.add(new THREE.HemisphereLight(0xeaf2ff, 0x6b4a2b, 0.55));
const sun = new THREE.DirectionalLight(0xffffff, 1.05);
sun.position.set(4, 11, 6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -12;
sun.shadow.camera.right = 12;
sun.shadow.camera.top = 12;
sun.shadow.camera.bottom = -12;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 30;
sun.shadow.bias = -0.0005;
scene.add(sun);

// =============================================================
// TEXTURES (procedurally generated via Canvas)
// =============================================================
function makeWoodTexture() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 512;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#b9763a';
  ctx.fillRect(0, 0, 512, 512);
  const plankH = 56;
  for (let y = 0; y < 512; y += plankH) {
    const hue = 28 + Math.random() * 6;
    const light = 38 + Math.random() * 10;
    ctx.fillStyle = `hsl(${hue}, 52%, ${light}%)`;
    ctx.fillRect(0, y, 512, plankH - 2);
    ctx.fillStyle = 'rgba(20, 10, 5, 0.55)';
    ctx.fillRect(0, y + plankH - 2, 512, 2);
  }
  ctx.strokeStyle = 'rgba(60, 30, 10, 0.18)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 320; i++) {
    const y = Math.random() * 512;
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x < 512; x += 24) {
      ctx.lineTo(x + 24, y + (Math.random() - 0.5) * 5);
    }
    ctx.stroke();
  }
  for (let i = 0; i < 18; i++) {
    const x = Math.random() * 512;
    const y = Math.random() * 512;
    const r = 4 + Math.random() * 6;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(40, 20, 10, 0.35)');
    g.addColorStop(1, 'rgba(40, 20, 10, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function makeBasketballTexture() {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 512;
  const ctx = c.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, '#e8842a');
  grad.addColorStop(0.5, '#d96e1e');
  grad.addColorStop(1, '#a85013');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 1024, 512);
  for (let i = 0; i < 14000; i++) {
    const x = Math.random() * 1024;
    const y = Math.random() * 512;
    const r = Math.random() * 1.4 + 0.4;
    const dark = Math.random() < 0.5;
    ctx.fillStyle = dark ? 'rgba(90, 40, 10, 0.55)' : 'rgba(255, 170, 90, 0.55)';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = 'rgba(20, 10, 5, 0.85)';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(0, 256); ctx.lineTo(1024, 256);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(256, 0); ctx.lineTo(256, 512);
  ctx.moveTo(768, 0); ctx.lineTo(768, 512);
  ctx.stroke();
  ctx.beginPath();
  for (let x = 0; x <= 1024; x += 8) {
    const y = 256 + Math.sin((x / 1024) * Math.PI * 2) * 90;
    if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function makeBackboardTexture() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 320;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 320);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(1, '#e8efff');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 512, 320);
  ctx.strokeStyle = '#0d1b3d';
  ctx.lineWidth = 6;
  ctx.strokeRect(8, 8, 496, 304);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const woodTex = makeWoodTexture();
const ballTex = makeBasketballTexture();
const backboardTex = makeBackboardTexture();

// =============================================================
// COURT
// =============================================================
const COURT_W = 14;
const COURT_L = 22;
{
  const ct = woodTex.clone();
  ct.needsUpdate = true;
  ct.wrapS = ct.wrapT = THREE.RepeatWrapping;
  ct.repeat.set(3, 4);
  const court = new THREE.Mesh(
    new THREE.PlaneGeometry(COURT_W, COURT_L),
    new THREE.MeshStandardMaterial({ map: ct, roughness: 0.75 })
  );
  court.rotation.x = -Math.PI / 2;
  court.position.z = -4;
  court.receiveShadow = true;
  scene.add(court);

  // Inner key area paint
  const paint = new THREE.Mesh(
    new THREE.PlaneGeometry(3.2, 5),
    new THREE.MeshStandardMaterial({ color: 0xff9a47, roughness: 0.85 })
  );
  paint.rotation.x = -Math.PI / 2;
  paint.position.set(0, 0.001, -7 + 2.5);
  paint.receiveShadow = true;
  scene.add(paint);

  // Court lines (thin white)
  const lineMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  function addRect(x, z, w, l, thick = 0.05) {
    const a = new THREE.Mesh(new THREE.PlaneGeometry(w, thick), lineMat);
    a.rotation.x = -Math.PI / 2; a.position.set(x, 0.002, z - l/2);
    const b = a.clone(); b.position.set(x, 0.002, z + l/2);
    const c = new THREE.Mesh(new THREE.PlaneGeometry(thick, l), lineMat);
    c.rotation.x = -Math.PI / 2; c.position.set(x - w/2, 0.002, z);
    const d = c.clone(); d.position.set(x + w/2, 0.002, z);
    scene.add(a, b, c, d);
  }
  addRect(0, -7 + 2.5, 3.2, 5);

  // Free-throw arc (semicircle)
  const arcPts = [];
  for (let i = 0; i <= 32; i++) {
    const a = (i / 32) * Math.PI;
    arcPts.push(new THREE.Vector3(Math.cos(a) * 1.8, 0.002, -7 + 5 + Math.sin(a) * 1.8));
  }
  const arcGeo = new THREE.BufferGeometry().setFromPoints(arcPts);
  scene.add(new THREE.Line(arcGeo, new THREE.LineBasicMaterial({ color: 0xffffff })));

  // Three-point arc
  const tpPts = [];
  const tpR = 6.75;
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * Math.PI;
    tpPts.push(new THREE.Vector3(Math.cos(a) * tpR, 0.002, -7 + Math.sin(a) * tpR));
  }
  scene.add(new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(tpPts),
    new THREE.LineBasicMaterial({ color: 0xffffff })
  ));
}

// Decorative crowd backdrop — two low rows of colored blocks
{
  const colors = [0x2b5dff, 0xff5a6b, 0xffd166, 0x4ade80, 0xa78bfa, 0xff7a29];
  for (let row = 0; row < 2; row++) {
    for (let i = -6; i <= 6; i++) {
      const c = colors[(i + row * 3 + 30) % colors.length];
      const block = new THREE.Mesh(
        new THREE.BoxGeometry(0.9, 0.7 + Math.random() * 0.6, 0.7),
        new THREE.MeshStandardMaterial({ color: c, roughness: 0.9 })
      );
      block.position.set(i * 1.1, 0.35 + row * 0.55, -14 - row * 0.9);
      block.castShadow = false;
      scene.add(block);
    }
  }
}

// =============================================================
// HOOP (group so we can move it as one unit)
// =============================================================
const hoopGroup = new THREE.Group();
scene.add(hoopGroup);

// Backboard (white with subtle border) + red square target
const backboard = new THREE.Mesh(
  new THREE.BoxGeometry(BACKBOARD_W, BACKBOARD_H, BACKBOARD_THICK),
  new THREE.MeshStandardMaterial({ map: backboardTex, roughness: 0.35, metalness: 0.05 })
);
backboard.position.set(0, RIM_Y + BACKBOARD_Y_OFFSET, BACKBOARD_Z_OFFSET);
backboard.castShadow = true;
hoopGroup.add(backboard);

const targetSquare = new THREE.Mesh(
  new THREE.PlaneGeometry(0.7, 0.5),
  new THREE.MeshBasicMaterial({ color: 0xe74c3c })
);
targetSquare.position.set(0, RIM_Y + 0.32, BACKBOARD_Z_OFFSET + BACKBOARD_THICK/2 + 0.001);
hoopGroup.add(targetSquare);
const targetBorder = new THREE.Mesh(
  new THREE.PlaneGeometry(0.78, 0.58),
  new THREE.MeshBasicMaterial({ color: 0x000000 })
);
targetBorder.position.copy(targetSquare.position);
targetBorder.position.z -= 0.0005;
hoopGroup.add(targetBorder);

// Rim
const rim = new THREE.Mesh(
  new THREE.TorusGeometry(RIM_RADIUS, RIM_TUBE, 12, 32),
  new THREE.MeshStandardMaterial({ color: 0xff3b30, roughness: 0.5, metalness: 0.3 })
);
rim.rotation.x = Math.PI / 2;
rim.position.set(0, RIM_Y, 0);
rim.castShadow = true;
hoopGroup.add(rim);

// Net — cone of line segments + horizontal rings
{
  const netMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 });
  const segs = 14;
  const top = RIM_RADIUS - 0.01;
  const bot = RIM_RADIUS * 0.55;
  const height = 0.55;
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    const p = [
      new THREE.Vector3(Math.cos(a) * top, RIM_Y - 0.02, Math.sin(a) * top),
      new THREE.Vector3(Math.cos(a) * bot, RIM_Y - height, Math.sin(a) * bot)
    ];
    hoopGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(p), netMat));
  }
  for (let r = 1; r <= 3; r++) {
    const t = r / 3;
    const y = RIM_Y - 0.02 - t * height;
    const rr = top * (1 - t) + bot * t;
    const p = [];
    const rs = 32;
    for (let i = 0; i <= rs; i++) {
      const a = (i / rs) * Math.PI * 2;
      p.push(new THREE.Vector3(Math.cos(a) * rr, y, Math.sin(a) * rr));
    }
    hoopGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(p), netMat));
  }
}

// Pole + arm behind the backboard
{
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.6, metalness: 0.4 });
  const poleH = RIM_Y + BACKBOARD_Y_OFFSET + 0.4;
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, poleH, 16), poleMat);
  pole.position.set(0, poleH / 2, BACKBOARD_Z_OFFSET - 0.8);
  pole.castShadow = true;
  hoopGroup.add(pole);

  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.85), poleMat);
  arm.position.set(0, RIM_Y + BACKBOARD_Y_OFFSET, BACKBOARD_Z_OFFSET - 0.4);
  arm.castShadow = true;
  hoopGroup.add(arm);

  // Base plate
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.7, 0.1, 24), poleMat);
  base.position.set(0, 0.05, BACKBOARD_Z_OFFSET - 0.8);
  base.castShadow = true;
  hoopGroup.add(base);
}

// =============================================================
// BALL
// =============================================================
const ball = new THREE.Group();
{
  const skin = new THREE.Mesh(
    new THREE.SphereGeometry(BALL_RADIUS, 48, 32),
    new THREE.MeshStandardMaterial({ map: ballTex, roughness: 0.62, metalness: 0.0 })
  );
  skin.castShadow = true;
  ball.add(skin);
}
scene.add(ball);

// Ball shadow blob — a soft circle on the floor that scales with height
const shadow = new THREE.Mesh(
  new THREE.CircleGeometry(BALL_RADIUS * 0.95, 24),
  new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 })
);
shadow.rotation.x = -Math.PI / 2;
shadow.position.y = 0.005;
scene.add(shadow);

// =============================================================
// CONFETTI — instanced fluttering rectangles
// =============================================================
const CONFETTI_MAX = 120;
const CONFETTI_COLORS = [
  [1.00, 0.45, 0.30],
  [1.00, 0.82, 0.30],
  [0.32, 0.85, 0.50],
  [0.30, 0.62, 1.00],
  [0.90, 0.35, 0.92],
  [1.00, 0.55, 0.15]
];
const confetti = new THREE.InstancedMesh(
  new THREE.PlaneGeometry(0.12, 0.18),
  new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, vertexColors: false, toneMapped: false }),
  CONFETTI_MAX
);
confetti.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
confetti.frustumCulled = false;
confetti.count = 0;
// Pre-allocate instance color attribute so the shader compiles with USE_INSTANCING_COLOR
{
  const colArr = new Float32Array(CONFETTI_MAX * 3);
  for (let i = 0; i < CONFETTI_MAX; i++) { colArr[i*3] = 1; colArr[i*3+1] = 1; colArr[i*3+2] = 1; }
  confetti.instanceColor = new THREE.InstancedBufferAttribute(colArr, 3);
}
scene.add(confetti);

const confettiState = [];
const _cMat = new THREE.Matrix4();
const _cPos = new THREE.Vector3();
const _cQuat = new THREE.Quaternion();
const _cEul = new THREE.Euler();
const _cScale = new THREE.Vector3(1, 1, 1);
const _cColor = new THREE.Color();
const _hiddenMat = new THREE.Matrix4().compose(
  new THREE.Vector3(1e6, 1e6, 1e6),
  new THREE.Quaternion(),
  new THREE.Vector3(0, 0, 0)
);

function spawnConfetti(x, y, z) {
  const count = 60;
  for (let i = 0; i < count; i++) {
    if (confettiState.length >= CONFETTI_MAX) confettiState.shift();
    confettiState.push({
      pos: new THREE.Vector3(x + (Math.random() - 0.5) * 1.5, y + (Math.random() - 0.5) * 1.5, z),
      vel: new THREE.Vector3(0, 0, 0),
      rot: new THREE.Vector3(Math.random() * 6, Math.random() * 6, Math.random() * 6),
      rotVel: new THREE.Vector3(0, 0, 0),
      life: 999,
      color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)]
    });
  }
}

function updateConfetti(dt) {
  for (let i = confettiState.length - 1; i >= 0; i--) {
    const p = confettiState[i];
    p.vel.y += GRAVITY * 0.35 * dt;
    p.pos.x += p.vel.x * dt;
    p.pos.y += p.vel.y * dt;
    p.pos.z += p.vel.z * dt;
    p.rot.x += p.rotVel.x * dt;
    p.rot.y += p.rotVel.y * dt;
    p.rot.z += p.rotVel.z * dt;
    p.life -= dt;
    if (p.life <= 0 || p.pos.y < 0) confettiState.splice(i, 1);
  }
  const n = confettiState.length;
  for (let i = 0; i < n; i++) {
    const p = confettiState[i];
    _cPos.copy(p.pos);
    _cEul.set(p.rot.x, p.rot.y, p.rot.z);
    _cQuat.setFromEuler(_cEul);
    const fade = Math.min(1, p.life / 0.6);
    _cScale.set(fade, fade, fade);
    _cMat.compose(_cPos, _cQuat, _cScale);
    confetti.setMatrixAt(i, _cMat);
    _cColor.setRGB(p.color[0], p.color[1], p.color[2]);
    confetti.setColorAt(i, _cColor);
  }
  confetti.count = n;
  confetti.instanceMatrix.needsUpdate = true;
  if (confetti.instanceColor) confetti.instanceColor.needsUpdate = true;
}

// Trajectory preview points
const trajGeo = new THREE.BufferGeometry();
const trajMat = new THREE.PointsMaterial({
  color: 0xffd166,
  size: 0.11,
  transparent: true,
  opacity: 0.85,
  sizeAttenuation: true
});
const trajPoints = new THREE.Points(trajGeo, trajMat);
trajPoints.visible = false;
scene.add(trajPoints);

// =============================================================
// AUDIO (Web Audio API — all SFX synthesized)
// =============================================================
let audioCtx = null;
let muted = false;

function initAudio() {
  if (audioCtx) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  } catch {
    audioCtx = null;
  }
}

function withCtx(fn) {
  if (!audioCtx || muted) return;
  if (audioCtx.state === 'suspended') audioCtx.resume();
  fn(audioCtx);
}

function playBounce(strength = 0.5) {
  withCtx(ctx => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(160 + strength * 80, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(60, ctx.currentTime + 0.12);
    gain.gain.setValueAtTime(0.18 * Math.min(1, strength + 0.3), ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.16);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.18);
  });
}

function playRim() {
  withCtx(ctx => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(900, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(420, ctx.currentTime + 0.18);
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.22);
  });
}

function playBackboard() {
  withCtx(ctx => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(260, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(140, ctx.currentTime + 0.15);
    gain.gain.setValueAtTime(0.1, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.16);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.18);
  });
}

function playSwish() {
  withCtx(ctx => {
    const dur = 0.35;
    const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      const t = i / data.length;
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 1.8);
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filt = ctx.createBiquadFilter();
    filt.type = 'bandpass';
    filt.frequency.value = 5200;
    filt.Q.value = 1.5;
    const gain = ctx.createGain();
    gain.gain.value = 0.4;
    src.connect(filt).connect(gain).connect(ctx.destination);
    src.start();
  });
}

function playScore() {
  withCtx(ctx => {
    [523.25, 659.25, 783.99].forEach((f, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = f;
      const t0 = ctx.currentTime + i * 0.07;
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(0.18, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.32);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.34);
    });
  });
}

function playMiss() {
  withCtx(ctx => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(220, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(140, ctx.currentTime + 0.4);
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.42);
  });
}

function playBuzzer() {
  withCtx(ctx => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.value = 180;
    gain.gain.setValueAtTime(0.18, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.1);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 1.15);
  });
}

function playLevelUp() {
  withCtx(ctx => {
    [392, 523, 659, 784, 1047].forEach((f, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = f;
      const t0 = ctx.currentTime + i * 0.08;
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(0.16, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.36);
    });
  });
}

// =============================================================
// GAME STATE
// =============================================================
const state = {
  phase: 'title',        // 'title' | 'intro' | 'play' | 'levelComplete' | 'gameOver' | 'select'
  level: 0,
  baskets: 0,            // baskets this level
  attempts: 0,           // shots taken this level
  ballsLeft: LEVELS[0].balls,
  score: 0,
  best: parseInt(localStorage.getItem('maxball.best') || '0', 10) || 0,
  maxLevelUnlocked: Math.min(
    parseInt(localStorage.getItem('maxball.maxLevel') || '0', 10) || 0,
    LEVELS.length - 1
  ),
  ballPhase: 'idle',     // 'idle' | 'flying' | 'dead'
  hoopTime: 0,
  randomTarget: { x: 0, y: 0, z: -8 }
};

const ballPos = new THREE.Vector3();
const ballVel = new THREE.Vector3();
let prevBallY = 0;
let scoredThisShot = false;
let touchedRim = false;
let touchedBoard = false;

function resetBall() {
  ballPos.copy(BALL_START);
  ballVel.set(0, 0, 0);
  ball.position.copy(ballPos);
  ball.rotation.set(0, 0, 0);
  state.ballPhase = 'idle';
  scoredThisShot = false;
  touchedRim = false;
  touchedBoard = false;
  prevBallY = ballPos.y;
  showHint(true);
}

// =============================================================
// HOOP MOTION
// =============================================================
function pickRandomHoopTarget() {
  state.randomTarget = {
    x: (Math.random() * 2 - 1) * 3,
    y: Math.random() * 0.7,
    z: -7 - Math.random() * 3
  };
}

function updateHoop(dt) {
  const lvl = LEVELS[state.level];
  state.hoopTime += dt;
  let x = 0, y = 0;
  const z = -lvl.dist;
  switch (lvl.motion) {
    case 'horizontal':
      x = Math.sin(state.hoopTime * lvl.speed) * lvl.range;
      break;
    case 'vertical':
      y = Math.sin(state.hoopTime * lvl.speed) * lvl.range;
      break;
    case 'figure8':
      x = Math.sin(state.hoopTime * lvl.speed) * lvl.range;
      y = Math.sin(state.hoopTime * lvl.speed * 2) * 0.6;
      break;
    case 'random': {
      // Lerp toward target
      const t = state.randomTarget;
      hoopGroup.position.x += (t.x - hoopGroup.position.x) * Math.min(1, dt * 2);
      hoopGroup.position.y += (t.y - hoopGroup.position.y) * Math.min(1, dt * 2);
      hoopGroup.position.z += (t.z - hoopGroup.position.z) * Math.min(1, dt * 2);
      return;
    }
    case 'none':
    default:
      break;
  }
  hoopGroup.position.set(x, y, z);
}

// =============================================================
// PHYSICS
// =============================================================
function physicsStep(dt) {
  if (state.ballPhase !== 'flying') return;

  // Substep for better collision stability
  const subs = 3;
  const sdt = dt / subs;
  for (let s = 0; s < subs; s++) {
    prevBallY = ballPos.y;
    ballVel.y += GRAVITY * sdt;
    ballPos.x += ballVel.x * sdt;
    ballPos.y += ballVel.y * sdt;
    ballPos.z += ballVel.z * sdt;

    // Floor
    if (ballPos.y < BALL_RADIUS) {
      ballPos.y = BALL_RADIUS;
      if (ballVel.y < 0) {
        const impact = Math.min(1, -ballVel.y / 12);
        ballVel.y = -ballVel.y * 0.55;
        ballVel.x *= 0.7;
        ballVel.z *= 0.7;
        if (Math.abs(ballVel.y) < 1.3) ballVel.y = 0;
        playBounce(impact);
      }
    }

    checkBackboard();
    checkRim();
    checkScore();
  }

  // Visual update
  ball.position.copy(ballPos);
  // Roll the ball roughly based on velocity
  const spin = 0.6;
  ball.rotation.x += ballVel.z * dt * spin;
  ball.rotation.z -= ballVel.x * dt * spin;

  // End-of-shot checks
  const outOfBounds =
    ballPos.z > 6 || ballPos.z < -22 ||
    Math.abs(ballPos.x) > 12 || ballPos.y > 30;
  const settled =
    ballPos.y <= BALL_RADIUS + 0.02 &&
    Math.abs(ballVel.y) < 0.6 &&
    (Math.abs(ballVel.x) + Math.abs(ballVel.z)) < 1.2;

  if (outOfBounds || settled) {
    endShot();
  }
}

function checkBackboard() {
  // World-space backboard center
  const bx = hoopGroup.position.x;
  const by = hoopGroup.position.y + RIM_Y + BACKBOARD_Y_OFFSET;
  const bz = hoopGroup.position.z + BACKBOARD_Z_OFFSET;
  const left = bx - BACKBOARD_W / 2;
  const right = bx + BACKBOARD_W / 2;
  const bottom = by - BACKBOARD_H / 2;
  const top = by + BACKBOARD_H / 2;
  const frontZ = bz + BACKBOARD_THICK / 2;
  const backZ = bz - BACKBOARD_THICK / 2;

  if (ballPos.x > left - BALL_RADIUS && ballPos.x < right + BALL_RADIUS &&
      ballPos.y > bottom - BALL_RADIUS && ballPos.y < top + BALL_RADIUS) {
    // Hit the front face (ball travelling forward into backboard)
    if (ballPos.z < frontZ + BALL_RADIUS && ballPos.z > backZ && ballVel.z < 0) {
      ballPos.z = frontZ + BALL_RADIUS;
      ballVel.z = -ballVel.z * 0.45;
      ballVel.x *= 0.8;
      ballVel.y *= 0.85;
      playBackboard();
      touchedBoard = true;
    }
  }
}

function checkRim() {
  // Two collision points: rim itself (torus) — approximated by closest-point-on-circle test
  const hx = hoopGroup.position.x;
  const hy = hoopGroup.position.y + RIM_Y;
  const hz = hoopGroup.position.z;
  const dx = ballPos.x - hx;
  const dz = ballPos.z - hz;
  const horizDist = Math.sqrt(dx * dx + dz * dz);
  if (horizDist < 0.001) return;
  const ratio = RIM_RADIUS / horizDist;
  const rpx = hx + dx * ratio;
  const rpz = hz + dz * ratio;
  const rpy = hy;
  const vx = ballPos.x - rpx;
  const vy = ballPos.y - rpy;
  const vz = ballPos.z - rpz;
  const d = Math.sqrt(vx * vx + vy * vy + vz * vz);
  const minD = BALL_RADIUS + RIM_TUBE;
  if (d < minD && d > 0.0001) {
    const nx = vx / d, ny = vy / d, nz = vz / d;
    const push = (minD - d);
    ballPos.x += nx * push;
    ballPos.y += ny * push;
    ballPos.z += nz * push;
    const vDotN = ballVel.x * nx + ballVel.y * ny + ballVel.z * nz;
    if (vDotN < 0) {
      const r = 0.5;
      ballVel.x -= (1 + r) * vDotN * nx;
      ballVel.y -= (1 + r) * vDotN * ny;
      ballVel.z -= (1 + r) * vDotN * nz;
      ballVel.multiplyScalar(0.86);
      playRim();
      touchedRim = true;
    }
  }
}

function checkScore() {
  if (scoredThisShot) return;
  const hx = hoopGroup.position.x;
  const hy = hoopGroup.position.y + RIM_Y;
  const hz = hoopGroup.position.z;
  if (prevBallY > hy && ballPos.y <= hy && ballVel.y < 0) {
    const dx = ballPos.x - hx;
    const dz = ballPos.z - hz;
    const r = RIM_RADIUS - BALL_RADIUS * 0.55;
    if (dx * dx + dz * dz < r * r) {
      onScore();
    }
  }
}

function onScore() {
  scoredThisShot = true;
  const swish = !touchedRim && !touchedBoard;
  const pts = swish ? 3 : 2;
  state.baskets += 1;
  state.score += pts;
  if (swish) {
    showPopup(`+${pts}  SWISH!`, 'swish');
    playSwish();
    setTimeout(playScore, 90);
  } else {
    showPopup(`+${pts}`, '');
    playScore();
  }
  spawnConfetti(
    hoopGroup.position.x,
    hoopGroup.position.y + RIM_Y - 0.1,
    hoopGroup.position.z
  );
  updateHUD();
}

function endShot() {
  if (state.ballPhase !== 'flying') return;
  state.ballPhase = 'dead';
  if (!scoredThisShot) {
    showPopup('MISS', 'miss');
    playMiss();
  }
  setTimeout(() => {
    const lvl = LEVELS[state.level];
    if (state.baskets >= lvl.target && state.level < LEVELS.length - 1) {
      onLevelComplete();
    } else if (state.ballsLeft <= 0) {
      onGameOver();
    } else {
      if (lvl.motion === 'random') pickRandomHoopTarget();
      resetBall();
    }
  }, 900);
}

// =============================================================
// LEVEL / FLOW
// =============================================================
function startGame() {
  state.level = 0;
  state.score = 0;
  initLevel();
}

function initLevel() {
  const lvl = LEVELS[state.level];
  state.baskets = 0;
  state.attempts = 0;
  state.ballsLeft = lvl.balls;
  state.hoopTime = 0;
  if (lvl.motion === 'random') pickRandomHoopTarget();
  else hoopGroup.position.set(0, 0, -lvl.dist);

  state.phase = 'intro';
  document.getElementById('intro-level').textContent = state.level + 1;
  document.getElementById('intro-name').textContent = lvl.name;
  document.getElementById('intro-target').textContent =
    lvl.target >= 999 ? '∞' : lvl.target;
  document.getElementById('intro-balls').textContent =
    lvl.balls >= 999 ? '∞' : lvl.balls;
  showOverlay('intro-card');
  updateHUD();
  resetBall();
}

function onLevelComplete() {
  state.phase = 'levelComplete';
  playLevelUp();
  const next = Math.min(state.level + 1, LEVELS.length - 1);
  if (next > state.maxLevelUnlocked) {
    state.maxLevelUnlocked = next;
    localStorage.setItem('maxball.maxLevel', String(next));
  }
  document.getElementById('complete-baskets').textContent = state.baskets;
  document.getElementById('complete-attempts').textContent = state.attempts;
  document.getElementById('complete-score').textContent = state.score;
  showOverlay('complete-card');
}

function onGameOver() {
  state.phase = 'gameOver';
  playBuzzer();
  if (state.score > state.best) {
    state.best = state.score;
    localStorage.setItem('maxball.best', String(state.best));
    document.getElementById('over-headline').textContent = 'New best score! 🔥';
  } else {
    document.getElementById('over-headline').textContent = 'Out of balls!';
  }
  document.getElementById('over-score').textContent = state.score;
  document.getElementById('over-best').textContent = state.best;
  showOverlay('over-card');
}

function nextLevel() {
  state.level = Math.min(state.level + 1, LEVELS.length - 1);
  initLevel();
}

// =============================================================
// UI
// =============================================================
const overlayEl = document.getElementById('overlay');
const cards = ['title-card', 'intro-card', 'complete-card', 'over-card', 'select-card'];

function showLevelSelect() {
  state.phase = 'select';
  const grid = document.getElementById('level-grid');
  grid.innerHTML = '';
  LEVELS.forEach((lvl, i) => {
    const btn = document.createElement('button');
    const unlocked = i <= state.maxLevelUnlocked;
    const cleared = i < state.maxLevelUnlocked;
    btn.className = 'level-btn' + (unlocked ? (cleared ? ' cleared' : '') : ' locked');
    btn.disabled = !unlocked;
    btn.innerHTML = `<span class="num">LV ${i + 1}</span><span class="lname">${lvl.name}</span>`;
    if (unlocked) {
      btn.addEventListener('click', () => {
        state.level = i;
        state.score = 0;
        initLevel();
      });
    }
    grid.appendChild(btn);
  });
  showOverlay('select-card');
}

function showOverlay(cardId) {
  overlayEl.classList.remove('hidden');
  cards.forEach(id => document.getElementById(id).classList.toggle('hidden', id !== cardId));
  showHint(false);
}

function hideOverlay() {
  overlayEl.classList.add('hidden');
}

function updateHUD() {
  document.getElementById('score-value').textContent = state.score;
  document.getElementById('level-value').textContent = state.level + 1;
  document.getElementById('level-name').textContent = LEVELS[state.level].name;
  const bl = state.ballsLeft;
  document.getElementById('balls-value').textContent = bl >= 999 ? '∞' : bl;
  const objEl = document.getElementById('objective');
  const lvl = LEVELS[state.level];
  if (state.phase === 'play' && lvl.target < 999) {
    objEl.classList.remove('hidden');
    document.getElementById('objective-text').textContent =
      `${state.baskets} / ${lvl.target} baskets`;
  } else if (state.phase === 'play') {
    objEl.classList.remove('hidden');
    document.getElementById('objective-text').textContent = 'Endless · go for high score';
  } else {
    objEl.classList.add('hidden');
  }
}

function showHint(on) {
  document.getElementById('hint').classList.toggle('hidden', !on);
}

function showPopup(text, cls = '') {
  const el = document.createElement('div');
  el.className = 'popup ' + cls;
  el.textContent = text;
  document.getElementById('popup-layer').appendChild(el);
  setTimeout(() => el.remove(), 1200);
}

// Mute button
document.getElementById('mute-btn').addEventListener('click', () => {
  muted = !muted;
  document.getElementById('mute-btn').textContent = muted ? '🔇' : '🔊';
});

// Overlay buttons
overlayEl.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  initAudio();
  const action = btn.dataset.action;
  if (action === 'start') {
    startGame();
  } else if (action === 'play') {
    state.phase = 'play';
    hideOverlay();
    showHint(true);
    updateHUD();
  } else if (action === 'next') {
    nextLevel();
  } else if (action === 'restart') {
    startGame();
  } else if (action === 'select') {
    showLevelSelect();
  } else if (action === 'back-to-title') {
    state.phase = 'title';
    showOverlay('title-card');
  }
});

// =============================================================
// INPUT — pointer (mouse + touch unified)
// =============================================================
const aimCanvas = document.getElementById('aim-canvas');
const aimCtx = aimCanvas.getContext('2d');
let dragStart = null;
let dragCurrent = null;

function resizeAimCanvas() {
  aimCanvas.width = window.innerWidth * devicePixelRatio;
  aimCanvas.height = window.innerHeight * devicePixelRatio;
  aimCanvas.style.width = window.innerWidth + 'px';
  aimCanvas.style.height = window.innerHeight + 'px';
}
resizeAimCanvas();

function onPointerDown(e) {
  if (state.phase !== 'play' || state.ballPhase !== 'idle') return;
  initAudio();
  e.preventDefault();
  dragStart = { x: e.clientX, y: e.clientY };
  dragCurrent = { ...dragStart };
  showHint(false);
}

function onPointerMove(e) {
  if (!dragStart) return;
  e.preventDefault();
  dragCurrent = { x: e.clientX, y: e.clientY };
  drawAim();
  updateTrajectory();
}

function onPointerUp(e) {
  if (!dragStart) return;
  const cur = dragCurrent || dragStart;
  const dx = cur.x - dragStart.x;
  const dy = cur.y - dragStart.y;
  const dist = Math.hypot(dx, dy);
  const validSwipe = dist >= 30 && dy <= -20;
  dragStart = null;
  dragCurrent = null;
  clearAim();
  trajPoints.visible = false;
  if (!validSwipe) return;
  const vel = computeVelocity(dx, dy);
  ballVel.copy(vel);
  state.ballPhase = 'flying';
  state.ballsLeft -= 1;
  state.attempts += 1;
  updateHUD();
}

function computeVelocity(dx, dy) {
  // Vertical swipe magnitude (upward = positive "up")
  const up = Math.min(-dy, 600);
  const power = Math.max(0.25, up / 480); // 0..~1.25
  const forward = 5.5 + power * 6.0;
  const upSpeed = 5.0 + power * 6.5;
  // Side input — modest sensitivity so users can fine-tune horizontally
  const side = dx * 0.011;
  return new THREE.Vector3(side, upSpeed, -forward);
}

function clearAim() {
  aimCtx.clearRect(0, 0, aimCanvas.width, aimCanvas.height);
}

function drawAim() {
  if (!dragStart || !dragCurrent) return;
  const dpr = devicePixelRatio;
  clearAim();
  const sx = dragStart.x * dpr;
  const sy = dragStart.y * dpr;
  const cx = dragCurrent.x * dpr;
  const cy = dragCurrent.y * dpr;
  const dy = dragCurrent.y - dragStart.y;
  const power = Math.max(0, Math.min(1, -dy / 480));

  // Arrow line
  aimCtx.lineCap = 'round';
  aimCtx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  aimCtx.lineWidth = 5 * dpr;
  aimCtx.setLineDash([10 * dpr, 8 * dpr]);
  aimCtx.beginPath();
  aimCtx.moveTo(sx, sy);
  aimCtx.lineTo(cx, cy);
  aimCtx.stroke();
  aimCtx.setLineDash([]);

  // Power circle on cursor
  const hue = 120 - power * 120; // green → red
  aimCtx.beginPath();
  aimCtx.arc(cx, cy, (12 + 22 * power) * dpr, 0, Math.PI * 2);
  aimCtx.fillStyle = `hsla(${hue}, 90%, 55%, 0.55)`;
  aimCtx.fill();
  aimCtx.strokeStyle = `hsla(${hue}, 90%, 70%, 0.9)`;
  aimCtx.lineWidth = 3 * dpr;
  aimCtx.stroke();

  // Origin pip
  aimCtx.beginPath();
  aimCtx.arc(sx, sy, 8 * dpr, 0, Math.PI * 2);
  aimCtx.fillStyle = 'rgba(255, 209, 102, 0.95)';
  aimCtx.fill();
}

function updateTrajectory() {
  if (!dragStart || !dragCurrent) {
    trajPoints.visible = false;
    return;
  }
  const dx = dragCurrent.x - dragStart.x;
  const dy = dragCurrent.y - dragStart.y;
  if (dy >= -10) {
    trajPoints.visible = false;
    return;
  }
  const v = computeVelocity(dx, dy);
  const p = ball.position.clone();
  const points = [];
  const dt = 0.045;
  for (let i = 0; i < 50; i++) {
    points.push(p.clone());
    p.x += v.x * dt;
    p.y += v.y * dt;
    p.z += v.z * dt;
    v.y += GRAVITY * dt;
    if (p.y < BALL_RADIUS - 0.05) break;
  }
  trajGeo.setFromPoints(points);
  trajPoints.visible = true;
}

// Use pointer events on the whole game area so swipes anywhere count
const gameRoot = document.getElementById('game-root');
gameRoot.addEventListener('pointerdown', onPointerDown);
window.addEventListener('pointermove', onPointerMove);
window.addEventListener('pointerup', onPointerUp);
window.addEventListener('pointercancel', () => {
  dragStart = null;
  dragCurrent = null;
  clearAim();
  trajPoints.visible = false;
});

// Block context menu / scroll on canvas
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// =============================================================
// RESIZE
// =============================================================
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  resizeAimCanvas();
});

// =============================================================
// LOOP
// =============================================================
let lastT = performance.now();
function tick(now) {
  const dt = Math.min((now - lastT) / 1000, 0.05);
  lastT = now;

  if (state.phase === 'play') {
    updateHoop(dt);
    physicsStep(dt);
  } else if (state.phase === 'intro' || state.phase === 'title') {
    // Slow idle hoop sway for atmosphere
    state.hoopTime += dt;
    const lvl = LEVELS[state.level];
    hoopGroup.position.set(
      Math.sin(state.hoopTime * 0.6) * 0.2,
      0,
      -lvl.dist
    );
  }

  // Shadow follows ball
  shadow.position.x = ball.position.x;
  shadow.position.z = ball.position.z;
  const h = Math.max(0, ball.position.y - BALL_RADIUS);
  const s = Math.max(0.2, 1 - h / 8);
  shadow.scale.set(s, s, s);
  shadow.material.opacity = 0.35 * s;

  updateConfetti(dt);
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

// Boot
resetBall();
updateHUD();
showOverlay('title-card');
requestAnimationFrame(tick);

window.__test = {
  state, ballPos, ballVel, hoopGroup, ball, BALL_START, spawnConfetti, scene,
  forceShot(side = 0, up = 11, fwd = 11) {
    if (state.ballPhase !== 'idle') return 'busy';
    ballVel.set(side, up, -fwd);
    state.ballPhase = 'flying';
    state.ballsLeft -= 1;
    state.attempts += 1;
    updateHUD();
    return 'thrown';
  },
  step(n = 1, dt = 1 / 60) {
    for (let i = 0; i < n; i++) {
      if (state.phase === 'play') {
        updateHoop(dt);
        physicsStep(dt);
      }
      updateConfetti(dt);
      renderer.render(scene, camera);
    }
    return { pos: ball.position.toArray(), score: state.score, baskets: state.baskets, confettiCount: confettiState.length };
  }
};
