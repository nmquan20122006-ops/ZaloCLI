import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const DIR = path.join(os.homedir(), ".local", "share", "zalo-cli");
fs.mkdirSync(DIR, { recursive: true });

const db = new DatabaseSync(path.join(DIR, "zalo.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY, name TEXT, is_group INTEGER, last_ts INTEGER
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, thread_id TEXT, from_id TEXT, from_name TEXT,
    ts INTEGER, kind TEXT, body TEXT, is_self INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_msg_thread ON messages(thread_id, ts);
`);

export function saveMessage(m) {
  const inserted = db.prepare(`INSERT OR IGNORE INTO messages
    (id,thread_id,from_id,from_name,ts,kind,body,is_self) VALUES (?,?,?,?,?,?,?,?)`)
    .run(m.id, m.threadId, m.fromId, m.fromName, m.ts, m.kind, m.text, m.isSelf ? 1 : 0);

  // m.fromName là tên NGƯỜI GỬI, không phải tên hội thoại. Với chat nhóm
  // nếu ghi vào đây thì /chats sẽ hiện tên người nhắn cuối. Chỉ ghi tên
  // hội thoại khi thực sự biết (m.threadName), và không ghi đè tên đã có.
  // last_ts dùng MAX vì khi đồng bộ lịch sử cũ, tin cũ không được đẩy
  // hội thoại xuống dưới danh sách.
  db.prepare(`INSERT INTO threads (id,name,is_group,last_ts) VALUES (?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      last_ts=MAX(COALESCE(threads.last_ts, 0), COALESCE(excluded.last_ts, 0)),
      is_group=excluded.is_group,
      name=COALESCE(threads.name, excluded.name)`)
    .run(m.threadId, m.threadName ?? null, m.isGroup ? 1 : 0, m.ts);

  return inserted.changes > 0;
}

// Đặt tên hội thoại khi đã biết (danh bạ, /open <id> <tên>, ...)
export function renameThread(id, name) {
  db.prepare(`UPDATE threads SET name=? WHERE id=?`).run(name, id);
}

export function getThread(id) {
  return db.prepare(`SELECT * FROM threads WHERE id=?`).get(id);
}

export function readThread(threadId, limit = 30) {
  return db.prepare(`SELECT * FROM messages WHERE thread_id=?
                     ORDER BY ts DESC LIMIT ?`).all(threadId, limit).reverse();
}

export function listThreads(limit = 20) {
  return db.prepare(`SELECT * FROM threads ORDER BY last_ts DESC LIMIT ?`).all(limit);
}