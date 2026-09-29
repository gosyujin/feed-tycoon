/**
 * 「記事リンクを開いたか(既読)」を localStorage に記録するモジュール。
 * 記録は URL -> 既読にした時刻(ms)。古いものから MAX_ENTRIES を超えた分を捨てる。
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

  global.Visited = { markRead, isRead };
})(window);
