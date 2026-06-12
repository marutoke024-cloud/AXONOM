# AXONOM — Spatial Mapping Studio

データセンター拠点のフロアマップを、積み木のように直感的に作成できるPWAです。
平面図から積層の俯瞰図（軸測投影）まで、ひと目で伝わる一枚に仕上げ、PNGとして書き出せます。

![status](https://img.shields.io/badge/status-active-success) ![license](https://img.shields.io/badge/stack-Vanilla%20JS-blue)

## Features

- **Plan / Pseudo-3D** — 真上の平面図と、X/Y/Z角度スライダーによる斜め見下ろしをリアルタイム切替。プリセット（真上 / Isometric / Cabinet）付き
- **Block-style modeling** — 矩形・多角形・L字・自由多角形、頂点ドラッグ変形、厚みの押し出し、Boolean演算（接合 / 型抜き / 抽出 / 除外）
- **Stacked floors** — 複数フロアをレイヤー管理し、立体的に積層表示
- **DC icon library** — サーバーラック、MDF/IDF、空調（AHU / CRAC）、UPS、発電機、セキュリティゲート、監視カメラ（視野扇形つき）などをインラインSVGで内蔵。**擬似3Dビューでは各アイコンが立体モデルに自動切替**
- **PNG export** — 背景（透明 / 白 / テーマ色）と解像度（1x / 2x）を選択可。PowerPoint貼り付けに最適
- **Projects** — LocalStorageへの自動保存、複数プロジェクト管理、JSON入出力
- **5 theme palettes** — Greige / Sage / Mist / Sand / Lavender
- **PWA** — オフライン動作・ホーム画面へのインストールに対応

## Tech Stack

ビルドツール不使用の素のHTML/CSS/JavaScript。

| 領域 | 採用技術 |
|---|---|
| ホーム演出 | Three.js + GSAP（CDN） |
| 図面エディタ | Canvas 2D + 自前の軸測投影エンジン |
| Boolean演算 | polygon-clipping（Martinezアルゴリズム） |
| オフライン | Service Worker（キャッシュ優先） |

## Usage

静的サーバーで配信するだけで動作します（ESM・SWのため `file://` 不可）。

```
index.html   … ホーム（Start Creating からエディタへ）
editor.html  … 図面エディタ本体
```

エディタ上部の **Guide** ボタンに、マウス操作・タッチ操作それぞれの使い方ガイドがあります。
