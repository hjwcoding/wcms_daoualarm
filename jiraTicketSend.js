/**
 * Jira 티켓 자동 생성 스크립트 v3 (패킷 완전 분석 기반)
 *
 * 실제 패킷 흐름:
 *  03: GET /login.jsp
 *      → Set-Cookie 없음, HTML <meta id="atlassian-token"> 에서 xsrf 파싱
 *        (기존 JSESSIONID는 브라우저 기보유 → 스크립트는 이 단계에서 신규 발급 없음)
 *
 *  07: POST /login.jsp
 *      → Cookie: 기존 JSESSIONID + xsrf(|lout)
 *      → 302, X-Seraph-LoginReason: OK
 *        Set-Cookie: 새 JSESSIONID + seraph.rememberme.cookie
 *        (xsrf 토큰은 아직 갱신 안됨)
 *
 *  08: GET /  (브라우저가 자동 리다이렉트)
 *      → Cookie: 새 JSESSIONID + seraph.rememberme.cookie + xsrf(|lout 그대로)
 *      → 302, Location: /secure/RapidBoard.jspa
 *        Set-Cookie: atlassian.xsrf.token = ...|lin  ← 여기서 xsrf 갱신!
 *
 *  09: GET /secure/RapidBoard.jspa
 *      → Cookie: 새 JSESSIONID + seraph.rememberme.cookie + xsrf(|lin)
 *      → 200, X-AUSERNAME: 황재웅  ← 로그인 확인
 *        HTML에 "로그아웃" 있음
 *
 *  27: POST /secure/QuickCreateIssue!default.jspa?decorator=none
 *      → formToken + atl_token 파싱
 *
 *  61: POST /secure/QuickCreateIssue.jspa?decorator=none
 *      → 티켓 생성, issueKey 반환
 */

'use strict';

const http = require('http');
const querystring = require('querystring');
const zlib = require('zlib');

// ─────────────────────────────────────────────
// 설정
// ─────────────────────────────────────────────
const CONFIG = {
  host: 'jira.kwic.co.kr',
  port: 80,
  username: '황재웅',
  password: 'kwic5539!!',
  defaults: {
    pid: '11704',
    issuetype: '11101',
    assignee: '황재웅',
    priority: '3',
  },
};

