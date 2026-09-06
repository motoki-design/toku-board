/**
 * サービスアカウントで Google Sheets を読むだけの最小実装。
 * Node 22 の標準機能のみ（crypto の RS256 署名 + グローバル fetch）。外部パッケージなし。
 */
const crypto = require('crypto');

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getAccessToken(sa, scope) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope,
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  }));
  const signingInput = `${header}.${claim}`;
  const signature = b64url(crypto.sign('RSA-SHA256', Buffer.from(signingInput), sa.private_key));
  const assertion = `${signingInput}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const j = await res.json();
  if (!j.access_token) throw new Error('token取得に失敗: ' + JSON.stringify(j));
  return j.access_token;
}

/** シートの値を2次元配列で返す（range 例: "'Form Responses 1'!A1:Z500"） */
async function readRange(saPath, spreadsheetId, range) {
  const sa = JSON.parse(require('fs').readFileSync(saPath, 'utf8'));
  const token = await getAccessToken(sa, 'https://www.googleapis.com/auth/spreadsheets.readonly');
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`;
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) throw new Error(`Sheets API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).values || [];
}

/** シートのタブ名一覧 */
async function listSheets(saPath, spreadsheetId) {
  const sa = JSON.parse(require('fs').readFileSync(saPath, 'utf8'));
  const token = await getAccessToken(sa, 'https://www.googleapis.com/auth/spreadsheets.readonly');
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties.title`;
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) throw new Error(`Sheets API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).sheets.map(s => s.properties.title);
}

module.exports = { readRange, listSheets };
