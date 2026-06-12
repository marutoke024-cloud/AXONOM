/* ============================================================
   AXONOM — editor.js（図面エディタ本体）

   ■ 実装方式の選択と理由
   「Canvas 2D ＋ 自前の軸測投影エンジン ＋ polygon-clipping」を採用。
   - Canvas 2D : X/Y/Z軸の角度スライダーで図面全体の見え方を
     リアルタイムに変えるには、全座標を自前の投影行列で変換して
     描き直すのが最も自然。SVGやKonva/Fabricはシーングラフが
     2D平面前提のため、擬似3D（押し出し・斜め視点・階層の立体配置）を
     後付けするとライブラリと戦うことになる。
     Canvas 2Dなら「ワールド座標(x, y, 高さz) → 投影 → 描画」を
     一本道で制御でき、タッチ/マウスも Pointer Events で統一できる。
   - polygon-clipping (Martinezアルゴリズム / MIT) : PowerPointの
     「図形の結合」と同等のBoolean演算（接合・型抜き・抽出・除外）を
     堅牢に行うため採用。穴あきポリゴンにも対応。
   - アイコンは本ファイル内のインラインSVG文字列のみで完結
     （外部画像への依存なし）。data URL経由でキャンバスに描画する。

   ■ 座標系
   - ワールド座標 : フロア平面が (x, y)、高さが z（上向き）。
   - 投影         : M = Ry(角度Y) * Rx(角度X) * Rz(角度Z) の回転後、
                    平行投影（x, y成分が画面、z成分が奥行き）。
   - キャビネット図 : 回転ではなく「平面そのまま＋高さを斜め45°へ
                    1/2スケールでオフセット」する斜投影として実装。
   ============================================================ */

"use strict";

/* ============================================================
   1. 定数・DOM参照
   ============================================================ */

const canvas = document.getElementById("stage");
const ctx = canvas.getContext("2d");
const stageWrap = document.getElementById("stage-wrap");
const overlayLayer = document.getElementById("overlay-layer");
const hintEl = document.getElementById("hint");

const GRID = 20;             // グリッド1マスのワールド単位
const FLOOR_GAP = 170;       // 階層間の高さ（ワールド単位）
const DEFAULT_HEIGHT = 60;   // 図形押し出しの初期厚み
const MIN_DRAG = 6;          // これ未満のドラッグはクリック扱い

/* CSSカスタムプロパティを読む（テーマ連動の要） */
const cssVar = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/* ============================================================
   2. 状態
   ============================================================ */

let idSeq = 1;
const uid = () => "s" + (idSeq++);

/* ドキュメント＝フロアの配列。index 0 が最下階 */
const doc = { floors: [] };

function newFloor(name) {
  return { id: uid(), name, visible: true, shapes: [] };
}

doc.floors.push(newFloor("1F"));
let activeFloorId = doc.floors[0].id;

/* ビュー（投影・ズーム・パン） */
const view = {
  ax: 0, ay: 0, az: 0,  // 角度（度）
  ob: 0,                 // キャビネット図の斜投影係数（0=無効）
  zoom: 1,
  panX: 0, panY: 0,
};
let last3D = { ax: 60, ay: 0, az: 45, ob: 0 }; // 3Dモード復帰用に記憶

/* UI状態 */
const ui = {
  tool: "select",       // select / rect / ngon / lshape / free / text / icon
  iconKind: null,       // tool=icon のときの種類
  selection: [],        // 選択中の図形ID（選択順を保持）
  vertexEditId: null,   // 頂点編集中の図形ID
  freePts: null,        // 自由多角形の作成中頂点
  freeCursor: null,     // 自由多角形のプレビュー用カーソル位置
  gridShow: true,
  snap: true,
  multiSelect: false,   // ON中はタップ/クリックが追加選択になる（タッチ向け）
  drag: null,           // 進行中のドラッグ情報
  clipboard: null,      // コピー内容(JSON)
};

/* ============================================================
   3. Undo / Redo（ドキュメントのスナップショット方式）
   ============================================================ */

const undoStack = [];
const redoStack = [];

const snapshot = () =>
  JSON.stringify({ floors: doc.floors, activeFloorId, idSeq });

function pushUndo() {
  undoStack.push(snapshot());
  if (undoStack.length > 60) undoStack.shift();
  redoStack.length = 0;
}

function restore(json) {
  const d = JSON.parse(json);
  doc.floors = d.floors;
  activeFloorId = d.activeFloorId;
  idSeq = d.idSeq;
  ui.selection = [];
  ui.vertexEditId = null;
  renderFloorsPanel();
  renderProps();
  requestRender();
}

function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  restore(undoStack.pop());
}

function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  restore(redoStack.pop());
}

/* ============================================================
   4. 投影エンジン
   ============================================================ */

/* 3x3行列（行優先）。初期値は単位行列＝真上からの平面図 */
let M = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function mul3(a, b) {
  const r = new Array(9);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      r[i * 3 + j] =
        a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return r;
}

function updateMatrix() {
  const rad = (d) => (d * Math.PI) / 180;
  const cx = Math.cos(rad(view.ax)), sx = Math.sin(rad(view.ax));
  const cy = Math.cos(rad(view.ay)), sy = Math.sin(rad(view.ay));
  const cz = Math.cos(rad(view.az)), sz = Math.sin(rad(view.az));

  /* Z回転（平面の向き）→ X回転（前後の傾き）→ Y回転（左右の傾き） */
  const Rz = [cz, -sz, 0, sz, cz, 0, 0, 0, 1];
  const Rx = [1, 0, 0, 0, cx, -sx, 0, sx, cx];
  const Ry = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
  M = mul3(Ry, mul3(Rx, Rz));

  if (view.ob > 0) {
    /* キャビネット図：平面は無歪みのまま、高さだけ斜め右上へ */
    M = Rz.slice();
    M[2] = view.ob * 0.707;   // zの画面x成分
    M[5] = -view.ob * 0.707;  // zの画面y成分（上方向）
    M[8] = 1;
  }
}

/* ワールド(x, y, z) → 画面座標と奥行き */
function project(x, y, z = 0) {
  return {
    x: (M[0] * x + M[1] * y + M[2] * z) * view.zoom + view.panX,
    y: (M[3] * x + M[4] * y + M[5] * z) * view.zoom + view.panY,
    d: M[6] * x + M[7] * y + M[8] * z,
  };
}

/* 画面座標 → 高さzの平面上のワールド(x, y) */
function unproject(sx, sy, z = 0) {
  const px = (sx - view.panX) / view.zoom - M[2] * z;
  const py = (sy - view.panY) / view.zoom - M[5] * z;
  const det = M[0] * M[4] - M[1] * M[3];
  return {
    x: (M[4] * px - M[1] * py) / det,
    y: (M[0] * py - M[3] * px) / det,
  };
}

/* 高さ方向が画面に現れるか（平面図なら false） */
const zVisible = () => Math.abs(M[2]) + Math.abs(M[5]) > 1e-6;
const isPlanView = () =>
  view.ax === 0 && view.ay === 0 && view.ob === 0;

/* フロアの床面の高さ */
const floorElev = (floorIndex) => floorIndex * FLOOR_GAP;

/* スナップ */
const snapV = (v) => (ui.snap ? Math.round(v / GRID) * GRID : v);

/* ============================================================
   5. DCアイコンライブラリ（インラインSVG）
   {{C}} が描画色に置換される。
   ============================================================ */

const SVG_HEAD =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" fill="none" ' +
  'stroke="{{C}}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">';

const ICONS = {
  rack: { label: "サーバーラック", svg: SVG_HEAD +
    '<rect x="12" y="5" width="24" height="38" rx="2"/>' +
    '<path d="M12 13h24M12 21h24M12 29h24M12 37h24"/></svg>' },
  mdf: { label: "MDF", svg: SVG_HEAD +
    '<rect x="9" y="5" width="30" height="38" rx="2"/>' +
    '<path d="M14 12h20M14 18h20M14 24h20"/>' +
    '<text x="24" y="38" text-anchor="middle" font-size="10" font-weight="700" ' +
    'font-family="sans-serif" fill="{{C}}" stroke="none">MDF</text></svg>' },
  idf: { label: "IDF", svg: SVG_HEAD +
    '<rect x="9" y="5" width="30" height="38" rx="2"/>' +
    '<path d="M14 12h20M14 18h20M14 24h20"/>' +
    '<text x="24" y="38" text-anchor="middle" font-size="10" font-weight="700" ' +
    'font-family="sans-serif" fill="{{C}}" stroke="none">IDF</text></svg>' },
  ahu: { label: "壁吹き空調 (AHU)", svg: SVG_HEAD +
    '<rect x="6" y="8" width="36" height="24" rx="3"/>' +
    '<circle cx="24" cy="20" r="6.5"/>' +
    '<path d="M24 13.5v13M18.4 16.8l11.2 6.4M29.6 16.8l-11.2 6.4"/>' +
    '<path d="M13 37l-2 5M24 37v5M35 37l2 5"/></svg>' },
  crac: { label: "冷却 (CRAC/CRAH)", svg: SVG_HEAD +
    '<rect x="13" y="4" width="22" height="40" rx="2"/>' +
    '<path d="M24 30V12M24 12l-4.5 4.5M24 12l4.5 4.5"/>' +
    '<path d="M18 37h12"/></svg>' },
  ups: { label: "UPS", svg: SVG_HEAD +
    '<rect x="8" y="10" width="32" height="28" rx="3"/>' +
    '<path d="M26 15l-7 10h5.5L21 33l8.5-12H24z" fill="{{C}}" stroke="none"/></svg>' },
  generator: { label: "非常用発電機", svg: SVG_HEAD +
    '<rect x="5" y="17" width="31" height="21" rx="2"/>' +
    '<path d="M36 23h7v9h-7M11 17v-6h9"/>' +
    '<circle cx="14" cy="27.5" r="4"/>' +
    '<path d="M27 21.5l-3.6 6h3.6l-2 5.5"/></svg>' },
  reception: { label: "受付端末", svg: SVG_HEAD +
    '<rect x="12" y="6" width="24" height="16" rx="2"/>' +
    '<path d="M24 22v7M16 33h16M13 40h22"/></svg>' },
  biometric: { label: "生体情報スキャナ", svg: SVG_HEAD +
    '<rect x="13" y="5" width="22" height="38" rx="4"/>' +
    '<path d="M24 31c-2.8 0-5-2.2-5-5s2.2-5 5-5 5 2.2 5 5"/>' +
    '<path d="M24 35.5c-5.2 0-9.5-4.3-9.5-9.5S18.8 16.5 24 16.5s9.5 4.3 9.5 9.5"/></svg>' },
  gate: { label: "セキュリティゲート", svg: SVG_HEAD +
    '<rect x="5" y="8" width="9" height="32" rx="1.5"/>' +
    '<rect x="34" y="8" width="9" height="32" rx="1.5"/>' +
    '<path d="M14 17c6 4.5 14 4.5 20 0"/><path d="M14 31h7M27 31h7"/></svg>' },
  camera: { label: "監視カメラ", svg: SVG_HEAD +
    '<path d="M7 17l24-6 2.4 9.5L9.5 27z"/>' +
    '<circle cx="29.5" cy="15.5" r="2.2"/>' +
    '<path d="M14 27l-2.5 9H5"/>' +
    '<path d="M36 22l7 4M37.5 17l8-1.5" opacity="0.55"/></svg>' },
  tree: { label: "植栽（木々）", svg: SVG_HEAD +
    '<circle cx="24" cy="15" r="9"/><circle cx="14.5" cy="23" r="6.5"/>' +
    '<circle cx="33.5" cy="23" r="6.5"/>' +
    '<path d="M24 29v14M24 36l-5-4M24 33.5l5-4"/></svg>' },
  carGate: { label: "車両門 / 人用門", svg: SVG_HEAD +
    '<rect x="5" y="24" width="7" height="18" rx="1.5"/>' +
    '<path d="M12 27l31-8.5"/>' +
    '<path d="M19 25.2l1.3 4.8M27 23l1.3 4.8M35 20.8l1.3 4.8" opacity="0.7"/></svg>' },
};

