/* ============================================================
   AXONOM — export.js（PNG出力）

   仕組み：
   エディタ本体（editor.js）の描画パイプラインをそのまま使い、
   1. 表示中コンテンツの画面上バウンディングボックスを計測
   2. キャンバスバッファを一時的に「内容＋余白」のサイズへ変更
   3. exportOverride（背景・倍率）を設定して再描画
   4. toDataURL でPNG化してダウンロード
   5. キャンバスとビューを元に戻して再描画
   現在の角度・視点（投影行列）は一切変更しないため、
   擬似3Dモードの見え方がそのまま出力に反映される。
   表示中の全フロア（レイヤー）が重なった状態で一括出力される。
   ============================================================ */

"use strict";

(() => {
  const E = window.__axoEditor;
  if (!E) return;

  const MARGIN = 48; // 出力画像の余白（CSSピクセル）

  /* ---- 出力本体 ---------------------------------------------- */
  function exportPNG({ bg, scale }) {
    const canvas = E.canvas;
    const bbox = E.contentScreenBBox();
    if (!bbox) {
      E.showHint("出力する図形がありません。先に図形を配置してください。");
      return false;
    }

    /* 現在の状態を退避（終了後に完全復元する） */
    const saved = {
      w: canvas.width,
      h: canvas.height,
      panX: E.view.panX,
      panY: E.view.panY,
    };

    try {
      /* 内容が(余白, 余白)から始まるようにパンだけ平行移動。
         ズーム・角度はそのまま＝見た目をそのまま切り出す */
      const outW = Math.ceil(bbox.maxX - bbox.minX) + MARGIN * 2;
      const outH = Math.ceil(bbox.maxY - bbox.minY) + MARGIN * 2;
      E.view.panX = saved.panX + (MARGIN - bbox.minX);
      E.view.panY = saved.panY + (MARGIN - bbox.minY);

      canvas.width = outW * scale;
      canvas.height = outH * scale;

      E.setExportOverride({ bg, scale });
      E.render();

      const url = canvas.toDataURL("image/png");

      /* ダウンロード（ファイル名に日時を付与） */
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
      const a = document.createElement("a");
      a.href = url;
      a.download = `axonom-map-${stamp}.png`;
      a.click();
      return true;
    } finally {
      /* 失敗してもエディタ表示は必ず元へ戻す */
      E.setExportOverride(null);
      canvas.width = saved.w;
      canvas.height = saved.h;
      E.view.panX = saved.panX;
      E.view.panY = saved.panY;
      E.render();
    }
  }

  /* ---- UIバインド --------------------------------------------- */

  const openBtn = document.getElementById("btn-export");
  if (openBtn) openBtn.addEventListener("click", () => E.openModal("modal-export"));

  const runBtn = document.getElementById("btn-export-run");
  if (runBtn) {
    runBtn.addEventListener("click", () => {
      const bg = document.querySelector('input[name="exp-bg"]:checked')?.value || "transparent";
      const scale = Number(document.querySelector('input[name="exp-scale"]:checked')?.value || 1);
      const ok = exportPNG({ bg, scale });
      if (ok) {
        E.closeModal("modal-export");
        E.showHint("PNGを書き出しました。");
      }
    });
  }

  /* 検証用フック */
  E.exportPNG = exportPNG;
})();
