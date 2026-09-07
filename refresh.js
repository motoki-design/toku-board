#!/usr/bin/env node
/**
 * payload.json の「予約」「HPアクセス」セクションを最新化する。
 *
 *   node refresh.js
 *
 * 読むもの
 *   0. 事業創発室 案件マスタ（GSheet）… サービスアカウントで読む
 *      → ★2026-09-07 改修。以前はブラウザが gviz で毎回読んでいたため、公開ページに
 *        マスタのシートIDが出ており、そのシートが「リンクを知っている全員が閲覧可」だった。
 *        サーバ側で読んで payload に入れ、build.js が暗号化する形へ移した（結 0905便）。
 *   1. 輪島屋内覧会_予約一覧（GSheet・非公開）… サービスアカウントで読む
 *      → 氏名・ふりがな・会社名・メール・電話は一切payload に書かない（集計と匿名項目のみ）
 *   2. 解く HPアクセス分析ダッシュボード（公開ページ）… 主要指標だけ抜く
 *      → 数値の正本はあちら。ここでは見出しだけ持ち、詳細はリンクで飛ばす
 *
 * 書くもの
 *   payload.json の projects / reservation / pr セクションのみ（他のセクションは触らない）
 */
const fs = require('fs');
const path = require('path');
const { readRange } = require('./lib/gsheet');

/**
 * 置き場と識別子はリポジトリに書かない。
 * 優先順：環境変数 → config.local.json（.gitignore済み・各端末で作る）
 */
function localConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.local.json'), 'utf8'));
  } catch (e) {
    return {};
  }
}
const CFG = localConfig();

function need(name, key) {
  const v = process.env[name] || CFG[key];
  if (!v) {
    console.error(
      '[refresh] ' + name + ' が未設定です。\n' +
      '  環境変数 ' + name + ' を渡すか、config.local.json に "' + key + '" を書いてください。\n' +
      '  （値は社内の運用メモを参照。このリポジトリには書きません）'
    );
    process.exit(2);
  }
  return v;
}

const SA_PATH = need('TOKU_SA', 'saPath');
const PAYLOAD = need('TOKU_PAYLOAD', 'payloadPath');

const RESV_SHEET_ID = need('TOKU_RESV_SHEET_ID', 'reservationSheetId');
const RESV_TAB = 'Form Responses 1';
/** テスト申込を落とすカットオフ（ga_pull.py と同じ基準） */
const CUTOFF = new Date(2026, 7, 1); // 2026-08-01 00:00
const TWA_URL = 'https://motoki-design.github.io/toku-web-access/';