/* SVG → Image のキャッシュ（kind|色 をキーに） */
const iconImgCache = new Map();

function iconImage(kind, tint) {
  const key = kind + "|" + tint;
  if (iconImgCache.has(key)) return iconImgCache.get(key);
  const svg = ICONS[kind].svg.replaceAll("{{C}}", tint);
  const img = new Image();
  img.onload = requestRender; // 読み込み完了で再描画
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  iconImgCache.set(key, img);
  return img;
}

/* ============================================================
   5b. DCアイコンの3Dモデル
   擬似3Dビュー（角度付き・キャビネット図）では、平面記号の代わりに
   「箱・角柱の組み合わせ」で作った立体モデルを描く。
   各モデルは投影行列を通して描画されるため、X/Y/Z角度の変更にも
   正しく追従する。平面図（真上）では従来のSVG記号のまま。

   パーツ形式: { ring(底面のワールド座標), z0(床からの高さ),
                h(パーツの高さ), color, alpha? }
   寸法はアイコンの footprint（s.w × s.h）を基準にした相対値。
   ============================================================ */

/* 中心(cx,cy)・幅w・奥行dの矩形リング */
function boxRing(cx, cy, w, d) {
  return [
    [cx - w / 2, cy - d / 2], [cx + w / 2, cy - d / 2],
    [cx + w / 2, cy + d / 2], [cx - w / 2, cy + d / 2],
  ];
}

/* 中心(cx,cy)・半径rのn角形リング（樹冠などの丸い形に使う） */
function ngonRing3D(cx, cy, r, n = 8) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return pts;
}

/* 角柱を1本描く（drawPolyの押し出しと同じ painter 方式） */
function drawPrism(ring, z0, h, color, alpha = 1) {
  const prevAlpha = ctx.globalAlpha;
  ctx.globalAlpha *= alpha;
  if (h > 0) {
    const faces = [];
    for (let i = 0; i < ring.length; i++) {
      const p1 = ring[i], p2 = ring[(i + 1) % ring.length];
      const a = project(p1[0], p1[1], z0);
      const b = project(p2[0], p2[1], z0);
      const c = project(p2[0], p2[1], z0 + h);
      const d = project(p1[0], p1[1], z0 + h);
      const lit = b.x - a.x > 0 ? 0.82 : 0.6; // 簡易ライティング
      faces.push({ pts: [a, b, c, d], d: (a.d + b.d) / 2, lit });
    }
    faces.sort((f1, f2) => f1.d - f2.d);
    faces.forEach((f) => {
      ctx.beginPath();
      f.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.fillStyle = shade(color, f.lit);
      ctx.fill();
    });
  }
  /* 上面 */
  ctx.beginPath();
  ring.forEach(([x, y], i) => {
    const p = project(x, y, z0 + h);
    i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
  });
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.globalAlpha = prevAlpha;
}

/* モデル定義。s（アイコン図形）からパーツ配列を返す。
   B(...) = 箱パーツの省略記法 */
const ICON_MODELS = {

  /* サーバーラック：縦長の筐体 */
  rack: (s, T) => {
    const u = s.w;
    return [
      B(s, 0, 0, u * 0.78, s.h * 0.78, 0, u * 1.5, T),
      B(s, 0, 0, u * 0.6, s.h * 0.6, u * 1.5, u * 0.04, shade(T, 0.8)),
    ];
  },

  /* MDF：幅広の配線盤キャビネット */
  mdf: (s, T) => [
    B(s, 0, 0, s.w * 0.95, s.h * 0.55, 0, s.w * 1.25, T),
  ],

  /* IDF：MDFより小ぶり */
  idf: (s, T) => [
    B(s, 0, 0, s.w * 0.72, s.h * 0.5, 0, s.w * 0.95, T),
  ],

  /* 壁吹き空調 (AHU)：横長の機体＋上部ユニット */
  ahu: (s, T) => [
    B(s, 0, 0, s.w * 0.95, s.h * 0.55, 0, s.w * 0.6, "#aab4b6"),
    B(s, -s.w * 0.25, 0, s.w * 0.28, s.h * 0.32, s.w * 0.6, s.w * 0.14, shade("#aab4b6", 0.85)),
  ],

  /* 冷却 (CRAC/CRAH)：背の高い空調筐体＋天面キャップ */
  crac: (s, T) => [
    B(s, 0, 0, s.w * 0.6, s.h * 0.6, 0, s.w * 1.35, "#9fb6bd"),
    B(s, 0, 0, s.w * 0.66, s.h * 0.66, s.w * 1.35, s.w * 0.1, "#8aa6ae"),
  ],

  /* UPS：明るいキャビネット＋黒い基台（参考画像準拠） */
  ups: (s, T) => [
    B(s, 0, 0, s.w * 0.85, s.h * 0.6, 0, s.w * 0.07, "#3a3733"),
    B(s, 0, 0, s.w * 0.8, s.h * 0.55, s.w * 0.07, s.w * 1.1, "#e9e2d2"),
    B(s, 0, s.h * 0.05, s.w * 0.5, s.h * 0.45, s.w * 1.17, s.w * 0.04, "#d9d0bc"),
  ],

  /* 非常用発電機：黒スキッド＋エンジン＋発電機＋排気管（参考画像準拠） */
  generator: (s, T) => [
    B(s, 0, 0, s.w * 1.05, s.h * 0.55, 0, s.w * 0.1, "#33312e"),
    B(s, -s.w * 0.15, 0, s.w * 0.6, s.h * 0.45, s.w * 0.1, s.w * 0.5, "#ccd6d2"),
    B(s, s.w * 0.36, 0, s.w * 0.26, s.h * 0.38, s.w * 0.1, s.w * 0.42, "#b9c6c1"),
    B(s, -s.w * 0.18, -s.h * 0.05, s.w * 0.1, s.h * 0.1, s.w * 0.6, s.w * 0.32, "#8d9995"),
  ],

  /* 受付端末：カウンター＋モニター */
  reception: (s, T) => [
    B(s, 0, 0, s.w * 0.8, s.h * 0.42, 0, s.w * 0.45, "#cfc4ae"),
    B(s, 0, -s.h * 0.06, s.w * 0.3, s.h * 0.05, s.w * 0.45, s.w * 0.26, T),
  ],

  /* 生体情報スキャナ：細い支柱＋読み取りパネル */
  biometric: (s, T) => [
    B(s, 0, 0, s.w * 0.16, s.h * 0.16, 0, s.w * 0.58, T),
    B(s, 0, -s.h * 0.04, s.w * 0.26, s.h * 0.18, s.w * 0.58, s.w * 0.07, cssVar("--color-accent")),
  ],

  /* セキュリティゲート：金属ペデスタル2基＋ガラスフラップ（参考画像準拠） */
  gate: (s, T) => {
    const u = s.w, metal = "#b6bcc2", glass = "#cfe0ea";
    return [
      B(s, -u * 0.38, 0, u * 0.24, s.h * 0.85, 0, u * 0.5, metal),
      B(s, u * 0.38, 0, u * 0.24, s.h * 0.85, 0, u * 0.5, metal),
      /* ガラスパネル：ペデスタル上に立つ薄い板（半透明） */
      { ring: boxRing(s.x - u * 0.38, s.y, u * 0.04, s.h * 0.7), z0: u * 0.5, h: u * 0.62, color: glass, alpha: 0.5 },
      { ring: boxRing(s.x + u * 0.38, s.y, u * 0.04, s.h * 0.7), z0: u * 0.5, h: u * 0.62, color: glass, alpha: 0.5 },
    ];
  },

  /* 監視カメラ：支柱＋向きに合わせたヘッド（視野扇形は床面に別描画） */
  camera: (s, T) => {
    const u = s.w;
    const dir = ((s.dir || 0) * Math.PI) / 180;
    return [
      B(s, 0, 0, u * 0.07, u * 0.07, 0, u * 0.55, T),
      { ring: boxRing(s.x + Math.cos(dir) * u * 0.12, s.y + Math.sin(dir) * u * 0.12, u * 0.22, u * 0.14),
        z0: u * 0.55, h: u * 0.13, color: T },
    ];
  },

  /* 植栽：幹＋八角形の樹冠2段（参考画像準拠） */
  tree: (s, T) => [
    B(s, 0, 0, s.w * 0.1, s.h * 0.1, 0, s.w * 0.5, "#7a5b3a"),
    { ring: ngonRing3D(s.x, s.y, s.w * 0.42), z0: s.w * 0.42, h: s.w * 0.62, color: "#5f8a4f" },
    { ring: ngonRing3D(s.x, s.y, s.w * 0.27), z0: s.w * 1.04, h: s.w * 0.34, color: "#74a35e" },
  ],

  /* 車両門：木調フレーム＋縦格子バー（参考画像準拠） */
  carGate: (s, T) => {
    const u = s.w, wood = "#7d5c3e", bar = "#3a3a3a";
    const parts = [
      B(s, -u * 0.48, 0, u * 0.07, s.h * 0.14, 0, u * 0.6, wood),
      B(s, u * 0.48, 0, u * 0.07, s.h * 0.14, 0, u * 0.6, wood),
      B(s, 0, 0, u * 1.02, s.h * 0.1, u * 0.54, u * 0.08, wood),
    ];
    /* 縦格子：等間隔の細いバー */
    for (let i = -3; i <= 3; i++) {
      parts.push(B(s, (i / 8) * u, 0, u * 0.025, s.h * 0.06, 0, u * 0.54, bar));
    }
    return parts;
  },
};

