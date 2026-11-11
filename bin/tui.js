#!/usr/bin/env bun
// Entry point cho `zalo tui`.
//
// Phải chạy bằng Bun vì OpenTUI cần Bun >= 1.3.14 (hoặc Node >= 26.4).
// bin/zalo.js sẽ tự spawn file này bằng bun trong node_modules/.bin.

import { ZaloClient } from "../src/client.js";
import { loadDirectory } from "../src/sync.js";
import { startTui } from "../src/tui.js";

// Cú pháp: bun bin/tui.js [--open <threadId>]
const argv = process.argv.slice(2);
const openIdx = argv.indexOf("--open");
const initialThreadId = openIdx !== -1 ? argv[openIdx + 1] : null;

const client = new ZaloClient();

try {
  await client.connect({ listen: true });
} catch (e) {
  console.error("Đăng nhập thất bại:", e.message);
  process.exit(1);
}

// Tải danh bạ trước khi vào TUI. Bước này có thể mất vài giây nên báo cho
// người dùng biết (lúc này renderer chưa chiếm màn hình).
if (process.stdout.isTTY) console.log("Đang tải danh bạ bạn bè / nhóm…");

// Chạy song song: danh bạ (để đếm bạn/nhóm) và profile (tên + id hiển thị
// ở footer). allSettled để một API lỗi không làm hỏng cả TUI.
const [directoryResult, profileResult] = await Promise.allSettled([
  loadDirectory(client),
  client.profile(),
]);

const directory = directoryResult.status === "fulfilled" ? directoryResult.value : new Map();
if (directoryResult.status === "rejected") {
  console.error("Không tải được danh bạ:", directoryResult.reason?.message);
}

const profile =
  profileResult.status === "fulfilled"
    ? profileResult.value
    : { id: client.me, name: client.me };
if (profileResult.status === "rejected") {
  console.error("Không lấy được thông tin tài khoản:", profileResult.reason?.message);
}

await startTui(client, {
  directory,
  profile,
  initialThread: initialThreadId
    ? {
        threadId: initialThreadId,
        name: directory.get(initialThreadId)?.name || initialThreadId,
        isGroup: Boolean(directory.get(initialThreadId)?.isGroup),
      }
    : null,
});
