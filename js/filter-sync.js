/**
 * フィルタ設定(mute / unmute / forceMute)をシークレットGist経由で端末間共有するモジュール
 * (hateb-tycoon の js/filter-sync.js が元)。Gist IDだけを設定する。
 *
 * - 1つのGistに種類ごとのCSVファイル(tycoon-filter-<kind>.csv、type,value形式)を置く。
 * - 同期 = Gistから取り込み(マージ)→ ローカルとの和集合でGistを上書き。つまりルールは
 *   「積み上げ」方式で、削除は同期されない。ルールを消したい時はGist側のCSVを直接編集する
 *   (ただし他端末のローカルに残っていれば次の同期で復活する)。
 * - 起動時は取り込みのみ(ETagで変更なしなら304)。書き込みは手動の「保存して同期」だけ。
 * - 読み取りは認証不要(Gist ID だけの読み取り専用端末でも取り込める)。書き込みには js/gist.js の
 *   トークンが必要。
 * - ファイルはhateb-tycoonと共有する。このアプリ非対応のtype(user/comment等)の行は
 *   取り込まずに無視するが、上書き時にはリモートの行をそのまま残す(相手アプリのルールを消さない)。
 * - CSVの解析・生成は app.js のものを init で受け取る。
 */
(function (global) {
  const STORAGE_KEY = 'feed-tycoon:filterSync';
  // hateb-tycoonなど他アプリと同じファイルを共有するため、アプリ名は含めない
  const fileName = (kind) => `tycoon-filter-${kind}.csv`;

  // { gistId, etag, lastSyncAt, lastError }
  let state = loadState();
  let parseCsv = null;
  let toCsv = null;

  function loadState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function setState(patch) {
    state = { ...state, ...patch };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      // localStorageが使えない環境では記憶をあきらめる
    }
  }

  function isConfigured() {
    return !!state.gistId;
  }

  function normalize(text) {
    return String(text || '').replace(/\r\n/g, '\n').trim();
  }

  // foreign: リモートにあった未対応type行(上書きで消さないよう一緒に書き出す)
  function localCsv(kind, foreign) {
    return toCsv(Filters.sortRules([...Filters.loadRules(kind), ...(foreign || [])]));
  }

  // リモートの各CSVをローカルへマージする。
  // 戻り値: { added, ignored, errors, texts, invalid }(invalidは不正CSVだった種類。上書きしない)
  async function mergeFromRemote(json) {
    const result = { added: 0, ignored: 0, errors: [], texts: {}, invalid: new Set(), foreign: {} };
    for (const kind of Filters.KINDS) {
      const text = await Gist.fileText(json, fileName(kind));
      result.texts[kind] = text;
      // ファイル無し/空/ヘッダーのみは「リモートにルール無し」(パーサーは空データをエラーにするため先に除く)
      if (!normalize(text) || /^type,value$/i.test(normalize(text))) continue;
      const parsed = parseCsv(text);
      if (parsed.errors.length > 0) {
        // 手で編集して壊したCSVを、ローカルの内容で黙って上書きしてしまわないようにする
        result.invalid.add(kind);
        result.errors.push(`${kind}: ${parsed.errors[0]}`);
        continue;
      }
      result.added += Filters.importRules(kind, parsed.rules);
      result.ignored += parsed.ignored;
      result.foreign[kind] = parsed.ignoredRules;
    }
    return result;
  }

  // 保存して同期: 取り込み(マージ) → トークンがあれば和集合で上書き。
  async function sync() {
    if (!state.gistId) throw new Error('Gist IDを入力してください');
    try {
      const res = await Gist.get(state.gistId);
      const merged = await mergeFromRemote(res.json);
      let pushed = 0;
      let etag = res.etag;
      if (Gist.getToken()) {
        const files = {};
        for (const kind of Filters.KINDS) {
          if (merged.invalid.has(kind)) continue;
          if (Filters.loadRules(kind).length === 0 && !normalize(merged.texts[kind])) continue;
          const csv = localCsv(kind, merged.foreign[kind]);
          if (normalize(csv) !== normalize(merged.texts[kind])) files[fileName(kind)] = csv;
        }
        pushed = Object.keys(files).length;
        if (pushed > 0) {
          await Gist.update(state.gistId, files);
          etag = ''; // 自分の書き込みでETagが変わるため、次回は全量取得させる
        }
      }
      setState({ etag, lastSyncAt: Date.now(), lastError: '' });
      return { added: merged.added, ignored: merged.ignored, errors: merged.errors, pushed, canPush: !!Gist.getToken() };
    } catch (err) {
      setState({ lastError: err && err.message ? err.message : String(err) });
      throw err;
    }
  }

  // 起動時: 取り込みのみ(最大 timeoutMs だけ待つ)。失敗は無視して通常起動する。
  async function syncOnStartup(timeoutMs) {
    if (!state.gistId) return;
    const pull = async () => {
      const res = await Gist.get(state.gistId, state.etag);
      if (!res) return; // 304: 前回取り込み以降に変更なし
      await mergeFromRemote(res.json);
      setState({ etag: res.etag, lastSyncAt: Date.now(), lastError: '' });
    };
    const timeout = new Promise((resolve) => setTimeout(resolve, timeoutMs));
    await Promise.race([
      pull().catch((err) => {
        setState({ lastError: err && err.message ? err.message : String(err) });
        console.warn('[filter-sync] startup pull failed', err);
      }),
      timeout,
    ]);
  }

  // 新しいシークレットGistを作成してIDを保存する(トークン必須)
  async function createGist() {
    const files = {};
    for (const kind of Filters.KINDS) files[fileName(kind)] = localCsv(kind);
    const id = await Gist.create('feed-tycoon filters', files);
    setState({ gistId: id, etag: '', lastError: '' });
    return id;
  }

  function configure({ gistId }) {
    setState({ gistId: Gist.parseGistId(gistId), etag: '', lastError: '' });
  }

  function getConfig() {
    return { gistId: state.gistId || '', lastSyncAt: state.lastSyncAt || 0, lastError: state.lastError || '' };
  }

  function init(opts) {
    parseCsv = opts.parseCsv;
    toCsv = opts.toCsv;
  }

  global.FilterSync = { init, sync, syncOnStartup, createGist, configure, getConfig, isConfigured };
})(window);
