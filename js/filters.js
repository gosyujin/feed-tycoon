/**
 * localStorage に保存するフィルタルール(mute / unmute / forceMute)の管理と、
 * 記事に対するマッチング判定を行うモジュール(hateb-tycoon の filters.js が元)。
 *
 * ルールは { id, type, value } の配列。
 *   type: TYPES 参照。value は部分一致(大文字小文字を区別しない)。ただし url のみ完全一致
 *   (記事単独を消す用途のため、部分一致だと他ページを巻き込む恐れがある)
 *
 * 判定ロジック:
 *   1. forceMute に一致 -> 強制的に非表示 (unmute でも解除不可)
 *   2. mute に一致し、unmute に一致しない -> 非表示
 *   3. それ以外 -> 表示
 *
 * ルールは種別ごとに一度だけ localStorage から読み、メモリにキャッシュする。
 * 外部要因で localStorage を書き換えた場合は reload() を呼ぶこと。
 */
(function (global) {
  const STORAGE_KEYS = {
    mute: 'feed-tycoon:mute',
    unmute: 'feed-tycoon:unmute',
    forceMute: 'feed-tycoon:forceMute',
  };

  const KINDS = Object.keys(STORAGE_KEYS);
  const KIND_LABELS = { mute: 'ミュート', unmute: 'ミュート解除', forceMute: '強制ミュート' };

  // 追加したい種別は、ここと matchRule の case を足す。UI・CSV の検証は TYPES から自動生成される。
  const TYPE_LABELS = {
    title: 'タイトル',
    domain: 'ドメイン',
    url: 'URL',
    source: '取得元',
    tag: 'タグ',
    description: '説明',
    // 以下はブックマークページのコメント一覧にだけ効く(フィードの記事は持たない)
    user: 'ユーザー',
    comment: 'コメント',
  };
  const TYPES = Object.keys(TYPE_LABELS);

  let cache = {};

  function assertKind(kind) {
    if (!KINDS.includes(kind)) {
      throw new Error(`unknown rule kind: ${kind}`);
    }
  }

  function assertType(type) {
    if (!TYPES.includes(type)) {
      throw new Error(`unknown rule type: ${type}`);
    }
  }

  function loadRules(kind) {
    assertKind(kind);
    if (cache[kind]) return cache[kind];
    let rules = [];
    try {
      const raw = localStorage.getItem(STORAGE_KEYS[kind]);
      const parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) rules = parsed;
    } catch (e) {
      console.error('[filters] failed to load rules', kind, e);
    }
    cache[kind] = rules;
    return rules;
  }

  function saveRules(kind, rules) {
    assertKind(kind);
    cache[kind] = rules;
    try {
      localStorage.setItem(STORAGE_KEYS[kind], JSON.stringify(rules));
    } catch (e) {
      console.error('[filters] failed to save rules', kind, e);
    }
  }

  function reload() {
    cache = {};
  }

  function makeId() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return global.crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  // type asc, value asc でソートする(登録・編集・インポートの各タイミングで適用)。
  function sortRules(rules) {
    return rules.slice().sort((a, b) => a.type.localeCompare(b.type) || a.value.localeCompare(b.value));
  }

  function ruleKey(type, value) {
    return `${type}:${value.toLowerCase()}`;
  }

  // 同じ type + value(大文字小文字を無視)の重複を除く。先に出たものを残す。
  function uniqueRules(rules) {
    const seen = new Set();
    return rules.filter((r) => {
      const key = ruleKey(r.type, r.value);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // ローカルに既にある重複を掃除する。戻り値は取り除いた件数。
  function dedupeRules(kind) {
    assertKind(kind);
    const rules = loadRules(kind);
    const unique = uniqueRules(rules);
    if (unique.length !== rules.length) saveRules(kind, unique);
    return rules.length - unique.length;
  }

  // 追加できたら true。値が空、または同じ type + value(大文字小文字を無視)が既にあれば false。
  function addRule(kind, type, value) {
    assertKind(kind);
    assertType(type);
    const trimmed = (value || '').trim();
    if (!trimmed) return false;
    const rules = loadRules(kind);
    if (rules.some((r) => ruleKey(r.type, r.value) === ruleKey(type, trimmed))) return false;
    saveRules(kind, sortRules(rules.concat({ id: makeId(), type, value: trimmed })));
    return true;
  }

  // 更新できたら true。他のルールと重複する内容への変更や、空の値は false。
  function updateRule(kind, id, type, value) {
    assertKind(kind);
    assertType(type);
    const trimmed = (value || '').trim();
    if (!trimmed) return false;
    const rules = loadRules(kind);
    if (rules.some((r) => r.id !== id && ruleKey(r.type, r.value) === ruleKey(type, trimmed))) return false;
    saveRules(
      kind,
      sortRules(rules.map((r) => (r.id === id ? { id, type, value: trimmed } : r)))
    );
    return true;
  }

  function removeRule(kind, id) {
    assertKind(kind);
    saveRules(kind, loadRules(kind).filter((r) => r.id !== id));
  }

  // 既存ルールとの重複を避けて追加する。戻り値は実際に追加された件数。
  function importRules(kind, newRules) {
    assertKind(kind);
    const rules = loadRules(kind).slice();
    const existingKeys = new Set(rules.map((r) => ruleKey(r.type, r.value)));
    let added = 0;
    for (const r of newRules) {
      if (!TYPES.includes(r.type)) continue;
      const trimmed = (r.value || '').trim();
      if (!trimmed) continue;
      const key = ruleKey(r.type, trimmed);
      if (existingKeys.has(key)) continue;
      rules.push({ id: makeId(), type: r.type, value: trimmed });
      existingKeys.add(key);
      added++;
    }
    saveRules(kind, sortRules(rules));
    return added;
  }

  function includes(haystack, needle) {
    return !!haystack && haystack.toLowerCase().includes(needle);
  }

  function matchRule(rule, item) {
    const needle = (rule.value || '').trim().toLowerCase();
    if (!needle) return false;
    switch (rule.type) {
      case 'title':
        return includes(item.title, needle);
      case 'domain':
        return includes(item.domain, needle);
      case 'url':
        return !!item.url && item.url.toLowerCase() === needle;
      case 'source':
        return includes(item.source, needle);
      case 'tag':
        return Array.isArray(item.tags) && item.tags.some((t) => includes(t, needle));
      case 'description':
        return includes(item.description, needle);
      case 'user':
        return includes(item.user, needle);
      case 'comment':
        return includes(item.comment, needle);
      default:
        return false;
    }
  }

  // 判定結果と、その根拠になったルールを返す。
  //   { hidden: false } / { hidden: true, kind: 'forceMute' | 'mute', rule }
  function judge(item) {
    const forced = loadRules('forceMute').find((r) => matchRule(r, item));
    if (forced) return { hidden: true, kind: 'forceMute', rule: forced };

    const muted = loadRules('mute').find((r) => matchRule(r, item));
    if (!muted) return { hidden: false };
    if (loadRules('unmute').some((r) => matchRule(r, item))) return { hidden: false };
    return { hidden: true, kind: 'mute', rule: muted };
  }

  function isHidden(item) {
    return judge(item).hidden;
  }

  global.Filters = {
    KINDS,
    KIND_LABELS,
    TYPES,
    TYPE_LABELS,
    loadRules,
    saveRules,
    reload,
    addRule,
    updateRule,
    removeRule,
    importRules,
    sortRules,
    uniqueRules,
    dedupeRules,
    judge,
    isHidden,
  };
})(window);