/* 箱パーツの省略記法 */
function B(s, dx, dy, w, d, z0, h, color) {
  return { ring: boxRing(s.x + dx, s.y + dy, w, d), z0, h, color };
}

/* 選択枠・ヒット範囲の計算に使う各モデルの最大高さ（footprint幅に対する倍率） */
const ICON_3D_H = {
  rack: 1.6, mdf: 1.3, idf: 1.0, ahu: 0.8, crac: 1.5, ups: 1.25,
  generator: 1.0, reception: 0.75, biometric: 0.7, gate: 1.15,
  camera: 0.75, tree: 1.45, carGate: 0.65,
};

/* 3Dモデルの描画：パーツを奥行きソートして奥から手前へ */
function drawIcon3D(s, elev) {
  const T = s.tint || cssVar("--color-ink");
  const parts = ICON_MODELS[s.kind](s, T);
  parts
    .map((p) => {
      let cx = 0, cy = 0;
      p.ring.forEach(([x, y]) => { cx += x; cy += y; });
      cx /= p.ring.length; cy /= p.ring.length;
      return { p, depth: project(cx, cy, elev + p.z0 + p.h / 2).d };
    })
    .sort((a, b) => a.depth - b.depth)
    .forEach(({ p }) => drawPrism(p.ring, elev + p.z0, p.h, p.color, p.alpha ?? 1));
}

/* ============================================================
   6. 図形ヘルパー
   ============================================================ */

const getFloor = (id) => doc.floors.find((f) => f.id === id);
const activeFloor = () => getFloor(activeFloorId);

/* IDから図形と所属フロアを引く */
function findShape(id) {
  for (const f of doc.floors) {
    const s = f.shapes.find((s) => s.id === id);
    if (s) return { shape: s, floor: f };
  }
  return null;
}

const selectedShapes = () =>
  ui.selection.map((id) => findShape(id)).filter(Boolean);

/* 新しい多角形の既定スタイル（現在のテーマから採色） */
function newPoly(rings) {
  return {
    id: uid(), type: "poly", rings,
    fill: cssVar("--color-accent-soft"),
    opacity: 1,
    stroke: cssVar("--color-ink"),
    strokeWidth: 1.5,
    height: DEFAULT_HEIGHT,
  };
}

/* リング群の重心（並べ替え・拡縮の基準点） */
function ringsCentroid(rings) {
  let sx = 0, sy = 0, n = 0;
  rings[0].forEach(([x, y]) => { sx += x; sy += y; n++; });
  return { x: sx / n, y: sy / n };
}

/* 画面座標の多角形に対する内外判定（even-odd） */
function pointInScreenRings(screenRings, px, py) {
  let inside = false;
  for (const ring of screenRings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if (
        yi > py !== yj > py &&
        px < ((xj - xi) * (py - yi)) / (yj - yi) + xi
      ) inside = !inside;
    }
  }
  return inside;
}

/* 色を暗くする（押し出し側面の陰影用） */
function shade(hex, factor) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const v = parseInt(m[1], 16);
  const f = (c) => Math.round(((v >> c) & 255) * factor);
  return "#" + [16, 8, 0].map((c) => f(c).toString(16).padStart(2, "0")).join("");
}

/* ============================================================
   7. レンダリング
   ============================================================ */

let renderQueued = false;
function requestRender() {
  /* 変更通知（theme.jsの自動保存が拾う。連打されてもデバウンス） */
  clearTimeout(requestRender._notify);
  requestRender._notify = setTimeout(() =>
    window.dispatchEvent(new CustomEvent("axonom:change")), 700);

  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

/* PNG出力時の描画上書き設定（export.jsが設定する）
   { bg: "transparent"|"white"|"theme", scale: 1|2 } */
let exportOverride = null;
function setExportOverride(o) { exportOverride = o; }

/* キャンバスのサイズをDPRに合わせて調整 */
function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = stageWrap.clientWidth, h = stageWrap.clientHeight;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  render();
}

function render() {
  const dpr = exportOverride
    ? exportOverride.scale
    : Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.width / dpr, h = canvas.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  /* 背景：通常はテーマ色。出力時はオプションに従う */
  ctx.clearRect(0, 0, w, h);
  if (!exportOverride) {
    ctx.fillStyle = cssVar("--color-bg");
    ctx.fillRect(0, 0, w, h);
  } else if (exportOverride.bg === "white") {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
  } else if (exportOverride.bg === "theme") {
    ctx.fillStyle = cssVar("--color-bg");
    ctx.fillRect(0, 0, w, h);
  } /* transparent は塗らない（PPT貼り付け用） */

  if (ui.gridShow && !exportOverride) drawGrid(w, h);

  /* フロアを下から順に描く（高さ順＝描画順） */
  const plan = isPlanView();
  doc.floors.forEach((floor, i) => {
    if (!floor.visible) return;
    const elev = floorElev(i);
    /* 平面図では非アクティブ階を薄く重ねて参照できるようにする。
       出力時は編集補助の減光をせず、全フロアを本来の濃度で重ねる */
    const alpha = plan && !exportOverride && floor.id !== activeFloorId ? 0.3 : 1;
    drawFloor(floor, elev, alpha);
  });

  /* 編集用オーバーレイは出力に含めない */
  if (!exportOverride) {
    drawFreePreview();
    drawSelectionOverlay();
  }
}

