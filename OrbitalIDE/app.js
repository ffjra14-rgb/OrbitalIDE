/* ============================================================
   OrbitalIDE — 3D файловый менеджер с редактором кода
   ------------------------------------------------------------
   Стек:
   • Python-бэкенд (run.py) — реальная файловая система
   • Three.js — рендер сцены
   • Кастомная пружинная физика (без внешних зависимостей)
   • CodeMirror 5 — встроенный редактор

   Структура файла:
   1. Константы и метаданные типов файлов
   2. Дерево данных и API рабочей папки
   3. Инициализация Three.js
   4. Построение уровня: узлы, связи, ядро
   5. Пружинная физика
   6. Взаимодействие мышью (hover, drag, drill-down)
   7. Интерфейс: шапка, контекстное меню, модалки
   8. Редактор кода
   9. Анимационный цикл и запуск
   ============================================================ */

import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';

/* ============================================================
   1. Константы и метаданные
   ============================================================ */

const $ = (id) => document.getElementById(id);

const FOLDER_META = {
  color: '#59e1ff',
  lang: 'Папка',
  mode: null,
  folder: true,
};

// Цвета и режимы CodeMirror для популярных расширений.
const FILE_TYPES = {
  py: { color: '#63d8a2', lang: 'Python', mode: 'python' },
  js: { color: '#f5d76e', lang: 'JavaScript', mode: 'javascript' },
  mjs: { color: '#f5d76e', lang: 'JavaScript', mode: 'javascript' },
  cjs: { color: '#f5d76e', lang: 'JavaScript', mode: 'javascript' },
  jsx: { color: '#61dafb', lang: 'React JSX', mode: 'javascript' },
  ts: { color: '#5fa8ff', lang: 'TypeScript', mode: 'text/typescript' },
  tsx: { color: '#5fa8ff', lang: 'TypeScript JSX', mode: 'text/typescript' },
  cpp: { color: '#6aa8ff', lang: 'C++', mode: 'text/x-c++src' },
  cc: { color: '#6aa8ff', lang: 'C++', mode: 'text/x-c++src' },
  cxx: { color: '#6aa8ff', lang: 'C++', mode: 'text/x-c++src' },
  c: { color: '#6aa8ff', lang: 'C', mode: 'text/x-csrc' },
  h: { color: '#7db4ff', lang: 'C/C++ Header', mode: 'text/x-c++src' },
  hpp: { color: '#7db4ff', lang: 'C++ Header', mode: 'text/x-c++src' },
  cs: { color: '#b58cff', lang: 'C#', mode: 'text/x-csharp' },
  java: { color: '#ff9d6b', lang: 'Java', mode: 'text/x-java' },
  kt: { color: '#b58cff', lang: 'Kotlin', mode: 'text/x-kotlin' },
  go: { color: '#64d8e8', lang: 'Go', mode: 'text/x-go' },
  rs: { color: '#ffb36b', lang: 'Rust', mode: 'text/x-rustsrc' },
  rb: { color: '#ff7b8a', lang: 'Ruby', mode: 'text/x-ruby' },
  php: { color: '#a99cff', lang: 'PHP', mode: 'application/x-httpd-php' },
  html: { color: '#ff8a5c', lang: 'HTML', mode: 'htmlmixed' },
  htm: { color: '#ff8a5c', lang: 'HTML', mode: 'htmlmixed' },
  css: { color: '#c792ea', lang: 'CSS', mode: 'css' },
  scss: { color: '#e78ac3', lang: 'SCSS', mode: 'css' },
  less: { color: '#b7a0ff', lang: 'LESS', mode: 'css' },
  json: { color: '#8ee06b', lang: 'JSON', mode: 'application/json' },
  yml: { color: '#ff7ea8', lang: 'YAML', mode: 'yaml' },
  yaml: { color: '#ff7ea8', lang: 'YAML', mode: 'yaml' },
  toml: { color: '#ffb36b', lang: 'TOML', mode: 'toml' },
  md: { color: '#dfe9ff', lang: 'Markdown', mode: 'markdown' },
  markdown: { color: '#dfe9ff', lang: 'Markdown', mode: 'markdown' },
  txt: { color: '#9fb3d1', lang: 'Text', mode: null },
  sh: { color: '#a6e3a1', lang: 'Shell', mode: 'text/x-sh' },
  bash: { color: '#a6e3a1', lang: 'Bash', mode: 'text/x-sh' },
  zsh: { color: '#a6e3a1', lang: 'Shell', mode: 'text/x-sh' },
  sql: { color: '#e8b37a', lang: 'SQL', mode: 'text/x-sql' },
  svg: { color: '#ffb86c', lang: 'SVG', mode: 'xml' },
  xml: { color: '#ffb86c', lang: 'XML', mode: 'xml' },
  png: { color: '#ff7aa2', lang: 'Image', mode: null },
  jpg: { color: '#ff7aa2', lang: 'Image', mode: null },
  jpeg: { color: '#ff7aa2', lang: 'Image', mode: null },
  gif: { color: '#ff7aa2', lang: 'Image', mode: null },
  webp: { color: '#ff7aa2', lang: 'Image', mode: null },
  ico: { color: '#ff7aa2', lang: 'Image', mode: null },
};

const DEFAULT_FILE_META = { color: '#a9c4e8', lang: 'Text', mode: null };
const KNOWN_EXTS = new Set(Object.keys(FILE_TYPES).map((e) => '.' + e));

/* ============================================================
   2. Дерево данных и API рабочей папки
   ============================================================ */

let idCounter = 0;

// Запасной id на случай, если сервер его не прислал.
function nodeId() {
  idCounter += 1;
  return 'n' + Date.now().toString(36) + idCounter.toString(36);
}

function setParent(node, parent) {
  Object.defineProperty(node, 'parent', {
    value: parent,
    writable: true,
    configurable: true,
    enumerable: false, // не попадает в JSON.stringify — нет циклов
  });
}

function hydrate(node, parent = null) {
  if (!node || typeof node !== 'object') throw new Error('Некорректный узел дерева');
  if (!node.id) node.id = nodeId();
  node.name = String(node.name || 'untitled');
  node.type = node.type === 'folder' ? 'folder' : 'file';
  setParent(node, parent);

  if (node.type === 'folder') {
    if (!Array.isArray(node.children)) node.children = [];
    node.children = node.children.filter((child) => child && typeof child === 'object');
    node.children.forEach((child) => hydrate(child, node));
  } else {
    node.content = typeof node.content === 'string' ? node.content : '';
  }
  return node;
}

function extOf(name) {
  const i = String(name).lastIndexOf('.');
  return i > 0 ? String(name).slice(i + 1).toLowerCase() : '';
}

function metaFor(node) {
  if (!node) return DEFAULT_FILE_META;
  if (node.type === 'folder') return FOLDER_META;
  return FILE_TYPES[extOf(node.name)] || DEFAULT_FILE_META;
}

function pathTo(node) {
  const chain = [];
  let current = node;
  while (current) {
    chain.unshift(current);
    current = current.parent;
  }
  return chain;
}

function relativePath(node) {
  return pathTo(node).map((item) => item.name).join('/');
}

// Путь относительно корня рабочей папки — именно его понимает Python API.
function diskPath(node) {
  if (!node) return '';
  return pathTo(node).slice(1).map((item) => item.name).join('/');
}

function findNodeByRel(root, rel) {
  if (!rel) return root;
  let current = root;
  for (const part of String(rel).split('/')) {
    if (!current || current.type !== 'folder') return null;
    current = current.children.find((child) => child.name === part);
  }
  return current || null;
}

function containsNode(root, target) {
  if (!root || !target) return false;
  if (root === target) return true;
  if (root.type !== 'folder') return false;
  return root.children.some((child) => containsNode(child, target));
}

/* ---------- HTTP-клиент ---------- */

async function apiFetch(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body) headers['Content-Type'] = 'application/json';

  const response = await fetch(url, {
    cache: 'no-store',
    ...options,
    headers,
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message = payload && payload.error
      ? payload.error
      : `Ошибка сервера (${response.status}).`;
    throw new Error(message);
  }
  return payload;
}

const api = {
  info: () => apiFetch('/api/info'),
  tree: () => apiFetch('/api/tree'),

  create: (parent, type, name, content = '') => apiFetch('/api/create', {
    method: 'POST',
    body: JSON.stringify({ parent, type, name, content }),
  }),

  rename: (path, name) => apiFetch('/api/rename', {
    method: 'POST',
    body: JSON.stringify({ path, name }),
  }),

  remove: (path) => apiFetch('/api/delete', {
    method: 'DELETE',
    body: JSON.stringify({ path }),
  }),

  read: (path) => apiFetch('/api/read?path=' + encodeURIComponent(path)),

  write: (path, content) => apiFetch('/api/write', {
    method: 'PUT',
    body: JSON.stringify({ path, content }),
  }),
};

