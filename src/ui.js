import readline from "node:readline";
import { saveMessage, readThread, listThreads, getThread, renameThread } from "./store.js";
import { syncRecent } from "./sync.js";

const c = { dim: s => `\x1b[2m${s}\x1b[0m`, cyan: s => `\x1b[36m${s}\x1b[0m`, green: s => `\x1b[32m${s}\x1b[0m` };

const LABEL = {
  "chat.photo": "[ảnh]", "chat.sticker": "[sticker]", "chat.voice": "[voice]",
  "chat.video.msg": "[video]", "chat.recommended": "[link]",
};
const preview = (m) => m.text || LABEL[m.kind] || `[${m.kind}]`;

// directory: Map<threadId, { name, isGroup }> — biết trước bạn bè/nhóm
// để /open lấy đúng tên và đúng loại hội thoại.
export function startUI(client, initialThread, directory = new Map()) {
  let current = initialThread; // { threadId, name, isGroup }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });

  const print = (line) => {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    console.log(line);
    rl.prompt(true);
  };

  client.on("message", (m) => {
    // Ghi kèm tên hội thoại nếu đã biết trong danh bạ
    saveMessage({ ...m, threadName: directory.get(m.threadId)?.name });
    const label = preview(m);
    if (m.threadId === current?.threadId) {
      const time = new Date(m.ts).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
      print(`${c.dim(time)} ${m.isSelf ? c.green("tôi") : c.cyan(m.fromName)}: ${label}`);
    } else {
      print(c.dim(`(${m.fromName}) ${label.slice(0, 60)}`));
    }
  });

  client.on("old-messages", (msgs) => {
    // Tin nhắn lỡ khi offline, server phát lại lúc kết nối
    let saved = 0;
    for (const m of msgs) {
      if (saveMessage({ ...m, threadName: directory.get(m.threadId)?.name })) saved++;
    }
    if (saved) print(c.dim(`Đã nạp ${saved} tin nhắn cũ.`));
  });

  rl.on("line", async (line) => {
    const text = line.trim();
    if (!text) return rl.prompt();

    if (text === "/quit") return rl.close();

    if (text === "/chats") {
      const threads = listThreads(20);
      if (!threads.length) print(c.dim("Chưa có hội thoại nào. Thử /groups hoặc /friends để lấy id."));
      for (const t of threads) {
        const name = t.name || directory.get(t.id)?.name || t.id;
        const tag = t.is_group ? c.dim("[nhóm]") : "";
        print(`${c.cyan(t.id)}  ${name} ${tag}  ${new Date(t.last_ts).toLocaleString("vi-VN")}`);
      }
      return rl.prompt();
    }

    if (text === "/sync") {
      print("Đang đồng bộ tin nhắn cũ... (chờ vài giây)");
      try {
        const { messages, saved } = await syncRecent(client, {
          directory,
          log: (line) => print(c.dim("  " + line)),
        });
        print(`Đồng bộ xong: ${messages} tin nhắn, lưu mới ${saved}. Gõ /chats để xem.`);
      } catch (e) {
        print(`Lỗi đồng bộ: ${e.message}`);
      }
      return rl.prompt();
    }

    if (text === "/groups") {
      try {
        const groups = await client.groups();
        if (!groups.length) print(c.dim("Không có nhóm nào."));
        for (const g of groups) {
          directory.set(g.groupId, { name: g.name, isGroup: true });
          renameThread(g.groupId, g.name);
          print(`${c.cyan(g.groupId)}  ${g.name} ${c.dim("[nhóm]")}`);
        }
      } catch (e) {
        print(`Lỗi tải nhóm: ${e.message}`);
      }
      return rl.prompt();
    }

    if (text === "/friends") {
      try {
        const friends = await client.friends();
        if (!friends.length) print(c.dim("Không có bạn bè nào."));
        for (const f of friends) {
          const name = f.zaloName || f.displayName;
          directory.set(f.userId, { name, isGroup: false });
          renameThread(f.userId, name);
          print(`${c.cyan(f.userId)}  ${name}`);
        }
      } catch (e) {
        print(`Lỗi tải bạn bè: ${e.message}`);
      }
      return rl.prompt();
    }

    if (text.startsWith("/open ")) {
      const [, id, ...name] = text.split(" ");
      if (!id) {
        print("Cách dùng: /open <threadId> [tên]");
        return rl.prompt();
      }

      const known = getThread(id);
      const info = directory.get(id);
      const nameInput = name.join(" ").trim();
      if (nameInput) renameThread(id, nameInput);

      current = {
        threadId: id,
        name: nameInput || info?.name || known?.name || id,
        isGroup: info ? info.isGroup : Boolean(known?.is_group),
      };
      print(c.dim(`Đang mở: ${current.name}${current.isGroup ? " [nhóm]" : ""}`));

      const history = readThread(id, 30);
      if (!history.length) print(c.dim("Chưa có tin nhắn trong hội thoại này."));
      for (const m of history) {
        const who = m.is_self ? c.green("tôi") : c.cyan(m.from_name);
        const label = m.body || LABEL[m.kind] || `[${m.kind}]`;
        print(`${who}: ${label}`);
      }
      return rl.prompt();
    }

    if (text === "/help") {
      print("/chats  /sync  /groups  /friends");
      print("/open <threadId> [tên]   /quit");
      print("Gõ chữ thường để gửi tin vào hội thoại đang mở.");
      return rl.prompt();
    }

    if (!current) {
      print("Chưa chọn hội thoại: /chats (hoặc /groups, /friends) rồi /open <id>");
      return rl.prompt();
    }

    try {
      await client.send(current.threadId, text, current.isGroup);
      print(c.dim("đã gửi"));
    } catch (e) {
      print(`Lỗi gửi: ${e.message}`);
    }
    rl.prompt();
  });

  rl.prompt();
  return rl;
}
