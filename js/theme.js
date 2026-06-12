/* ============================================================
   AXONOM — theme.js（テーマカラー永続化＋プロジェクト管理）

   役割：
   1. テーマカラーの保存・復元（ホーム画面と共有のlocalStorageキー）
   2. マップデータのLocalStorage自動保存（editor.jsの
      "axonom:change" イベントをデバウンス済みで受け取る）
   3. 複数プロジェクトの管理（作成・切替・名前変更・削除）と
      モーダルUIの描画
   4. JSONファイルとしてのエクスポート / インポート

   ストレージ設計：
   - axonom:theme           … テーマ名（ホームと共有）
   - axonom:projects        … [{id, name, updated}] の一覧
   - axonom:project:<id>    … 各プロジェクトの serialize() 結果
   - axonom:current         … 開いているプロジェクトID
   ============================================================ */

"use strict";

(() => {
  const E = window.__axoEditor;
  if (!E) return;

  const KEY_THEME = "axonom:theme";
  const KEY_INDEX = "axonom:projects";
  const KEY_CURRENT = "axonom:current";
  const KEY_PROJECT = (id) => "axonom:project:" + id;

  /* ---- ストレージ入出力（壊れたJSONに耐える） ------------------ */

  function readJSON(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch (_) {
      return fallback;
    }
  }

  const readIndex = () => readJSON(KEY_INDEX, []);
  const writeIndex = (list) => localStorage.setItem(KEY_INDEX, JSON.stringify(list));

  let currentId = localStorage.getItem(KEY_CURRENT);

  /* ---- テーマの保存・復元 ------------------------------------- */

  const savedTheme = localStorage.getItem(KEY_THEME);
  if (savedTheme) E.applyTheme(savedTheme);

  /* エディタのテーマドット操作を横で拾って永続化する */
  document.querySelectorAll(".theme-dot").forEach((dot) => {
    dot.addEventListener("click", () => {
      localStorage.setItem(KEY_THEME, dot.dataset.themeName);
    });
  });

  /* （参考データ）assets/themes/themes.json を読めたら
     モーダルのテーマ見本に使う。失敗してもCSS変数で代替できる */
  let themeDefs = null;
  fetch("assets/themes/themes.json")
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => { themeDefs = j; })
    .catch(() => {});

  /* ---- プロジェクトの保存・読込 -------------------------------- */

  function saveCurrent() {
    if (!currentId) return;
    const data = E.serialize();
    localStorage.setItem(KEY_PROJECT(currentId), JSON.stringify(data));
    const index = readIndex();
    const item = index.find((p) => p.id === currentId);
    if (item) item.updated = Date.now();
    writeIndex(index);
    renderProjectList();
  }

  function createProject(name, data = null) {
    const id = "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const index = readIndex();
    index.push({ id, name, updated: Date.now() });
    writeIndex(index);
    if (data) localStorage.setItem(KEY_PROJECT(id), JSON.stringify(data));
    return id;
  }

  function openProject(id) {
    if (id === currentId) return;
    saveCurrent(); // 切替前に現在の作業を保存
    const data = readJSON(KEY_PROJECT(id), null);
    currentId = id;
    localStorage.setItem(KEY_CURRENT, id);
    if (data) {
      E.loadDoc(data);
    }
    renderProjectList();
    E.showHint("プロジェクトを開きました：" + (readIndex().find((p) => p.id === id)?.name || ""));
  }

  function renameProject(id, name) {
    const index = readIndex();
    const item = index.find((p) => p.id === id);
    if (item && name.trim()) {
      item.name = name.trim();
      writeIndex(index);
    }
    renderProjectList();
  }

  function deleteProject(id) {
    let index = readIndex();
    if (index.length <= 1) {
      E.showHint("最後のプロジェクトは削除できません。");
      return;
    }
    index = index.filter((p) => p.id !== id);
    writeIndex(index);
    localStorage.removeItem(KEY_PROJECT(id));
    if (id === currentId) {
      /* 開いていたものを消したら、いちばん新しい別プロジェクトへ */
      const next = [...index].sort((a, b) => b.updated - a.updated)[0];
      currentId = null;
      openProject(next.id);
    } else {
      renderProjectList();
    }
  }

  /* ---- JSONエクスポート / インポート --------------------------- */

  function exportJSON() {
    const data = E.serialize();
    const name = readIndex().find((p) => p.id === currentId)?.name || "axonom-project";
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name.replace(/[\\/:*?"<>|]/g, "_") + ".json";
    a.click();
    URL.revokeObjectURL(a.href);
    E.showHint("JSONを書き出しました。");
  }

  function importJSON(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (data.app !== "axonom" || !Array.isArray(data.floors)) {
          throw new Error("AXONOMのプロジェクトファイルではありません");
        }
        saveCurrent();
        const name = file.name.replace(/\.json$/i, "");
        const id = createProject(name, data);
        currentId = null; // openProjectの二重保存を防ぐ
        currentId = id;
        localStorage.setItem(KEY_CURRENT, id);
        E.loadDoc(data);
        renderProjectList();
        E.showHint("インポートしました：" + name);
      } catch (err) {
        E.showHint("読み込みに失敗しました：" + err.message);
      }
    };
    reader.readAsText(file);
  }

  /* ---- モーダルUI ---------------------------------------------- */

  const fmtDate = (t) => {
    const d = new Date(t);
    const z = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}/${z(d.getMonth() + 1)}/${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`;
  };

  function renderProjectList() {
    const list = document.getElementById("project-list");
    if (!list) return;
    list.innerHTML = "";
    [...readIndex()].sort((a, b) => b.updated - a.updated).forEach((p) => {
      const row = document.createElement("li");
      row.className = "ed-project-row" + (p.id === currentId ? " is-active" : "");

      const info = document.createElement("div");
      info.className = "ed-project-info";
      const name = document.createElement("strong");
      name.textContent = p.name;
      const meta = document.createElement("span");
      meta.textContent = "更新 " + fmtDate(p.updated);
      info.append(name, meta);

      const openBtn = document.createElement("button");
      openBtn.className = "ed-btn";
      openBtn.textContent = p.id === currentId ? "編集中" : "開く";
      openBtn.disabled = p.id === currentId;
      openBtn.addEventListener("click", () => {
        openProject(p.id);
        E.closeModal("modal-projects");
      });

      const renameBtn = document.createElement("button");
      renameBtn.className = "ed-btn";
      renameBtn.textContent = "改名";
      renameBtn.addEventListener("click", () => {
        const input = document.createElement("input");
        input.type = "text";
        input.value = p.name;
        name.replaceWith(input);
        input.focus();
        const commit = () => renameProject(p.id, input.value || p.name);
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") commit(); });
        input.addEventListener("blur", commit);
      });

      const delBtn = document.createElement("button");
      delBtn.className = "ed-btn";
      delBtn.textContent = "削除";
      delBtn.addEventListener("click", () => {
        if (confirm(`「${p.name}」を削除しますか？この操作は元に戻せません。`)) {
          deleteProject(p.id);
        }
      });

      row.append(info, openBtn, renameBtn, delBtn);
      list.appendChild(row);
    });
  }

  /* ---- イベント結線 -------------------------------------------- */

  document.getElementById("btn-projects")
    ?.addEventListener("click", () => { renderProjectList(); E.openModal("modal-projects"); });

  document.getElementById("btn-project-new")?.addEventListener("click", () => {
    saveCurrent();
    const id = createProject("Untitled " + (readIndex().length + 1));
    currentId = id;
    localStorage.setItem(KEY_CURRENT, id);
    /* まっさらなドキュメントで開始 */
    E.loadDoc({
      app: "axonom", version: 1,
      floors: [{ id: "f1", name: "1F", visible: true, shapes: [] }],
      activeFloorId: "f1", idSeq: 1000,
      view: { ax: 0, ay: 0, az: 0, ob: 0, zoom: 1, panX: E.canvas.clientWidth / 2, panY: E.canvas.clientHeight / 2 },
      theme: document.documentElement.dataset.theme,
    });
    saveCurrent();
    E.closeModal("modal-projects");
    E.showHint("新しいプロジェクトを作成しました。");
  });

  document.getElementById("btn-project-export")?.addEventListener("click", exportJSON);

  const importInput = document.getElementById("project-import-file");
  document.getElementById("btn-project-import")?.addEventListener("click", () => importInput?.click());
  importInput?.addEventListener("change", () => {
    if (importInput.files[0]) importJSON(importInput.files[0]);
    importInput.value = "";
  });

  /* 自動保存：editor.jsが変更のたびに（デバウンス済みで）発火する */
  window.addEventListener("axonom:change", saveCurrent);
  /* 離脱時にも保存しておく */
  window.addEventListener("beforeunload", saveCurrent);

  /* ---- 起動時：前回のプロジェクトを復元 ------------------------- */

  const index = readIndex();
  if (currentId && index.some((p) => p.id === currentId)) {
    const data = readJSON(KEY_PROJECT(currentId), null);
    if (data) E.loadDoc(data);
  } else {
    /* 初回起動：今の空ドキュメントを最初のプロジェクトとして登録 */
    currentId = createProject("My First Map");
    localStorage.setItem(KEY_CURRENT, currentId);
    saveCurrent();
  }

  /* 検証用フック */
  E.projects = { saveCurrent, createProject, openProject, deleteProject, exportJSON, readIndex, get currentId() { return currentId; } };
})();