/** "7/31/2026 6:03:44" → Date */
function parseTs(s) {
  const m = String(s).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(+m[3], +m[1] - 1, +m[2], +m[4], +m[5], +m[6]);
}
function fmt(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function tally(arr) {
  const o = {};
  arr.filter(Boolean).forEach(v => { o[v] = (o[v] || 0) + 1; });
  return o;
}
function peopleOf(s) {
  const m = String(s || '').match(/(\d+)/);
  return m ? +m[1] : 1;
}

/**
 * 案件マスタを読み、13列をそのまま payload に置く。
 * ★シートIDは payload.json の sheet_id を使う（payload はリポジトリ外なのでIDは漏れない）。
 *   環境変数 TOKU_MASTER_SHEET_ID / config.local.json の masterSheetId でも上書きできる。
 * ★列名は見出し名でマッピングする側（ページ）に任せ、ここでは行をそのまま持つ。
 */
async function projects(masterId) {
  const rows = await readRange(SA_PATH, masterId, 'A1:M200');
  if (!rows.length) throw new Error('案件マスタが空です');
  const head = rows[0].map(h => (h || '').trim());
  const need = ['種別', '案件番号', '業務名', '状態', '次アクション', '期限'];
  const miss = need.filter(n => !head.includes(n));
  if (miss.length) throw new Error('案件マスタの見出しに ' + miss.join('・') + ' がありません');
  // 業務名の無い行（空行・注記行）は落とす
  const iName = head.indexOf('業務名');
  const body = rows.slice(1).filter(r => r && (r[iName] || '').trim());
  return {
    as_of: fmt(new Date()),
    head,
    rows: body.map(r => head.map((_, i) => (r[i] == null ? '' : String(r[i])))),
  };
}

async function reservation() {
  const rows = await readRange(SA_PATH, RESV_SHEET_ID, `'${RESV_TAB}'!A1:R500`);
  if (!rows.length) throw new Error('予約一覧が空です');
  const head = rows[0];
  const col = name => head.findIndex(h => (h || '').trim() === name);
  const IDX = {
    ts: 0,
    //: ★同一性を見るためだけに読む列。payload には書かない（公開URLに置くため）
    mail: col('メールアドレス'),
    tel: col('電話番号（当日連絡用）'),
    kana: col('ふりがな'),
    industry: col('業種・お立場'),
    people: col('参加人数'),
    day: col('第1希望日'),
    time: col('第1希望の時間帯'),
    second: col('第2希望日・時間帯'),
    stage: col('ご検討の状況'),
    interest: col('当日聞いてみたいこと・ご関心（任意）'),
    access: col('ご来場方法'),
    source: col('この内覧会を何で知りましたか'),
    status: col('確定状況'),
    memo: col('備考'),
  };

  const all = rows.slice(1).filter(r => r && r[0]);
  const kept = [], dropped = [];
  for (const r of all) {
    const t = parseTs(r[IDX.ts]);
    (t && t >= CUTOFF ? kept : dropped).push({ r, t });
  }
  kept.sort((a, b) => a.t - b.t);

  const g = (r, k) => (IDX[k] >= 0 ? (r[IDX[k]] || '').trim() : '');

  /**
   * ★フォームの行数は件数ではない（2026-09-07 結の指摘・実測で確認）。
   *
   * 日程を変えたい人はフォームをもう一度出す。同じ予約が2行になり、件数と人数が
   * 二重に数えられる。実測＝小玉さんが 9/1 14:30（9/27午前）と 9/3 18:26（9/26午後）
   * の2行で、これを3件5名と数えていた。正しくは2組3名。
   *
   * **同じ人の行は、いちばん新しい1行だけを採る。**同一性はメール→電話→ふりがなの
   * 順で見る（メールは表記揺れが少ない）。どれも空の行は畳まず個別に残す
   * ——**推測で人をまとめない**。畳んだ数は `superseded` として出す（黙って減らさない）。
   */
  const idKey = r => {
    const mail = g(r, 'mail').toLowerCase();
    if (mail) return 'm:' + mail;
    const tel = g(r, 'tel').replace(/[^0-9]/g, '');
    if (tel) return 't:' + tel;
    const kana = g(r, 'kana').replace(/[\s\u3000]/g, '');
    if (kana) return 'k:' + kana;
    return null;
  };
  const latest = new Map();
  const singles = [];
  for (const e of kept) {
    const k = idKey(e.r);
    if (k === null) { singles.push(e); continue; }
    latest.set(k, e);                  // keptは古い順なので、後の行が残る
  }
  const superseded = kept.length - (latest.size + singles.length);
  const unique = [...latest.values(), ...singles].sort((a, b) => a.t - b.t);

  // ★氏名・ふりがな・会社名・メール・電話は載せない（公開URLに置くため）
  const entries = unique.map(({ r, t }) => ({
    at: fmt(t),
    day: g(r, 'day'),
    time: g(r, 'time'),
    second: g(r, 'second'),
    people: peopleOf(g(r, 'people')),
    industry: g(r, 'industry'),
    stage: g(r, 'stage'),
    source: g(r, 'source'),
    access: g(r, 'access'),
    interest: g(r, 'interest').replace(/\s+/g, ' ').trim(),
    status: g(r, 'status') || '未確定',
  }));

  return {
    as_of: fmt(new Date()),
    sheet_rows_total: all.length,
    excluded_as_test: dropped.length,
    //: ★同じ人の古い行（日程変更で二重になった分）。件数の内訳として出す
    superseded: superseded,
    form_count: entries.length,
    people_total: entries.reduce((s, e) => s + e.people, 0),
    last_at: entries.length ? entries[entries.length - 1].at : null,
    by_day: tally(entries.map(e => e.day)),
    by_industry: tally(entries.map(e => e.industry)),
    by_stage: tally(entries.map(e => e.stage)),
    by_source: tally(entries.map(e => e.source)),
    by_status: tally(entries.map(e => e.status)),
    entries,
  };
}

async function webAccess() {
  const res = await fetch(TWA_URL);
  if (!res.ok) throw new Error(`HPアクセス分析の取得に失敗: HTTP ${res.status}`);
  const html = await res.text();
  const i = html.indexOf('window.__GA_DATA__');
  if (i < 0) throw new Error('window.__GA_DATA__ が見つかりません（先方のページ構造が変わった可能性）');
  const start = html.indexOf('{', i);
  // 先頭のJSONオブジェクトだけを取り出す（波括弧の対応を数える）
  let depth = 0, end = -1, inStr = false, esc = false;
  for (let p = start; p < html.length; p++) {
    const c = html[p];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = p + 1; break; } }
  }
  const d = JSON.parse(html.slice(start, end));

  const oc = d.owned_channels || {};
  return {
    as_of: d.generated_at || null,
    period: d.period || null,
    users: d.overview?.users ?? null,
    sessions: d.overview?.sessions ?? null,
    pageviews: d.overview?.pageviews ?? null,
    prev_sessions: d.overview?.prev?.sessions ?? null,
    // 自社で仕掛けた導線（PR TIMES・会社公式web・note等）の合計とサイト全体に占める割合
    owned_total: oc.total_sessions ?? null,
    owned_prev: oc.prev_total_sessions ?? null,
    owned_share: oc.share_of_site ?? null,
    owned_rows: (oc.rows || []).map(r => ({
      label: r.label, sessions: r.sessions, prev_sessions: r.prev_sessions,
    })),
    channels: d.channels || [],
    note_inbound: d.note?.inbound_total ?? null,
    news_pv: d.news?.total_pv ?? null,
    releases: d.pr_releases || [],
    dashboard_url: TWA_URL,
  };
}

