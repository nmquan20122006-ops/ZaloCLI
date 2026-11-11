import { EventEmitter } from "node:events";
import { ThreadType } from "zca-js";
import { login } from "./auth.js";

export class ZaloClient extends EventEmitter {
  #api; #me;
  // Đệm tin nhắn cũ nhận được trước khi recentMessages() kịp gắn listener
  // (ví dụ trong lúc loadDirectory() đang gọi HTTP lấy danh bạ).
  #oldBuffer = [];
  #connected = false;

  // listen = false dùng cho các lệnh one-shot (whoami, send, ...) để
  // không mở WebSocket làm process bị treo sau khi in kết quả.
  async connect({ listen = true, force = false } = {}) {
    this.#api = await login({ force });
    this.#me = this.#api.getOwnId();

    if (listen) {
      this.#api.listener.on("message", (msg) => { // listener la 1 thuc the cua api zalo
                                                  // nam tai "node_modules/zca-js/dist/apis.js"
                                                  // message la 1 event nhan tin nhan
                                                  // on("Ten su kien", callback)
      this.emit("message", this.#normalize(msg)); // ban su kien "message" voi data = msg duoc chuan hoa
      });
      this.#api.listener.on("old_messages", (msgs) => { // lang nghe su kien ->  thuc hien callback ham
        const normalized = msgs.map((m) => this.#normalize(m)); // thuc hien chuan hoa du lieu cho tung msg trong mang
        this.#oldBuffer.push(...normalized);
        this.emit("old-messages", normalized);
      });
      this.#api.listener.on("connected", () => {
        this.#connected = true;
        this.emit("connected");
        // Mỗi lần kết nối (kể cả reconnect), xin lại tin nhắn lỡ trong 2 tuần
        this.#api.listener.requestOldMessages(ThreadType.User);
        this.#api.listener.requestOldMessages(ThreadType.Group);
      });
      this.#api.listener.on("closed", (code, reason) => {
        this.#connected = false;
        this.emit("closed", code, reason);
      });
      // Bên kia đang gõ. Zalo chỉ gửi id người gõ + id hội thoại, không gửi
      // tên, nên TUI tự tra tên trong directory khi hiển thị.
      this.#api.listener.on("typing", (typing) => {
        this.emit("typing", {
          threadId: typing.threadId,
          isGroup: typing.type === ThreadType.Group,
          fromId: typing.data.uid,
        });
      });

      this.#api.listener.start({ retryOnClose: true });
    }
  }

  close() {
    this.#api?.listener?.stop();
  }

  #normalize(m) {
    return {
      id: m.data.msgId,
      threadId: m.threadId,
      isGroup: m.type === ThreadType.Group,
      isSelf: m.isSelf,
      fromId: m.data.uidFrom,
      fromName: m.data.dName || (m.isSelf ? "tôi" : m.data.uidFrom),
      ts: Number(m.data.ts),
      kind: m.data.msgType,
      text: typeof m.data.content === "string" ? m.data.content : "",
      raw: m,
    };
  }

  // sendMessage cần quote đúng cấu trúc SendMessageQuote, không phải
  // nguyên object Message của zca-js.
  #toQuote(m) {
    const d = m.raw ? m.raw.data : m.data;
    return {
      content: d.content,
      msgType: d.msgType,
      propertyExt: d.propertyExt,
      uidFrom: d.uidFrom,
      msgId: d.msgId,
      cliMsgId: d.cliMsgId,
      ts: d.ts,
      ttl: d.ttl,
    };
  }

  async send(threadId, text, isGroup = false, quote) {
    return this.#api.sendMessage(
      { msg: text, quote: quote ? this.#toQuote(quote) : undefined },
      threadId,
      isGroup ? ThreadType.Group : ThreadType.User,
    );
  }

  // Báo cho hội thoại biết mình đang gõ. Zalo tự hết trạng thái này sau vài
  // giây, nên TUI gọi có giới hạn tần suất chứ không gọi mỗi phím.
  async typing(threadId, isGroup = false) {
    return this.#api.sendTypingEvent(
      threadId,
      isGroup ? ThreadType.Group : ThreadType.User,
    );
  }

  // Xoá dấu chưa đọc trên server → badge trên điện thoại cũng mất.
  async markRead(threadId, isGroup = false) {
    return this.#api.removeUnreadMark(
      threadId,
      isGroup ? ThreadType.Group : ThreadType.User,
    );
  }

  // Báo "đã xem" cho một tin vừa nhận để bên gửi thấy trạng thái đã xem.
  // Chỉ làm được với tin còn `raw` từ WebSocket; tin đọc lại từ DB thì không.
  async seen(m) {
    if (!m?.raw?.data) return;
    const d = m.raw.data;
    return this.#api.sendSeenEvent(
      {
        msgId: d.msgId,
        cliMsgId: d.cliMsgId,
        uidFrom: d.uidFrom,
        idTo: d.idTo,
        msgType: d.msgType,
        st: d.st,
        at: d.at,
        cmd: d.cmd,
        ts: d.ts,
      },
      m.isGroup ? ThreadType.Group : ThreadType.User,
    );
  }

  async friends() { return this.#api.getAllFriends(); }

  // Thông tin tài khoản đang đăng nhập (dùng cho footer của TUI).
  // fetchAccountInfo() trả về profile giống lúc login đã in tên.
  async profile() {
    const { profile } = await this.#api.fetchAccountInfo();
    return {
      id: this.#me,
      name: profile.displayName || profile.zaloName || profile.username || this.#me,
    };
  }

  // Xin server phát lại tin nhắn cũ (bị lỡ khi offline) qua WebSocket.
  // Chờ waitMs để gom hết các frame server gửi về.
  // Lưu ý: KHÔNG dùng getGroupChatHistory() — endpoint /api/group/history
  // đã bị Zalo xoá nên luôn trả 404 (xem issue #356 của zca-js).
  async recentMessages({ waitMs = 4000 } = {}) {
    // Nếu WebSocket chưa connected, request sẽ bị bỏ qua (sendWs không làm gì
    // khi ws chưa mở). Chờ connected tối đa waitMs.
    if (!this.#connected) {
      await new Promise((resolve) => {
        const onConn = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          this.off("connected", onConn);
          resolve();
        }, waitMs);
        this.once("connected", onConn);
      });
    }

    // Lấy những tin đã nhận sẵn trong buffer (auto-request lúc connected)
    // để không bị mất khi loadDirectory() chạy lâu.
    const collected = this.#oldBuffer.splice(0);
    const seen = new Set(collected.map((m) => m.id));

    const onOld = (msgs) => {
      for (const m of msgs) {
        const n = this.#normalize(m);
        if (seen.has(n.id)) continue; // tránh trùng do request 2 lần
        seen.add(n.id);
        collected.push(n);
      }
    };

    this.#api.listener.on("old_messages", onOld);
    try {
      this.#api.listener.requestOldMessages(ThreadType.User);
      this.#api.listener.requestOldMessages(ThreadType.Group);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    } finally {
      this.#api.listener.off("old_messages", onOld);
    }

    return collected;
  }

  // getAllGroups() chỉ trả về { version, gridVerMap } (id -> version),
  // nên phải gọi thêm getGroupInfo để lấy tên nhóm.
  async groups() {
    const { gridVerMap } = await this.#api.getAllGroups();
    const ids = Object.keys(gridVerMap ?? {});
    if (!ids.length) return [];

    const { gridInfoMap } = await this.#api.getGroupInfo(ids);
    return ids.map((id) => ({
      groupId: id,
      name: gridInfoMap?.[id]?.name || id,
    }));
  }

  get me() { return this.#me; }
}
