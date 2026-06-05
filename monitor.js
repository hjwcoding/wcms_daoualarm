// monitor.js
const { chromium } = require('playwright');
const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');
const { createJiraTicket } = require('./jiraTicketSend');
require('dotenv').config();

const DAOU_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) dop-chat-front/4.2.3 Chrome/130.0.6723.137 Electron/33.2.1 Safari/537.36 DOP_PC_MESSENGER',
};

let daouCookie = '';
const notifiedIds = new Set();
let browser = null;

// ────────────────────────────────────────
// 다우메신저
// ────────────────────────────────────────
async function daouLogin() {
  try {
    const res = await fetch(process.env.DAOU_CONFIG_loginUrl, {
      method: 'POST',
      headers: {
        ...DAOU_HEADERS,
        Referer: 'https://kwic.daouoffice.com/login',
        Origin: 'https://kwic.daouoffice.com',
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) dop-chat-front/4.3.0 Chrome/130.0.6723.137 Electron/33.2.1 Safari/537.36 DOP_PC_MESSENGER',
      },
      body: JSON.stringify({
        companyId: '11000000660',
        loginId: process.env.DAOU_CONFIG_id,
        password: process.env.DAOU_CONFIG_pw,
        captcha: '',
      }),
    });

    const body = await res.text();
    console.log('다우 로그인 status:', res.status);
    console.log('다우 로그인 body:', body);

    const setCookie = res.headers.get('set-cookie') ?? '';
    const accessToken = setCookie.match(/AccessToken=([^;]+)/)?.[1];
    const refreshToken = setCookie.match(/RefreshToken=([^;]+)/)?.[1];

    if (accessToken) {
      daouCookie = `AccessToken=${accessToken}; RefreshToken=${refreshToken ?? ''}`;
      console.log('✅ 다우메신저 로그인 완료');
    } else {
      console.error('❌ 토큰 추출 실패');
    }
  } catch (err) {
    console.error('다우 로그인 오류:', err);
  }
}

async function sendDaouAlert(post, issueKey = null) {
  if (!daouCookie) await daouLogin();

  const message = [
    '📋 WinCMS 알림',
    `유형    : ${post.type}`,
    `이름    : ${post.name}`,
    `회사    : ${post.company}`,
    `전화    : ${post.phone}`,
    `내용    : ${post.content}`,
    `담당    : ${post.handler}`,
    `일시    : ${post.date}`,
    issueKey ? `티켓    : (${issueKey}) 이 생성되었습니다.` : '티켓    : 생성 실패',
    `자세한 티켓 상세내용은 WINCMS 게시판을 참고해서 작성해 주시기 바랍니다.`
  ].join('\n');

  try {
    const res = await fetch(process.env.DAOU_CONFIG_messageUrl, {
      method: 'POST',
      headers: {
        ...DAOU_HEADERS,
        Cookie: daouCookie,
        'X-Referer-Info': 'kwic.daouoffice.com',
      },
      body: JSON.stringify({
        chatRoomId: process.env.DAOU_CONFIG_chatRoomId,
        cmid: uuidv4(),
        content: { message },
      }),
    });

    const body = await res.text();
    console.log('메시지 전송 status:', res.status);
    console.log('메시지 전송 body:', body);

    if (res.status === 401) {
      console.log('토큰 만료 - 재로그인 후 재시도');
      daouCookie = '';
      await daouLogin();
      await sendDaouAlert(post, issueKey);
      return;
    }

    if (res.ok) {
      console.log(`✅ 다우메신저 전송 완료 [${post.postId}]`);
    } else {
      console.error(`❌ 전송 실패 [${post.postId}]:`, res.status);
    }
  } catch (err) {
    console.error('전송 오류:', err);
  }
}

// ────────────────────────────────────────
// WinCMS 스크래핑
// ────────────────────────────────────────
async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ headless: true });
  }
  return browser;
}

async function login(page) {
  await page.goto(process.env.CONFIG_loginUrl, { waitUntil: 'networkidle' });

  await page.fill('input[name="userId"]', process.env.CONFIG_id);
  await page.fill('input[name="userPwd"]', process.env.CONFIG_pw);
  await page.fill('input[name="ssn1"]', process.env.CONFIG_birth);
  await page.click('a[href="javascript:signCert();"]');

  // waitForNavigation 대신 타임아웃으로 대기
  await page.waitForTimeout(5000);
  console.log('✅ WinCMS 로그인 완료 - URL:', page.url());
}