(async () => {
  const p = JSON.parse(fs.readFileSync(PAYLOAD, 'utf8'));

  const masterId = process.env.TOKU_MASTER_SHEET_ID || CFG.masterSheetId || p.sheet_id;
  if (!masterId) {
    console.error('[refresh] 案件マスタのシートIDが分かりません。'
      + 'payload.json の sheet_id か、TOKU_MASTER_SHEET_ID を渡してください。');
    process.exitCode = 1;
  } else {
    try {
      p.projects = await projects(masterId);
      console.log(`案件マスタ: ${p.projects.rows.length}行を取り込み（${p.projects.as_of} 時点）`);
    } catch (e) {
      //: ★落ちても payload の前回値は残す。ページは「◯時点」が古いまま出るので、
      //   黙って空になることはない
      console.error('案件マスタの取得に失敗:', e.message);
      process.exitCode = 1;
    }
  }

  try {
    p.reservation = { ...(p.reservation || {}), ...(await reservation()) };
    console.log(`予約: 実申込 ${p.reservation.form_count}組／のべ ${p.reservation.people_total}名`
      + `（テスト除外 ${p.reservation.excluded_as_test}件・日程変更で畳んだ古い行 `
      + `${p.reservation.superseded}件・最終申込 ${p.reservation.last_at}）`);
  } catch (e) {
    console.error('予約の取得に失敗:', e.message);
    process.exitCode = 1;
  }

  try {
    p.pr = { ...(p.pr || {}), ...(await webAccess()) };
    console.log(`HPアクセス: ${p.pr.as_of} 生成分を反映（セッション ${p.pr.sessions}／自社導線 ${p.pr.owned_total}（${p.pr.owned_share}%）／note導線 ${p.pr.note_inbound}／リリース ${p.pr.releases.length}本）`);
  } catch (e) {
    console.error('HPアクセスの取得に失敗:', e.message);
    process.exitCode = 1;
  }

  fs.writeFileSync(PAYLOAD, JSON.stringify(p, null, 2) + '\n', 'utf8');
  console.log('書き込み:', PAYLOAD);
  console.log('→ 続けて  node build.js  でページを生成してください');
})();
