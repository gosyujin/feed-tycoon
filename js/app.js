/**
 * feed-tycoon ビューア。data/feed.json(GitHub Actions が生成)を読み、
 * フィルタ(Filters)と既読(Visited)を適用して一覧表示する。
 */
(function () {
  // ?debug=1 のとき、フッターに実際に動いている JS / データの状態を出す(端末ごとの表示差の切り分け用)。
  const APP_TAG = 'bm-count-button';
  const DEBUG = new URLSearchParams(location.search).has('debug');
  const PAGE_SIZE = 50;
  const REFRESH_AFTER_MS = 5 * 60 * 1000;
  const STARTUP_IMPORT_TIMEOUT_MS = 3000;
  const KEYS = {
    hideRead: 'feed-tycoon:hideRead',
    lastVisit: 'feed-tycoon:lastVisit',
    importUrl: (kind) => `feed-tycoon:importUrl:${kind}`,
  };

  const state = {
    entries: [],
    meta: null,
    activeSource: '',
    query: '',
    hideRead: readStorage(KEYS.hideRead) === '1',
    showHidden: false,
    shown: PAGE_SIZE,
    previousVisit: Number(readStorage(KEYS.lastVisit)) || 0,
    loadedAt: 0,
    settingsKind: 'mute',
    editingId: null,
  };

  const $ = (id) => document.getElementById(id);

  function readStorage(key) {
    try {
      return localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  function writeStorage(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (e) {
      // localStorage が使えない環境では保存をあきらめる
    }
  }

  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    Object.entries(props || {}).forEach(([k, v]) => {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    });
    children.flat().forEach((c) => c != null && node.append(c));
    return node;
  }

  function safeHref(url) {
    return /^https?:\/\//i.test(url) ? url : '#';
  }

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  function formatTime(iso) {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return '';
    const diffMin = Math.floor((Date.now() - t) / 60000);
    if (diffMin < 1) return 'たった今';
    if (diffMin < 60) return `${diffMin}分前`;
    if (diffMin < 60 * 24) return `${Math.floor(diffMin / 60)}時間前`;
    const d = new Date(t);
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // ---------------------------------------------------------------- データ取得

  async function loadData() {
    $('list-status').textContent = '読み込み中…';
    try {
      // Pages の CDN は max-age=600 で配信するため、cache: 'no-cache' だけでは CDN 上の古い JSON が返ることがある。
      // URL を毎回変えて CDN のキャッシュを避ける(取得しても数百KB程度)。
      const bust = Date.now();
      const [feedRes, metaRes] = await Promise.all([
        fetch(`data/feed.json?t=${bust}`, { cache: 'no-cache' }),
        fetch(`data/meta.json?t=${bust}`, { cache: 'no-cache' }),
      ]);
      if (!feedRes.ok) throw new Error(`feed.json: HTTP ${feedRes.status}`);
      state.entries = await feedRes.json();
      state.meta = metaRes.ok ? await metaRes.json() : null;
      state.loadedAt = Date.now();
    } catch (e) {
      $('list-status').textContent = `読み込みに失敗しました(${e.message})`;
      return;
    }
    render();
  }

  // ---------------------------------------------------------------- 一覧描画

  function matchesQuery(entry) {
    if (!state.query) return true;
    const q = state.query.toLowerCase();
    return (entry.title || '').toLowerCase().includes(q) || (entry.description || '').toLowerCase().includes(q);
  }

  function computeView() {
    const visible = [];
    const filtered = [];
    let readHidden = 0;
    const sourceCounts = new Map();

    for (const entry of state.entries) {
      const verdict = Filters.judge(entry);
      if (!verdict.hidden) {
        sourceCounts.set(entry.sourceId, (sourceCounts.get(entry.sourceId) || 0) + 1);
      }
      if (state.activeSource && entry.sourceId !== state.activeSource) continue;
      if (!matchesQuery(entry)) continue;
      if (verdict.hidden) {
        filtered.push({ entry, verdict });
      } else if (state.hideRead && Visited.isRead(entry.url)) {
        readHidden++;
      } else {
        visible.push({ entry });
      }
    }
    return { visible, filtered, readHidden, sourceCounts };
  }

  function renderSourceTabs(sourceCounts) {
    const nav = $('source-tabs');
    nav.replaceChildren();
    const total = [...sourceCounts.values()].reduce((a, b) => a + b, 0);
    const tab = (id, label, count) =>
      el(
        'button',
        {
          type: 'button',
          class: 'tab' + (state.activeSource === id ? ' tab--active' : ''),
          onclick: () => {
            state.activeSource = id;
            state.shown = PAGE_SIZE;
            render();
          },
        },
        `${label} (${count})`
      );
    nav.append(tab('', 'すべて', total));
    const seen = new Map();
    state.entries.forEach((e) => seen.set(e.sourceId, e.source));
    seen.forEach((name, id) => nav.append(tab(id, name, sourceCounts.get(id) || 0)));
  }

  function renderCard(item) {
    const { entry, verdict } = item;
    const isNew = state.previousVisit > 0 && Date.parse(entry.firstSeenAt) > state.previousVisit;
    const read = Visited.isRead(entry.url);
    const link = el('a', {
      class: 'entry-title',
      href: safeHref(entry.url),
      target: '_blank',
      rel: 'noopener noreferrer',
      text: entry.title,
    });
    const markRead = () => {
      Visited.markRead(entry.url);
      card.classList.add('entry--read');
    };
    link.addEventListener('click', markRead);
    link.addEventListener('auxclick', markRead);

    const presetButton = (text, type, value, hint) =>
      el('button', { type: 'button', class: 'meta-link', title: hint, onclick: () => openSettings('mute', type, value) }, text);

    const meta = el(
      'div',
      { class: 'entry-meta' },
      isNew ? el('span', { class: 'badge-new', text: 'NEW' }) : null,
      presetButton(entry.source, 'source', entry.source, 'この取得元のミュートを設定'),
      ' · ',
      presetButton(entry.domain, 'domain', entry.domain, 'このドメインのミュートを設定'),
      ' · ',
      el('span', { text: formatTime(entry.publishedAt || entry.firstSeenAt) }),
      // <a href> にしないのは、コンテンツブロッカーが「はてなブックマークへのリンク」を隠すため
      // (iPhone Safari で display:none になることを確認済み)。クリックで開くボタンにしている。
      entry.bookmarkUrl
        ? el('button', {
            type: 'button',
            class: 'bm-count',
            title: 'はてなブックマークページを開く',
            onclick: () => window.open(safeHref(entry.bookmarkUrl), '_blank', 'noopener,noreferrer'),
            text: `${entry.bookmarkCount || 0} users`,
          })
        : null,
      (entry.tags || []).map((t) => el('span', { class: 'tag', text: t }))
    );

    const card = el(
      'article',
      { class: 'entry' + (read ? ' entry--read' : '') + (verdict ? ' entry--hidden' : '') },
      link,
      meta,
      entry.description ? el('p', { class: 'entry-desc', text: entry.description }) : null,
      verdict
        ? el('p', { class: 'entry-reason', text: `${Filters.KIND_LABELS[verdict.kind]}: ${Filters.TYPE_LABELS[verdict.rule.type]}「${verdict.rule.value}」に一致` })
        : el('button', {
            type: 'button',
            class: 'btn btn--x',
            title: 'この記事をミュート',
            'aria-label': 'この記事をミュート',
            onclick: () => {
              Filters.addRule('mute', 'url', entry.url);
              render();
            },
            text: '×',
          })
    );
    return card;
  }

  function render() {
    const { visible, filtered, readHidden, sourceCounts } = computeView();
    renderSourceTabs(sourceCounts);

    const items = state.showHidden ? filtered : visible;
    const list = $('entry-list');
    list.replaceChildren(...items.slice(0, state.shown).map(renderCard));
    if (items.length === 0) {
      list.append(el('p', { class: 'empty', text: state.showHidden ? 'フィルタで隠れた記事はありません' : '表示する記事がありません' }));
    }
    $('more-btn').hidden = items.length <= state.shown;

    const parts = [];
    if (filtered.length) parts.push(`フィルタ${filtered.length}件`);
    if (readHidden) parts.push(`既読${readHidden}件`);
    $('list-status').textContent = state.showHidden
      ? `フィルタで隠れた ${filtered.length} 件を表示中`
      : `${visible.length} 件を表示中` + (parts.length ? `(${parts.join('・')}を非表示)` : '');

    const btn = $('show-hidden-btn');
    btn.hidden = filtered.length === 0 && !state.showHidden;
    btn.textContent = state.showHidden ? '通常表示に戻る' : '隠した記事を見る';

    renderFooter();
  }

  function renderFooter() {
    const meta = state.meta;
    const info = $('update-info');
    if (meta && meta.updatedAt) {
      const d = new Date(meta.updatedAt);
      const failed = Object.values(meta.sources || {}).filter((s) => s.ok === false).map((s) => s.name);
      info.textContent =
        `最終更新 ${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}` +
        (failed.length ? `(取得失敗: ${failed.join(', ')})` : '');
    }
    const b = window.BUILD_INFO;
    $('build-info').textContent = b ? `build ${b.sha} ${b.time}` : '';
    if (DEBUG) renderDebug();
  }

  function describeBox(node) {
    if (!node) return 'none';
    const cs = getComputedStyle(node);
    const r = node.getBoundingClientRect();
    return `display=${cs.display} visibility=${cs.visibility} opacity=${cs.opacity} color=${cs.color} size=${Math.round(r.width)}x${Math.round(r.height)} text="${node.textContent}"`;
  }

  // 「はてなのURLを持つ <a> だけが隠れる」という仮説の検証用プローブ。
  function probeBoxes() {
    const make = (tag, attrs) => {
      const node = el(tag, attrs, 'probe');
      document.body.append(node);
      const desc = describeBox(node);
      node.remove();
      return desc.replace(/ color=.*? size=/, ' size=').replace(/ text=.*$/, '');
    };
    return [
      `probe a[href=hatena]: ${make('a', { href: 'https://b.hatena.ne.jp/entry/s/example.com/' })}`,
      `probe a[href=other]: ${make('a', { href: 'https://example.com/' })}`,
      `probe button: ${make('button', { type: 'button', class: 'bm-count' })}`,
    ];
  }

  function renderDebug() {
    let box = $('debug-info');
    if (!box) {
      box = el('pre', { id: 'debug-info', class: 'debug-info' });
      document.querySelector('.app-footer').after(box);
    }
    box.textContent = [
      `js: ${APP_TAG}`,
      `entries: ${state.entries.length}, with bookmarkUrl: ${state.entries.filter((e) => e.bookmarkUrl).length}`,
      `cards: ${document.querySelectorAll('.entry').length}, .bm-count: ${document.querySelectorAll('.bm-count').length}`,
      `first .bm-count: ${describeBox(document.querySelector('.bm-count'))}`,
      ...probeBoxes(),
      `meta.updatedAt: ${state.meta && state.meta.updatedAt}`,
      `ua: ${navigator.userAgent}`,
    ].join('\n');
  }

  // ---------------------------------------------------------------- 設定モーダル

  function openSettings(kind, type, value) {
    if (kind) state.settingsKind = kind;
    state.editingId = null;
    $('settings-modal').hidden = false;
    renderSettings();
    if (type) $('rule-type').value = type;
    if (value !== undefined) $('rule-value').value = value;
    $('rule-value').focus();
  }

  function setImportStatus(message) {
    $('import-status').textContent = message;
  }

  function renderSettings() {
    const kind = state.settingsKind;
    const tabs = $('settings-tabs');
    tabs.replaceChildren(
      ...Filters.KINDS.map((k) =>
        el(
          'button',
          {
            type: 'button',
            class: 'tab' + (k === kind ? ' tab--active' : ''),
            onclick: () => {
              state.settingsKind = k;
              state.editingId = null;
              setImportStatus('');
              renderSettings();
            },
          },
          `${Filters.KIND_LABELS[k]} (${Filters.loadRules(k).length})`
        )
      )
    );

    const typeSelect = $('rule-type');
    if (!typeSelect.options.length) {
      Filters.TYPES.forEach((t) => typeSelect.append(el('option', { value: t, text: Filters.TYPE_LABELS[t] })));
      $('type-list').textContent = Filters.TYPES.join(' / ');
    }

    const rules = Filters.loadRules(kind);
    $('rule-count').textContent = rules.length;
    $('rule-list').replaceChildren(...rules.map(renderRuleRow));
    $('import-url-input').value = readStorage(KEYS.importUrl(kind)) || '';
    $('export-text').hidden = true;
  }

  function renderRuleRow(rule) {
    const kind = state.settingsKind;
    if (state.editingId === rule.id) {
      const select = el('select', {}, Filters.TYPES.map((t) => el('option', { value: t, text: Filters.TYPE_LABELS[t] })));
      select.value = rule.type;
      const input = el('input', { type: 'text', value: rule.value, autocomplete: 'off' });
      return el(
        'li',
        { class: 'rule-row' },
        select,
        input,
        el(
          'button',
          {
            type: 'button',
            class: 'btn btn--small',
            onclick: () => {
              if (!Filters.updateRule(kind, rule.id, select.value, input.value)) {
                setImportStatus('保存できません(値が空、または同じルールが既にあります)');
                return;
              }
              setImportStatus('');
              state.editingId = null;
              renderSettings();
              render();
            },
          },
          '保存'
        ),
        el('button', { type: 'button', class: 'btn btn--small', onclick: () => { state.editingId = null; renderSettings(); } }, 'キャンセル')
      );
    }
    return el(
      'li',
      { class: 'rule-row' },
      el('span', { class: 'rule-type', text: Filters.TYPE_LABELS[rule.type] }),
      el('span', { class: 'rule-value', text: rule.value }),
      el('button', { type: 'button', class: 'btn btn--small', onclick: () => { state.editingId = rule.id; renderSettings(); } }, '編集'),
      el(
        'button',
        {
          type: 'button',
          class: 'btn btn--small',
          onclick: () => {
            Filters.removeRule(kind, rule.id);
            renderSettings();
            render();
          },
        },
        '削除'
      )
    );
  }

  function applyImport(rules) {
    const added = Filters.importRules(state.settingsKind, rules);
    setImportStatus(`${added}件を追加しました(重複${rules.length - added}件はスキップ)`);
    renderSettings();
    render();
  }

  function bindSettings() {
    $('settings-btn').addEventListener('click', () => openSettings());
    $('settings-close').addEventListener('click', () => { $('settings-modal').hidden = true; });
    $('settings-modal').addEventListener('click', (e) => {
      if (e.target === $('settings-modal')) $('settings-modal').hidden = true;
    });

    $('settings-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const added = Filters.addRule(state.settingsKind, $('rule-type').value, $('rule-value').value);
      setImportStatus(added ? '' : '追加できません(値が空、または同じルールが既にあります)');
      if (added) $('rule-value').value = '';
      renderSettings();
      render();
    });

    $('export-btn').addEventListener('click', () => {
      const csv = RulesIO.rulesToCsv(Filters.loadRules(state.settingsKind));
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      const a = el('a', { href: url, download: `feed-tycoon-${state.settingsKind}.csv` });
      a.click();
      URL.revokeObjectURL(url);
    });
    $('copy-btn').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(RulesIO.rulesToCsv(Filters.loadRules(state.settingsKind)));
        setImportStatus('クリップボードにコピーしました');
      } catch (e) {
        setImportStatus('コピーに失敗しました。「テキストで表示」を使ってください');
      }
    });
    $('export-text-btn').addEventListener('click', () => {
      const box = $('export-text');
      box.value = RulesIO.rulesToCsv(Filters.loadRules(state.settingsKind));
      box.hidden = false;
      box.select();
    });

    $('import-file-input').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      const result = RulesIO.parseRulesCsv(await file.text());
      if (result.error) setImportStatus(result.error);
      else applyImport(result.rules);
    });

    $('import-url-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const url = $('import-url-input').value.trim();
      const key = KEYS.importUrl(state.settingsKind);
      if (!url) {
        writeStorage(key, null);
        setImportStatus('自動インポートのURLを解除しました');
        return;
      }
      setImportStatus('取得中…');
      try {
        const result = RulesIO.parseRulesCsv(await RulesIO.fetchText(url));
        if (result.error) {
          setImportStatus(result.error);
          return;
        }
        writeStorage(key, url);
        applyImport(result.rules);
      } catch (err) {
        setImportStatus(`取得に失敗しました(${err.message})`);
      }
    });
  }

  // 起動時に、登録済みの Gist から各リストを取り込む(最初の描画を待たせるのは最大3秒。失敗しても通常起動)。
  async function importOnStartup() {
    const tasks = Filters.KINDS.map(async (kind) => {
      const url = readStorage(KEYS.importUrl(kind));
      if (!url) return;
      const result = RulesIO.parseRulesCsv(await RulesIO.fetchText(url, STARTUP_IMPORT_TIMEOUT_MS));
      if (result.rules) Filters.importRules(kind, result.rules);
    });
    const timeout = new Promise((resolve) => setTimeout(resolve, STARTUP_IMPORT_TIMEOUT_MS));
    await Promise.race([Promise.allSettled(tasks), timeout]);
  }

  // ---------------------------------------------------------------- 初期化

  function bindList() {
    $('header-search').addEventListener('input', (e) => {
      state.query = e.target.value.trim();
      state.shown = PAGE_SIZE;
      render();
    });
    $('hide-read-checkbox').checked = state.hideRead;
    $('hide-read-checkbox').addEventListener('change', (e) => {
      state.hideRead = e.target.checked;
      writeStorage(KEYS.hideRead, state.hideRead ? '1' : '0');
      render();
    });
    $('show-hidden-btn').addEventListener('click', () => {
      state.showHidden = !state.showHidden;
      state.shown = PAGE_SIZE;
      render();
    });
    $('more-btn').addEventListener('click', () => {
      state.shown += PAGE_SIZE;
      render();
    });
    // ページが前面に戻ったとき、しばらく経っていれば最新を読み直す(push の代わり)。
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && Date.now() - state.loadedAt > REFRESH_AFTER_MS) loadData();
    });
  }

  async function init() {
    bindSettings();
    bindList();
    await importOnStartup();
    await loadData();
    writeStorage(KEYS.lastVisit, String(Date.now()));
  }

  init();
})();