async function scrapePosts(page) {
  await page.goto(process.env.CONFIG_boardUrl, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  const bodyFrame = page.frames().find((f) => f.url().includes('wccom500_01i.jsp'));

  if (!bodyFrame) {
    console.error('❌ 프레임 못 찾음');
    return [];
  }

  console.log('✅ 프레임 찾음!');

  const posts = await bodyFrame.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('tr.brd_a'));
    const result = [];

    for (let i = 0; i < rows.length; i++) {
      const tds = rows[i].querySelectorAll('td');
      const td7 = tds[7];
      const td7Text = td7?.textContent?.trim() ?? '';
      const hasSname = !!td7?.querySelector('a.sname');

      // a.sname 없으면 스킵
      if (!hasSname) continue;
      // 전달/등록 아니면 스킵
      if (td7Text !== '전달' && td7Text !== '등록') continue;

      // 위로 올라가며 접수 정보 행 찾기
      let infoTds = tds; // 기본값: 같은 행
      for (let j = i - 1; j >= 0; j--) {
        const prevLink = rows[j].querySelector("a[href*='uf_link(']");
        if (prevLink) {
          infoTds = rows[j].querySelectorAll('td');
          break;
        }
      }

      const linkEl = td7?.querySelector('a.sname') ?? infoTds[0]?.querySelector("a[href*='uf_link(']");
      const href = linkEl?.getAttribute('href') ?? '';
      const match = href.match(/uf_link\('\d+','(\w+)'/);

      result.push({
        postId: match?.[1] ?? '',
        name: infoTds[1]?.textContent?.trim() ?? '',
        company: infoTds[2]?.textContent?.trim() ?? '',
        phone: infoTds[3]?.textContent?.trim() ?? '',
        content: infoTds[4]?.textContent?.trim() ?? '',
        handler: tds[5]?.textContent?.trim() ?? '',
        date: tds[6]?.textContent?.trim() ?? '',
        type: td7Text,
      });
    }

    return result;
  });

  const filtered = posts.filter((p) => p.postId !== '');
  console.log(`감지된 항목 (전달/등록): ${filtered.length}개`);
  return filtered;
}

// ────────────────────────────────────────
// 메인 루프
// ────────────────────────────────────────
async function checkNewPosts() {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await login(page);
    const posts = await scrapePosts(page);

    console.log(`[${new Date().toISOString()}] 감지된 항목: ${posts.length}개`);

    for (const post of posts) {
      console.log('----------------------------------');
      console.log('유형    :', post.type);
      console.log('postId  :', post.postId);
      console.log('이름    :', post.name);
      console.log('회사    :', post.company);
      console.log('전화    :', post.phone);
      console.log('내용    :', post.content);
      console.log('담당    :', post.handler);
      console.log('관련자  :', ['김나연', '이동훈', '정수지', '황재웅']);
      console.log('일시    :', post.date);
      console.log('중복    :', notifiedIds.has(post.postId) ? '중복 - 스킵' : '신규');
      console.log('----------------------------------');

      if (notifiedIds.has(post.postId)) continue;

      let issueKey = null;
      try {
        const result = await createJiraTicket({
          summary:        `[WinCMS] ${post.content} ${post.phone}`,
          customerInfo:   [post.company, 'wincms'],
          receiptContent: post.content,
          assignee:       '황재웅',
          relatedUsers:   ['김나연', '이동훈', '정수지', '황재웅'],
          priority:       '3',
        });
        issueKey = result.issueKey;
        console.log(`✅ Jira 티켓 생성: ${issueKey}`);
      } catch (err) {
        console.error('❌ Jira 티켓 생성 실패:', err.message);
      }

      await sendDaouAlert(post, issueKey);

      notifiedIds.add(post.postId);
    }
  } catch (err) {
    console.error('체크 중 오류:', err);
  } finally {
    await page.close();
  }
}

// 매 5분마다 실행
cron.schedule('*/1 * * * *', async () => {
  console.log(`\n[${new Date().toISOString()}] 스케줄 실행`);
  await checkNewPosts();
});

// 시작 시 즉시 1회 실행
console.log('모니터링 시작...');
checkNewPosts();
