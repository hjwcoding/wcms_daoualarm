typescript// scheduler.ts

import cron from 'node-cron';
import { checkNewPosts } from './monitor';

// 매 5분마다 실행
cron.schedule('*/5 * * * *', async () => {
  console.log(`[${new Date().toISOString()}] 게시판 체크 시작`);
  await checkNewPosts();
});