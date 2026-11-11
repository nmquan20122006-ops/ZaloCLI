import { saveMessage, renameThread } from "./store.js";

// Lấy bạn bè + nhóm, lưu tên vào DB và trả về Map<threadId, {name,isGroup}>
// để tra cứu nhanh khi lưu tin nhắn.
export async function loadDirectory(client) {
  const directory = new Map();

  const [friends, groups] = await Promise.all([client.friends(), client.groups()]);
  for (const f of friends) {
    const name = f.zaloName || f.displayName;
    renameThread(f.userId, name);
    directory.set(f.userId, { name, isGroup: false });
  }
  for (const g of groups) {
    renameThread(g.groupId, g.name);
    directory.set(g.groupId, { name: g.name, isGroup: true });
  }
  return directory;
}

// Đồng bộ tin nhắn cũ (bị lỡ khi offline) qua WebSocket old_messages.
// Lưu ý: zca-js 2.2.0 KHÔNG dùng được getGroupChatHistory() nữa —
// endpoint /api/group/history đã bị Zalo xoá nên luôn trả 404.
// Client phải đang chạy listener (connect({ listen: true })).
export async function syncRecent(client, { waitMs = 4000, directory = new Map(), log = () => {} } = {}) {
  const msgs = await client.recentMessages({ waitMs });

  let saved = 0;
  for (const m of msgs) {
    if (saveMessage({ ...m, threadName: directory.get(m.threadId)?.name })) saved++;
  }

  log(`${msgs.length} tin nhắn cũ (lưu mới ${saved})`);
  return { messages: msgs.length, saved };
}
