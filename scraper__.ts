// scraper.ts
import { chromium, Browser, Page } from 'playwright';

export interface Post {
  id: number;
  title: string;
  author: string;
  date: string;
  url: string;
}

let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browser) {
    browser = await chromium.launch({ headless: true });
  }
  return browser;
}

export async function scrapePosts(): Promise<Post[]> {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    // WinCMS 로그인 (필요한 경우)
    await login(page);

    // 게시판 페이지 이동
    await page.goto('https://svc.wooribank.com/wsm/common/login_counsel.jsp', {
      waitUntil: 'networkidle',
    });

    // 게시글 목록 파싱
    const posts = await page.evaluate(() => {
      const rows = document.querySelectorAll('table.board-list tbody tr');

      return Array.from(rows).map(row => {
        const idEl = row.querySelector('td.num');
        const titleEl = row.querySelector('td.title a');
        const authorEl = row.querySelector('td.writer');
        const dateEl = row.querySelector('td.date');

        return {
          id: Number(idEl?.textContent?.trim()),
          title: titleEl?.textContent?.trim() ?? '',
          author: authorEl?.textContent?.trim() ?? '',
          date: dateEl?.textContent?.trim() ?? '',
          url: titleEl?.getAttribute('href') ?? '',
        };
      });
    });

    return posts.filter(p => p.id > 0);
  } finally {
    await page.close();
  }
}

async function login(page: Page) {
  const LOGIN_URL = 'https://svc.wooribank.com/wsm/common/login_counsel.jsp';

  await page.goto(LOGIN_URL, { waitUntil: 'networkidle' });

  const isLoggedIn = await page.$('a.logout');
  if (isLoggedIn) return;

  await page.fill('input[name="userId"]', 'kwic02');
  await page.fill('input[name="userPw"]', 'user01');

  // 생년월일 입력 (YYYYMMDD 형식 가정)
  await page.fill('input[name="birthDate"]', '930126');

  await page.click('button[type="submit"]');
  await page.waitForNavigation({ waitUntil: 'networkidle' });
}