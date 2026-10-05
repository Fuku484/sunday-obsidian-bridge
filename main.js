/*
 * Sunday Obsidian Bridge（09_セカンドブレイン機能設計書）
 *
 * Sunday の自宅サーバーから同期命令を取りに行き、Sunday/ 配下のノートを作成・更新する。
 * 利用者がVaultで書いた部分（利用者メモ・追加したタグ・タスクのチェック）だけをサーバーへ返す。
 *
 * 守ること:
 * - 書き込むのは Sunday/ 配下だけ。利用者が作ったノートは削除・移動・全面書き換えしない。
 * - サーバーへ送るのは、Sunday管理ノートの許可した項目と、利用者が sunday_import: true を付けたノートだけ。
 *   それ以外のノート・.obsidian の設定・添付ファイルは読まない。
 * - 自動生成節を利用者が書き換えていたら上書きせず、_System/Conflicts に差分ノートを作る。
 *
 * ビルド不要の素のJavaScript。このフォルダを <Vault>/.obsidian/plugins/sunday-obsidian-bridge/ に置く。
 *
 * 同じVaultをiCloud等で複数の端末から開くときは、同期を受け持つ端末を1台だけにする。
 * 設定（data.json）はVaultと一緒に共有されるため、「この端末で同期する」だけは端末ごとに保存する。
 * 受け持たない端末は何もしない（他の端末で書いた編集は、同期で届いた先の受け持ち端末が拾う）。
 */

const { Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, normalizePath, parseYaml, requestUrl, stringifyYaml } = require("obsidian");

const ROOT = "Sunday";
const SYSTEM = `${ROOT}/_System`;
const PREVIEW = `${SYSTEM}/Preview`;
const CONFLICTS = `${SYSTEM}/Conflicts`;
const START = "<!-- sunday:generated:start -->";
const END = "<!-- sunday:generated:end -->";
const MEMO_HEADING = "## 利用者メモ";
const MEMO_GUARD = "<!-- この節は同期で自動上書きしない -->";
const TASK_MARK = /^\s*[-*+] \[([ xX])\] .*<!-- sunday-task:([0-9a-f-]{36}) -->\s*$/;
const PLUGIN_VERSION = "0.4.0";
const ACTIVE_KEY = "sunday-bridge-active";

// グラフビューの色分け（上にあるものほど優先）。Sunday がノートに付ける管理用タグで見分ける
const GRAPH_GROUPS = [
  ["tag:#sunday/index", 0xf5c542, "ホーム・一覧"],
  ["tag:#sunday/topic", 0xa78bfa, "話題"],
  ["tag:#sunday/project", 0x3b82f6, "プロジェクト"],
  ["tag:#sunday/area", 0x22d3ee, "領域"],
  ["tag:#sunday/resource", 0x22c55e, "調べもの"],
  ["tag:#sunday/daily", 0xf97316, "日記"],
  ["tag:#sunday/task", 0xeab308, "タスク"],
  ["tag:#sunday/inbox", 0xef4444, "Inbox"],
  ["tag:#sunday/timeline", 0x9ca3af, "行動記録"],
];
const GRAPH_SEARCH = '-path:"Sunday/_System"';

const DEFAULT_SETTINGS = {
  serverUrl: "",
  deviceToken: "",
  intervalSeconds: 60,
  vaultId: "",
  // 以下はプラグインが管理する状態
  accessToken: "",
  accessExpiresAt: "",
  mode: "",
  lastSyncAt: "",
  lastError: "",
  notes: {}, // note_id -> { path, writtenHash, fileHash, sent: { memo, tags, tasks } }
  imports: {}, // path -> 送った内容のハッシュ
};

// ---- SHA-256（vault.process の中で同期的に比べるため、自前で計算する） ----
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const bitLen = bytes.length * 8;
  const total = Math.ceil((bytes.length + 9) / 64) * 64;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(total - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(total - 4, bitLen >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, "0")).join("");
}