/* グリッド：アクティブフロアの床面に描く */
function drawGrid(w, h) {
  const fIdx = doc.floors.findIndex((f) => f.id === activeFloorId);
  const elev = floorElev(Math.max(fIdx, 0));

  /* 画面四隅をワールドへ逆投影して描画範囲を決める */
  const corners = [
    unproject(0, 0, elev), unproject(w, 0, elev),
    unproject(0, h, elev), unproject(w, h, elev),
  ];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  corners.forEach((c) => {
    minX = Math.min(minX, c.x); maxX = Math.max(maxX, c.x);
    minY = Math.min(minY, c.y); maxY = Math.max(maxY, c.y);
  });

  /* ズームアウト時はグリッド間隔を粗くして描画数を抑える */
  let step = GRID;
  while (step * view.zoom < 14) step *= 2;

  ctx.strokeStyle = cssVar("--color-line");
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.55;
  ctx.beginPath();
  for (let x = Math.floor(minX / step) * step; x <= maxX; x += step) {
    const a = project(x, minY, elev), b = project(x, maxY, elev);
    ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
  }
  for (let y = Math.floor(minY / step) * step; y <= maxY; y += step) {
    const a = project(minX, y, elev), b = project(maxX, y, elev);
    ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/* 1フロア分の描画 */
function drawFloor(floor, elev, alpha) {
  ctx.globalAlpha = alpha;

  /* ポリゴンは奥行きでソートして奥から描く（擬似3Dの整合性） */
  const polys = floor.shapes.filter((s) => s.type === "poly")
    .map((s) => {
      const c = ringsCentroid(s.rings);
      return { s, d: project(c.x, c.y, elev).d };
    })
    .sort((a, b) => a.d - b.d);

  polys.forEach(({ s }) => drawPoly(s, elev));

  /* アイコンとテキストはポリゴンの上に重ねる */
  floor.shapes.forEach((s) => {
    if (s.type === "icon") drawIcon(s, elev);
    else if (s.type === "text") drawText(s, elev);
  });

  ctx.globalAlpha = 1;
}

/* ポリゴン（押し出し対応） */
function drawPoly(s, elev) {
  const extruded = zVisible() && s.height > 0;
  const topZ = extruded ? elev + s.height : elev;
  ctx.globalAlpha *= s.opacity;
  const baseAlpha = ctx.globalAlpha;

  if (extruded) {
    /* 側面：全エッジを四角形として集め、奥行き順に描く */
    const faces = [];
    s.rings.forEach((ring) => {
      for (let i = 0; i < ring.length; i++) {
        const p1 = ring[i], p2 = ring[(i + 1) % ring.length];
        const a = project(p1[0], p1[1], elev);
        const b = project(p2[0], p2[1], elev);
        const c = project(p2[0], p2[1], topZ);
        const d = project(p1[0], p1[1], topZ);
        /* 画面上の辺の向きで陰影を2段階に振り分ける（簡易ライティング） */
        const lit = b.x - a.x > 0 ? 0.82 : 0.62;
        faces.push({ pts: [a, b, c, d], d: (a.d + b.d) / 2, lit });
      }
    });
    faces.sort((f1, f2) => f1.d - f2.d);
    faces.forEach((f) => {
      ctx.beginPath();
      f.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.fillStyle = shade(s.fill, f.lit);
      ctx.fill();
      ctx.strokeStyle = shade(s.fill, 0.5);
      ctx.lineWidth = 1;
      ctx.stroke();
    });
  }

  /* 上面（平面図では唯一の面） */
  ctx.beginPath();
  s.rings.forEach((ring) => {
    ring.forEach(([x, y], i) => {
      const p = project(x, y, topZ);
      i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
    });
    ctx.closePath();
  });
  ctx.fillStyle = s.fill;
  ctx.fill("evenodd");
  if (s.strokeWidth > 0) {
    ctx.strokeStyle = s.stroke;
    ctx.lineWidth = s.strokeWidth;
    ctx.stroke();
  }
  ctx.globalAlpha = baseAlpha / (s.opacity || 1);
}

/* アイコン：平面図ではSVG記号、擬似3Dでは立体モデルを描く */
function drawIcon(s, elev) {
  /* 削除済みのアイコン種（旧プロジェクトのPDU・外周柵など）は安全に無視 */
  if (!ICONS[s.kind]) return;

  const p = project(s.x, s.y, elev);

  /* 監視カメラ：向いている方向に放射状の視野扇形を描く */
  if (s.kind === "camera") {
    const dir = ((s.dir || 0) * Math.PI) / 180;
    const r = Math.max(s.w, s.h) * 1.8;
    const half = (32 * Math.PI) / 180;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    for (let i = 0; i <= 10; i++) {
      const a = dir - half + (half * 2 * i) / 10;
      const q = project(s.x + Math.cos(a) * r, s.y + Math.sin(a) * r, elev);
      ctx.lineTo(q.x, q.y);
    }
    ctx.closePath();
    const grad = cssVar("--color-accent");
    ctx.fillStyle = grad;
    ctx.globalAlpha *= 0.22;
    ctx.fill();
    ctx.globalAlpha /= 0.22;
  }

  /* 高さが見える視点では3Dモデルで描く */
  if (zVisible() && ICON_MODELS[s.kind]) {
    drawIcon3D(s, elev);
    return;
  }

  const img = iconImage(s.kind, s.tint || cssVar("--color-ink"));
  if (!img.complete) return; // 読み込み中はスキップ（onloadで再描画）
  const w = s.w * view.zoom, h = s.h * view.zoom;
  ctx.drawImage(img, p.x - w / 2, p.y - h / 2, w, h);
}

/* テキスト */
function drawText(s, elev) {
  const p = project(s.x, s.y, elev);
  ctx.font = `${s.weight} ${s.size * view.zoom}px "Noto Sans JP", "Space Grotesk", sans-serif`;
  ctx.fillStyle = s.color;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.fillText(s.text, p.x, p.y);
}

/* 自由多角形の作成プレビュー */
function drawFreePreview() {
  if (!ui.freePts || !ui.freePts.length) return;
  const fIdx = doc.floors.findIndex((f) => f.id === activeFloorId);
  const elev = floorElev(Math.max(fIdx, 0));
  const accent = cssVar("--color-accent");

  ctx.beginPath();
  ui.freePts.forEach(([x, y], i) => {
    const p = project(x, y, elev);
    i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
  });
  if (ui.freeCursor) {
    const c = project(ui.freeCursor.x, ui.freeCursor.y, elev);
    ctx.lineTo(c.x, c.y);
  }
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.stroke();
  ctx.setLineDash([]);

  ui.freePts.forEach(([x, y]) => {
    const p = project(x, y, elev);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = accent;
    ctx.fill();
  });
}

/* 図形の画面上バウンディングボックスを求める */
function shapeScreenBBox(entry) {
  const { shape: s, floor } = entry;
  const elev = floorElev(doc.floors.indexOf(floor));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (p) => {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  };
  if (s.type === "poly") {
    const topZ = zVisible() && s.height > 0 ? elev + s.height : elev;
    s.rings.forEach((r) => r.forEach(([x, y]) => {
      add(project(x, y, elev));
      if (topZ !== elev) add(project(x, y, topZ));
    }));
  } else if (s.type === "icon") {
    const p = project(s.x, s.y, elev);
    const w = (s.w * view.zoom) / 2, h = (s.h * view.zoom) / 2;
    add({ x: p.x - w, y: p.y - h }); add({ x: p.x + w, y: p.y + h });
    /* 3Dモデル表示時はモデルの高さぶんも枠・ヒット範囲に含める */
    if (zVisible() && ICON_MODELS[s.kind]) {
      const topH = (ICON_3D_H[s.kind] || 1) * s.w;
      [[-s.w / 2, -s.h / 2], [s.w / 2, -s.h / 2], [s.w / 2, s.h / 2], [-s.w / 2, s.h / 2]]
        .forEach(([dx, dy]) => {
          add(project(s.x + dx, s.y + dy, elev));
          add(project(s.x + dx, s.y + dy, elev + topH));
        });
    }
  } else {
    const p = project(s.x, s.y, elev);
    ctx.font = `${s.weight} ${s.size * view.zoom}px "Noto Sans JP", sans-serif`;
    const tw = ctx.measureText(s.text).width / 2;
    const th = (s.size * view.zoom) / 2 + 4;
    add({ x: p.x - tw, y: p.y - th }); add({ x: p.x + tw, y: p.y + th });
  }
  return { minX, minY, maxX, maxY };
}

/* 選択枠・リサイズハンドル・頂点ハンドル */
function drawSelectionOverlay() {
  const accent = cssVar("--color-accent");

  selectedShapes().forEach((entry) => {
    const b = shapeScreenBBox(entry);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(b.minX - 5, b.minY - 5, b.maxX - b.minX + 10, b.maxY - b.minY + 10);
    ctx.setLineDash([]);

    /* アイコン/テキストは右下にリサイズハンドル */
    if (entry.shape.type !== "poly") {
      ctx.fillStyle = accent;
      ctx.fillRect(b.maxX + 1, b.maxY + 1, 9, 9);
    }
  });

  /* 頂点編集ハンドル */
  if (ui.vertexEditId) {
    const entry = findShape(ui.vertexEditId);
    if (entry && entry.shape.type === "poly") {
      const elev = floorElev(doc.floors.indexOf(entry.floor));
      entry.shape.rings.forEach((ring) => ring.forEach(([x, y]) => {
        const p = project(x, y, elev);
        ctx.fillStyle = cssVar("--color-surface");
        ctx.strokeStyle = accent;
        ctx.lineWidth = 1.5;
        ctx.fillRect(p.x - 5, p.y - 5, 10, 10);
        ctx.strokeRect(p.x - 5, p.y - 5, 10, 10);
      }));
    }
  }
}

/* ============================================================
   8. ヒットテスト
   ============================================================ */

/* 頂点ハンドルのヒット（頂点編集中のみ） */
function hitVertex(sx, sy) {
  if (!ui.vertexEditId) return null;
  const entry = findShape(ui.vertexEditId);
  if (!entry || entry.shape.type !== "poly") return null;
  const elev = floorElev(doc.floors.indexOf(entry.floor));
  for (let ri = 0; ri < entry.shape.rings.length; ri++) {
    const ring = entry.shape.rings[ri];
    for (let pi = 0; pi < ring.length; pi++) {
      const p = project(ring[pi][0], ring[pi][1], elev);
      if (Math.abs(p.x - sx) <= 8 && Math.abs(p.y - sy) <= 8)
        return { entry, ri, pi };
    }
  }
  return null;
}

/* リサイズハンドルのヒット（選択中のアイコン/テキスト） */
function hitResizeHandle(sx, sy) {
  for (const entry of selectedShapes()) {
    if (entry.shape.type === "poly") continue;
    const b = shapeScreenBBox(entry);
    if (sx >= b.maxX && sx <= b.maxX + 12 && sy >= b.maxY && sy <= b.maxY + 12)
      return entry;
  }
  return null;
}

/* 図形のヒット（上に描かれたものを優先） */
function hitShape(sx, sy) {
  /* アクティブ階を最優先、その後は上の階から順に */
  const order = [...doc.floors].reverse()
    .sort((a, b) => (a.id === activeFloorId ? -1 : b.id === activeFloorId ? 1 : 0));

  for (const floor of order) {
    if (!floor.visible) continue;
    const elev = floorElev(doc.floors.indexOf(floor));
    for (let i = floor.shapes.length - 1; i >= 0; i--) {
      const s = floor.shapes[i];
      if (s.type === "poly") {
        const topZ = zVisible() && s.height > 0 ? elev + s.height : elev;
        const top = s.rings.map((r) => r.map(([x, y]) => {
          const p = project(x, y, topZ); return [p.x, p.y];
        }));
        if (pointInScreenRings(top, sx, sy)) return { shape: s, floor };
        if (topZ !== elev) {
          const base = s.rings.map((r) => r.map(([x, y]) => {
            const p = project(x, y, elev); return [p.x, p.y];
          }));
          if (pointInScreenRings(base, sx, sy)) return { shape: s, floor };
        }
      } else {
        const b = shapeScreenBBox({ shape: s, floor });
        if (sx >= b.minX && sx <= b.maxX && sy >= b.minY && sy <= b.maxY)
          return { shape: s, floor };
      }
    }
  }
  return null;
}

/* ============================================================
   9. ポインタ操作（マウス・タッチ統合）
   ============================================================ */

const pointers = new Map(); // ピンチ判定用

function canvasPos(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

canvas.addEventListener("pointerdown", (e) => {
  const pos = canvasPos(e);
  pointers.set(e.pointerId, pos);
  try { canvas.setPointerCapture(e.pointerId); } catch (_) {}

  /* 2本指 → ピンチズーム＆パンへ移行 */
  if (pointers.size === 2) {
    const [p1, p2] = [...pointers.values()];
    ui.drag = {
      type: "pinch",
      d0: Math.hypot(p2.x - p1.x, p2.y - p1.y),
      c0: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 },
      zoom0: view.zoom, pan0: { x: view.panX, y: view.panY },
    };
    return;
  }

  /* Space＋ドラッグ＝どのツール中でもパン（PowerPoint風） */
  if (spaceDown) {
    ui.drag = { type: "pan", start: pos, pan0: { x: view.panX, y: view.panY }, moved: true };
    return;
  }

  const fIdx = Math.max(doc.floors.findIndex((f) => f.id === activeFloorId), 0);
  const elev = floorElev(fIdx);
  const wpt = unproject(pos.x, pos.y, elev);

  if (ui.tool === "select") {
    /* 1. 頂点ハンドル */
    const v = hitVertex(pos.x, pos.y);
    if (v) {
      pushUndo();
      ui.drag = { type: "vertex", ...v, elev };
      return;
    }
    /* 2. リサイズハンドル */
    const rh = hitResizeHandle(pos.x, pos.y);
    if (rh) {
      pushUndo();
      ui.drag = { type: "resize", entry: rh, start: pos, w0: rh.shape.w ?? 0, h0: rh.shape.h ?? 0, size0: rh.shape.size ?? 0 };
      return;
    }
    /* 3. 図形本体 */
    const hit = hitShape(pos.x, pos.y);
    if (hit) {
      if (e.shiftKey || ui.multiSelect) {
        /* Shift＋クリック、または複数選択モード中のタップで追加/解除
           （タッチ端末にはShiftキーが無いためモードで代替する） */
        const i = ui.selection.indexOf(hit.shape.id);
        i >= 0 ? ui.selection.splice(i, 1) : ui.selection.push(hit.shape.id);
      } else if (!ui.selection.includes(hit.shape.id)) {
        ui.selection = [hit.shape.id];
        ui.vertexEditId = null;
      }
      renderProps();
      /* 選択図形をまとめて移動するための初期位置を控える */
      const hitElev = floorElev(doc.floors.indexOf(hit.floor));
      ui.drag = {
        type: "move",
        startW: unproject(pos.x, pos.y, hitElev),
        elev: hitElev,
        moved: false,
        orig: selectedShapes().map((en) => ({
          id: en.shape.id,
          rings: en.shape.rings ? JSON.parse(JSON.stringify(en.shape.rings)) : null,
          x: en.shape.x, y: en.shape.y,
        })),
      };
      requestRender();
      return;
    }
    /* 4. 何もない場所 → パン（クリックだけなら選択解除） */
    ui.drag = { type: "pan", start: pos, pan0: { x: view.panX, y: view.panY }, moved: false };
    return;
  }

  if (ui.tool === "rect" || ui.tool === "ngon" || ui.tool === "lshape") {
    ui.drag = { type: "draw", x0: snapV(wpt.x), y0: snapV(wpt.y), x1: snapV(wpt.x), y1: snapV(wpt.y), elev };
    return;
  }

  if (ui.tool === "free") {
    if (!ui.freePts) ui.freePts = [];
    ui.freePts.push([snapV(wpt.x), snapV(wpt.y)]);
    requestRender();
    return;
  }

  if (ui.tool === "text") {
    openTextInput(wpt.x, wpt.y, null, pos);
    return;
  }

  if (ui.tool === "icon" && ui.iconKind) {
    pushUndo();
    const s = {
      id: uid(), type: "icon", kind: ui.iconKind,
      x: snapV(wpt.x), y: snapV(wpt.y), w: 60, h: 60,
      tint: cssVar("--color-ink"),
    };
    if (ui.iconKind === "camera") s.dir = 0;
    activeFloor().shapes.push(s);
    ui.selection = [s.id];
    setTool("select");
    renderProps();
    requestRender();
  }
});

canvas.addEventListener("pointermove", (e) => {
  const pos = canvasPos(e);
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, pos);

  /* 自由多角形ツールのプレビュー線 */
  if (ui.tool === "free" && ui.freePts) {
    const fIdx = Math.max(doc.floors.findIndex((f) => f.id === activeFloorId), 0);
    const w = unproject(pos.x, pos.y, floorElev(fIdx));
    ui.freeCursor = { x: snapV(w.x), y: snapV(w.y) };
    requestRender();
  }

  const d = ui.drag;
  if (!d) return;

  if (d.type === "pinch" && pointers.size === 2) {
    const [p1, p2] = [...pointers.values()];
    const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const c = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    const z = Math.min(4, Math.max(0.2, d.zoom0 * (dist / d.d0)));
    /* ピンチ中心が同じワールド点を指し続けるようにパンを補正 */
    view.panX = c.x - ((d.c0.x - d.pan0.x) * z) / d.zoom0;
    view.panY = c.y - ((d.c0.y - d.pan0.y) * z) / d.zoom0;
    view.zoom = z;
    syncViewUI();
    requestRender();
    return;
  }

  if (d.type === "pan") {
    view.panX = d.pan0.x + (pos.x - d.start.x);
    view.panY = d.pan0.y + (pos.y - d.start.y);
    if (Math.hypot(pos.x - d.start.x, pos.y - d.start.y) > MIN_DRAG) d.moved = true;
    requestRender();
    return;
  }

  if (d.type === "move") {
    const cur = unproject(pos.x, pos.y, d.elev);
    let dx = cur.x - d.startW.x, dy = cur.y - d.startW.y;
    if (ui.snap) { dx = Math.round(dx / GRID) * GRID; dy = Math.round(dy / GRID) * GRID; }
    if (!d.moved && (dx !== 0 || dy !== 0)) { pushUndo(); d.moved = true; }
    d.orig.forEach((o) => {
      const entry = findShape(o.id);
      if (!entry) return;
      const s = entry.shape;
      if (s.type === "poly") {
        s.rings = o.rings.map((r) => r.map(([x, y]) => [x + dx, y + dy]));
      } else {
        s.x = o.x + dx; s.y = o.y + dy;
      }
    });
    requestRender();
    return;
  }

  if (d.type === "vertex") {
    const w = unproject(pos.x, pos.y, d.elev);
    d.entry.shape.rings[d.ri][d.pi] = [snapV(w.x), snapV(w.y)];
    requestRender();
    return;
  }

  if (d.type === "resize") {
    const s = d.entry.shape;
    const scale = Math.max(0.2, 1 + (pos.x - d.start.x) / 80);
    if (s.type === "icon") {
      s.w = Math.max(16, Math.round(d.w0 * scale));
      s.h = Math.max(16, Math.round(d.h0 * scale));
    } else if (s.type === "text") {
      s.size = Math.max(8, Math.round(d.size0 * scale));
    }
    renderProps();
    requestRender();
    return;
  }

  if (d.type === "draw") {
    const w = unproject(pos.x, pos.y, d.elev);
    d.x1 = snapV(w.x); d.y1 = snapV(w.y);
    drawDragPreview(d);
  }
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  const d = ui.drag;
  if (!d) return;
  if (d.type === "pinch") { if (pointers.size < 2) ui.drag = null; return; }
  ui.drag = null;

  if (d.type === "pan" && !d.moved) {
    /* 空クリック＝選択解除・頂点編集終了 */
    ui.selection = [];
    ui.vertexEditId = null;
    renderProps();
    requestRender();
  }

  if (d.type === "draw") {
    const wpx = Math.abs(d.x1 - d.x0), hpx = Math.abs(d.y1 - d.y0);
    if (wpx >= GRID / 2 && hpx >= GRID / 2) {
      pushUndo();
      const s = newPoly(buildRings(ui.tool, d));
      activeFloor().shapes.push(s);
      ui.selection = [s.id];
      renderProps();
    }
    requestRender();
  }
}

canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);

/* ドラッグ描画中のラバーバンド表示 */
function drawDragPreview(d) {
  render();
  const rings = buildRings(ui.tool, d);
  ctx.beginPath();
  rings.forEach((ring) => {
    ring.forEach(([x, y], i) => {
      const p = project(x, y, d.elev);
      i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
    });
    ctx.closePath();
  });
  ctx.strokeStyle = cssVar("--color-accent");
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.stroke();
  ctx.setLineDash([]);
}

/* ツール×ドラッグ範囲からリング座標を生成 */
function buildRings(tool, d) {
  const x0 = Math.min(d.x0, d.x1), x1 = Math.max(d.x0, d.x1);
  const y0 = Math.min(d.y0, d.y1), y1 = Math.max(d.y0, d.y1);
  if (tool === "ngon") {
    /* 範囲に内接する六角形 */
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const rx = (x1 - x0) / 2, ry = (y1 - y0) / 2;
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 3;
      pts.push([Math.round(cx + rx * Math.cos(a)), Math.round(cy + ry * Math.sin(a))]);
    }
    return [pts];
  }
  if (tool === "lshape") {
    /* 右上を欠いたL字 */
    const xm = (x0 + x1) / 2, ym = (y0 + y1) / 2;
    return [[[x0, y0], [xm, y0], [xm, ym], [x1, ym], [x1, y1], [x0, y1]]];
  }
  return [[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]];
}

