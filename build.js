#!/usr/bin/env node
/**
 * payload.json（平文・リポジトリ外）を合言葉で暗号化し、index.html を生成する。
 *
 *   TOKU_PASS='合言葉' node build.js
 *
 * 暗号：PBKDF2-SHA256（250,000回）で鍵を導出し AES-256-GCM。
 * 生成される index.html には暗号文しか入らないので、GitHubで公開しても
 * 合言葉を知らない人には案件データ・予約集計・シートIDのいずれも読めない。
 *
 * ★ただし案件マスタ（GSheet）自体は「リンクを知っている全員が閲覧可」のままなので、
 *   マスタのURLを別経路で知っている人はそちらを直接見られる（sohatsu-board が公開しているため）。
 *   ここで守れるのは 予約集計・広報実績・未採番案件・区分/停滞フラグ。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ITER = 250000;
const PAYLOAD = process.env.TOKU_PAYLOAD
  || (function () {
    try {
      return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.local.json'), 'utf8')).payloadPath;
    } catch (e) {
      console.error('[build] TOKU_PAYLOAD が未設定です。環境変数か config.local.json の "payloadPath" を使ってください。');
      process.exit(2);
    }
  })();
const TEMPLATE = path.join(__dirname, 'template.html');
const OUT = path.join(__dirname, 'index.html');

/** 合言葉＝環境変数 → config.local.json の "pass"（gitignore済み・無人バッチ用） */
const pass = process.env.TOKU_PASS || (function () {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.local.json'), 'utf8')).pass;
  } catch (e) { return null; }
})();
if (!pass) {
  console.error('合言葉が指定されていません。\n  TOKU_PASS=\'合言葉\' node build.js\n  （または config.local.json の \"pass\" に書く）');
  process.exit(1);
}
if (!fs.existsSync(PAYLOAD)) {
  console.error('payload.json が見つかりません:', PAYLOAD);
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(PAYLOAD, 'utf8'));
delete data._について; // 生成物には運用メモを載せない

const salt = crypto.randomBytes(16);
const iv = crypto.randomBytes(12);
const key = crypto.pbkdf2Sync(Buffer.from(pass, 'utf8'), salt, ITER, 32, 'sha256');
const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
const ct = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
const tag = cipher.getAuthTag();

const blob = {
  v: 1,
  kdf: { name: 'PBKDF2', hash: 'SHA-256', iter: ITER, salt: salt.toString('base64') },
  iv: iv.toString('base64'),
  // WebCrypto の AES-GCM は暗号文の末尾に認証タグが付いている前提なので連結して渡す
  ct: Buffer.concat([ct, tag]).toString('base64'),
};

const tpl = fs.readFileSync(TEMPLATE, 'utf8');
if (!tpl.includes('/*__BLOB__*/null')) {
  console.error('template.html に差込位置 /*__BLOB__*/null がありません');
  process.exit(1);
}
const built = tpl
  .replace('/*__BLOB__*/null', JSON.stringify(blob))
  .replace('/*__BUILT_AT__*/""', JSON.stringify(
    new Date().toLocaleString('ja-JP', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' })));

fs.writeFileSync(OUT, built, 'utf8');
console.log(`生成: ${OUT}`);
console.log(`  平文 ${JSON.stringify(data).length} バイト → 暗号文 ${blob.ct.length} バイト（base64）`);
console.log(`  案件 ${Object.keys(data.toku || {}).length + (data.extra || []).length} 件／予約 ${data.reservation?.form_count ?? '—'} 件／掲載 ${(data.media || []).length} 件`);
console.log('→ git add index.html && git commit && git push で公開されます');