/*
 * Перечитывает дерево с диска, сохраняя текущую папку и позиции узлов.
 * Если открыт файл, он перепривязывается к новому объекту дерева.
 * options.editorPath позволяет указать новый путь после переименования.
 */
async function refreshTree({ preservePositions = true, editorPath } = {}) {
  const currentRel = state.current ? diskPath(state.current) : '';
  const editorRel = editorPath !== undefined
    ? editorPath
    : (editorState.file ? diskPath(editorState.file) : '');
  const tree = await api.tree();

  state.root = hydrate(tree, null);
  state.current = findNodeByRel(state.root, currentRel) || state.root;

  if (editorRel) {
    const editorFile = findNodeByRel(state.root, editorRel);
    if (editorFile && editorFile.type === 'file') {
      editorState.file = editorFile;
      state.activeFile = editorFile;
      refreshEditorMeta();
    } else {
      await closeEditor({ save: false });
      showToast('Открытый файл больше не существует', true);
    }
  }

  rebuildLevel({ preservePositions });
  updateHeader();
}

/* ============================================================
   Глобальное состояние
   ============================================================ */

const state = {
  root: null,
  current: null,
  nodes: [],        // сценические обёртки текущего уровня
  links: [],
  hovered: null,
  dragNode: null,
  activeFile: null,
  intro: null,
};

const interactives = [];
const raycaster = new THREE.Raycaster();
const pointerNDC = new THREE.Vector2();
const tmpVec = new THREE.Vector3();
const tmpVec2 = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

const gesture = {
  active: false,
  node: null,
  startX: 0,
  startY: 0,
  moved: false,
  plane: new THREE.Plane(),
  offset: new THREE.Vector3(),
  pointerId: null,
};

let orbitingPointer = false;

/* ============================================================
   3. Инициализация Three.js
   ============================================================ */

const canvas = $('scene');

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.24;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070f);
scene.fog = new THREE.FogExp2(0x05070f, 0.0028);

const camera = new THREE.PerspectiveCamera(
  46,
  window.innerWidth / window.innerHeight,
  0.1,
  600,
);
camera.position.set(0, 7, 80);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.075;
controls.rotateSpeed = 0.5;
controls.zoomSpeed = 0.85;
controls.panSpeed = 0.55;
controls.minDistance = 24;
controls.maxDistance = 170;
controls.target.set(0, 3, 0);
controls.mouseButtons = {
  LEFT: THREE.MOUSE.ROTATE,
  MIDDLE: THREE.MOUSE.DOLLY,
  RIGHT: null, // правую кнопку отдаём контекстному меню
};
controls.touches = {
  ONE: THREE.TOUCH.ROTATE,
  TWO: THREE.TOUCH.DOLLY_PAN,
};

/* ---------- Свет ---------- */

scene.add(new THREE.AmbientLight(0x8aa8ff, 1.15));

const keyLight = new THREE.DirectionalLight(0xffffff, 2.7);
keyLight.position.set(24, 34, 42);
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0x6f8cff, 1.2);
fillLight.position.set(-30, -16, 24);
scene.add(fillLight);

const cyanLight = new THREE.PointLight(0x59e1ff, 900, 180, 2);
cyanLight.position.set(-34, 16, 26);
scene.add(cyanLight);

const violetLight = new THREE.PointLight(0x8b7bff, 700, 180, 2);
violetLight.position.set(32, -20, 18);
scene.add(violetLight);

/* ---------- Общие текстуры ---------- */

function makeRadialTexture(size = 128, stops = null) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  const list = stops || [
    [0, 'rgba(255,255,255,0.95)'],
    [0.22, 'rgba(255,255,255,0.5)'],
    [0.55, 'rgba(255,255,255,0.1)'],
    [1, 'rgba(255,255,255,0)'],
  ];
  for (const [offset, color] of list) g.addColorStop(offset, color);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.userData.shared = true;
  return tex;
}

const glowTexture = makeRadialTexture(128);
const starTexture = makeRadialTexture(64, [
  [0, 'rgba(255,255,255,1)'],
  [0.18, 'rgba(255,255,255,0.95)'],
  [0.42, 'rgba(255,255,255,0.28)'],
  [1, 'rgba(255,255,255,0)'],
]);