/* 自由多角形の確定 */
function commitFreePoly() {
  if (ui.freePts && ui.freePts.length >= 3) {
    pushUndo();
    const s = newPoly([ui.freePts]);
    activeFloor().shapes.push(s);
    ui.selection = [s.id];
    renderProps();
  }
  ui.freePts = null;
  ui.freeCursor = null;
  requestRender();
}

/* ダブルクリック：自由多角形の確定 / 頂点編集 / テキスト編集 */
canvas.addEventListener("dblclick", (e) => {
  const pos = canvasPos(e);
  if (ui.tool === "free") { commitFreePoly(); return; }
  const hit = hitShape(pos.x, pos.y);
  if (!hit) return;
  if (hit.shape.type === "poly") {
    ui.vertexEditId = hit.shape.id;
    ui.selection = [hit.shape.id];
    showHint("頂点をドラッグして変形できます。空クリックで終了。");
    renderProps();
    requestRender();
  } else if (hit.shape.type === "text") {
    const elev = floorElev(doc.floors.indexOf(hit.floor));
    const p = project(hit.shape.x, hit.shape.y, elev);
    openTextInput(hit.shape.x, hit.shape.y, hit.shape, p);
  }
});

/* ホイールズーム（カーソル位置を中心に） */
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const pos = canvasPos(e);
  setZoom(view.zoom * (e.deltaY < 0 ? 1.12 : 0.89), pos.x, pos.y);
}, { passive: false });

