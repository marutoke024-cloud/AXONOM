/* ============================================================
   AXONOM — home.js
   ホーム画面のすべての動きを担当する。
   1. Three.js：積層フロアを軸測投影で描く3Dインタラクティブ背景
   2. GSAP   ：ページロード演出・テーマ切替・ページ遷移
   3. PWA    ：Service Worker の登録
   ============================================================ */

import * as THREE from "three";

/* JSが動いていることをCSSへ伝える（登場アニメの初期状態を有効化） */
document.documentElement.classList.add("js");

/* OSの「視差効果を減らす」設定を尊重する */
const prefersReducedMotion =
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ------------------------------------------------------------
   テーマカラーの取得
   CSSカスタムプロパティを読むことで、CSSとJS（3D側）の
   色定義を一元化する。
   ------------------------------------------------------------ */
function readThemeColors() {
  const style = getComputedStyle(document.documentElement);
  const pick = (name) => style.getPropertyValue(name).trim();
  return {
    bg: pick("--color-bg"),
    surface: pick("--color-surface"),
    surface2: pick("--color-surface-2"),
    ink: pick("--color-ink"),
    line: pick("--color-line"),
    accent: pick("--color-accent"),
    accentSoft: pick("--color-accent-soft"),
  };
}

/* ============================================================
   1. Three.js — 積層フロアの3D背景
   ============================================================ */

const canvas = document.getElementById("bg-canvas");

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: true, // 背景はCSS側の色を活かすため透過
});
/* 内蔵GPUでも軽快に動くよう、ピクセル比は1.75で頭打ちにする */
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));

const scene = new THREE.Scene();

/* 軸測投影（パース無し）＝アプリの世界観そのものなので
   OrthographicCamera を採用する */
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
camera.position.set(12, 10, 12);
camera.lookAt(0, 1.2, 0);

/* 柔らかい屋内光：環境光＋天空光＋弱い平行光 */
const hemiLight = new THREE.HemisphereLight(0xffffff, 0xb8b1a4, 1.1);
scene.add(hemiLight);

const dirLight = new THREE.DirectionalLight(0xffffff, 1.4);
dirLight.position.set(6, 12, 4);
scene.add(dirLight);

/* ---- 積層フロアの構築 -------------------------------------- */

const stack = new THREE.Group(); // フロア全体（回転・パララックスの単位）
scene.add(stack);

/* マテリアルは後からテーマ色で塗り替えるため参照を保持する */
const materials = {
  slabTop: new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0 }),
  slabMid: new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0 }),
  slabBottom: new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0 }),
  rack: new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0 }),
  edge: new THREE.LineBasicMaterial({ transparent: true, opacity: 0.5 }),
};

const SLAB_SIZE = 6; // フロア一辺
const SLAB_THICKNESS = 0.22; // フロア厚
const FLOOR_GAP = 1.5; // 階層間の空き

const slabGeometry = new THREE.BoxGeometry(SLAB_SIZE, SLAB_THICKNESS, SLAB_SIZE);
const slabEdges = new THREE.EdgesGeometry(slabGeometry);

/* ラック（小箱）の配置を各階ごとに定義。
   乱数ではなく手置きにして、どのテーマでも構図が崩れないようにする。
   [x, z, 幅, 奥行, 高さ] */
const rackLayouts = [
  /* 1F：受電・空調エリアのイメージ。大きめの設備を点在させる */
  [
    [-1.8, -1.6, 1.2, 0.8, 0.7],
    [0.4, -1.8, 0.8, 0.8, 0.5],
    [1.9, 0.2, 0.7, 1.6, 0.6],
    [-1.5, 1.6, 1.6, 0.7, 0.45],
  ],
  /* 2F：サーバ室のイメージ。ラック列を平行に並べる */
  [
    [-1.6, -1.2, 0.55, 2.4, 0.85],
    [-0.5, -1.2, 0.55, 2.4, 0.85],
    [0.6, -1.2, 0.55, 2.4, 0.85],
    [1.7, -1.2, 0.55, 2.4, 0.85],
    [-0.2, 1.8, 1.8, 0.6, 0.5],
  ],
  /* 3F：会議室・オフィスのイメージ。低くゆったり */
  [
    [-1.4, -1.4, 1.7, 1.1, 0.4],
    [1.5, -1.0, 0.9, 0.9, 0.4],
    [0.9, 1.5, 1.5, 0.8, 0.35],
  ],
];