// ─────────────────────────────────────────────
// 유틸
// ─────────────────────────────────────────────
function httpRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const enc = res.headers['content-encoding'];
        const finish = (decoded) =>
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: decoded.toString('utf-8'),
          });
        if (enc === 'gzip') {
          zlib.gunzip(buf, (err, decoded) => err ? reject(err) : finish(decoded));
        } else if (enc === 'deflate') {
          zlib.inflate(buf, (err, decoded) => err ? reject(err) : finish(decoded));
        } else {
          finish(buf);
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** Set-Cookie 배열 → { name: value } */
function parseCookies(setCookieHeader) {
  const result = {};
  if (!setCookieHeader) return result;
  const arr = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const cookie of arr) {
    const [pair] = cookie.split(';');
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    result[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
  return result;
}

/** HTML <meta id="atlassian-token" content="..."> 파싱 */
function extractAtlassianToken(html) {
  const m =
    html.match(/<meta[^>]+id=["']atlassian-token["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+id=["']atlassian-token["']/i);
  return m ? m[1] : null;
}

/** jar → Cookie 헤더 문자열 */
function toCookieStr(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

/** jar에 새 쿠키 병합 */
function mergeCookies(jar, setCookieHeader) {
  Object.assign(jar, parseCookies(setCookieHeader));
}

// ─────────────────────────────────────────────
// 로그인 + 세션 준비
// ─────────────────────────────────────────────
async function setupSession() {

  // ── [1] GET /login.jsp → HTML에서 xsrf 토큰 추출 ─────────
  console.log('[1/4] GET /login.jsp...');
  const r1 = await httpRequest({
    host: CONFIG.host, port: CONFIG.port,
    path: '/login.jsp', method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'Accept-Encoding': 'gzip, deflate',
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  });

  const jar = { 'jira.editor.user.mode': 'wysiwyg' };
  mergeCookies(jar, r1.headers['set-cookie']);

  // xsrf: Set-Cookie에 없으면 HTML에서 파싱 (패킷에서 HTML 내 meta 태그로 확인)
  if (!jar['atlassian.xsrf.token']) {
    const fromHtml = extractAtlassianToken(r1.body);
    if (fromHtml) jar['atlassian.xsrf.token'] = fromHtml;
  }

  const xsrf1 = jar['atlassian.xsrf.token'];
  if (!xsrf1) throw new Error('xsrf 토큰 획득 실패');
  console.log(`   xsrf(초기): ${xsrf1}`);

  // ── [2] POST /login.jsp ───────────────────────────────────
  console.log('[2/4] POST /login.jsp → 로그인...');
  const loginBody = querystring.stringify({
    os_username: CONFIG.username,
    os_password: CONFIG.password,
    os_cookie: 'true',
    os_destination: '',
    user_role: '',
    atl_token: '',         // 패킷 확인: 빈 값으로 전송
    login: '로그인',
  });

  const r2 = await httpRequest(
    {
      host: CONFIG.host, port: CONFIG.port,
      path: '/login.jsp', method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Content-Length': Buffer.byteLength(loginBody),
        'Cache-Control': 'max-age=0',
        'Upgrade-Insecure-Requests': '1',
        'Cookie': toCookieStr(jar),
        'Origin': `http://${CONFIG.host}`,
        'Referer': `http://${CONFIG.host}/login.jsp`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Encoding': 'gzip, deflate',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
      },
    },
    loginBody
  );

  if (r2.statusCode !== 302)
    throw new Error(`로그인 실패 (status=${r2.statusCode})\n${r2.body.slice(0, 300)}`);
  if (r2.headers['x-seraph-loginreason'] !== 'OK')
    throw new Error(`로그인 거부: ${r2.headers['x-seraph-loginreason']} (ID/PW 확인)`);

  mergeCookies(jar, r2.headers['set-cookie']);
  // 이 시점 jar: 새 JSESSIONID + seraph.rememberme.cookie, xsrf는 아직 |lout
  console.log(`   302 OK, JSESSIONID: ${jar['JSESSIONID']}`);

  // ── [3] GET / → 302 → xsrf |lin 갱신 ────────────────────
  // 패킷 08: GET / 쿠키에 xsrf|lout 그대로, 응답 302에서 xsrf|lin Set-Cookie
  console.log('[3/4] GET / → 리다이렉트 → xsrf 갱신...');
  const r3 = await httpRequest({
    host: CONFIG.host, port: CONFIG.port,
    path: '/', method: 'GET',
    headers: {
      'Cache-Control': 'max-age=0',
      'Upgrade-Insecure-Requests': '1',
      'Cookie': toCookieStr(jar),
      'Referer': `http://${CONFIG.host}/login.jsp`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'Accept-Encoding': 'gzip, deflate',
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  });

  mergeCookies(jar, r3.headers['set-cookie']);
  console.log(`   xsrf(갱신): ${jar['atlassian.xsrf.token']}`);

  // ── [4] GET /secure/RapidBoard.jspa → 로그인 확인 ────────
  // 패킷 09: 이 요청부터 xsrf|lin 사용
  console.log('[4/4] GET /secure/RapidBoard.jspa → 로그인 확인...');
  const r4 = await httpRequest({
    host: CONFIG.host, port: CONFIG.port,
    path: '/secure/RapidBoard.jspa',
    method: 'GET',
    headers: {
      'Cache-Control': 'max-age=0',
      'Upgrade-Insecure-Requests': '1',
      'Cookie': toCookieStr(jar),
      'Referer': `http://${CONFIG.host}/login.jsp`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'Accept-Encoding': 'gzip, deflate',
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  });

  mergeCookies(jar, r4.headers['set-cookie']);

  const loggedInUser = r4.headers['x-ausername'];
  const hasLogout = r4.body.includes('로그아웃');
  console.log(`   X-AUSERNAME: ${loggedInUser}`);
  console.log(`   로그아웃 버튼: ${hasLogout ? '✅ 있음' : '❌ 없음'}`);

  if (!hasLogout || loggedInUser === 'anonymous' || loggedInUser === undefined) {
    throw new Error('RapidBoard 로그인 확인 실패 (로그아웃 버튼 없음)');
  }

  console.log(`\n✅ 세션 준비 완료`);
  console.log(`   최종 쿠키: ${toCookieStr(jar)}\n`);

  return jar;
}

// ─────────────────────────────────────────────
// formToken 획득
// ─────────────────────────────────────────────
async function getFormToken(jar) {
  console.log('[5/5] POST QuickCreateIssue!default.jspa → formToken...');

  const res = await httpRequest({
    host: CONFIG.host, port: CONFIG.port,
    path: '/secure/QuickCreateIssue!default.jspa?decorator=none',
    method: 'POST',
    headers: {
      'Content-Length': '0',
      'X-Requested-With': 'XMLHttpRequest',
      'X-AUSERNAME': encodeURIComponent(CONFIG.username),
      'Cookie': toCookieStr(jar),
      'Origin': `http://${CONFIG.host}`,
      'Referer': `http://${CONFIG.host}/secure/RapidBoard.jspa?rapidView=137&quickFilter=310`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Encoding': 'gzip, deflate',
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  });

  if (res.statusCode !== 200)
    throw new Error(`formToken 요청 실패 (status=${res.statusCode})\n${res.body.slice(0, 300)}`);

  if (res.body.trimStart().startsWith('<'))
    throw new Error(`formToken 응답이 HTML → 세션 오류\n${res.body.slice(0, 300)}`);

  const json = JSON.parse(res.body);
  if (!json.formToken) throw new Error('formToken 파싱 실패');

  console.log(`   ✅ formToken: ${json.formToken}`);
  return { formToken: json.formToken, atlToken: json.atl_token };
}

// ─────────────────────────────────────────────
// 티켓 생성
// ─────────────────────────────────────────────
async function createTicket(jar, tokens, ticketData) {
  console.log('[6/6] POST QuickCreateIssue.jspa → 티켓 생성...');

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const nowStr = `${now.getFullYear()}/${pad(now.getMonth()+1)}/${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const due = new Date(now);
  due.setDate(due.getDate() + 2);
  const dueStr = `${due.getFullYear()}/${pad(due.getMonth()+1)}/${pad(due.getDate())}`;

  const fields = {
    pid:                   ticketData.pid            || CONFIG.defaults.pid,
    issuetype:             ticketData.issuetype      || CONFIG.defaults.issuetype,
    atl_token:             tokens.atlToken,
    formToken:             tokens.formToken,
    summary:               ticketData.summary,
    customfield_11203:     ticketData.customerInfo   || '',
    customfield_10705:     ticketData.receiptRoute   || '-1',
    customfield_10404:     ticketData.receiptTime    || nowStr,
    assignee:              ticketData.assignee       || CONFIG.defaults.assignee,
    customfield_11201:     ticketData.relatedUsers   || '',
    customfield_10503:     ticketData.receiptContent || '',
    customfield_10405:     ticketData.completeTime   || '',
    customfield_10502:     ticketData.actionContent  || '',
    priority:              ticketData.priority       || CONFIG.defaults.priority,
    'dnd-dropzone':        '',
    'customfield_11111':   '',
    'customfield_11111:1': '',
    customfield_10500:     '',
    duedate:               ticketData.dueDate        || dueStr,
    customfield_11209:     ticketData.requester      || '',
    customfield_11112:     '',
    customfield_11104:     '',
    customfield_11107:     '-1',
    customfield_11108:     '',
  };

  const retainFields = [
    'project','issuetype','customfield_11203','customfield_10705',
    'customfield_11206','customfield_11205','customfield_10404','assignee',
    'customfield_11201','customfield_10503','customfield_10405','customfield_10502',
    'priority','customfield_11111','customfield_10500','duedate',
    'customfield_10002','customfield_11209','labels','customfield_11112',
    'customfield_11104','customfield_11107','customfield_11108',
  ];

  let bodyStr = querystring.stringify(fields);
  retainFields.forEach((f) => { bodyStr += `&fieldsToRetain=${encodeURIComponent(f)}`; });

  const res = await httpRequest(
    {
      host: CONFIG.host, port: CONFIG.port,
      path: '/secure/QuickCreateIssue.jspa?decorator=none',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Content-Length': Buffer.byteLength(bodyStr),
        'X-Requested-With': 'XMLHttpRequest',
        'X-AUSERNAME': encodeURIComponent(CONFIG.username),
        'Cookie': toCookieStr(jar),
        'Origin': `http://${CONFIG.host}`,
        'Referer': `http://${CONFIG.host}/secure/RapidBoard.jspa?rapidView=137&quickFilter=310`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Encoding': 'gzip, deflate',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
      },
    },
    bodyStr
  );

  if (res.statusCode !== 200)
    throw new Error(`티켓 생성 HTTP 오류 (status=${res.statusCode})\n${res.body.slice(0, 300)}`);
  if (res.body.trimStart().startsWith('<'))
    throw new Error(`티켓 생성 응답이 HTML\n${res.body.slice(0, 300)}`);

  const json = JSON.parse(res.body);
  if (!json.issueKey)
    throw new Error(`issueKey 없음\n${JSON.stringify(json.errors || json.errorMessages || {}).slice(0, 300)}`);

  return json;
}

// ─────────────────────────────────────────────
// 메인
// ─────────────────────────────────────────────
async function main() {

  // ── 티켓 내용 수정 ────────────────────────────
  const ticketData = {
    pid:            '11704',
    issuetype:      '11101',              // 문의접수
    summary:        '자동생성 테스트 티켓',
    customerInfo:   '우리은행wincms',
    receiptContent: '자동화 스크립트로 생성한 티켓입니다.',
    actionContent:  '조치내용 없음',
    receiptRoute:   '-1',
    priority:       '3',
    assignee:       '황재웅',
    // dueDate: '2026/04/10',
    // receiptTime: '2026/04/07 09:00',
  };
  // ──────────────────────────────────────────────

  try {
    const jar    = await setupSession();
    const tokens = await getFormToken(jar);
    const result = await createTicket(jar, tokens, ticketData);

    console.log('\n══════════════════════════════════════════');
    console.log('✅  티켓 생성 완료!');
    console.log(`   이슈 키 : ${result.issueKey}`);
    console.log(`   이슈 ID : ${result.createdIssueDetails?.id}`);
    console.log(`   URL     : http://${CONFIG.host}/browse/${result.issueKey}`);
    console.log('══════════════════════════════════════════');
  } catch (err) {
    console.error('\n❌ 오류:', err.message);
    process.exit(1);
  }
}

async function createJiraTicket(ticketData) {
  const jar    = await setupSession();
  const tokens = await getFormToken(jar);
  const result = await createTicket(jar, tokens, ticketData);
  return result;
}

module.exports = { createJiraTicket };