function setZoom(z, cx, cy) {
  z = Math.min(4, Math.max(0.2, z));
  cx = cx ?? canvas.clientWidth / 2;
  cy = cy ?? canvas.clientHeight / 2;
  /* カーソル下のワールド点を固定したままズーム */
  view.panX = cx - ((cx - view.panX) * z) / view.zoom;
  view.panY = cy - ((cy - view.panY) * z) / view.zoom;
  view.zoom = z;
  syncViewUI();
  requestRender();
}

/* 表示中の全コンテンツの画面上バウンディングボックス
   （現在のビューでの座標。export.jsの出力範囲計算にも使う） */
function contentScreenBBox() {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let found = false;
  doc.floors.forEach((floor) => {
    if (!floor.visible) return;
    floor.shapes.forEach((s) => {
      found = true;
      const b = shapeScreenBBox({ shape: s, floor });
      minX = Math.min(minX, b.minX); maxX = Math.max(maxX, b.maxX);
      minY = Math.min(minY, b.minY); maxY = Math.max(maxY, b.maxY);
    });
  });
  return found ? { minX, minY, maxX, maxY } : null;
}

/* 全体表示（コンテンツに合わせてズーム・パンを調整） */
function fitView() {
  const bb = contentScreenBBox();
  const found = !!bb;
  const { minX, minY, maxX, maxY } = bb ||
    { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!found) {
    view.zoom = 1; view.panX = w / 2; view.panY = h / 2;
  } else {
    /* 現在の画面座標系でのbboxを基に、余白60pxで収まる倍率を計算 */
    const scale = Math.min(
      4,
      Math.max(0.2, Math.min(
        (w - 120) / Math.max(maxX - minX, 1),
        (h - 120) / Math.max(maxY - minY, 1)
      ) * view.zoom)
    );
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    view.panX = w / 2 - ((cx - view.panX) * scale) / view.zoom - 0;
    view.panY = h / 2 - ((cy - view.panY) * scale) / view.zoom - 0;
    view.panX += 0; /* 補正済み */
    view.zoom = scale;
  }
  syncViewUI();
  requestRender();
}

/* ============================================================
   10. テキスト入力（浮遊input）
   ============================================================ */

function openTextInput(wx, wy, existing, screenPos) {
  overlayLayer.innerHTML = "";
  const input = document.createElement("input");
  input.type = "text";
  input.value = existing ? existing.text : "";
  input.placeholder = "テキストを入力";
  input.style.left = Math.max(4, screenPos.x - 60) + "px";
  input.style.top = Math.max(4, screenPos.y - 16) + "px";
  overlayLayer.appendChild(input);
  input.focus();

  const commit = () => {
    const val = input.value.trim();
    overlayLayer.innerHTML = "";
    if (existing) {
      pushUndo();
      if (val) existing.text = val;
      else removeShapes([existing.id]);
    } else if (val) {
      pushUndo();
      const s = {
        id: uid(), type: "text", x: snapV(wx), y: snapV(wy),
        text: val, size: 16, color: cssVar("--color-ink"), weight: "500",
      };
      activeFloor().shapes.push(s);
      ui.selection = [s.id];
      setTool("select");
    }
    renderProps();
    requestRender();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") overlayLayer.innerHTML = "";
  });
  input.addEventListener("blur", commit);
}

/* ============================================================
   11. コマンド（Boolean・コピー・削除・フロア管理）
   ============================================================ */

function removeShapes(ids) {
  doc.floors.forEach((f) => {
    f.shapes = f.shapes.filter((s) => !ids.includes(s.id));
  });
  ui.selection = ui.selection.filter((id) => !ids.includes(id));
  if (ids.includes(ui.vertexEditId)) ui.vertexEditId = null;
}

function deleteSelection() {
  if (!ui.selection.length) return;
  pushUndo();
  removeShapes([...ui.selection]);
  renderProps();
  requestRender();
}

function copySelection() {
  const entries = selectedShapes();
  if (!entries.length) return;
  ui.clipboard = JSON.stringify(entries.map((e) => e.shape));
  showHint(entries.length + "件コピーしました。");
}

function pasteClipboard() {
  if (!ui.clipboard) return;
  pushUndo();
  const shapes = JSON.parse(ui.clipboard);
  const ids = [];
  shapes.forEach((s) => {
    s.id = uid();
    /* 少しずらして貼り付け（重なり防止） */
    if (s.type === "poly") {
      s.rings = s.rings.map((r) => r.map(([x, y]) => [x + GRID, y + GRID]));
    } else {
      s.x += GRID; s.y += GRID;
    }
    activeFloor().shapes.push(s);
    ids.push(s.id);
  });
  ui.selection = ids;
  renderProps();
  requestRender();
}

/* Boolean演算（選択順の1つ目が基準図形） */
function applyBoolean(op) {
  if (!window.polygonClipping) {
    showHint("演算ライブラリを読み込み中です。少し待って再試行してください。");
    return;
  }
  const entries = selectedShapes().filter((e) => e.shape.type === "poly");
  if (entries.length < 2) {
    showHint("ポリゴンを2つ以上選択してください（Shift＋クリックで追加）。");
    return;
  }
  pushUndo();
  const geoms = entries.map((e) => [e.shape.rings]);
  let result;
  try {
    result = op === "difference"
      ? polygonClipping.difference(geoms[0], ...geoms.slice(1))
      : polygonClipping[op](...geoms);
  } catch (err) {
    undoStack.pop(); // 失敗時はUndo履歴を戻す
    showHint("演算に失敗しました：" + err.message);
    return;
  }
  const base = entries[0].shape;
  const targetFloor = entries[0].floor;
  removeShapes(entries.map((e) => e.shape.id));

  const ids = [];
  result.forEach((polyRings) => {
    /* polygon-clippingの出力は始点と終点が重複するため取り除く */
    const rings = polyRings.map((r) => {
      const q = r.map(([x, y]) => [x, y]);
      const a = q[0], b = q[q.length - 1];
      if (q.length > 1 && a[0] === b[0] && a[1] === b[1]) q.pop();
      return q;
    });
    const s = { ...base, id: uid(), rings };
    targetFloor.shapes.push(s);
    ids.push(s.id);
  });
  ui.selection = ids;
  if (!ids.length) showHint("結果が空になりました（重なりがない等）。");
  renderProps();
  requestRender();
}

/* ---- フロア管理 ---- */

function addFloor() {
  pushUndo();
  const f = newFloor((doc.floors.length + 1) + "F");
  doc.floors.push(f);
  activeFloorId = f.id;
  renderFloorsPanel();
  requestRender();
}

function moveFloor(id, dir) {
  const i = doc.floors.findIndex((f) => f.id === id);
  const j = i + dir;
  if (j < 0 || j >= doc.floors.length) return;
  pushUndo();
  [doc.floors[i], doc.floors[j]] = [doc.floors[j], doc.floors[i]];
  renderFloorsPanel();
  requestRender();
}

function deleteFloor(id) {
  if (doc.floors.length <= 1) return;
  pushUndo();
  doc.floors = doc.floors.filter((f) => f.id !== id);
  if (activeFloorId === id) activeFloorId = doc.floors[doc.floors.length - 1].id;
  ui.selection = [];
  renderFloorsPanel();
  renderProps();
  requestRender();
}

/* ============================================================
   12. UI構築・バインド
   ============================================================ */

/* ---- ヒント表示 ---- */
let hintTimer = null;
function showHint(text, sticky = false) {
  hintEl.textContent = text;
  clearTimeout(hintTimer);
  if (!sticky) hintTimer = setTimeout(() => { hintEl.textContent = ""; }, 4000);
}

/* ---- ツール切替 ---- */
const TOOL_HINTS = {
  select: "クリックで選択、ドラッグで移動。Shift＋クリックで複数選択。ダブルクリックで頂点編集。",
  rect: "ドラッグで矩形を描きます。",
  ngon: "ドラッグで六角形を描きます。",
  lshape: "ドラッグでL字形を描きます。",
  free: "クリックで頂点を追加、ダブルクリックまたはEnterで確定。",
  text: "配置したい位置をクリックしてください。",
  icon: "配置したい位置をクリックしてください。",
};

function setTool(tool, iconKind = null) {
  /* 自由多角形の作成途中で別ツールへ切り替えたら、捨てずに確定する。
     （タッチ端末ではダブルタップより確実な確定手段になる） */
  if (ui.tool === "free" && tool !== "free" && ui.freePts && ui.freePts.length >= 3) {
    commitFreePoly();
  }
  ui.tool = tool;
  ui.iconKind = iconKind;
  if (tool !== "free") { ui.freePts = null; ui.freeCursor = null; }
  document.querySelectorAll(".ed-tool[data-tool]").forEach((b) =>
    b.classList.toggle("is-active", b.dataset.tool === tool));
  document.querySelectorAll(".ed-icon-btn").forEach((b) =>
    b.classList.toggle("is-active", tool === "icon" && b.dataset.icon === iconKind));
  canvas.classList.toggle("is-select", tool === "select");
  showHint(TOOL_HINTS[tool] || "", tool !== "select");
  requestRender();
}

document.querySelectorAll(".ed-tool[data-tool]").forEach((b) =>
  b.addEventListener("click", () => setTool(b.dataset.tool)));

/* ---- Boolean・複製・削除ボタン ---- */
document.querySelectorAll(".ed-bool").forEach((b) =>
  b.addEventListener("click", () => applyBoolean(b.dataset.bool)));
document.getElementById("btn-copy").addEventListener("click", () => {
  copySelection(); pasteClipboard();
});
document.getElementById("btn-delete").addEventListener("click", deleteSelection);

/* ---- 複数選択モード（タッチでのShift+クリック代替） ---- */
document.getElementById("btn-multi").addEventListener("click", (e) => {
  ui.multiSelect = !ui.multiSelect;
  e.currentTarget.classList.toggle("is-active", ui.multiSelect);
  showHint(ui.multiSelect
    ? "複数選択モードON：タップ/クリックで選択に追加されます。"
    : "複数選択モードOFF");
});

