/**
 * フィルタルールの CSV 入出力を担当するモジュール。
 * CSV は `type,value` の 2 列(1行目のヘッダーは任意)。DOM には触れない。
 */
(function (global) {
  function csvEscape(field) {
    return /[",\r\n]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
  }

  function rulesToCsv(rules) {
    const lines = ['type,value'].concat(rules.map((r) => `${csvEscape(r.type)},${csvEscape(r.value)}`));
    return lines.join('\r\n') + '\r\n';
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

  // 1行でも不正なら全体を取り込まない(errors に理由が入り、rules は空)。ただし未対応の type の行は、
  // hateb-tycoon など他アプリと CSV を共有できるようエラーにせず、件数を ignored に数え、行自体は
  // ignoredRules に残す(Gist 同期の上書き時に相手アプリのルールを消さず書き戻すため)。
  function parseRulesCsv(text) {
    const rows = parseCsv(String(text || '').replace(/^\uFEFF/, ''));
    if (rows.length > 0 && rows[0][0].trim().toLowerCase() === 'type' && (rows[0][1] || '').trim().toLowerCase() === 'value') {
      rows.shift();
    }
    if (rows.length === 0) return { rules: [], errors: ['データが空です'], ignored: 0, ignoredRules: [] };
    const errors = [];
    const rules = [];
    const ignoredRules = [];
    for (let i = 0; i < rows.length; i++) {
      const type = (rows[i][0] || '').trim();
      const value = (rows[i][1] || '').trim();
      if (rows[i].length !== 2 || !type || !value) {
        errors.push(`形式が不正です(データ${i + 1}行目)。type と value は空以外にしてください。`);
        continue;
      }
      if (!global.Filters.TYPES.includes(type)) {
        ignoredRules.push({ type, value });
        continue;
      }
      rules.push({ type, value });
    }
    return { rules: errors.length > 0 ? [] : rules, errors, ignored: ignoredRules.length, ignoredRules };
  }

  global.RulesIO = { rulesToCsv, parseCsv, parseRulesCsv };
})(window);
