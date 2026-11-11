#!/usr/bin/env node
import { ZaloClient } from "../src/client.js";
import { startUI } from "../src/ui.js";
import { loadDirectory, syncRecent } from "../src/sync.js";
import { logout } from "../src/auth.js";

const [cmd = "listen", ...args] = process.argv.slice(2);

if (cmd === "logout") {
  logout();
  console.log("Đã đăng xuất.");
  process.exit(0);
}

// `tui` phải chạy bằng Bun (OpenTUI cần Bun >= 1.3.14 hoặc Node >= 26.4),
// nên spawn một process riêng thay vì chạy tiếp bằng Node hiện tại.
// Đặt trước client.connect() để không mở 2 kết nối Zalo cùng lúc.
if (cmd === "tui") {
  const { spawn } = await import("node:child_process");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const localBun = path.join(
    here,
    "..",
    "node_modules",
    ".bin",
    process.platform === "win32" ? "bun.cmd" : "bun",
  );
  // Ưu tiên bun cài trong project; nếu không có (vd. cài global) thì dùng
  // bun trên PATH.
  const bun = fs.existsSync(localBun) ? localBun : "bun";
  const entry = path.join(here, "tui.js");

  const child = spawn(bun, [entry, ...args], { stdio: "inherit" });
  const code = await new Promise((resolve) => {
    child.on("error", (e) => {
      console.error("Không chạy được Bun:", e.message);
      console.error("Cài lại bằng: npm install");
      resolve(1);
    });
    child.on("exit", (c, signal) => resolve(c ?? (signal ? 1 : 0)));
  });
  process.exit(code);
}

const isListen = cmd === "listen";
const needsListener = isListen || cmd === "sync";
const forceLogin = cmd === "login";

const client = new ZaloClient();
// Chỉ mở listener (WebSocket) khi thật sự cần nghe tin nhắn.
// Nếu mở ở các lệnh one-shot, process sẽ không thoát sau khi in kết quả.
try {
  await client.connect({ listen: needsListener, force: forceLogin });
} catch (e) {
  console.error("Đăng nhập thất bại:", e.message);
  process.exit(1);
}

try {
  switch (cmd) {
    case "login":
      // login() đã in tên + uid
      break;

    case "whoami":
      console.log(client.me);
      break;

    case "friends":
      for (const f of await client.friends()) {
        console.log(f.userId, f.zaloName || f.displayName);
      }
      break;

    case "groups":
      // client.groups() đã tự gọi getGroupInfo để lấy tên nhóm
      for (const g of await client.groups()) console.log(g.groupId, g.name);
      break;

    case "sync": {
      // Nạp danh bạ để biết tên hội thoại, rồi xin server phát lại tin cũ
      const directory = await loadDirectory(client);
      const { messages, saved } = await syncRecent(client, {
        directory,
        log: (line) => console.log(line),
      });
      console.log(`Đồng bộ xong: nhận ${messages} tin nhắn, lưu mới ${saved}.`);
      break;
    }

    case "send": {
      // Tách cờ --group ra trước khi lấy threadId, tránh trường hợp
      // `send --group <id> ...` khiến threadId = "--group".
      const groupIdx = args.indexOf("--group");
      const isGroup = groupIdx !== -1;
      if (isGroup) args.splice(groupIdx, 1);

      const [threadId, ...rest] = args;
      const text = rest.join(" ");
      if (!threadId || !text) {
        console.error("Cách dùng: zalo send <threadId> [--group] <nội dung>");
        process.exitCode = 1;
        break;
      }
      await client.send(threadId, text, isGroup);
      console.log("Đã gửi");
      break;
    }

    case "listen": {
      // Nạp sẵn bạn bè / nhóm để /open biết tên và biết đâu là nhóm
      let directory = new Map();
      try {
        directory = await loadDirectory(client);
      } catch (e) {
        console.error("Không tải được danh bạ:", e.message);
      }

      console.log("Đang nghe tin nhắn... (Ctrl+C để thoát)");
      console.log("Gõ /help để xem trợ giúp, /sync để nạp hội thoại đã chat.");
      startUI(client, null, directory);
      break;
    }

    default:
      console.error(`Lệnh không hợp lệ: ${cmd}`);
      console.error("Các lệnh: login | logout | whoami | friends | groups | send | sync | listen | tui");
      process.exitCode = 1;
  }
} finally {
  // Lệnh listen cần listener sống tiếp, chỉ đóng ở các lệnh one-shot
  if (!isListen) client.close();
}