/* ---- アイコンパレット（インラインSVGを注入） ---- */
const iconGrid = document.getElementById("icon-grid");
Object.entries(ICONS).forEach(([kind, def]) => {
  const btn = document.createElement("button");
  btn.className = "ed-icon-btn";
  btn.dataset.icon = kind;
  btn.title = def.label;
  btn.innerHTML = def.svg.replaceAll("{{C}}", "currentColor") + "<span>" + def.label + "</span>";
  btn.addEventListener("click", () => setTool("icon", kind));
  iconGrid.appendChild(btn);
});
/* 汎用ラベル（テキストツールへのショートカット）もパレットに置く */
{
  const btn = document.createElement("button");
  btn.className = "ed-icon-btn";
  btn.title = "汎用ラベル・テキスト";
  btn.innerHTML = SVG_HEAD.replaceAll("{{C}}", "currentColor") +
    '<rect x="6" y="14" width="36" height="20" rx="3"/><path d="M13 24h16"/></svg>' +
    "<span>ラベル</span>";
  btn.addEventListener("click", () => setTool("text"));
  iconGrid.appendChild(btn);
}

/* ---- 角度スライダー＆数値入力 ---- */
const angleInputs = {
  ax: [document.getElementById("ang-x"), document.getElementById("num-x")],
  ay: [document.getElementById("ang-y"), document.getElementById("num-y")],
  az: [document.getElementById("ang-z"), document.getElementById("num-z")],
};

Object.entries(angleInputs).forEach(([axis, [slider, num]]) => {
  const apply = (v) => {
    view[axis] = Number(v) || 0;
    view.ob = 0;             // 手動調整したらキャビネット斜投影は解除
    updateMatrix();
    syncViewUI();
    requestRender();
  };
  slider.addEventListener("input", () => apply(slider.value));
  num.addEventListener("input", () => apply(num.value));
});

/* ---- プリセット＆モード切替 ---- */
const PRESETS = {
  plan: { ax: 0, ay: 0, az: 0, ob: 0 },
  iso: { ax: 60, ay: 0, az: 45, ob: 0 },
  cabinet: { ax: 0, ay: 0, az: 0, ob: 0.5 },
};

function setPreset(name) {
  Object.assign(view, PRESETS[name]);
  if (name !== "plan") last3D = { ...PRESETS[name] };
  updateMatrix();
  syncViewUI();
  requestRender();
}

document.querySelectorAll("[data-preset]").forEach((b) =>
  b.addEventListener("click", () => setPreset(b.dataset.preset)));

document.getElementById("mode-plan").addEventListener("click", () => setPreset("plan"));
document.getElementById("mode-3d").addEventListener("click", () => {
  Object.assign(view, last3D);
  updateMatrix();
  syncViewUI();
  requestRender();
});

/* ビュー関連UIの同期表示 */
function syncViewUI() {
  Object.entries(angleInputs).forEach(([axis, [slider, num]]) => {
    slider.value = view[axis];
    num.value = view[axis];
  });
  const plan = isPlanView();
  document.getElementById("mode-plan").classList.toggle("is-active", plan);
  document.getElementById("mode-3d").classList.toggle("is-active", !plan);
  document.querySelectorAll("[data-preset]").forEach((b) => {
    const p = PRESETS[b.dataset.preset];
    b.classList.toggle("is-active",
      p.ax === view.ax && p.ay === view.ay && p.az === view.az && p.ob === view.ob);
  });
  document.getElementById("zoom-label").textContent = Math.round(view.zoom * 100) + "%";
  if (!plan) last3D = { ax: view.ax, ay: view.ay, az: view.az, ob: view.ob };
}

/* ---- 履歴・表示補助 ---- */
document.getElementById("btn-undo").addEventListener("click", undo);
document.getElementById("btn-redo").addEventListener("click", redo);
document.getElementById("btn-grid").addEventListener("click", (e) => {
  ui.gridShow = !ui.gridShow;
  e.currentTarget.classList.toggle("is-active", ui.gridShow);
  requestRender();
});
document.getElementById("btn-snap").addEventListener("click", (e) => {
  ui.snap = !ui.snap;
  e.currentTarget.classList.toggle("is-active", ui.snap);
});
document.getElementById("btn-zoom-in").addEventListener("click", () => setZoom(view.zoom * 1.2));
document.getElementById("btn-zoom-out").addEventListener("click", () => setZoom(view.zoom / 1.2));
document.getElementById("btn-fit").addEventListener("click", fitView);

/* ---- テーマ切替 ---- */
document.querySelectorAll(".theme-dot").forEach((dot) => {
  dot.addEventListener("click", () => {
    document.documentElement.dataset.theme = dot.dataset.themeName;
    document.querySelectorAll(".theme-dot").forEach((d) =>
      d.classList.toggle("is-active", d === dot));
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = cssVar("--color-bg");
    renderProps(); // スウォッチの色を更新
    requestRender();
  });
});

/* ---- モバイル：パネル開閉 ---- */
document.getElementById("btn-panel-toggle").addEventListener("click", () => {
  document.getElementById("side-panel").classList.toggle("is-open");
});

/* ---- フロアパネル ---- */
function renderFloorsPanel() {
  const list = document.getElementById("floor-list");
  list.innerHTML = "";
  doc.floors.forEach((f) => {
    const row = document.createElement("li");
    row.className = "ed-floor-row" + (f.id === activeFloorId ? " is-active" : "");

    const name = document.createElement("span");
    name.textContent = f.name;
    name.title = "ダブルクリックで名前を変更";
    name.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      const input = document.createElement("input");
      input.type = "text";
      input.value = f.name;
      input.style.width = "70px";
      name.replaceWith(input);
      input.focus();
      const commit = () => {
        if (input.value.trim()) { pushUndo(); f.name = input.value.trim(); }
        renderFloorsPanel();
      };
      input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") commit(); });
      input.addEventListener("blur", commit);
    });

    const eye = document.createElement("button");
    eye.textContent = f.visible ? "◉" : "○";
    eye.title = "表示 / 非表示";
    eye.className = f.visible ? "" : "is-off";
    eye.addEventListener("click", (e) => {
      e.stopPropagation();
      f.visible = !f.visible;
      renderFloorsPanel();
      requestRender();
    });

    const up = document.createElement("button");
    up.textContent = "▲";
    up.title = "1つ上の階へ";
    up.addEventListener("click", (e) => { e.stopPropagation(); moveFloor(f.id, +1); });

    const down = document.createElement("button");
    down.textContent = "▼";
    down.title = "1つ下の階へ";
    down.addEventListener("click", (e) => { e.stopPropagation(); moveFloor(f.id, -1); });

    const del = document.createElement("button");
    del.textContent = "✕";
    del.title = "フロアを削除";
    del.disabled = doc.floors.length <= 1;
    del.addEventListener("click", (e) => { e.stopPropagation(); deleteFloor(f.id); });

    row.append(name, eye, up, down, del);
    row.addEventListener("click", () => {
      activeFloorId = f.id;
      ui.selection = [];
      renderFloorsPanel();
      renderProps();
      requestRender();
    });
    list.appendChild(row);
  });
}

/* ---- プロパティパネル ---- */

/* 操作開始時に一度だけUndoを積むラッパー */
function bindLive(el, apply) {
  let armed = true;
  const arm = () => { if (armed) { pushUndo(); armed = false; } };
  el.addEventListener("pointerdown", arm);
  el.addEventListener("focus", arm);
  el.addEventListener("input", () => { apply(el.value); requestRender(); });
  el.addEventListener("blur", () => { armed = true; });
}

function propRow(label, el) {
  const row = document.createElement("div");
  row.className = "ed-prop-row";
  const lab = document.createElement("span");
  lab.textContent = label;
  row.append(lab, el);
  return row;
}

function makeInput(type, value, attrs = {}) {
  const el = document.createElement("input");
  el.type = type;
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
  el.value = value;
  return el;
}

function renderProps() {
  const box = document.getElementById("props");
  box.innerHTML = "";
  const entries = selectedShapes();

  if (!entries.length) {
    box.innerHTML = '<p class="ed-prop-hint">図形を選択するとここに設定が表示されます。<br>' +
      'Boolean演算は Shift＋クリックで2つ以上選択してから実行します。</p>';
    return;
  }

  if (entries.length > 1) {
    box.innerHTML = `<p class="ed-prop-hint">${entries.length}件選択中。<br>` +
      '左の「図形の結合」からBoolean演算ができます。<br>1つ目に選んだ図形が基準（型抜きの土台）です。</p>';
    return;
  }

  const s = entries[0].shape;

  /* テーマ色スウォッチ（どのタイプでも色適用に使える） */
  const swatches = document.createElement("div");
  swatches.className = "ed-swatches";
  ["--color-accent", "--color-accent-soft", "--color-surface-2", "--color-surface", "--color-ink"]
    .forEach((v) => {
      const sw = document.createElement("button");
      sw.className = "ed-swatch";
      sw.style.background = cssVar(v);
      sw.title = "この色を適用";
      sw.addEventListener("click", () => {
        pushUndo();
        const c = cssVar(v);
        if (s.type === "poly") s.fill = c;
        else if (s.type === "icon") s.tint = c;
        else s.color = c;
        renderProps();
        requestRender();
      });
      swatches.appendChild(sw);
    });

  if (s.type === "poly") {
    const fill = makeInput("color", s.fill);
    bindLive(fill, (v) => { s.fill = v; });
    box.appendChild(propRow("塗り", fill));
    box.appendChild(swatches);

    const op = makeInput("range", s.opacity, { min: 0.1, max: 1, step: 0.05 });
    bindLive(op, (v) => { s.opacity = Number(v); });
    box.appendChild(propRow("透明度", op));

    const stroke = makeInput("color", s.stroke);
    bindLive(stroke, (v) => { s.stroke = v; });
    box.appendChild(propRow("枠線色", stroke));

    const sw2 = makeInput("number", s.strokeWidth, { min: 0, max: 10, step: 0.5 });
    bindLive(sw2, (v) => { s.strokeWidth = Number(v); });
    box.appendChild(propRow("枠線幅", sw2));

    const height = makeInput("number", s.height, { min: 0, max: 1000, step: 10 });
    bindLive(height, (v) => { s.height = Number(v); });
    box.appendChild(propRow("厚み", height));

    const editBtn = document.createElement("button");
    editBtn.className = "ed-btn ed-btn-wide";
    editBtn.textContent = ui.vertexEditId === s.id ? "頂点編集を終了" : "頂点を編集";
    editBtn.addEventListener("click", () => {
      ui.vertexEditId = ui.vertexEditId === s.id ? null : s.id;
      renderProps();
      requestRender();
    });
    box.appendChild(editBtn);

  } else if (s.type === "icon") {
    const tint = makeInput("color", s.tint);
    bindLive(tint, (v) => { s.tint = v; });
    box.appendChild(propRow("色", tint));
    box.appendChild(swatches);

    const wIn = makeInput("number", s.w, { min: 16, max: 600, step: 4 });
    bindLive(wIn, (v) => { s.w = Number(v); });
    box.appendChild(propRow("幅", wIn));

    const hIn = makeInput("number", s.h, { min: 16, max: 600, step: 4 });
    bindLive(hIn, (v) => { s.h = Number(v); });
    box.appendChild(propRow("高さ", hIn));

    if (s.kind === "camera") {
      const dir = makeInput("range", s.dir || 0, { min: 0, max: 360, step: 5 });
      bindLive(dir, (v) => { s.dir = Number(v); });
      box.appendChild(propRow("向き", dir));
    }

  } else if (s.type === "text") {
    const txt = makeInput("text", s.text);
    bindLive(txt, (v) => { s.text = v; });
    box.appendChild(propRow("内容", txt));

    const size = makeInput("number", s.size, { min: 8, max: 120, step: 1 });
    bindLive(size, (v) => { s.size = Number(v); });
    box.appendChild(propRow("サイズ", size));

    const color = makeInput("color", s.color);
    bindLive(color, (v) => { s.color = v; });
    box.appendChild(propRow("色", color));
    box.appendChild(swatches);

    const weight = document.createElement("select");
    [["400", "標準"], ["500", "中"], ["700", "太"]].forEach(([v, label]) => {
      const o = document.createElement("option");
      o.value = v; o.textContent = label;
      if (v === s.weight) o.selected = true;
      weight.appendChild(o);
    });
    weight.addEventListener("change", () => {
      pushUndo();
      s.weight = weight.value;
      requestRender();
    });
    box.appendChild(propRow("太さ", weight));
  }
}