const slabPivots = []; // ふわふわ浮遊アニメ用に各階の親を保持

rackLayouts.forEach((racks, floorIndex) => {
  /* 各階を1つのピボットにまとめる（浮遊は階単位で動かす） */
  const pivot = new THREE.Group();
  pivot.position.y = floorIndex * (SLAB_THICKNESS + FLOOR_GAP);
  stack.add(pivot);
  slabPivots.push(pivot);

  /* フロアプレート本体 */
  const slabMaterial =
    floorIndex === 2 ? materials.slabTop :
    floorIndex === 1 ? materials.slabMid : materials.slabBottom;
  const slab = new THREE.Mesh(slabGeometry, slabMaterial);
  pivot.add(slab);

  /* プレートの輪郭線：図面らしさを足すアクセント */
  const outline = new THREE.LineSegments(slabEdges, materials.edge);
  pivot.add(outline);

  /* ラック群 */
  racks.forEach(([x, z, w, d, h]) => {
    const rack = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      materials.rack
    );
    /* プレート上面に接地させる */
    rack.position.set(x, SLAB_THICKNESS / 2 + h / 2, z);
    pivot.add(rack);
  });
});

/* ---- テーマ色の適用（GSAPで滑らかに補間） ------------------- */

function applyThemeToScene(animated = true) {
  const colors = readThemeColors();
  const targets = [
    [materials.slabTop.color, colors.accent],
    [materials.slabMid.color, colors.surface2],
    [materials.slabBottom.color, colors.ink],
    [materials.rack.color, colors.surface],
    [materials.edge.color, colors.ink],
  ];
  targets.forEach(([colorObj, hex]) => {
    const to = new THREE.Color(hex);
    if (animated && window.gsap && !prefersReducedMotion) {
      gsap.to(colorObj, { r: to.r, g: to.g, b: to.b, duration: 0.6, ease: "power2.out" });
    } else {
      colorObj.copy(to);
    }
  });
}

applyThemeToScene(false);

/* ---- レイアウト（リサイズ対応） ----------------------------- */

function layout() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);

  /* 画面の縦横比に応じて正投影の視界を決める。
     縦長（モバイル）では引き気味にして全体を収める */
  const aspect = w / h;
  const frustumHeight = aspect > 1 ? 11 : 15;
  camera.top = frustumHeight / 2;
  camera.bottom = -frustumHeight / 2;
  camera.left = (-frustumHeight * aspect) / 2;
  camera.right = (frustumHeight * aspect) / 2;
  camera.updateProjectionMatrix();

  /* デスクトップでは文字を左に置くため、モチーフを右へ寄せる。
     モバイルでは中央上部に配置する */
  if (aspect > 1) {
    /* 見出しとの重なりを減らすため、モチーフはやや右寄りに置く */
    stack.position.set(frustumHeight * aspect * 0.28, 0, 0);
  } else {
    stack.position.set(0, 2.2, 0);
  }
}

layout();
window.addEventListener("resize", layout);

/* ---- ポインタ追従（パララックス） --------------------------- */

const pointer = { x: 0, y: 0 }; // -1〜1 に正規化した現在値

window.addEventListener("pointermove", (e) => {
  pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
  pointer.y = (e.clientY / window.innerHeight) * 2 - 1;
});

/* ---- 描画ループ --------------------------------------------- */

const clock = new THREE.Clock();

function render() {
  const t = clock.getElapsedTime();

  /* 各階をわずかに浮遊させる（位相をずらして有機的に） */
  slabPivots.forEach((pivot, i) => {
    const baseY = i * (SLAB_THICKNESS + FLOOR_GAP);
    pivot.position.y = baseY + Math.sin(t * 0.6 + i * 1.3) * 0.12;
  });

  /* ゆっくり旋回しつつ、ポインタ方向へ滑らかに傾ける */
  const targetRotY = t * 0.08 + pointer.x * 0.25;
  const targetRotX = pointer.y * 0.08;
  stack.rotation.y += (targetRotY - stack.rotation.y) * 0.05;
  stack.rotation.x += (targetRotX - stack.rotation.x) * 0.05;

  renderer.render(scene, camera);
}

