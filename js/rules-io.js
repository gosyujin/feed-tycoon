/**
 * フィルタルールの CSV 入出力と、Gist Raw URL の取得を担当するモジュール。
 * CSV は `type,value` の 2 列(1行目のヘッダーは任意)。DOM には触れない。
 */
(function (global) {
  function csvEscape(field) {
    return /[",\r\n]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
  }

  function rulesToCsv(rules) {
    const lines = ['type,value'].concat(rules.map((r) => `${csvEscape(r.type)},${csvEscape(r.value)}`));
    return lines.join('\n') + '\n';
  }

  // RFC 4180 相当の最小実装(ダブルクォート内のカンマ・改行・"" に対応)。
  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += c;
        }
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        row.push(field);
        field = '';
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field);
        field = '';
        rows.push(row);
        row = [];
      } else {
        field += c;
      }
    }
    if (field !== '' || row.length > 0) {
      row.push(field);
      rows.push(row);
    }
    return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
  }

  // 1行でも不正なら全体を取り込まない。戻り値は { rules } または { error }。
  function parseRulesCsv(text) {
    const rows = parseCsv(text.replace(/^﻿/, ''));
    if (rows.length > 0 && rows[0][0].trim().toLowerCase() === 'type' && (rows[0][1] || '').trim().toLowerCase() === 'value') {
      rows.shift();
    }
    const rules = [];
    for (let i = 0; i < rows.length; i++) {
      const type = (rows[i][0] || '').trim();
      const value = (rows[i][1] || '').trim();
      if (rows[i].length !== 2 || !global.Filters.TYPES.includes(type) || !value) {
        return { error: `形式が不正です(データ${i + 1}行目)。type は ${global.Filters.TYPES.join(' / ')} のいずれか、value は空以外にしてください。` };
      }
      rules.push({ type, value });
    }
    return { rules };
  }

  // gist.github.com の URL は CORS ヘッダーを返さないため、gist.githubusercontent.com の Raw URL に直す。
  function normalizeUrl(raw) {
    let url;
    try {
      url = new URL(raw.trim());
    } catch (e) {
      return raw.trim();
    }
    if (url.hostname === 'gist.github.com') {
      const parts = url.pathname.split('/').filter(Boolean);
      if (!parts.includes('raw')) parts.splice(2, 0, 'raw');
      url.hostname = 'gist.githubusercontent.com';
      url.pathname = '/' + parts.join('/');
    }
    return url.toString();
  }

  async function fetchText(rawUrl, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || 10000);
    try {
      const res = await fetch(normalizeUrl(rawUrl), { signal: controller.signal, cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  global.RulesIO = { rulesToCsv, parseCsv, parseRulesCsv, normalizeUrl, fetchText };
})(window);