// サーバー（app/obsidian/notes.py の content_hash）と同じ手順で比べる。
// 改行をLFにし、行末の空白と前後の空行を除き、チェックボックスの印は同じものとみなす
function contentHash(text) {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const normalized = lines.map((l) => l.replace(/\s+$/, "").replace(/^(\s*[-*+] )\[[ xX]\]/, "$1[ ]")).join("\n").trim();
  return sha256(normalized);
}

// ---- ノートの分解と組み立て ----

// 先頭の Frontmatter、自動生成節の前・中・後に分ける。区切りが見つからなければ generated は null
function splitNote(data) {
  let fmText = "";
  let body = data;
  const fm = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(data);
  if (fm) {
    fmText = fm[1];
    body = data.slice(fm[0].length);
  }
  const s = body.indexOf(START);
  const e = body.indexOf(END);
  if (s < 0 || e < 0 || e < s) return { fmText, before: body, generated: null, after: "" };
  return {
    fmText,
    before: body.slice(0, s),
    generated: body.slice(s + START.length, e).replace(/^\n/, "").replace(/\n$/, ""),
    after: body.slice(e + END.length),
  };
}

function parseFrontmatter(fmText) {
  if (!fmText) return {};
  try {
    return parseYaml(fmText) || {};
  } catch (e) {
    return {};
  }
}

function asTags(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return value.split(/[,\s]+/).filter(Boolean);
  return [];
}

function compose(existing, job) {
  const current = existing ? parseFrontmatter(existing.fmText) : {};
  const managed = new Set(job.managed_keys);
  const managedTags = new Set(job.managed_tags);
  // 利用者が足したタグ・項目は残す（Sundayが付けたことのあるタグは、Sundayの版に従う）
  const userTags = asTags(current.tags).filter((t) => !managedTags.has(t));
  const fm = { ...job.frontmatter, last_synced_at: new Date().toISOString() };
  fm.tags = Array.from(new Set([...asTags(job.frontmatter.tags), ...userTags]));
  for (const [key, value] of Object.entries(current)) {
    if (!managed.has(key) && key !== "tags") fm[key] = value;
  }
  const before = existing ? existing.before : "\n";
  // 自動生成節の後ろ（利用者メモを含む）は利用者の領域として、そのまま残す
  const after = existing && existing.generated !== null ? existing.after : `\n\n${job.memo}`;
  return `---\n${stringifyYaml(fm)}---\n${before}${START}\n${job.generated}\n${END}${after}`;
}

function extractMemo(data) {
  const i = data.indexOf(MEMO_HEADING);
  if (i < 0) return "";
  return data.slice(i + MEMO_HEADING.length).replace(MEMO_GUARD, "").trim();
}

function extractTasks(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = TASK_MARK.exec(line);
    if (m) out[m[2]] = m[1] !== " ";
  }
  return out;
}