if (prefersReducedMotion) {
  /* 動きを減らす設定時は静止画として1回だけ描く */
  render();
  window.addEventListener("resize", render);
} else {
  renderer.setAnimationLoop(render);
}

/* ============================================================
   2. GSAP — 登場演出・テーマ切替・ページ遷移
   ============================================================ */

function runIntro() {
  if (!window.gsap || prefersReducedMotion) {
    /* GSAP未読込・動き削減時は最終状態を直接適用する */
    document.querySelectorAll(".reveal").forEach((el) => (el.style.opacity = 1));
    document.querySelectorAll(".hero-title .line-inner")
      .forEach((el) => (el.style.transform = "none"));
    return;
  }

  const tl = gsap.timeline({ defaults: { ease: "expo.out" } });

  /* 3Dモチーフ：下から組み上がる */
  tl.from(stack.scale, { x: 0.6, y: 0.6, z: 0.6, duration: 1.6 }, 0);
  slabPivots.forEach((pivot, i) => {
    tl.from(pivot.position, { y: -4, duration: 1.4 }, 0.12 * i);
  });

  /* 見出し：行マスクからせり上がる */
  tl.to(".hero-title .line-inner", {
    y: 0,
    duration: 1.1,
    stagger: 0.12,
  }, 0.35);

  /* その他の要素：順にフェードイン */
  tl.to(".reveal", {
    opacity: 1,
    duration: 0.9,
    stagger: 0.06,
  }, 0.7);
}

/* GSAPはdefer読込のため、DOM準備完了後に開始する */
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", runIntro);
} else {
  runIntro();
}

/* ---- テーマパレット切替 -------------------------------------- */

const themeDots = document.querySelectorAll(".theme-dot");

/* 前回選んだテーマを復元（エディタ画面と共有のキー） */
const savedTheme = localStorage.getItem("axonom:theme");
if (savedTheme && document.querySelector(`.theme-dot[data-theme-name="${savedTheme}"]`)) {
  document.documentElement.dataset.theme = savedTheme;
  themeDots.forEach((d) =>
    d.classList.toggle("is-active", d.dataset.themeName === savedTheme));
  applyThemeToScene(false);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = readThemeColors().bg;
}

themeDots.forEach((dot) => {
  dot.addEventListener("click", () => {
    /* data-theme を差し替えるだけでCSS側は全て連動する */
    document.documentElement.dataset.theme = dot.dataset.themeName;
    localStorage.setItem("axonom:theme", dot.dataset.themeName);

    themeDots.forEach((d) => d.classList.toggle("is-active", d === dot));

    /* 3Dシーンとブラウザのテーマカラーも追従させる */
    applyThemeToScene(true);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = readThemeColors().bg;
  });
});

/* ---- ページ遷移（Start Creating → editor.html） -------------- */

const startBtn = document.getElementById("start-btn");

startBtn.addEventListener("click", (e) => {
  if (!window.gsap || prefersReducedMotion) return; // 通常遷移に任せる

  e.preventDefault();
  const href = startBtn.getAttribute("href");

  /* インク色の幕が下から立ち上がってから遷移する */
  gsap.timeline()
    .to(".page-transition", {
      scaleY: 1,
      duration: 0.55,
      ease: "power3.inOut",
    })
    .add(() => { window.location.href = href; });
});

/* ============================================================
   3. PWA — Service Worker 登録
   ============================================================ */

/* URLに ?nosw を付けると登録をスキップできる（開発・検証用） */
const noServiceWorker = new URLSearchParams(location.search).has("nosw");

if ("serviceWorker" in navigator && !noServiceWorker) {
  /* file:// で開いた場合などは登録できないため失敗は握りつぶす */
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

/* 開発・検証用のフック（DevToolsからシーンを覗くため） */
window.__axonom = { renderer, scene, camera, stack, materials };
