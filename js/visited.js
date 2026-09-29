/**
 * localStorage に次の 2 つを記録するモジュール。どちらも URL -> 時刻(ms) で、
 * 古いものから MAX_ENTRIES を超えた分を捨てる。
 *   - 既読: 記事リンクを開いた(一覧のグレーアウト・既読を隠す の対象)
 *   - ブックマークページの最終訪問: 前回訪問後に付いたコメントに NEW を付けるための基準
 */
(function (global) {
  const STORAGE_KEY = 'feed-tycoon:visited';
  const MAX_ENTRIES = 3000;

  let cache = null;

  function load() {
    if (cache) return cache;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      cache = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (e) {
      cache = {};
    }
    return cache;
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
    } catch (e) {
      // localStorage が使えない環境では既読管理をあきらめる
    }
  }

  function markRead(url) {
    if (!url) return;
    const map = load();
    map[url] = Date.now();
    const keys = Object.keys(map);
    if (keys.length > MAX_ENTRIES) {
      keys.sort((a, b) => map[a] - map[b]);
      keys.slice(0, keys.length - MAX_ENTRIES).forEach((k) => delete map[k]);
    }
    save();
  }

  function isRead(url) {
    return !!url && Object.prototype.hasOwnProperty.call(load(), url);
  }

  const BOOKMARK_VISIT_KEY = 'feed-tycoon:bmVisited';
  let bookmarkCache = null;

  function loadBookmarkVisits() {
    if (bookmarkCache) return bookmarkCache;
    try {
      const raw = localStorage.getItem(BOOKMARK_VISIT_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      bookmarkCache = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (e) {
      bookmarkCache = {};
    }
    return bookmarkCache;
  }

  // 前回ブックマークページを開いた時刻(ms)。未訪問なら null。
  // markBookmarkVisit で上書きされるため、新着判定には上書き前に取得しておくこと。
  function getLastBookmarkVisit(url) {
    const t = url ? loadBookmarkVisits()[url] : null;
    return typeof t === 'number' ? t : null;
  }

  function markBookmarkVisit(url) {
    if (!url) return;
    const map = loadBookmarkVisits();
    map[url] = Date.now();
    const keys = Object.keys(map);
    if (keys.length > MAX_ENTRIES) {
      keys.sort((a, b) => map[a] - map[b]);
      keys.slice(0, keys.length - MAX_ENTRIES).forEach((k) => delete map[k]);
    }
    try {
      localStorage.setItem(BOOKMARK_VISIT_KEY, JSON.stringify(map));
    } catch (e) {
      // localStorage が使えない環境では新着判定をあきらめる
    }
  }

  global.Visited = { markRead, isRead, getLastBookmarkVisit, markBookmarkVisit };
})(window);