function safeName(name) {
  return name.replace(/[\\/:*?"<>|#^[\]\n\r\t]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "無題";
}

function insideSunday(path) {
  return path.startsWith(`${ROOT}/`) && !path.startsWith(`${SYSTEM}/`);
}

function randomId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return "vault-" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

module.exports = class SundayBridge extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!this.settings.vaultId) {
      this.settings.vaultId = randomId();
      await this.saveSettings();
    }
    this.pending = []; // サーバーへ送る前の変更
    this.syncing = false;
    this.selfWrites = new Set(); // 自分が書き込み・移動中のパス（変更として送り返さない）
    this.timers = {};

    this.addSettingTab(new SundaySettingTab(this.app, this));
    this.addCommand({ id: "sync-now", name: "今すぐ同期", callback: () => this.syncNow(true) });
    this.addCommand({ id: "graph-style", name: "グラフの色分けを設定", callback: () => this.applyGraphStyle() });
    // 外から（Local REST API のコマンド実行など）でも、同期を受け持つ端末を切り替えられるようにする
    this.addCommand({ id: "activate-device", name: "この端末で同期を受け持つ", callback: () => this.switchDevice(true) });
    this.addCommand({ id: "deactivate-device", name: "この端末での同期をやめる", callback: () => this.switchDevice(false) });

    this.registerEvent(this.app.vault.on("modify", (file) => this.onModify(file)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.onDelete(file)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.onRename(file, oldPath)));
    this.registerEvent(this.app.metadataCache.on("changed", (file, data, cache) => this.onMetadata(file, data, cache)));

    this.app.workspace.onLayoutReady(() => {
      this.scanImports();
      this.syncNow(false);
    });
    this.restartTimer();
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // 端末ごとの設定。Vaultと一緒に同期されない場所へ保存する
  isActiveDevice() {
    return this.app.loadLocalStorage(ACTIVE_KEY) === "1";
  }

  setActiveDevice(active) {
    this.app.saveLocalStorage(ACTIVE_KEY, active ? "1" : null);
  }

  async switchDevice(active) {
    this.setActiveDevice(active);
    new Notice(active ? "Sunday: この端末で同期を受け持ちます" : "Sunday: この端末での同期をやめました");
    if (active) {
      await this.scanImports();
      await this.syncNow(false);
    }
  }

  restartTimer() {
    if (this.interval) window.clearInterval(this.interval);
    const seconds = Math.max(15, Number(this.settings.intervalSeconds) || 60);
    this.interval = window.setInterval(() => this.syncNow(false), seconds * 1000);
    this.registerInterval(this.interval);
  }

  // ---- 通信 ----

  async call(method, path, body, auth = "access") {
    const base = this.settings.serverUrl.replace(/\/+$/, "");
    if (!base) throw new Error("サーバーのURLが未設定です");
    const headers = { "Content-Type": "application/json" };
    if (auth === "device") headers.Authorization = `Bearer ${this.settings.deviceToken}`;
    else {
      headers.Authorization = `Bearer ${this.settings.accessToken}`;
      headers["X-Sunday-Vault"] = this.settings.vaultId;
    }
    const res = await requestUrl({
      url: base + path, method, headers, body: body === undefined ? undefined : JSON.stringify(body), throw: false,
    });
    if (res.status === 401 && auth === "access") {
      this.settings.accessToken = ""; // 期限切れ。次の同期で登録し直す
      throw new Error("アクセストークンの期限が切れたため、登録し直します");
    }
    if (res.status >= 400) {
      const detail = (res.json && res.json.detail) || res.text;
      throw new Error(`${res.status} ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
    }
    return res.json;
  }

  async ensureAccess() {
    const expires = Date.parse(this.settings.accessExpiresAt || "") || 0;
    if (this.settings.accessToken && expires - Date.now() > 5 * 60 * 1000) return;
    if (!this.settings.deviceToken) throw new Error("端末トークンが未設定です");
    const result = await this.call("POST", "/api/v1/obsidian/agents/register", {
      vault_id: this.settings.vaultId, vault_name: this.app.vault.getName(), plugin_version: PLUGIN_VERSION,
    }, "device");
    this.settings.accessToken = result.access_token;
    this.settings.accessExpiresAt = result.expires_at;
    await this.saveSettings();
  }

  async syncNow(manual) {
    if (this.syncing || !this.isActiveDevice() || !this.settings.serverUrl || !this.settings.deviceToken) return;
    this.syncing = true;
    try {
      await this.ensureAccess();
      await this.flushChanges();
      const { mode, jobs } = await this.call("GET", "/api/v1/obsidian/sync-jobs");
      if (this.settings.mode === "preview" && mode === "auto") await this.removePreview();
      this.settings.mode = mode;
      for (const job of jobs) await this.runJob(job);
      await this.flushChanges();
      this.settings.lastSyncAt = new Date().toISOString();
      this.settings.lastError = "";
      if (manual) new Notice(`Sunday: 同期しました（${jobs.length}件）`);
    } catch (e) {
      this.settings.lastError = String(e.message || e);
      if (manual) new Notice(`Sunday: 同期できませんでした — ${this.settings.lastError}`);
    } finally {
      await this.saveSettings();
      this.syncing = false;
    }
  }

  async report(job, result, extra = {}) {
    await this.call("POST", `/api/v1/obsidian/sync-jobs/${job.id}/result`, { result, path: job.path, ...extra });
  }

  // ---- 同期命令の実行 ----

  async runJob(job) {
    try {
      const path = normalizePath(job.path);
      if (!path.startsWith(`${ROOT}/`) || !path.endsWith(".md")) throw new Error("Sunday/ の外への書き込みは行いません");
      const outcome = job.preview ? await this.writePreview(path, job) : await this.writeNote(path, job);
      if (outcome.conflict) await this.report(job, "conflict", { vault_hash: outcome.vaultHash });
      else await this.report(job, "success", { content_hash: job.content_hash });
    } catch (e) {
      await this.report(job, "failed", { error: String(e.message || e).slice(0, 400) }).catch(() => {});
    }
  }

  async writePreview(path, job) {
    const file = this.app.vault.getAbstractFileByPath(path);
    const content = compose(null, job);
    await this.ensureFolder(path);
    if (file instanceof TFile) await this.app.vault.modify(file, content);
    else await this.app.vault.create(path, content);
    return { conflict: false };
  }

  async writeNote(path, job) {
    const rec = this.settings.notes[job.note_id] || {};
    let file = await this.locate(job, rec, path);
    if (!file) {
      await this.ensureFolder(path);
      this.selfWrites.add(path);
      file = await this.app.vault.create(path, compose(null, job));
    } else {
      let conflict = null;
      this.selfWrites.add(file.path);
      await this.app.vault.process(file, (data) => {
        const parts = splitNote(data);
        const vaultHash = parts.generated === null ? "" : contentHash(parts.generated);
        const known = [job.base_hash, job.content_hash, rec.writtenHash].filter(Boolean);
        // 利用者が自動生成節を書き換えていたら上書きしない（区切りを消した場合も同じ扱い）
        if (!job.force && (parts.generated === null || !known.includes(vaultHash))) {
          conflict = { vaultHash, vaultText: parts.generated === null ? data : parts.generated };
          return data;
        }
        return compose(parts, job);
      });
      if (conflict) {
        this.selfWrites.delete(file.path);
        await this.writeConflict(file.path, job, conflict.vaultText);
        return { conflict: true, vaultHash: conflict.vaultHash };
      }
    }
    const data = await this.app.vault.read(file);
    this.settings.notes[job.note_id] = {
      path: file.path,
      writtenHash: job.content_hash,
      fileHash: sha256(data),
      sent: rec.sent || { memo: extractMemo(data), tags: null, tasks: extractTasks(job.generated) },
    };
    window.setTimeout(() => this.selfWrites.delete(file.path), 2000);
    return { conflict: false };
  }

  // 命令の場所にノートがあればそれを、利用者が動かしていれば動かした先を使う。分類が変わったときは移す
  async locate(job, rec, path) {
    const at = (p) => {
      const f = p ? this.app.vault.getAbstractFileByPath(p) : null;
      return f instanceof TFile ? f : null;
    };
    const target = at(path);
    if (target) return target;
    const moved = at(rec.path);
    if (moved && rec.path !== job.previous_path) return moved; // 利用者が移した場所を尊重する
    const previous = at(job.previous_path) || moved;
    if (previous) {
      this.selfWrites.add(previous.path);
      this.selfWrites.add(path);
      await this.ensureFolder(path);
      await this.app.fileManager.renameFile(previous, path); // リンクも新しい場所へ張り替わる
      return at(path);
    }
    return null;
  }

  async writeConflict(path, job, vaultText) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const name = safeName(path.split("/").pop().replace(/\.md$/, ""));
    const conflictPath = normalizePath(`${CONFLICTS}/${name} ${stamp}.md`);
    const fm = { sunday_conflict_of: job.note_id, sunday_note_path: path, created_at: new Date().toISOString() };
    const body = [
      `# 競合: ${name}`,
      "",
      "Sunday の自動生成節が、前回の同期の後で Vault 側でも書き換えられていたため、ノートは更新していません。",
      "Bridge の設定画面の「要対応のノート」で、DB版を採用するか Vault版を残すかを選んでください。",
      "残したい書き込みは、ノートの「## 利用者メモ」へ移すと、以後の同期で消えません。",
      "",
      "## DB版（Sunday が書き込もうとした内容）",
      "",
      job.generated,
      "",
      "## Vault版（現在のノートの内容）",
      "",
      vaultText,
    ].join("\n");
    await this.ensureFolder(conflictPath);
    await this.app.vault.create(conflictPath, `---\n${stringifyYaml(fm)}---\n\n${body}\n`);
  }

  async ensureFolder(filePath) {
    const parts = filePath.split("/").slice(0, -1);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) await this.app.vault.createFolder(current).catch(() => {});
    }
  }

  // グラフビューの設定（<設定フォルダ>/graph.json）に Sunday 用の色分けを入れる。
  // 利用者が自分で作った色グループや、その他の表示設定は残す。この端末の中だけの変更で、サーバーへは送らない
  async applyGraphStyle() {
    const path = `${this.app.vault.configDir}/graph.json`;
    const adapter = this.app.vault.adapter;
    let config = {};
    try {
      if (await adapter.exists(path)) config = JSON.parse(await adapter.read(path)) || {};
    } catch (e) {
      config = {};
    }
    const ours = new Set(GRAPH_GROUPS.map(([query]) => query));
    const mine = (config.colorGroups || []).filter((g) => !ours.has(g.query));
    config.colorGroups = [...GRAPH_GROUPS.map(([query, rgb]) => ({ query, color: { a: 1, rgb } })), ...mine];
    config.showTags = true;
    config.showOrphans = false;
    if (!config.search) config.search = GRAPH_SEARCH;
    else if (!config.search.includes(GRAPH_SEARCH)) config.search = `${config.search} ${GRAPH_SEARCH}`;
    await adapter.write(path, JSON.stringify(config, null, 2));
    // 開いているグラフは設定を読み直さないので、閉じて開き直す
    const opened = this.app.workspace.getLeavesOfType("graph");
    opened.forEach((leaf) => leaf.detach());
    if (opened.length) this.app.commands.executeCommandById("graph:open");
    new Notice("Sunday: グラフの色分けを設定しました");
  }

  async removePreview() {
    const folder = this.app.vault.getAbstractFileByPath(PREVIEW);
    if (folder instanceof TFolder) await this.app.vault.delete(folder, true);
  }

  // ---- 利用者の編集を拾う ----

  noteIdForPath(path) {
    for (const [id, rec] of Object.entries(this.settings.notes)) if (rec.path === path) return id;
    return null;
  }

  queue(change) {
    if (!this.isActiveDevice()) return;
    this.pending.push(change);
    window.clearTimeout(this.timers.flush);
    this.timers.flush = window.setTimeout(() => this.flushChanges().catch(() => {}), 3000);
  }

  async flushChanges() {
    if (!this.pending.length || !this.settings.accessToken) return;
    const changes = this.pending.splice(0, 200);
    try {
      await this.call("POST", "/api/v1/obsidian/note-changes", { changes });
    } catch (e) {
      this.pending.unshift(...changes); // 次の同期で送り直す
      throw e;
    }
  }

  onModify(file) {
    if (!this.isActiveDevice()) return;
    if (!(file instanceof TFile) || file.extension !== "md" || this.selfWrites.has(file.path)) return;
    const id = this.noteIdForPath(file.path);
    if (!id) return;
    // 打鍵ごとに送らないよう、少し待ってからまとめて読む
    window.clearTimeout(this.timers[id]);
    this.timers[id] = window.setTimeout(() => this.collectEdits(id, file), 2000);
  }

  async collectEdits(id, file) {
    const rec = this.settings.notes[id];
    if (!rec) return;
    const data = await this.app.vault.cachedRead(file);
    const digest = sha256(data);
    if (digest === rec.fileHash) return; // 自分の書き込みのまま
    rec.fileHash = digest;
    const sent = rec.sent || (rec.sent = { memo: "", tags: null, tasks: {} });
    const memo = extractMemo(data);
    if (memo !== sent.memo) {
      this.queue({ note_id: id, kind: "memo", memo });
      sent.memo = memo;
    }
    const tags = asTags(parseFrontmatter(splitNote(data).fmText).tags).sort();
    if (JSON.stringify(tags) !== JSON.stringify(sent.tags)) {
      this.queue({ note_id: id, kind: "tags", tags });
      sent.tags = tags;
    }
    const generated = splitNote(data).generated;
    if (generated !== null) {
      const tasks = extractTasks(generated);
      const changed = Object.entries(tasks)
        .filter(([taskId, done]) => sent.tasks && taskId in sent.tasks && sent.tasks[taskId] !== done)
        .map(([taskId, done]) => ({ task_id: taskId, done }));
      if (changed.length) this.queue({ note_id: id, kind: "tasks", tasks: changed });
      sent.tasks = tasks;
    }
    await this.saveSettings();
  }

  onDelete(file) {
    if (!this.isActiveDevice() || !(file instanceof TFile)) return;
    const id = this.noteIdForPath(file.path);
    if (id && !this.selfWrites.has(file.path)) {
      // Vaultでの削除はDBの原本を消さない。サーバー側で同期を止め、復元か同期解除を待つ
      delete this.settings.notes[id];
      this.queue({ note_id: id, kind: "deleted" });
      this.saveSettings();
    }
    if (file.path in this.settings.imports) {
      delete this.settings.imports[file.path];
      this.queue({ kind: "import_removed", path: file.path });
    }
  }

  onRename(file, oldPath) {
    if (!this.isActiveDevice() || !(file instanceof TFile)) return;
    const id = this.noteIdForPath(oldPath);
    if (id && !this.selfWrites.has(file.path)) {
      if (insideSunday(file.path)) this.settings.notes[id].path = file.path;
      else delete this.settings.notes[id]; // Sunday/ の外へ出したノートは同期しない
      this.queue({ note_id: id, kind: "moved", path: file.path });
      this.saveSettings();
    } else if (id) {
      this.settings.notes[id].path = file.path;
    }
    if (oldPath in this.settings.imports) {
      // 連携ノートの場所が変わったら、古い場所の候補を取り下げて新しい場所で送り直す
      delete this.settings.imports[oldPath];
      this.queue({ kind: "import_removed", path: oldPath });
      this.app.vault.cachedRead(file).then((data) => this.onMetadata(file, data, this.app.metadataCache.getFileCache(file)));
    }
  }

  // sunday_import: true を付けたノートだけを連携候補として送る（設計書 6.1）
  onMetadata(file, data, cache) {
    if (!this.isActiveDevice()) return;
    if (!(file instanceof TFile) || file.path.startsWith(`${ROOT}/`)) return;
    const fm = (cache && cache.frontmatter) || {};
    const flagged = fm.sunday_import === true;
    const known = file.path in this.settings.imports;
    if (flagged) {
      const digest = sha256(data);
      if (this.settings.imports[file.path] === digest) return;
      this.settings.imports[file.path] = digest;
      this.queue({ kind: "import", path: file.path, title: file.basename, content: data });
      this.saveSettings();
    } else if (known) {
      delete this.settings.imports[file.path];
      this.queue({ kind: "import_removed", path: file.path });
      this.saveSettings();
    }
  }

  async scanImports() {
    if (!this.isActiveDevice()) return;
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (file.path.startsWith(`${ROOT}/`)) continue;
      const cache = this.app.metadataCache.getFileCache(file);
      const flagged = cache && cache.frontmatter && cache.frontmatter.sunday_import === true;
      if (flagged || file.path in this.settings.imports) this.onMetadata(file, await this.app.vault.cachedRead(file), cache);
    }
  }
};

class SundaySettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Sunday Obsidian Bridge" });

    new Setting(containerEl)
      .setName("この端末で同期する")
      .setDesc("サーバーとの同期を受け持つ端末を1台だけオンにする（例: 自宅PC）。他の端末はオフのままで、ノートの閲覧・メモ・タスクのチェックができる。")
      .addToggle((t) => t.setValue(this.plugin.isActiveDevice()).onChange(async (v) => {
        this.plugin.setActiveDevice(v);
        if (v) {
          await this.plugin.scanImports();
          await this.plugin.syncNow(true);
        }
        this.display();
      }));
    if (!this.plugin.isActiveDevice()) {
      containerEl.createEl("p", { text: "この端末は同期を受け持っていません。以下の設定は、同期を受け持つ端末で入れてください。" });
    }

    new Setting(containerEl)
      .setName("サーバーのURL")
      .setDesc("例: https://sunday-pc.<tailnet名>.ts.net（Tailscale）または http://<自宅PCのIP>:8000（同じLAN内）")
      .addText((t) => t.setValue(s.serverUrl).onChange(async (v) => { s.serverUrl = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl)
      .setName("端末トークン")
      .setDesc("サーバーで issue_device_token --purpose obsidian_bridge を実行して表示された値")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setValue(s.deviceToken).onChange(async (v) => {
          s.deviceToken = v.trim();
          s.accessToken = ""; // トークンを替えたら登録し直す
          await this.plugin.saveSettings();
        });
      });
    new Setting(containerEl)
      .setName("同期の間隔（秒）")
      .addText((t) => t.setValue(String(s.intervalSeconds)).onChange(async (v) => {
        s.intervalSeconds = Math.max(15, Number(v) || 60);
        await this.plugin.saveSettings();
        this.plugin.restartTimer();
      }));
    new Setting(containerEl).setName("Vault ID").setDesc(s.vaultId);

    const state = containerEl.createDiv();
    state.createEl("p", { text: `状態: ${s.mode === "auto" ? "自動作成" : s.mode === "preview" ? "プレビュー（Sunday/_System/Preview に試しに出力）" : "未接続"}` });
    state.createEl("p", { text: `最後の同期: ${s.lastSyncAt ? new Date(s.lastSyncAt).toLocaleString() : "まだ"}` });
    if (s.lastError) state.createEl("p", { text: `エラー: ${s.lastError}`, cls: "mod-warning" });

    new Setting(containerEl).setName("今すぐ同期").addButton((b) => b.setButtonText("同期").onClick(async () => {
      await this.plugin.syncNow(true);
      this.display();
    }));
    if (s.mode === "preview") {
      new Setting(containerEl)
        .setName("自動作成を有効にする")
        .setDesc("プレビューの内容を確認したら押してください。Sunday/ の本来の場所へノートを作り、プレビューは片付けます。")
        .addButton((b) => b.setButtonText("有効にする").setCta().onClick(async () => {
          await this.plugin.call("POST", "/api/v1/obsidian/vault/mode", { mode: "auto" });
          await this.plugin.syncNow(true);
          this.display();
        }));
    }
    const graph = new Setting(containerEl)
      .setName("グラフの色分けを設定")
      .setDesc("グラフビューで、Sunday のノートを種類ごとに色分けし、タグも点として表示する。自分で作った色グループは残る。")
      .addButton((b) => b.setButtonText("設定する").onClick(() => this.plugin.applyGraphStyle()));
    const legend = graph.descEl.createDiv();
    for (const [, rgb, label] of GRAPH_GROUPS) {
      const item = legend.createSpan({ text: `● ${label}　` });
      item.style.color = `#${rgb.toString(16).padStart(6, "0")}`;
    }
    this.renderAttention(containerEl);
  }

  async renderAttention(containerEl) {
    const box = containerEl.createDiv();
    if (!this.plugin.settings.accessToken) return;
    let info;
    try {
      info = await this.plugin.call("GET", "/api/v1/obsidian/vault");
    } catch (e) {
      return;
    }
    if (!info.attention.length) return;
    box.createEl("h3", { text: "要対応のノート" });
    const act = async (id, action) => {
      await this.plugin.call("POST", `/api/v1/obsidian/notes/${id}/resolve`, { action });
      await this.plugin.syncNow(true);
      this.display();
    };
    for (const note of info.attention) {
      const row = new Setting(box).setName(note.title).setDesc(
        note.status === "conflict" ? `競合: ${note.path}` : `Vaultで削除されました: ${note.path}`,
      );
      if (note.status === "conflict") {
        row.addButton((b) => b.setButtonText("DB版を採用").onClick(() => act(note.id, "use_db")));
        row.addButton((b) => b.setButtonText("Vault版を残す").onClick(() => act(note.id, "keep_vault")));
      } else {
        row.addButton((b) => b.setButtonText("復元").onClick(() => act(note.id, "restore")));
        row.addButton((b) => b.setButtonText("同期を解除").onClick(() => act(note.id, "unlink")));
      }
    }
  }
}