function makeGlowSprite(color, size, opacity = 0.3) {
  const material = new THREE.SpriteMaterial({
    map: glowTexture,
    color: new THREE.Color(color),
    transparent: true,
    opacity,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(size, size, 1);
  return sprite;
}

/* ---------- Подписи узлов ---------- */

function roundRectPath(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function truncateLabel(text, max = 24) {
  const value = String(text);
  return value.length > max ? value.slice(0, max - 1) + '…' : value;
}

function makeLabelSprite(text, color) {
  const dpr = 2;
  const fontSize = 15 * dpr;
  const padX = 12 * dpr;
  const height = 33 * dpr;
  const font = `600 ${fontSize}px Inter, "Segoe UI", system-ui, -apple-system, sans-serif`;
  const display = truncateLabel(text);

  const measure = document.createElement('canvas').getContext('2d');
  measure.font = font;
  const textWidth = Math.ceil(measure.measureText(display).width);
  const width = Math.max(54 * dpr, textWidth + padX * 2);

  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d');

  // стеклянная плашка
  roundRectPath(ctx, 1.5, 1.5, width - 3, height - 3, 8 * dpr);
  ctx.fillStyle = 'rgba(4, 10, 21, 0.72)';
  ctx.fill();
  ctx.lineWidth = 1.2 * dpr;
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.42;
  ctx.stroke();
  ctx.globalAlpha = 1;

  // небольшая цветная точка типа
  ctx.beginPath();
  ctx.arc(padX * 0.45 + 2, height / 2, 2.6 * dpr, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 6 * dpr;
  ctx.fill();
  ctx.shadowBlur = 0;

  // текст
  ctx.font = font;
  ctx.fillStyle = 'rgba(230, 242, 255, 0.96)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(display, (width + padX * 0.5) / 2, height / 2 + 0.5);

  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    opacity: 0.9,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.renderOrder = 8;
  const scale = 0.021;
  sprite.scale.set(width * scale, height * scale, 1);
  return sprite;
}

/* ---------- Фон: звёзды и декоративные орбиты ---------- */

function createStarfield() {
  const count = 1500;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const palette = [
    new THREE.Color('#9cc0ff'),
    new THREE.Color('#e3ecff'),
    new THREE.Color('#59e1ff'),
    new THREE.Color('#8b7bff'),
  ];

  for (let i = 0; i < count; i += 1) {
    const radius = 78 + Math.random() * 150;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = radius * Math.cos(phi);
    positions[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);

    const color = palette[Math.floor(Math.random() * palette.length)];
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const material = new THREE.PointsMaterial({
    map: starTexture,
    size: 1.35,
    sizeAttenuation: true,
    vertexColors: true,
    transparent: true,
    opacity: 0.8,
    alphaTest: 0.01,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const stars = new THREE.Points(geometry, material);
  stars.frustumCulled = false;
  scene.add(stars);
  return stars;
}

const starfield = createStarfield();

const decorGroup = new THREE.Group();
scene.add(decorGroup);

for (const cfg of [
  { r: 13, color: 0x59e1ff, opacity: 0.075, rx: 1.18, ry: 0.15, speed: 0.012 },
  { r: 18.5, color: 0x8b7bff, opacity: 0.055, rx: 0.72, ry: 1.05, speed: -0.008 },
]) {
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(cfg.r, 0.025, 6, 160),
    new THREE.MeshBasicMaterial({
      color: cfg.color,
      transparent: true,
      opacity: cfg.opacity,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  ring.rotation.x = cfg.rx;
  ring.rotation.y = cfg.ry;
  ring.userData.speed = cfg.speed;
  decorGroup.add(ring);
}

/* ---------- Ядро текущей папки ---------- */

const coreGroup = new THREE.Group();
scene.add(coreGroup);

const coreHalo = makeGlowSprite('#59e1ff', 34, 0.26);
coreGroup.add(coreHalo);

const coreInner = new THREE.Mesh(
  new THREE.SphereGeometry(2.15, 48, 32),
  new THREE.MeshStandardMaterial({
    color: 0x07162a,
    emissive: 0x0a5c7a,
    emissiveIntensity: 1.7,
    roughness: 0.24,
    metalness: 0.72,
  }),
);
coreGroup.add(coreInner);

const coreWire = new THREE.Mesh(
  new THREE.IcosahedronGeometry(4.35, 1),
  new THREE.MeshBasicMaterial({
    color: 0x59e1ff,
    wireframe: true,
    transparent: true,
    opacity: 0.13,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }),
);
coreGroup.add(coreWire);

const coreRing = new THREE.Mesh(
  new THREE.TorusGeometry(6.1, 0.022, 6, 160),
  new THREE.MeshBasicMaterial({
    color: 0x8b7bff,
    transparent: true,
    opacity: 0.4,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }),
);
coreRing.rotation.x = 1.18;
coreRing.rotation.y = 0.42;
coreGroup.add(coreRing);

coreGroup.add(new THREE.PointLight(0x59e1ff, 260, 40, 2));

/* ---------- Группы уровня ---------- */

const levelGroup = new THREE.Group();
scene.add(levelGroup);

/* ============================================================
   4. Построение уровня
   ============================================================ */

// Общие геометрии (не уничтожаем при пересборке).
const sphereGeo = new THREE.SphereGeometry(1, 40, 28);
const crystalGeo = new THREE.IcosahedronGeometry(1, 1);
const shellGeo = new THREE.IcosahedronGeometry(1, 1);
const orbitGeo = new THREE.TorusGeometry(1.5, 0.02, 6, 96);
const stickGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);

for (const geo of [sphereGeo, crystalGeo, shellGeo, orbitGeo, stickGeo]) {
  geo.userData.shared = true;
}

function disposeLevel() {
  levelGroup.traverse((object) => {
    if (object.geometry && !object.geometry.userData.shared && !object.isSprite) {
      object.geometry.dispose();
    }
    if (object.material) {
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (material.map && !material.map.userData.shared) material.map.dispose();
        material.dispose();
      }
    }
  });
  levelGroup.clear();
}

function createNode(data, oldPositions) {
  const meta = metaFor(data);
  const color = new THREE.Color(meta.color);
  const isFolder = data.type === 'folder';
  const childCount = isFolder ? (data.children ? data.children.length : 0) : 0;
  const radius = isFolder ? 2.25 + Math.min(3, childCount) * 0.09 : 1.35;

  const group = new THREE.Group();
  group.name = `node:${data.name}`;

  const hasOldPos = oldPositions.has(data.id);
  if (hasOldPos) {
    group.position.copy(oldPositions.get(data.id));
  } else {
    group.position.set(
      (Math.random() - 0.5) * 1.6,
      (Math.random() - 0.5) * 1.6,
      (Math.random() - 0.5) * 1.6,
    );
  }

  const material = new THREE.MeshStandardMaterial({
    color,
    emissive: color.clone(),
    emissiveIntensity: isFolder ? 0.14 : 0.24,
    roughness: isFolder ? 0.3 : 0.24,
    metalness: isFolder ? 0.32 : 0.42,
    flatShading: !isFolder,
    transparent: true,
    opacity: 0.97,
  });

  const mesh = new THREE.Mesh(isFolder ? sphereGeo : crystalGeo, material);
  mesh.scale.setScalar(radius);
  group.add(mesh);

  let shell = null;
  let ring = null;

  if (isFolder) {
    shell = new THREE.Mesh(
      shellGeo,
      new THREE.MeshBasicMaterial({
        color,
        wireframe: true,
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    shell.scale.setScalar(radius * 1.34);
    group.add(shell);

    ring = new THREE.Mesh(
      orbitGeo,
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.34,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    ring.scale.setScalar(radius * 1.18);
    ring.rotation.x = 1.06;
    ring.rotation.y = 0.28;
    group.add(ring);
  }

  const halo = makeGlowSprite(meta.color, radius * (isFolder ? 7.4 : 6.6), isFolder ? 0.24 : 0.18);
  group.add(halo);

  const label = makeLabelSprite(isFolder ? data.name + '/' : data.name, meta.color);
  label.position.set(0, -(radius + (isFolder ? 1.65 : 1.45)), 0.35);
  group.add(label);

  const scale = hasOldPos ? 1 : 0.05;
  group.scale.setScalar(scale);
  levelGroup.add(group);

  const node = {
    data,
    group,
    mesh,
    shell,
    ring,
    halo,
    label,
    radius,
    color: meta.color,
    pos: group.position,
    anchor: new THREE.Vector3(),
    vel: new THREE.Vector3(),
    scale,
    phase: Math.random() * Math.PI * 2,
    restNext: 0,
  };

  mesh.userData.nodeRef = node;
  if (shell) shell.userData.nodeRef = node;
  interactives.push(mesh);
  if (shell) interactives.push(shell);

  return node;
}

function layoutAnchors() {
  const nodes = state.nodes;
  const n = nodes.length;
  if (!n) return;

  const radiusRing = Math.min(27, 14 + n * 1.3);
  const startAngle = Math.PI / 2;

  nodes.forEach((node, index) => {
    const angle = startAngle + (index / n) * Math.PI * 2;
    node.anchor.set(
      Math.cos(angle) * radiusRing,
      Math.sin(angle) * radiusRing,
      Math.sin(index * 2.4) * 2.3,
    );
  });

  for (let i = 0; i < n; i += 1) {
    const next = (i + 1) % n;
    if (n === 2 && i === 1) break;
    nodes[i].restNext = nodes[i].anchor.distanceTo(nodes[next].anchor) * 0.92;
  }
}

function addLink(a, b, color, radius, opacity, connectedNodes) {
  const material = new THREE.MeshBasicMaterial({
    color: new THREE.Color(color),
    transparent: true,
    opacity,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(stickGeo, material);
  mesh.frustumCulled = false;
  levelGroup.add(mesh);
  return {
    a,
    b,
    mesh,
    material,
    baseOpacity: opacity,
    radius,
    nodes: connectedNodes,
  };
}

function buildLinks() {
  const nodes = state.nodes;
  const n = nodes.length;
  if (!n) return;

  // Связи «ядро → узел»
  for (const node of nodes) {
    state.links.push(addLink(node.pos, null, node.color, 0.065, 0.34, [node, null]));
  }

  // Связи между соседями — именно они передают движение при перетаскивании
  if (n === 2) {
    state.links.push(addLink(nodes[0].pos, nodes[1].pos, '#7f9cff', 0.032, 0.17, [nodes[0], nodes[1]]));
  } else if (n > 2) {
    for (let i = 0; i < n; i += 1) {
      const a = nodes[i];
      const b = nodes[(i + 1) % n];
      state.links.push(addLink(a.pos, b.pos, '#7f9cff', 0.032, 0.17, [a, b]));
    }
  }
}

function updateLink(link) {
  const a = link.a;
  const b = link.b;
  const bx = b ? b.x : 0;
  const by = b ? b.y : 0;
  const bz = b ? b.z : 0;

  tmpVec2.set(bx - a.x, by - a.y, bz - a.z);
  const length = tmpVec2.length();

  if (length < 0.001) {
    link.mesh.visible = false;
    return;
  }

  link.mesh.visible = true;
  link.mesh.position.set((a.x + bx) / 2, (a.y + by) / 2, (a.z + bz) / 2);
  link.mesh.quaternion.setFromUnitVectors(UP, tmpVec2.normalize());
  link.mesh.scale.set(link.radius, length, link.radius);
}

function rebuildLevel({ preservePositions = false } = {}) {
  const oldPositions = new Map();
  if (preservePositions) {
    for (const node of state.nodes) oldPositions.set(node.data.id, node.pos.clone());
  }

  disposeLevel();
  interactives.length = 0;
  state.nodes = [];
  state.links = [];
  state.hovered = null;
  state.dragNode = null;
  gesture.active = false;
  gesture.node = null;

  const children = state.current ? state.current.children : [];
  for (const child of children) {
    state.nodes.push(createNode(child, oldPositions));
  }

  layoutAnchors();
  buildLinks();
  updateEmpty();
  canvas.style.cursor = 'grab';
}

function updateEmpty() {
  const empty = !state.current || state.current.children.length === 0;
  $('emptyHint').classList.toggle('hidden', !empty);
}

function triggerWarp() {
  const warp = $('warp');
  warp.classList.remove('run');
  void warp.offsetWidth;
  warp.classList.add('run');
}

/* ============================================================
   5. Пружинная физика
   ============================================================ */

const PHYSICS = {
  anchorK: 3.1,      // притяжение к своему месту на орбите
  linkK: 5.8,        // жёсткость связей между соседями
  repulsion: 26,     // мягкое расталкивание узлов
  damping: 2.0,      // затухание
  maxSpeed: 46,
  maxRadius: 62,
};

function physicsStep(dt) {
  const nodes = state.nodes;
  const n = nodes.length;
  if (!n) return;

  const dragged = state.dragNode;

  // 1. Пружина к «якорю» на орбите
  for (const node of nodes) {
    if (node === dragged) {
      node.vel.set(0, 0, 0);
      continue;
    }
    tmpVec.subVectors(node.anchor, node.pos);
    node.vel.addScaledVector(tmpVec, PHYSICS.anchorK * dt);
  }

  // 2. Пружины между соседними узлами
  if (n > 1) {
    const pairs = n === 2 ? 1 : n;
    for (let i = 0; i < pairs; i += 1) {
      const a = nodes[i];
      const b = nodes[(i + 1) % n];
      tmpVec.subVectors(b.pos, a.pos);
      const distance = tmpVec.length();
      if (distance < 0.0001) continue;

      const stretch = distance - a.restNext;
      const force = (stretch / distance) * PHYSICS.linkK * dt * 0.5;
      if (a !== dragged) a.vel.addScaledVector(tmpVec, force);
      if (b !== dragged) b.vel.addScaledVector(tmpVec, -force);
    }
  }

  // 3. Мягкое расталкивание, чтобы шары не слипались
  for (let i = 0; i < n; i += 1) {
    const a = nodes[i];
    for (let j = i + 1; j < n; j += 1) {
      const b = nodes[j];
      tmpVec.subVectors(b.pos, a.pos);
      const distance = tmpVec.length();
      const minDistance = (a.radius + b.radius) * 2.05;
      if (distance >= minDistance || distance < 0.0001) continue;

      const overlap = (minDistance - distance) / minDistance;
      const force = overlap * PHYSICS.repulsion * dt;
      tmpVec.multiplyScalar(1 / distance);
      if (a !== dragged) a.vel.addScaledVector(tmpVec, -force);
      if (b !== dragged) b.vel.addScaledVector(tmpVec, force);
    }
  }

  // 4. Демпфирование и интегрирование
  for (const node of nodes) {
    if (node === dragged) continue;

    node.vel.multiplyScalar(Math.exp(-PHYSICS.damping * dt));

    const speed = node.vel.length();
    if (speed > PHYSICS.maxSpeed) node.vel.multiplyScalar(PHYSICS.maxSpeed / speed);

    node.pos.addScaledVector(node.vel, dt);

    const distanceFromCenter = node.pos.length();
    if (distanceFromCenter > PHYSICS.maxRadius) {
      node.pos.multiplyScalar(PHYSICS.maxRadius / distanceFromCenter);
      node.vel.multiplyScalar(0.25);
    }
  }
}

function simulatePhysics(dt) {
  const steps = 2;
  for (let i = 0; i < steps; i += 1) physicsStep(dt / steps);
}

/* ============================================================
   6. Взаимодействие мышью
   ============================================================ */

function setPointerFromEvent(event) {
  const rect = canvas.getBoundingClientRect();
  pointerNDC.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointerNDC.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
}

function pickNode(event) {
  setPointerFromEvent(event);
  raycaster.setFromCamera(pointerNDC, camera);
  const hits = raycaster.intersectObjects(interactives, false);
  for (const hit of hits) {
    const node = hit.object.userData.nodeRef;
    if (node) return node;
  }
  return null;
}

function updateHover(event) {
  if (event.target !== canvas) {
    if (state.hovered) {
      state.hovered = null;
      canvas.style.cursor = 'grab';
    }
    return;
  }
  const node = pickNode(event);
  state.hovered = node;
  canvas.style.cursor = node ? 'pointer' : 'grab';
}

function activateNode(sceneNode) {
  const data = sceneNode && sceneNode.data;
  if (!data) return;
  if (data.type === 'folder') {
    enterFolder(data);
  } else {
    openEditor(data);
  }
}

function enterFolder(data) {
  if (!data || data.type !== 'folder' || data === state.current) return;
  closeContextMenu();
  state.current = data;
  rebuildLevel();
  updateHeader();
  triggerWarp();
}

function goBack() {
  if (state.current && state.current.parent) {
    enterFolder(state.current.parent);
  }
}

function onPointerDownCapture(event) {
  if (event.button !== 0) return;
  if (event.target !== canvas) return;

  if (state.intro) state.intro.active = false;
  closeContextMenu();

  if (!state.current) return;

  const node = pickNode(event);
  if (!node) {
    orbitingPointer = true;
    canvas.style.cursor = 'grabbing';
    return;
  }

  // Клик по узлу: готовим потенциальный drag.
  gesture.active = true;
  gesture.node = node;
  gesture.startX = event.clientX;
  gesture.startY = event.clientY;
  gesture.moved = false;
  gesture.pointerId = event.pointerId;

  // Плоскость, параллельная экрану и проходящая через узел.
  camera.getWorldDirection(tmpVec);
  gesture.plane.setFromNormalAndCoplanarPoint(tmpVec.negate(), node.pos);
  raycaster.setFromCamera(pointerNDC, camera);

  const hit = new THREE.Vector3();
  if (raycaster.ray.intersectPlane(gesture.plane, hit)) {
    gesture.offset.copy(node.pos).sub(hit);
  } else {
    gesture.offset.set(0, 0, 0);
  }

  canvas.style.cursor = 'grabbing';
  event.preventDefault();
  event.stopPropagation(); // OrbitControls не должен вращать камеру при drag узла
}

function onPointerMove(event) {
  if (gesture.active && event.pointerId === gesture.pointerId) {
    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;

    if (!gesture.moved && Math.hypot(dx, dy) > 5) {
      gesture.moved = true;
      state.dragNode = gesture.node;
      document.body.classList.add('grabbing');
    }

    if (gesture.moved && gesture.node) {
      setPointerFromEvent(event);
      raycaster.setFromCamera(pointerNDC, camera);
      const hit = new THREE.Vector3();
      if (raycaster.ray.intersectPlane(gesture.plane, hit)) {
        gesture.node.pos.copy(hit).add(gesture.offset);
        gesture.node.vel.set(0, 0, 0);
      }
      event.preventDefault();
      event.stopPropagation();
    }
    return;
  }

  if (orbitingPointer) return;
  updateHover(event);
}

function onPointerUp(event) {
  if (gesture.active) {
    const node = gesture.node;
    const wasMoved = gesture.moved;

    gesture.active = false;
    gesture.node = null;
    gesture.moved = false;
    state.dragNode = null;
    document.body.classList.remove('grabbing');
    canvas.style.cursor = state.hovered ? 'pointer' : 'grab';

    if (!wasMoved && node) {
      activateNode(node);
    }
  }

  if (orbitingPointer) {
    orbitingPointer = false;
    canvas.style.cursor = state.hovered ? 'pointer' : 'grab';
  }
}

function onPointerCancel() {
  if (gesture.active) {
    gesture.active = false;
    gesture.node = null;
    gesture.moved = false;
    state.dragNode = null;
    document.body.classList.remove('grabbing');
  }
  orbitingPointer = false;
  canvas.style.cursor = 'grab';
}

function onContextMenu(event) {
  event.preventDefault();
  if (state.intro) state.intro.active = false;
  closeContextMenu();

  const node = pickNode(event);
  if (node) {
    state.hovered = node;
    showNodeMenu(node, event.clientX, event.clientY);
  } else {
    state.hovered = null;
    showSceneMenu(event.clientX, event.clientY);
  }
}

function onResize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height, false);
}

window.addEventListener('pointerdown', onPointerDownCapture, true);
window.addEventListener('pointermove', onPointerMove, true);
window.addEventListener('pointerup', onPointerUp, true);
window.addEventListener('pointercancel', onPointerCancel, true);
window.addEventListener('resize', onResize);
canvas.addEventListener('contextmenu', onContextMenu);
canvas.addEventListener('wheel', () => {
  if (state.intro) state.intro.active = false;
}, { passive: true });

/* ============================================================
   7. Интерфейс: шапка, меню, модалки
   ============================================================ */

function plural(number, one, few, many) {
  const n = Math.abs(number) % 100;
  const n1 = n % 10;
  if (n > 10 && n < 20) return many;
  if (n1 > 1 && n1 < 5) return few;
  if (n1 === 1) return one;
  return many;
}

function updateHeader() {
  const current = state.current;
  if (!current) return;

  const crumbs = $('crumbs');
  crumbs.innerHTML = '';

  const chain = pathTo(current);

  if (chain.length === 1) {
    // В корне показываем бренд вместо дублирующего названия папки.
    const brand = document.createElement('span');
    brand.className = 'crumb-brand';
    brand.textContent = 'ORBITALIDE';
    crumbs.append(brand);
  } else {
    // Текущая папка уже есть в заголовке — в крошках только её предки.
    chain.slice(0, -1).forEach((folder, index) => {
      if (index > 0) {
        const separator = document.createElement('span');
        separator.className = 'crumb-sep';
        separator.textContent = '/';
        crumbs.append(separator);
      }

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'crumb';
      button.textContent = folder.name;
      button.addEventListener('click', () => enterFolder(folder));
      crumbs.append(button);
    });
  }

  $('folderTitle').textContent = current.name;
  document.title = `${current.name} — OrbitalIDE`;

  const folders = current.children.filter((child) => child.type === 'folder').length;
  const files = current.children.length - folders;
  $('folderMeta').textContent = `${folders} ${plural(folders, 'папка', 'папки', 'папок')} · ${files} ${plural(files, 'файл', 'файла', 'файлов')}`;

  const back = $('backBtn');
  back.disabled = !current.parent;
  back.classList.toggle('disabled', !current.parent);
}

/* ---------- Тост ---------- */

let toastTimer = null;

function showToast(message, isError = false) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.toggle('error', Boolean(isError));
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}

/* ---------- Валидация имён ---------- */

function sanitizeName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function validateName(name, parent, ignore = null) {
  if (!name) return 'Имя не может быть пустым.';
  if (name === '.' || name === '..') return 'Такое имя использовать нельзя.';
  if (name.length > 64) return 'Максимум 64 символа.';
  if (/[\\/:*?"<>|]/.test(name)) return 'Имя не должно содержать \\ / : * ? " < > |.';
  if (parent && parent.children.some(
    (child) => child !== ignore && child.name.toLowerCase() === name.toLowerCase(),
  )) {
    return 'Элемент с таким именем уже существует.';
  }
  return '';
}

function composeFileName(rawName, extension) {
  const name = sanitizeName(rawName);
  if (!name) return '';
  const lastDot = name.lastIndexOf('.');
  const hasExtension = lastDot > 0
    && lastDot < name.length - 1
    && !name.slice(lastDot).includes(' ');
  if (hasExtension || name.startsWith('.')) return name;
  return name + (extension || '.txt');
}

function replaceKnownExtension(input, extension) {
  const raw = input.value.trim();
  const match = raw.match(/^(.*)\.([A-Za-z0-9]+)$/);
  if (match && match[1] && KNOWN_EXTS.has('.' + match[2].toLowerCase())) {
    input.value = match[1] + extension;
  }
}

/* ---------- Контекстное меню ---------- */

function closeContextMenu() {
  const menu = $('contextMenu');
  if (!menu) return;
  menu.classList.add('hidden');
  menu.innerHTML = '';
  menu.style.left = '';
  menu.style.top = '';
}

function showContextMenu(items, x, y, head = '') {
  const menu = $('contextMenu');
  menu.innerHTML = '';

  if (head) {
    const header = document.createElement('div');
    header.className = 'menu-head';
    header.textContent = head;
    menu.append(header);
  }

  for (const item of items) {
    if (item.sep) {
      const separator = document.createElement('div');
      separator.className = 'menu-sep';
      menu.append(separator);
      continue;
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'menu-item' + (item.danger ? ' danger' : '');
    button.setAttribute('role', 'menuitem');

    const icon = document.createElement('span');
    icon.className = 'menu-icon';
    icon.textContent = item.icon || '·';

    const label = document.createElement('span');
    label.className = 'menu-label';
    label.textContent = item.label;

    button.append(icon, label);

    if (item.key) {
      const key = document.createElement('span');
      key.className = 'menu-key';
      key.textContent = item.key;
      button.append(key);
    }

    button.addEventListener('click', () => {
      closeContextMenu();
      item.action();
    });

    menu.append(button);
  }

  menu.classList.remove('hidden');
  const rect = menu.getBoundingClientRect();
  const margin = 12;
  const left = Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin));
  const top = Math.max(margin, Math.min(y, window.innerHeight - rect.height - margin));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function showSceneMenu(x, y) {
  const items = [
    { icon: '📁', label: 'Создать папку', action: openCreateFolder },
    { icon: '📄', label: 'Создать файл', action: openCreateFile },
    { sep: true },
  ];

  if (state.current !== state.root) {
    items.push({
      icon: '⌂',
      label: 'В корень проекта',
      action: () => enterFolder(state.root),
    });
  }

  items.push({
    icon: '↻',
    label: 'Пересобрать сцену',
    action: () => {
      rebuildLevel({ preservePositions: false });
      showToast('Сцена пересобрана');
    },
  });

  items.push({ sep: true });
  items.push({
    icon: '⟲',
    label: 'Обновить с диска',
    action: () => refreshFromDisk(),
  });

  showContextMenu(items, x, y, 'Действия');
}

function showNodeMenu(sceneNode, x, y) {
  const data = sceneNode.data;
  const isFolder = data.type === 'folder';

  const items = [
    {
      icon: isFolder ? '↳' : '✎',
      label: isFolder ? 'Открыть папку' : 'Открыть в редакторе',
      key: 'ЛКМ',
      action: () => activateNode(sceneNode),
    },
    { sep: true },
    {
      icon: '✏',
      label: 'Переименовать',
      key: 'F2',
      action: () => openRename(data),
    },
    {
      icon: '🗑',
      label: 'Удалить',
      danger: true,
      action: () => confirmDelete(data),
    },
  ];

  showContextMenu(items, x, y, data.name + (isFolder ? '/' : ''));
}

/* ---------- Модальные окна ---------- */

const modalState = {
  validate: null,
  onSubmit: null,
  getValues: null,
};

function isModalOpen() {
  return !$('modalRoot').classList.contains('hidden');
}

function createModalField(field) {
  const wrapper = document.createElement('div');
  wrapper.className = 'field';
  wrapper.dataset.field = field.name;

  const label = document.createElement('label');
  label.htmlFor = `mf-${field.name}`;
  label.textContent = field.label;
  wrapper.append(label);

  let control;
  if (field.type === 'select') {
    control = document.createElement('select');
    for (const option of field.options || []) {
      const element = document.createElement('option');
      element.value = option.value;
      element.textContent = option.label;
      control.append(element);
    }
    control.value = field.value || (field.options && field.options[0] ? field.options[0].value : '');
  } else {
    control = document.createElement('input');
    control.type = 'text';
    control.value = field.value || '';
    control.placeholder = field.placeholder || '';
    control.autocomplete = 'off';
    control.spellcheck = false;
    control.maxLength = 64;
  }

  control.id = `mf-${field.name}`;
  control.dataset.name = field.name;
  wrapper.append(control);

  if (field.hint) {
    const hint = document.createElement('div');
    hint.className = 'field-hint';
    hint.textContent = field.hint;
    wrapper.append(hint);
  }

  const error = document.createElement('div');
  error.className = 'field-error';
  wrapper.append(error);

  const clearInvalid = () => wrapper.classList.remove('invalid');
  control.addEventListener('input', clearInvalid);
  control.addEventListener('change', clearInvalid);

  return wrapper;
}

function getModalValues() {
  const values = {};
  $('modalFields').querySelectorAll('[data-name]').forEach((element) => {
    values[element.dataset.name] = element.value;
  });
  return values;
}

function setModalError(message, fieldName = 'name') {
  const fields = $('modalFields');
  fields.querySelectorAll('.field').forEach((field) => field.classList.remove('invalid'));

  let target = fields.querySelector(`.field[data-field="${fieldName}"]`);
  if (!target) target = fields.querySelector('.field');

  if (target) {
    target.classList.add('invalid');
    const error = target.querySelector('.field-error');
    if (error) error.textContent = message;
    const control = target.querySelector('input, select');
    if (control) control.focus();
  }
}

function openModal(options) {
  closeContextMenu();

  const root = $('modalRoot');
  const fields = $('modalFields');
  const form = $('modalForm');

  $('modalTitle').textContent = options.title || '';
  $('modalSubtitle').textContent = options.subtitle || '';
  fields.innerHTML = '';

  for (const field of options.fields || []) {
    fields.append(createModalField(field));
  }

  if (options.extra) fields.append(options.extra);

  const submit = $('modalSubmit');
  submit.textContent = options.submitLabel || 'Готово';
  submit.className = 'primary-btn' + (options.danger ? ' danger' : '');

  modalState.validate = options.validate || null;
  modalState.onSubmit = options.onSubmit || null;
  modalState.getValues = getModalValues;

  form.onsubmit = async (event) => {
    event.preventDefault();
    if (!modalState.onSubmit || submit.disabled) return;

    const values = modalState.getValues();
    const validation = modalState.validate ? modalState.validate(values) : null;
    if (validation) {
      const message = typeof validation === 'string' ? validation : validation.message;
      const field = typeof validation === 'string' ? 'name' : validation.field;
      setModalError(message, field);
      return;
    }

    // Операции с диском асинхронные: блокируем кнопку, чтобы не отправить
    // один и тот же запрос дважды, и показываем ошибку прямо в форме.
    const label = submit.textContent;
    submit.disabled = true;
    submit.classList.add('busy');

    try {
      const result = await modalState.onSubmit(values);
      if (result !== false) closeModal();
    } catch (error) {
      console.error('[OrbitalIDE] Ошибка модального окна:', error);
      setModalError(error.message || String(error), 'name');
      showToast('Ошибка: ' + error.message, true);
    } finally {
      submit.disabled = false;
      submit.classList.remove('busy');
      submit.textContent = label;
    }
  };

  if (typeof options.onMount === 'function') {
    options.onMount({
      form,
      fields,
      getValues: getModalValues,
    });
  }

  root.classList.remove('hidden');

  setTimeout(() => {
    const first = fields.querySelector('input, select');
    if (first) {
      first.focus();
      if (first.select && first.tagName === 'INPUT') first.select();
    }
  }, 60);
}

function closeModal() {
  const root = $('modalRoot');
  root.classList.add('hidden');
  $('modalForm').onsubmit = null;
  modalState.validate = null;
  modalState.onSubmit = null;
  modalState.getValues = null;
}

/* ---------- Создание, переименование, удаление ---------- */

function openCreateFolder() {
  if (!state.current) return;
  const parentRel = diskPath(state.current);

  openModal({
    title: 'Создать папку',
    subtitle: `Новая папка внутри «${state.current.name}»`,
    submitLabel: 'Создать папку',
    fields: [
      {
        name: 'name',
        label: 'Имя папки',
        placeholder: 'components',
        hint: 'Например: components, api, assets. Пробелы по краям обрезаются.',
      },
    ],
    validate: (values) => {
      const name = sanitizeName(values.name);
      if (!name) return { message: 'Введите имя папки.', field: 'name' };
      const error = validateName(name, state.current, null);
      return error ? { message: error, field: 'name' } : null;
    },
    onSubmit: async (values) => {
      const name = sanitizeName(values.name);
      await api.create(parentRel, 'folder', name);
      await refreshTree();
      showToast(`Папка «${name}» создана на диске`);
    },
  });
}

function openCreateFile() {
  if (!state.current) return;
  const parentRel = diskPath(state.current);

  const preview = document.createElement('div');
  preview.className = 'field-preview';

  openModal({
    title: 'Создать файл',
    subtitle: `Новый файл внутри «${state.current.name}»`,
    submitLabel: 'Создать файл',
    fields: [
      {
        name: 'name',
        label: 'Имя файла',
        placeholder: 'main.cpp',
        hint: 'Можно ввести расширение вручную или выбрать его в списке ниже.',
      },
      {
        name: 'ext',
        type: 'select',
        label: 'Расширение',
        value: '.txt',
        options: [
          { value: '.txt', label: '.txt — обычный текст' },
          { value: '.py', label: '.py — Python' },
          { value: '.cpp', label: '.cpp — C++' },
          { value: '.js', label: '.js — JavaScript' },
          { value: '.ts', label: '.ts — TypeScript' },
          { value: '.html', label: '.html — HTML' },
          { value: '.css', label: '.css — CSS' },
          { value: '.json', label: '.json — JSON' },
          { value: '.md', label: '.md — Markdown' },
          { value: '.go', label: '.go — Go' },
          { value: '.rs', label: '.rs — Rust' },
          { value: '.sh', label: '.sh — Shell' },
          { value: '.yml', label: '.yml — YAML' },
        ],
      },
    ],
    extra: preview,
    onMount: ({ getValues }) => {
      const nameInput = $('mf-name');
      const extSelect = $('mf-ext');

      const updatePreview = () => {
        const finalName = composeFileName(getValues().name, getValues().ext);
        preview.textContent = '';
        if (!finalName) {
          preview.textContent = 'Введите имя файла, чтобы увидеть результат.';
          return;
        }
        preview.append('Будет создан: ');
        const strong = document.createElement('b');
        strong.textContent = finalName;
        preview.append(strong);
      };

      nameInput.addEventListener('input', updatePreview);
      extSelect.addEventListener('change', () => {
        replaceKnownExtension(nameInput, extSelect.value);
        updatePreview();
      });
      updatePreview();
    },
    validate: (values) => {
      const finalName = composeFileName(values.name, values.ext);
      if (!finalName) return { message: 'Введите имя файла.', field: 'name' };
      const error = validateName(finalName, state.current, null);
      return error ? { message: error, field: 'name' } : null;
    },
    onSubmit: async (values) => {
      const finalName = composeFileName(values.name, values.ext);
      await api.create(parentRel, 'file', finalName, '');

      const createdRel = parentRel ? `${parentRel}/${finalName}` : finalName;
      await refreshTree();
      showToast(`Файл «${finalName}» создан на диске`);

      const created = findNodeByRel(state.root, createdRel);
      if (created && created.type === 'file') await openEditor(created);
    },
  });
}

function openRename(data) {
  if (!data || !data.parent) return;

  openModal({
    title: 'Переименовать',
    subtitle: data.type === 'folder' ? 'Папка' : 'Файл',
    submitLabel: 'Переименовать',
    fields: [
      {
        name: 'name',
        label: 'Новое имя',
        value: data.name,
        hint: data.type === 'file' ? 'Расширение можно изменить — стиль узла обновится.' : '',
      },
    ],
    validate: (values) => {
      const name = sanitizeName(values.name);
      if (!name) return { message: 'Введите новое имя.', field: 'name' };
      if (name === data.name) return { message: 'Имя не изменилось.', field: 'name' };
      const error = validateName(name, data.parent, data);
      return error ? { message: error, field: 'name' } : null;
    },
    onSubmit: async (values) => {
      const name = sanitizeName(values.name);
      const oldRel = diskPath(data);
      const oldEditorRel = editorState.file ? diskPath(editorState.file) : '';
      const editorInside = Boolean(oldEditorRel)
        && (oldEditorRel === oldRel || oldEditorRel.startsWith(oldRel + '/'));

      // Сохраняем открытый файл до переименования, чтобы содержимое
      // не осталось записанным по старому пути.
      if (editorState.file) {
        const saved = await saveEditor({ silent: true });
        if (!saved) return false;
      }

      await api.rename(oldRel, name);

      let newEditorRel;
      if (editorInside) {
        newEditorRel = oldEditorRel === oldRel
          ? name
          : name + oldEditorRel.slice(oldRel.length);
      }

      await refreshTree({ editorPath: newEditorRel });
      showToast(`«${data.name}» переименован в «${name}»`);
    },
  });
}

function countTree(node) {
  if (!node || node.type !== 'folder') return 0;
  return node.children.reduce((sum, child) => (
    sum + 1 + (child.type === 'folder' ? countTree(child) : 0)
  ), 0);
}

function confirmDelete(data) {
  if (!data || !data.parent) return;

  const isFolder = data.type === 'folder';
  const descendants = isFolder ? countTree(data) : 0;
  const warning = isFolder && descendants > 0
    ? `Папка «${data.name}» и всё её содержимое (${descendants} ${plural(descendants, 'элемент', 'элемента', 'элементов')}) будут удалены с диска безвозвратно.`
    : `«${data.name}» будет удалён с диска безвозвратно.`;

  openModal({
    title: isFolder ? 'Удалить папку?' : 'Удалить файл?',
    subtitle: warning,
    submitLabel: 'Удалить',
    danger: true,
    fields: [],
    validate: () => null,
    onSubmit: async () => {
      const targetRel = diskPath(data);
      const editorInside = Boolean(editorState.file && containsNode(data, editorState.file));

      // Сохраняем открытый файл перед удалением: если удаление не удастся,
      // пользователь не потеряет последние правки.
      if (editorInside) {
        const saved = await saveEditor({ silent: true });
        if (!saved) return false;
      }

      await api.remove(targetRel);

      if (editorInside) await closeEditor({ save: false });
      await refreshTree();
      showToast(`Удалено с диска: ${data.name}`);
    },
  });
}

let refreshInFlight = false;

/**
 * Перечитывает рабочую папку с диска. Используется кнопкой ⟲,
 * пунктом меню и после изменений, сделанных снаружи.
 */
async function refreshFromDisk({ announce = true } = {}) {
  if (refreshInFlight) return false;
  refreshInFlight = true;

  try {
    const editorRel = editorState.file ? diskPath(editorState.file) : '';

    if (editorState.file) {
      const saved = await saveEditor({ silent: true });
      if (!saved) return false;
    }

    await refreshTree();

    // Перечитываем открытый файл, чтобы показать изменения, сделанные
    // снаружи, а не только обновить дерево.
    if (editorRel && editorState.file) {
      const node = findNodeByRel(state.root, editorRel);
      if (node && node.type === 'file') await openEditor(node, { force: true });
    }

    if (announce) showToast('Дерево обновлено с диска');
    return true;
  } catch (error) {
    console.error('[OrbitalIDE] Не удалось обновить дерево:', error);
    showToast('Не удалось обновить: ' + (error.message || error), true);
    return false;
  } finally {
    refreshInFlight = false;
  }
}

/* ---------- Глобальные обработчики интерфейса ---------- */

$('backBtn').addEventListener('click', goBack);
$('newFolderBtn').addEventListener('click', openCreateFolder);
$('newFileBtn').addEventListener('click', openCreateFile);
$('resetBtn').addEventListener('click', () => refreshFromDisk());

$('modalRoot').addEventListener('click', (event) => {
  if (event.target.closest('[data-close]')) closeModal();
});

document.addEventListener('pointerdown', (event) => {
  const menu = $('contextMenu');
  if (menu && !menu.contains(event.target)) closeContextMenu();
});

window.addEventListener('resize', closeContextMenu);

/* ============================================================
   8. Встроенный редактор кода
   ============================================================ */

const editorState = {
  file: null,
  dirty: false,
  syncing: false,
  savedContent: '',
  loading: false,
};

let cm = null;
let autoSaveTimer = null;
let openToken = 0;
let saveChain = Promise.resolve();

function initEditor() {
  if (cm) return;
  if (typeof window.CodeMirror === 'undefined') {
    $('cmHost').innerHTML = '<div style="padding:24px;color:#8ba1c4;font-size:13px">Не удалось загрузить CodeMirror. Проверьте папку vendor/.</div>';
    return;
  }

  cm = window.CodeMirror($('cmHost'), {
    value: '',
    mode: null,
    theme: 'orbital',
    lineNumbers: true,
    lineWrapping: false,
    tabSize: 2,
    indentUnit: 2,
    indentWithTabs: false,
    autofocus: false,
    extraKeys: {
      Tab: (instance) => instance.replaceSelection('  ', 'end'),
      'Shift-Tab': (instance) => instance.execCommand('indentLess'),
    },
  });

  cm.on('change', () => {
    if (editorState.syncing || !editorState.file) return;
    editorState.dirty = true;
    updateDirty();
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => saveEditor({ silent: true }), 900);
  });

  cm.on('cursorActivity', updateCursor);
}

function updateDirty() {
  $('dirtyDot').classList.toggle('show', editorState.dirty);
}

function updateCursor() {
  if (!cm || !editorState.file) return;
  const cursor = cm.getCursor();
  $('editorStatus').textContent = `Стр ${cursor.line + 1}, стлб ${cursor.ch + 1} · Ctrl+S — сохранить`;
}

function refreshEditorMeta() {
  if (!editorState.file) return;
  const file = editorState.file;
  const meta = metaFor(file);

  $('editorName').textContent = file.name;
  $('editorPath').textContent = relativePath(file);
  $('editorLang').textContent = meta.lang;

  const dot = $('editorDot');
  dot.style.background = meta.color;
  dot.style.boxShadow = `0 0 12px ${meta.color}`;

  if (cm) cm.setOption('mode', meta.mode || null);
}

function setEditorValue(value) {
  editorState.syncing = true;
  cm.setValue(value);
  cm.clearHistory();
  editorState.syncing = false;
}

/**
 * Читает настоящий файл с диска и показывает его в CodeMirror.
 * Токен защищает от ситуации, когда пользователь быстро открыл
 * другой файл, пока предыдущий ещё читался.
 */
async function openEditor(file, { force = false } = {}) {
  if (!file || file.type !== 'file' || !cm) return false;

  // Повторный клик по уже открытому файлу не должен перечитывать диск
  // и терять несохранённые изменения — просто фокусируем редактор.
  // force используется кнопкой «Обновить с диска».
  if (
    !force
    && editorState.file
    && diskPath(editorState.file) === diskPath(file)
    && $('editorPanel').classList.contains('open')
  ) {
    cm.focus();
    return true;
  }

  const token = ++openToken;
  clearTimeout(autoSaveTimer);

  if (editorState.file && editorState.file !== file) {
    const saved = await saveEditor({ silent: true });
    if (!saved) return false;
  }
  if (token !== openToken) return false;

  editorState.loading = true;
  $('editorStatus').textContent = 'Чтение файла с диска…';

  let payload;
  try {
    payload = await api.read(diskPath(file));
  } catch (error) {
    if (token === openToken) {
      editorState.loading = false;
      showToast('Не удалось открыть файл: ' + (error.message || error), true);
      updateCursor();
    }
    return false;
  }

  if (token !== openToken) return false;
  editorState.loading = false;

  if (payload.binary) {
    showToast('Бинарный файл — встроенный редактор его не открывает', true);
    updateCursor();
    return false;
  }

  const content = typeof payload.content === 'string' ? payload.content : '';

  editorState.file = file;
  file.content = content;
  file.size = payload.size;
  editorState.savedContent = content;
  editorState.dirty = false;

  setEditorValue(content);
  refreshEditorMeta();
  updateDirty();
  updateCursor();

  state.activeFile = file;
  $('editorPanel').classList.add('open');
  $('editorPanel').setAttribute('aria-hidden', 'false');
  document.body.classList.add('editor-open');

  requestAnimationFrame(() => {
    if (!cm || editorState.file !== file) return;
    cm.refresh();
    cm.focus();
  });

  setTimeout(() => {
    if (cm && $('editorPanel').classList.contains('open')) cm.refresh();
  }, 360);

  return true;
}

/**
 * Сохраняет содержимое редактора на диск. Записи выполняются
 * последовательно, поэтому быстрые Ctrl+S и автосохранение
 * не могут обогнать друг друга.
 */
function saveEditor({ silent = false } = {}) {
  if (!cm || !editorState.file) return Promise.resolve(true);

  const file = editorState.file;
  const path = diskPath(file);
  const content = cm.getValue();
  file.content = content;

  if (content === editorState.savedContent) {
    editorState.dirty = false;
    updateDirty();
    if (!silent) showToast('Изменений нет');
    return Promise.resolve(true);
  }

  editorState.dirty = false;
  updateDirty();

  const run = async () => {
    try {
      await api.write(path, content);
      file.content = content;

      if (editorState.file === file) {
        editorState.savedContent = content;
        const stillDirty = cm.getValue() !== content;
        editorState.dirty = stillDirty;
        updateDirty();
      }

      if (!silent) showToast('Файл сохранён на диск');
      return true;
    } catch (error) {
      console.error('[OrbitalIDE] Ошибка сохранения:', error);
      if (editorState.file === file) {
        editorState.dirty = true;
        updateDirty();
      }
      showToast('Не удалось сохранить: ' + (error.message || error), true);
      return false;
    }
  };

  const queued = saveChain.then(run, run);
  saveChain = queued.then(() => {}, () => {});
  return queued;
}

async function closeEditor({ save = true } = {}) {
  const hadFile = Boolean(editorState.file);
  const panelOpen = $('editorPanel').classList.contains('open');
  if (!hadFile && !panelOpen) {
    ++openToken; // отменяем чтение, если панель ещё не успела открыться
    return true;
  }

  const token = ++openToken;
  clearTimeout(autoSaveTimer);

  if (save && hadFile) {
    const saved = await saveEditor({ silent: true });
    // Если записать не удалось, не закрываем редактор — иначе
    // несохранённый текст пропадёт безвозвратно.
    if (!saved) return false;
    // Пока шла запись, пользователь мог открыть другой файл.
    if (token !== openToken) return false;
  }

  $('editorPanel').classList.remove('open');
  $('editorPanel').setAttribute('aria-hidden', 'true');
  document.body.classList.remove('editor-open');

  if (cm) setEditorValue('');
  state.activeFile = null;
  editorState.file = null;
  editorState.dirty = false;
  editorState.savedContent = '';
  editorState.loading = false;
  updateDirty();
  return true;
}

$('saveBtn').addEventListener('click', () => saveEditor());
$('closeEditorBtn').addEventListener('click', closeEditor);

/* ============================================================
   Горячие клавиши
   ============================================================ */

function isTypingTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

function onKeyDown(event) {
  if (event.key === 'Escape') {
    if (isModalOpen()) {
      event.preventDefault();
      closeModal();
      return;
    }
    if (!$('contextMenu').classList.contains('hidden')) {
      event.preventDefault();
      closeContextMenu();
      return;
    }
    if ($('editorPanel').classList.contains('open')) {
      event.preventDefault();
      closeEditor();
      return;
    }
  }

  if (isModalOpen()) return;

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    if (editorState.file) {
      event.preventDefault();
      saveEditor();
    }
    return;
  }

  if (event.key === 'F2' && state.hovered && !isTypingTarget(event.target)) {
    event.preventDefault();
    openRename(state.hovered.data);
    return;
  }

  if (event.altKey && event.key === 'ArrowLeft') {
    if (state.current && state.current.parent) {
      event.preventDefault();
      goBack();
    }
    return;
  }

  if (event.key === 'Backspace' && !isTypingTarget(event.target) && !editorState.file) {
    if (state.current && state.current.parent) {
      event.preventDefault();
      goBack();
    }
  }
}

document.addEventListener('keydown', onKeyDown, true);

window.addEventListener('beforeunload', () => {
  if (!cm || !editorState.file) return;

  const content = cm.getValue();
  // Сравниваем с последним сохранённым текстом, а не только с флагом dirty:
  // во время записи флаг уже сброшен, но запрос ещё может не дойти до диска.
  if (content === editorState.savedContent) return;

  const body = JSON.stringify({
    path: diskPath(editorState.file),
    content,
  });

  try {
    // sendBeacon доживает до закрытия вкладки; сервер принимает и POST.
    if (navigator.sendBeacon) {
      const blob = new Blob([body], { type: 'application/json' });
      if (navigator.sendBeacon('/api/write', blob)) return;
    }
    fetch('/api/write', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    });
  } catch (error) {
    console.error('[OrbitalIDE] Не удалось сохранить при закрытии:', error);
  }
});

/* ============================================================
   9. Анимационный цикл и запуск
   ============================================================ */

const clock = new THREE.Clock();

function updateVisuals(dt, elapsed) {
  const dragged = state.dragNode;

  for (const node of state.nodes) {
    const hovered = state.hovered === node;
    const draggedNow = dragged === node;
    const active = Boolean(editorState.file && node.data === editorState.file);

    const targetScale = 1 * (hovered ? 1.12 : 1) * (draggedNow ? 1.06 : 1);
    node.scale += (targetScale - node.scale) * Math.min(1, dt * 10);
    node.group.scale.setScalar(Math.max(0.02, node.scale));

    const bob = Math.sin(elapsed * 0.9 + node.phase) * 0.16;
    node.mesh.position.y = bob;
    node.mesh.rotation.y += dt * (node.data.type === 'folder' ? 0.1 : 0.24);
    node.mesh.rotation.x += dt * 0.035;

    if (node.shell) {
      node.shell.position.y = bob;
      node.shell.rotation.y -= dt * 0.12;
      node.shell.rotation.z += dt * 0.05;
    }

    if (node.ring) {
      node.ring.position.y = bob;
      node.ring.rotation.z += dt * 0.16;
    }

    node.halo.position.y = bob * 0.4;

    const material = node.mesh.material;
    const baseEmissive = node.data.type === 'folder' ? 0.14 : 0.24;
    const targetEmissive = baseEmissive
      + (hovered ? 0.22 : 0)
      + (active ? 0.16 + Math.sin(elapsed * 4) * 0.06 : 0);
    material.emissiveIntensity += (targetEmissive - material.emissiveIntensity) * Math.min(1, dt * 8);

    if (node.shell) {
      const targetOpacity = 0.16 + (hovered ? 0.2 : 0) + (active ? 0.12 : 0);
      node.shell.material.opacity += (targetOpacity - node.shell.material.opacity) * Math.min(1, dt * 8);
    }

    if (node.ring) {
      const targetOpacity = 0.34 + (hovered ? 0.24 : 0);
      node.ring.material.opacity += (targetOpacity - node.ring.material.opacity) * Math.min(1, dt * 8);
    }

    node.halo.material.opacity += (
      ((hovered || active ? 0.42 : (node.data.type === 'folder' ? 0.24 : 0.18)) - node.halo.material.opacity)
      * Math.min(1, dt * 8)
    );

    node.label.material.opacity += (
      ((hovered || active ? 1 : 0.9) - node.label.material.opacity) * Math.min(1, dt * 8)
    );
  }

  const highlighted = dragged || state.hovered;
  for (const link of state.links) {
    updateLink(link);
    const connected = Boolean(highlighted && link.nodes
      && (link.nodes[0] === highlighted || link.nodes[1] === highlighted));
    const targetOpacity = connected ? Math.min(0.9, link.baseOpacity * 2.5) : link.baseOpacity;
    link.material.opacity += (targetOpacity - link.material.opacity) * Math.min(1, dt * 10);
  }
}

function animate() {
  requestAnimationFrame(animate);

  const dt = Math.min(clock.getDelta(), 0.05);
  const elapsed = clock.elapsedTime;

  simulatePhysics(dt);
  updateVisuals(dt, elapsed);

  // Декоративные орбиты
  starfield.rotation.y += dt * 0.004;
  starfield.rotation.x += dt * 0.0015;

  decorGroup.children.forEach((ring) => {
    ring.rotation.z += dt * (ring.userData.speed || 0);
  });

  coreGroup.rotation.y = elapsed * 0.1;
  coreGroup.rotation.x = Math.sin(elapsed * 0.2) * 0.07;
  coreWire.rotation.y = -elapsed * 0.16;
  coreRing.rotation.z = elapsed * 0.12;
  coreInner.material.emissiveIntensity = 1.65 + Math.sin(elapsed * 1.5) * 0.18;

  // Вступительный полёт камеры
  if (state.intro && state.intro.active) {
    state.intro.t = Math.min(1, state.intro.t + dt / 1.7);
    const eased = 1 - Math.pow(1 - state.intro.t, 3);
    camera.position.lerpVectors(state.intro.from, state.intro.to, eased);
    if (state.intro.t >= 1) state.intro.active = false;
  }

  controls.update();
  renderer.render(scene, camera);
}

let animationStarted = false;
let booting = false;

function setBootState({ title, path, retry }) {
  const boot = $('boot');
  if (title !== undefined) $('bootTitle').textContent = title;
  if (path !== undefined) $('bootPath').textContent = path;
  if (retry !== undefined) {
    $('bootRetry').classList.toggle('hidden', !retry);
  }
  if (title !== undefined || path !== undefined) boot.classList.remove('hidden');
}

/**
 * Подключается к рабочей папке: узнаёт её путь, читает дерево с диска
 * и только после этого показывает сцену. Никаких демо-файлов нет.
 */
async function boot() {
  if (booting) return;
  booting = true;

  const retryBtn = $('bootRetry');
  retryBtn.disabled = true;
  setBootState({
    title: 'Подключаюсь к рабочей папке…',
    path: '',
    retry: false,
  });

  try {
    const info = await api.info();
    setBootState({ path: info.path });

    const tree = await api.tree();
    state.root = hydrate(tree, null);
    state.current = state.root;
    state.intro = {
      active: true,
      t: 0,
      from: new THREE.Vector3(0, 26, 128),
      to: new THREE.Vector3(0, 7, 80),
    };

    initEditor();
    rebuildLevel();
    updateHeader();

    if (!animationStarted) {
      animationStarted = true;
      animate();
    }

    setBootState({ retry: false });
    $('boot').classList.add('hidden');
  } catch (error) {
    console.error('[OrbitalIDE] Не удалось подключиться к рабочей папке:', error);
    const reason = error && error.message ? error.message : String(error);
    setBootState({
      title: 'Не удалось подключиться к рабочей папке',
      path: `${reason}\nПроверьте, что run.py запущен, и нажмите «Повторить».`,
      retry: true,
    });
  } finally {
    booting = false;
    retryBtn.disabled = false;
  }
}

$('bootRetry').addEventListener('click', () => boot());

/* Небольшой отладочный API: удобно из консоли браузера и для автотестов. */
window.OrbitalIDE = {
  get state() {
    return state;
  },
  get editor() {
    return editorState;
  },
  get three() {
    return { scene, camera, renderer, controls, levelGroup };
  },
  api,
  boot,
  refreshTree,
  refreshFromDisk,
  saveEditor,
  enterFolder,
  goBack,
  rebuildLevel,
  openEditor,
  closeEditor,
  openCreateFolder,
  openCreateFile,
  openRename,
  confirmDelete,
  projectNode(name) {
    const node = state.nodes.find(
      (item) => item.data.name === name || `${item.data.name}/` === name,
    );
    if (!node) return null;
    tmpVec.copy(node.pos).project(camera);
    const rect = canvas.getBoundingClientRect();
    return {
      name: node.data.name,
      type: node.data.type,
      x: rect.left + ((tmpVec.x + 1) / 2) * rect.width,
      y: rect.top + ((-tmpVec.y + 1) / 2) * rect.height,
    };
  },
  openFolder(name) {
    const target = state.current
      && state.current.children.find((child) => child.type === 'folder' && child.name === name);
    if (target) enterFolder(target);
    return Boolean(target);
  },
};

boot();