/* ---- キーボードショートカット ---- */
let spaceDown = false; // Space＋ドラッグでパンするためのキー状態

window.addEventListener("keydown", (e) => {
  /* 入力中は無効 */
  if (["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;

  if (e.code === "Space") {
    spaceDown = true;
    e.preventDefault(); // ページスクロールを抑止
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
    e.preventDefault(); redo();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
    copySelection();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") {
    pasteClipboard();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
    /* 複製（コピー＆少しずらして貼り付け） */
    e.preventDefault();
    copySelection();
    pasteClipboard();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
    /* アクティブフロアの全図形を選択 */
    e.preventDefault();
    ui.selection = activeFloor().shapes.map((s) => s.id);
    renderProps();
    requestRender();
  } else if (e.key === "Delete" || e.key === "Backspace") {
    deleteSelection();
  } else if (e.key === "Enter" && ui.tool === "free") {
    commitFreePoly();
  } else if (e.key === "Escape") {
    ui.freePts = null; ui.freeCursor = null;
    ui.vertexEditId = null;
    ui.selection = [];
    renderProps();
    requestRender();
  }
});

window.addEventListener("keyup", (e) => {
  if (e.code === "Space") spaceDown = false;
});

/* ============================================================
   13. 保存・復元（theme.js / export.js 連携）
   ============================================================ */

/* 現在のドキュメント＋ビュー＋テーマを1つのJSONにまとめる */
function serialize() {
  return {
    app: "axonom",
    version: 1,
    floors: doc.floors,
    activeFloorId,
    idSeq,
    view: { ax: view.ax, ay: view.ay, az: view.az, ob: view.ob, zoom: view.zoom, panX: view.panX, panY: view.panY },
    theme: document.documentElement.dataset.theme,
  };
}

/* serialize()の結果からエディタの状態を丸ごと復元する */
function loadDoc(data) {
  if (!data || !Array.isArray(data.floors) || !data.floors.length) return false;
  doc.floors = data.floors;
  activeFloorId = getFloor(data.activeFloorId) ? data.activeFloorId : doc.floors[0].id;
  idSeq = data.idSeq || 1000;
  if (data.view) Object.assign(view, data.view);
  if (data.theme) applyTheme(data.theme);
  ui.selection = [];
  ui.vertexEditId = null;
  undoStack.length = 0;
  redoStack.length = 0;
  updateMatrix();
  renderFloorsPanel();
  renderProps();
  syncViewUI();
  requestRender();
  return true;
}

/* テーマ名を適用し、ドットの選択状態も同期する */
function applyTheme(name) {
  document.documentElement.dataset.theme = name;
  document.querySelectorAll(".theme-dot").forEach((d) =>
    d.classList.toggle("is-active", d.dataset.themeName === name));
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = cssVar("--color-bg");
}

/* ============================================================
   14. モーダル・ツールチップ・ローディング（UI仕上げ）
   ============================================================ */

/* ---- モーダル開閉（export.js / theme.js からも使う） ---- */
function openModal(id) {
  document.getElementById(id).classList.add("is-open");
}
function closeModal(id) {
  document.getElementById(id).classList.remove("is-open");
}
/* 背景クリックと✕ボタンで閉じる（イベント委譲） */
document.addEventListener("click", (e) => {
  if (e.target.classList?.contains("ed-modal-backdrop")) {
    e.target.classList.remove("is-open");
  }
  const closer = e.target.closest?.("[data-close-modal]");
  if (closer) closeModal(closer.dataset.closeModal);
});

const shortcutsBtn = document.getElementById("btn-shortcuts");
if (shortcutsBtn) shortcutsBtn.addEventListener("click", () => openModal("modal-shortcuts"));

/* ---- 操作ガイド ----
   スマホ・タブレット（粗いポインタ＝指）なら指操作ガイドを既定表示。
   タブでマウス⇄タッチをいつでも切り替えられる */
const isTouchDevice = window.matchMedia("(pointer: coarse)").matches;

function showGuideTab(mode) {
  document.getElementById("guide-mouse").style.display = mode === "mouse" ? "" : "none";
  document.getElementById("guide-touch").style.display = mode === "touch" ? "" : "none";
  document.getElementById("guide-tab-mouse").classList.toggle("is-active", mode === "mouse");
  document.getElementById("guide-tab-touch").classList.toggle("is-active", mode === "touch");
}

document.getElementById("btn-guide")?.addEventListener("click", () => {
  showGuideTab(isTouchDevice ? "touch" : "mouse");
  openModal("modal-guide");
});
document.getElementById("guide-tab-mouse")?.addEventListener("click", () => showGuideTab("mouse"));
document.getElementById("guide-tab-touch")?.addEventListener("click", () => showGuideTab("touch"));

/* ---- ツールチップ ----
   title属性をホバー時にスタイル付きツールチップへ昇格させる。
   （titleは残さず data-tip に移し替えて二重表示を防ぐ） */
const tipEl = document.createElement("div");
tipEl.className = "ed-tip";
document.body.appendChild(tipEl);

document.addEventListener("pointerover", (e) => {
  if (e.pointerType === "touch") return; // タッチでは出さない
  const t = e.target.closest?.("[title], [data-tip]");
  if (!t) { tipEl.classList.remove("is-show"); return; }
  if (t.title) { t.dataset.tip = t.title; t.removeAttribute("title"); }
  if (!t.dataset.tip) return;
  tipEl.textContent = t.dataset.tip;
  const r = t.getBoundingClientRect();
  tipEl.classList.add("is-show");
  /* 画面端で見切れないよう位置を調整 */
  const tw = tipEl.offsetWidth;
  let x = r.left + r.width / 2 - tw / 2;
  x = Math.max(6, Math.min(innerWidth - tw - 6, x));
  let y = r.bottom + 8;
  if (y + 40 > innerHeight) y = r.top - tipEl.offsetHeight - 8;
  tipEl.style.left = x + "px";
  tipEl.style.top = y + "px";
});
document.addEventListener("pointerout", (e) => {
  if (!e.relatedTarget?.closest?.("[data-tip]")) tipEl.classList.remove("is-show");
});
document.addEventListener("pointerdown", () => tipEl.classList.remove("is-show"));

/* ---- 起動ローディング演出 ---- */
function dismissLoading() {
  const el = document.getElementById("ed-loading");
  if (!el) return;
  el.classList.add("is-done");
  el.addEventListener("transitionend", () => el.remove(), { once: true });
  /* transitionが発火しない環境（動き削減設定など）への保険 */
  setTimeout(() => el.remove(), 1200);
}

/* ============================================================
   15. 初期化
   ============================================================ */

function init() {
  /* キャンバス中央を原点に */
  view.panX = stageWrap.clientWidth / 2;
  view.panY = stageWrap.clientHeight / 2;
  updateMatrix();

  renderFloorsPanel();
  renderProps();
  syncViewUI();
  setTool("select");
  resizeCanvas();

  showHint("左のツールで図形を描き、ダブルクリックで頂点編集。3Dボタンで斜め視点に。");

  /* 最初の描画が済んだらローディングをフェードアウト */
  setTimeout(dismissLoading, 450);
}

new ResizeObserver(resizeCanvas).observe(stageWrap);
window.addEventListener("resize", resizeCanvas);

init();

/* Service Worker（?nosw でスキップ可能） */
if ("serviceWorker" in navigator && !new URLSearchParams(location.search).has("nosw")) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

/* export.js / theme.js 連携＋開発・検証用フック */
window.__axoEditor = {
  doc, view, ui, canvas,
  render, project, unproject, updateMatrix,
  serialize, loadDoc, applyTheme,
  setExportOverride, contentScreenBBox,
  openModal, closeModal, showHint,
  api: { setTool, setPreset, applyBoolean, addFloor, deleteSelection,
         copySelection, pasteClipboard, undo, redo, fitView, setZoom, findShape },
};
