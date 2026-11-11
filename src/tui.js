// Giao diện TUI dùng OpenTUI (@opentui/core).
//
// Kiến trúc: đây chỉ là tầng TRÌNH BÀY. Toàn bộ logic Zalo vẫn nằm ở
// client.js / store.js / sync.js. TUI nghe event từ client rồi vẽ ra màn hình,
// và gọi lại client khi người dùng gửi tin.
//
// Layout:
//   ┌──────────────┬──────────────────────────────┐
//   │ header: tên hội thoại + trạng thái          │  (1 dòng, cố định)
//   ├──────────────┼──────────────────────────────┤
//   │ sidebar      │ chat log (ScrollBox)         │  (co giãn)
//   │ (Select)     │                              │
//   │  ↑/↓ Enter   ├──────────────────────────────┤
//   │              │ > ô nhập                     │  (1 dòng, cố định)
//   │              │ gợi ý phím tắt               │  (1 dòng, cố định)
//   ├──────────────┴──────────────────────────────┤
//   │ footer đen: tài khoản · bạn/nhóm · hội thoại │  (1 dòng, cập nhật mỗi giây)
//   └─────────────────────────────────────────────┘
//
// Tab chuyển focus giữa sidebar và ô nhập.
//
// File này được chạy bằng Bun (xem bin/tui.js) vì OpenTUI cần Bun >= 1.3.14
// hoặc Node >= 26.4.

import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  ScrollBoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  TextRenderable,
  createCliRenderer,
  t,
  bold,
  dim,
  fg,
} from "@opentui/core";
import { listThreads, getThread, readThread, renameThread, saveMessage } from "./store.js";
import { syncRecent } from "./sync.js";

// Bảng màu tối, đủ tương phản trên terminal thường.
const C = {
  bg: "#0f1115",
  panel: "#1a1d24",
  black: "#000000",
  text: "#c9d1d9",
  muted: "#6e7681",
  accent: "#7aa2f7",
  green: "#3fb950",
  yellow: "#d29922",
  red: "#f85149",
};

const LABEL = {
  "chat.photo": "[ảnh]",
  "chat.sticker": "[sticker]",
  "chat.voice": "[voice]",
  "chat.video.msg": "[video]",
  "chat.recommended": "[link]",
};

// Nội dung hiển thị của một tin nhắn: ưu tiên text, không có thì dùng nhãn loại.
const preview = (m) => m.text || LABEL[m.kind] || `[${m.kind}]`;

const clock = (ts) =>
  new Date(ts).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });

// Thời gian ngắn gọn cho sidebar: hôm nay thì hiện giờ, cũ hơn thì hiện ngày.
const shortTime = (ts) => {
  if (!ts) return "";
  const date = new Date(ts);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return clock(ts);
  return date.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" });
};

// Đồng hồ cho footer. pad2 để 09:05:03 thay vì 9:5:3.
const pad2 = (n) => String(n).padStart(2, "0");
const nowClock = () => {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

// Cắt chữ theo code point để không vỡ emoji khi footer chỉ có 1 dòng.
const cut = (s, max) => {
  const chars = [...String(s ?? "")];
  return chars.length <= max ? chars.join("") : chars.slice(0, max - 1).join("") + "…";
};

// Giới hạn số dòng trong log để bộ nhớ không tăng vô hạn khi chạy lâu.
const MAX_LINES = 500;

/**
 * Khởi động TUI.
 * @param {import("./client.js").ZaloClient} client
 * @param {{
 *   directory?: Map<string, {name: string, isGroup: boolean}>,
 *   profile?: {id: string, name: string},
 *   initialThread?: object|null,
 *   renderer?: object
 * }} options
 *   `profile` là tên + id tài khoản để hiện ở footer.
 *   `renderer` chỉ dùng cho test headless; bình thường để trống.
 */
export async function startTui(
  client,
  {
    directory = new Map(),
    profile: providedProfile = null,
    initialThread = null,
    renderer: providedRenderer = null,
  } = {},
) {
  // createCliRenderer() chiếm terminal (alternate screen + raw mode) và trả về
  // renderer. `renderer.root` là gốc của cây renderable.
  const renderer =
    providedRenderer ??
    (await createCliRenderer({
      exitOnCtrlC: true, // Ctrl+C do OpenTUI xử lý
      targetFps: 30,
    }));

  // ---- Cây layout -------------------------------------------------------

  const root = new BoxRenderable(renderer, {
    id: "root",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: C.bg,
  });

  const header = new BoxRenderable(renderer, {
    id: "header",
    width: "100%",
    height: 1,
    flexShrink: 0, // không cho Yoga co header xuống 0 dòng
    flexDirection: "row",
    justifyContent: "space-between",
    backgroundColor: C.panel,
    paddingLeft: 1,
    paddingRight: 1,
  });

  const title = new TextRenderable(renderer, {
    id: "title",
    content: t`${bold(fg(C.accent)("Zalo CLI"))}`,
  });

  const status = new TextRenderable(renderer, {
    id: "status",
    content: t`${fg(C.muted)("đang kết nối…")}`,
  });

  header.add(title);
  header.add(status);

  // Thân dưới header: sidebar bên trái + vùng chat bên phải.
  const body = new BoxRenderable(renderer, {
    id: "body",
    width: "100%",
    flexGrow: 1,
    flexBasis: 0,
    minHeight: 0,
    flexDirection: "row",
  });

  // ---- Sidebar: danh sách hội thoại ------------------------------------

  const SIDEBAR_WIDTH = 30;

  const sidebarBox = new BoxRenderable(renderer, {
    id: "sidebar",
    width: SIDEBAR_WIDTH,
    flexShrink: 0,
    flexDirection: "column",
    backgroundColor: C.panel,
    border: ["right"],
    borderColor: C.muted,
  });

  const sidebarTitle = new TextRenderable(renderer, {
    id: "sidebar-title",
    height: 1,
    flexShrink: 0,
    paddingLeft: 1,
    content: t`${bold(fg(C.muted)("HỘI THOẠI"))}`,
  });

  // SelectRenderable tự xử lý ↑/↓ và Enter khi được focus.
  // Mỗi option gồm 2 dòng: name (tên hội thoại) và description (thông tin phụ).
  const sidebar = new SelectRenderable(renderer, {
    id: "sidebar-list",
    width: "100%",
    flexGrow: 1,
    minHeight: 0,
    options: [],
    backgroundColor: C.panel,
    focusedBackgroundColor: C.panel,
    textColor: C.text,
    focusedTextColor: C.text,
    selectedBackgroundColor: "#26324a",
    selectedTextColor: "#ffffff",
    descriptionColor: C.muted,
    selectedDescriptionColor: C.text,
    showDescription: true,
    showSelectionIndicator: true,
    wrapSelection: false,
  });

  sidebarBox.add(sidebarTitle);
  sidebarBox.add(sidebar);

  // ---- Vùng chat -------------------------------------------------------

  const chatBox = new BoxRenderable(renderer, {
    id: "chat",
    flexGrow: 1,
    flexBasis: 0,
    minWidth: 0,
    flexDirection: "column",
  });

  // ScrollBox: vùng chat. flexGrow + flexBasis 0 để nó nhận hết chiều cao còn
  // lại. stickyScroll/stickyStart giữ view ở đáy khi có tin mới.
  const log = new ScrollBoxRenderable(renderer, {
    id: "log",
    width: "100%",
    flexGrow: 1,
    flexBasis: 0,
    minHeight: 0,
    stickyScroll: true,
    stickyStart: "bottom",
    backgroundColor: C.bg,
    viewportOptions: { paddingLeft: 1, paddingRight: 1 },
    scrollbarOptions: {
      trackOptions: { foregroundColor: C.muted, backgroundColor: C.panel },
    },
  });

  const inputRow = new BoxRenderable(renderer, {
    id: "input-row",
    width: "100%",
    height: 1,
    flexShrink: 0,
    flexDirection: "row",
    backgroundColor: C.panel,
    paddingLeft: 1,
    paddingRight: 1,
  });

  inputRow.add(new TextRenderable(renderer, { id: "prompt", content: "> ", fg: C.accent }));

  const input = new InputRenderable(renderer, {
    id: "input",
    flexGrow: 1,
    placeholder: "Nhập tin nhắn hoặc /help",
    backgroundColor: "transparent",
    focusedBackgroundColor: "transparent",
    textColor: C.text,
    cursorColor: C.accent,
  });
  inputRow.add(input);

  const hint = new TextRenderable(renderer, {
    id: "hint",
    height: 1,
    flexShrink: 0,
    content: "",
    paddingLeft: 1,
  });

  chatBox.add(log);
  chatBox.add(inputRow);
  chatBox.add(hint);

  body.add(sidebarBox);
  body.add(chatBox);

  // ---- Footer: thanh đen cố định ở đáy ----------------------------------

  const footer = new BoxRenderable(renderer, {
    id: "footer",
    width: "100%",
    height: 1,
    flexShrink: 0,
    flexDirection: "row",
    backgroundColor: C.black,
    paddingLeft: 1,
    paddingRight: 1,
  });

  // Bên trái co giãn, bên phải giữ nguyên độ rộng để đồng hồ không bị đẩy.
  const footerLeft = new TextRenderable(renderer, {
    id: "footer-left",
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    wrapMode: "none",
    content: "",
  });

  const footerRight = new TextRenderable(renderer, {
    id: "footer-right",
    flexShrink: 0,
    wrapMode: "none",
    content: "",
  });

  footer.add(footerLeft);
  footer.add(footerRight);

  root.add(header);
  root.add(body);
  root.add(footer); // luôn là con cuối: body tự nhường đúng 1 dòng
  renderer.root.add(root);

  // ---- Trạng thái ứng dụng ---------------------------------------------

  let current = initialThread; // { threadId, name, isGroup }
  let online = false;
  let focusMode = "input"; // "input" | "sidebar"
  const unreadByThread = new Map(); // threadId -> số tin chưa đọc
  let shuttingDown = false;

  // Thông tin tài khoản + số bạn/nhóm cho footer. directory đã chứa toàn bộ
  // bạn bè và nhóm do loadDirectory() tải về, nên chỉ cần đếm một lần.
  const profile = providedProfile ?? { id: client.me, name: client.me };
  const directoryValues = [...directory.values()];
  const friendCount = directoryValues.filter((v) => !v.isGroup).length;
  const groupCount = directoryValues.filter((v) => v.isGroup).length;

  let footerTimer = null;
  let lastFooter = "";

  // ---- Đã đọc / đang nhập ----------------------------------------------
  //
  // Zalo coi mỗi tín hiệu "đang gõ" là có hiệu lực ~5 giây, nên chỉ cần gửi
  // lại khi người dùng vẫn đang gõ. Tương tự, không cần gọi markRead cho
  // từng tin nhận được trong cùng một giây.

  const TYPING_TTL = 5000; // thời gian hiện "đang nhập…" sau tín hiệu cuối
  const TYPING_THROTTLE = 3000; // tối thiểu giữa 2 lần gọi sendTypingEvent
  const MARK_READ_THROTTLE = 2000; // tối thiểu giữa 2 lần gọi removeUnreadMark

  const typingByThread = new Map(); // threadId -> { label, timer }
  const lastTypingSent = new Map(); // threadId -> ts
  const lastMarkRead = new Map(); // threadId -> ts

  const clearTyping = (threadId) => {
    const entry = typingByThread.get(threadId);
    if (!entry) return;
    clearTimeout(entry.timer);
    typingByThread.delete(threadId);
    if (current?.threadId === threadId) updateHeader();
  };

  // Đánh dấu đã đọc. `message` chỉ có khi tin vừa nhận từ WebSocket, dùng để
  // gửi luôn biên nhận "đã xem" cho bên kia.
  const markReadNow = (threadId, isGroup, message = null) => {
    if (message) {
      Promise.resolve(client.seen?.(message)).catch(() => {});
    }
    const now = Date.now();
    if (now - (lastMarkRead.get(threadId) || 0) < MARK_READ_THROTTLE) return;
    lastMarkRead.set(threadId, now);
    Promise.resolve(client.markRead?.(threadId, isGroup)).catch(() => {});
  };

  // Người dùng gõ trong ô nhập → báo "đang nhập" cho hội thoại đang mở.
  const notifyTyping = () => {
    if (!current) return;
    const now = Date.now();
    if (now - (lastTypingSent.get(current.threadId) || 0) < TYPING_THROTTLE) return;
    lastTypingSent.set(current.threadId, now);
    Promise.resolve(client.typing?.(current.threadId, current.isGroup)).catch(() => {});
  };

  const totalUnread = () =>
    [...unreadByThread.values()].reduce((sum, n) => sum + n, 0);

  // Vẽ lại footer. Được gọi mỗi giây bởi setInterval và ngay khi trạng thái
  // đổi (online/offline, mở hội thoại, có tin mới).
  const updateFooter = () => {
    if (shuttingDown) return;

    // Terminal hẹp thì dùng nhãn ngắn để cả tài khoản và hội thoại đều còn chỗ.
    const width = renderer.width || 100;
    const compact = width < 100;

    const dot = online
      ? fg(C.green)(compact ? "●" : "● online")
      : fg(C.red)(compact ? "●" : "● offline");
    const who = fg(C.accent)(bold(cut(profile.name, compact ? 14 : 24)));
    const uid = fg(C.muted)(`(${cut(profile.id, compact ? 8 : 20)})`);
    const counts = fg(C.muted)(
      compact
        ? `${friendCount}b/${groupCount}n`
        : `${friendCount} bạn · ${groupCount} nhóm`,
    );

    const thread = current
      ? `${cut(current.name, compact ? 16 : 30)}${current.isGroup ? " [nhóm]" : ""}`
      : "chưa mở hội thoại";
    const time = nowClock();

    // Chỉ vẽ khi chuỗi đổi. Đồng hồ đổi mỗi giây nên footer vẫn "chạy".
    const key = `${width}|${online}|${current?.threadId ?? ""}|${thread}|${time}`;
    if (key === lastFooter) return;
    lastFooter = key;

    footerLeft.content = t`${dot}  ${who} ${uid}  ${fg(C.muted)("·")}  ${counts}`;
    footerRight.content = t` ${fg(C.text)(thread)}  ${fg(C.muted)("·")}  ${fg(C.muted)(time)}`;
  };

  const updateHeader = () => {
    const who = current
      ? `${current.name}${current.isGroup ? " [nhóm]" : ""}`
      : "chưa chọn hội thoại";
    title.content = t`${bold(fg(C.accent)("Zalo CLI"))} ${fg(C.muted)("·")} ${fg(C.text)(who)}`;

    const dot = online ? fg(C.green)("● online") : fg(C.red)("● offline");
    const unread = totalUnread();
    const typing = current ? typingByThread.get(current.threadId) : null;

    // "Đang nhập" ưu tiên hơn số tin chưa đọc vì nó chỉ tồn tại vài giây.
    if (typing) {
      status.content = t`${dot} ${fg(C.accent)(`· ${typing.label}`)}`;
    } else if (unread > 0) {
      status.content = t`${dot} ${fg(C.yellow)(`· ${unread} tin mới`)}`;
    } else {
      status.content = t`${dot}`;
    }

    updateFooter();
  };

  // ---- Ghi nội dung vào log --------------------------------------------

  // Xoá bớt dòng cũ nhất khi log quá dài. destroyRecursively() giải phóng
  // luôn tài nguyên native của renderable, không chỉ tháo khỏi cây.
  const trimLog = () => {
    const kids = log.getChildren();
    if (kids.length <= MAX_LINES) return;
    for (const child of kids.slice(0, kids.length - MAX_LINES)) {
      log.remove(child);
      child.destroyRecursively();
    }
  };

  /** Thêm một dòng bất kỳ (StyledText từ `t`, hoặc string thường). */
  const append = (content, { fgColor, selectable = true } = {}) => {
    const options = {
      width: "100%",
      wrapMode: "word",
      content,
      selectable,
    };
    // Chỉ set fg khi cần: với StyledText, màu từng đoạn đã nằm trong content.
    if (fgColor) options.fg = fgColor;

    log.add(new TextRenderable(renderer, options));
    trimLog();
  };

  const system = (text, color = C.muted) => append(text, { fgColor: color, selectable: false });

  /** Vẽ một tin nhắn chuẩn hoá (cùng shape với client.#normalize). */
  const appendMessage = (m) => {
    const who = m.isSelf ? "tôi" : m.fromName || m.fromId || "?";
    const name = m.isSelf ? fg(C.green)(bold(who)) : fg(C.accent)(bold(who));
    append(t`${dim(clock(m.ts))} ${name}: ${fg(C.text)(preview(m))}`);
  };

  // ---- Vẽ lịch sử khi mở hội thoại -------------------------------------

  const clearLog = () => {
    for (const child of log.getChildren()) {
      log.remove(child);
      child.destroyRecursively();
    }
  };

  // Chống trùng: cùng một tin có thể đến từ lịch sử DB, old_messages và
  // event live. Set này nhớ id đã vẽ trong hội thoại đang mở.
  let shown = new Set();
  const showMessage = (m) => {
    if (m.id && shown.has(m.id)) return;
    if (m.id) shown.add(m.id);
    if (shown.size > 5000) shown = new Set(); // chặn phình bộ nhớ
    appendMessage(m);
  };

  // ---- Sidebar ----------------------------------------------------------

  const selectInSidebar = (threadId) => {
    const index = sidebar.options.findIndex((o) => o.value === threadId);
    if (index >= 0) sidebar.setSelectedIndex(index);
  };

  // Đổi màu viền + tiêu đề để biết sidebar đang được focus hay không.
  const updateSidebarChrome = () => {
    const active = focusMode === "sidebar";
    sidebarBox.borderColor = active ? C.accent : C.muted;
    sidebarTitle.content = t`${bold(fg(active ? C.accent : C.muted)("HỘI THOẠI"))}`;
  };

  // Đọc lại danh sách hội thoại từ DB và vẽ lại sidebar. Giữ dòng đang chọn
  // (nếu còn) để khi danh sách tự sắp xếp lại, con trỏ không bị nhảy.
  const refreshSidebar = () => {
    const keep = sidebar.getSelectedOption()?.value ?? current?.threadId ?? null;
    const rows = listThreads(50);

    sidebar.options = rows.map((row) => {
      const name = row.name || directory.get(row.id)?.name || row.id;
      const unread = unreadByThread.get(row.id) || 0;
      const meta = [row.is_group ? "nhóm" : null, shortTime(row.last_ts)]
        .filter(Boolean)
        .join(" · ");

      return {
        name: `${unread ? "● " : ""}${name}`,
        description: unread ? `${meta} · ${unread} mới` : meta,
        value: row.id,
      };
    });

    if (keep) selectInSidebar(keep);
  };

  const updateHint = () => {
    const text =
      focusMode === "sidebar"
        ? "↑/↓ chọn  •  Enter mở  •  Esc/Tab: nhập"
        : "Tab: danh sách  •  /help  •  PgUp/PgDn: cuộn";
    hint.content = t`${fg(C.muted)(text)}`;
  };

  // Chuyển focus giữa ô nhập và sidebar. Khi sidebar focus, ↑/↓/Enter do
  // SelectRenderable tự xử lý; khi ô nhập focus, gõ chữ được bình thường.
  const setFocus = (mode) => {
    focusMode = mode;
    if (mode === "sidebar") {
      input.blur();
      sidebar.focus();
    } else {
      sidebar.blur();
      input.focus();
    }
    updateSidebarChrome();
    updateHint();
  };

  const openThread = (threadId, nameInput = "") => {
    const known = getThread(threadId);
    const info = directory.get(threadId);
    if (nameInput) renameThread(threadId, nameInput);

    current = {
      threadId,
      name: nameInput || info?.name || known?.name || threadId,
      isGroup: info ? info.isGroup : Boolean(known?.is_group),
    };
    unreadByThread.delete(threadId);
    // Mở hội thoại = đã đọc → xoá badge chưa đọc trên server.
    markReadNow(threadId, current.isGroup);
    updateHeader();
    refreshSidebar();
    selectInSidebar(threadId);

    clearLog();
    shown = new Set();
    const history = readThread(threadId, 50);
    if (!history.length) {
      system(`Chưa có tin nhắn trong hội thoại này (${threadId}).`);
      return;
    }
    for (const row of history) {
      showMessage({
        id: row.id,
        isSelf: Boolean(row.is_self),
        fromName: row.from_name,
        fromId: row.from_id,
        ts: row.ts,
        kind: row.kind,
        text: row.body,
      });
    }
  };

  // ---- Xử lý lệnh ------------------------------------------------------

  const help = () => {
    system("/chats                — 20 hội thoại gần nhất");
    system("/open <id> [tên]      — mở hội thoại (id lấy từ /chats)");
    system("/sync                 — nạp tin nhắn lỡ khi offline");
    system("/quit                 — thoát");
    system("Tab                   — chuyển focus sang sidebar / ô nhập");
    system("↑/↓ rồi Enter         — chọn hội thoại trong sidebar");
    system("Gõ chữ thường để gửi tin vào hội thoại đang mở.");
    system("PgUp/PgDn cuộn log, Ctrl+C thoát.");
  };

  const showChats = () => {
    const threads = listThreads(20);
    if (!threads.length) {
      system("Chưa có hội thoại nào. Thử /sync trước.");
      return;
    }
    system("Hội thoại gần đây:");
    for (const row of threads) {
      const name = row.name || directory.get(row.id)?.name || row.id;
      const tag = row.is_group ? " [nhóm]" : "";
      const when = row.last_ts ? new Date(row.last_ts).toLocaleString("vi-VN") : "";
      system(`  ${row.id}  ${name}${tag}  ${when}`, C.text);
    }
    system("Mở bằng: /open <id> hoặc Tab rồi ↑/↓ + Enter");
  };

  const doSync = async () => {
    system("Đang đồng bộ tin nhắn cũ… (chờ vài giây)");
    try {
      const { messages, saved } = await syncRecent(client, {
        directory,
        log: (line) => system("  " + line),
      });
      refreshSidebar();
      system(`Đồng bộ xong: ${messages} tin nhắn, lưu mới ${saved}.`, C.green);
    } catch (e) {
      system(`Lỗi đồng bộ: ${e.message}`, C.red);
    }
  };

  const send = async (text) => {
    if (!current) {
      system("Chưa chọn hội thoại: /chats rồi /open <id>", C.yellow);
      return;
    }
    try {
      await client.send(current.threadId, text, current.isGroup);
      const m = {
        id: `local-${Date.now()}`,
        threadId: current.threadId,
        fromId: client.me || "me",
        fromName: "tôi",
        ts: Date.now(),
        kind: "webchat",
        text,
        isSelf: true,
      };
      saveMessage({ ...m, threadName: current.name });
      showMessage(m);
      refreshSidebar();
    } catch (e) {
      system(`Lỗi gửi: ${e.message}`, C.red);
    }
  };

  const handleLine = async (raw) => {
    const text = raw.trim();
    if (!text) return;

    if (text === "/quit" || text === "/q") return shutdown();
    if (text === "/help" || text === "/?") return help();
    if (text === "/chats") return showChats();
    if (text === "/sync") return doSync();

    if (text.startsWith("/open")) {
      const [, id, ...rest] = text.split(/\s+/);
      if (!id) return system("Cách dùng: /open <threadId> [tên]", C.yellow);
      return openThread(id, rest.join(" ").trim());
    }

    if (text.startsWith("/")) return system(`Lệnh không hỗ trợ: ${text}`, C.yellow);

    await send(text);
  };

  // Input tự gọi submit() khi nhấn Enter. Ta xoá value ngay để lần sau sạch.
  input.on(InputRenderableEvents.ENTER, (value) => {
    input.value = "";
    void handleLine(value);
  });

  // Mỗi lần nội dung đổi (gõ hoặc xoá) báo "đang nhập", có throttle bên trong.
  input.on(InputRenderableEvents.INPUT, () => notifyTyping());

  // ---- Phím tắt toàn cục ------------------------------------------------

  // Global listener chạy TRƯỚC handleKeyPress của renderable đang focus,
  // nên preventDefault() ở đây chặn được Tab lọt vào ô nhập.
  renderer.keyInput.on("keypress", (key) => {
    if (key.name === "tab") {
      key.preventDefault();
      setFocus(focusMode === "sidebar" ? "input" : "sidebar");
      return;
    }

    if (focusMode === "sidebar") {
      // Esc thoát sidebar; ↑/↓/Enter do SelectRenderable tự xử lý.
      if (key.name === "escape") {
        key.preventDefault();
        setFocus("input");
      }
      return;
    }

    if (key.name === "pageup") log.scrollBy(-1, "viewport");
    else if (key.name === "pagedown") log.scrollBy(1, "viewport");
  });

  // Chọn hội thoại trong sidebar: mở rồi trả focus về ô nhập để gõ tiếp.
  sidebar.on(SelectRenderableEvents.ITEM_SELECTED, (_index, option) => {
    if (!option?.value) return;
    openThread(option.value);
    setFocus("input");
  });

  // ---- Nối event từ client ----------------------------------------------

  const onMessage = (m) => {
    saveMessage({ ...m, threadName: directory.get(m.threadId)?.name });
    if (current && m.threadId === current.threadId) {
      showMessage(m);
      // Đang xem hội thoại này → gửi biên nhận đã xem + xoá badge.
      clearTyping(m.threadId); // đã gửi tin rồi thì không còn "đang nhập"
      markReadNow(m.threadId, current.isGroup, m);
    } else {
      unreadByThread.set(m.threadId, (unreadByThread.get(m.threadId) || 0) + 1);
      updateHeader();
      system(`(${m.fromName}) ${preview(m).slice(0, 80)}`);
    }
    refreshSidebar();
  };

  const onOldMessages = (msgs) => {
    let saved = 0;
    for (const m of msgs) {
      if (saveMessage({ ...m, threadName: directory.get(m.threadId)?.name })) saved += 1;
      // Tin cũ thuộc hội thoại đang mở thì hiển thị luôn (đã chống trùng).
      if (current && m.threadId === current.threadId) showMessage(m);
    }
    if (saved) system(`Đã nạp ${saved} tin nhắn cũ.`);
    refreshSidebar();
  };

  const onConnected = () => {
    online = true;
    updateHeader();
  };
  const onClosed = () => {
    online = false;
    updateHeader();
  };

  // Bên kia đang gõ trong hội thoại đang mở. Tín hiệu chỉ có id người gõ,
  // nên với chat 1-1 ta tra tên trong directory; nhóm thì chỉ báo chung.
  const onTyping = (typing) => {
    if (!current || typing.threadId !== current.threadId) return;
    // Bỏ qua tín hiệu của chính mình (khi mở Zalo trên nhiều thiết bị).
    if (typing.fromId && typing.fromId === client.me) return;

    const name = directory.get(typing.threadId)?.name || getThread(typing.threadId)?.name;
    const label = typing.isGroup
      ? "đang nhập…"
      : `${cut(name || typing.fromId, 20)} đang nhập…`;

    const old = typingByThread.get(typing.threadId);
    if (old) clearTimeout(old.timer);

    const entry = {
      label,
      timer: setTimeout(() => {
        typingByThread.delete(typing.threadId);
        if (!shuttingDown) updateHeader();
      }, TYPING_TTL),
    };
    entry.timer.unref?.(); // không giữ process sống khi thoát
    typingByThread.set(typing.threadId, entry);
    updateHeader();
  };

  client.on("message", onMessage);
  client.on("old-messages", onOldMessages);
  client.on("connected", onConnected);
  client.on("closed", onClosed);
  client.on("typing", onTyping);

  // ---- Thoát ------------------------------------------------------------

  const cleanup = () => {
    if (footerTimer) {
      clearInterval(footerTimer);
      footerTimer = null;
    }
    for (const entry of typingByThread.values()) clearTimeout(entry.timer);
    typingByThread.clear();
    client.off("message", onMessage);
    client.off("old-messages", onOldMessages);
    client.off("connected", onConnected);
    client.off("closed", onClosed);
    client.off("typing", onTyping);
  };

  function shutdown(code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    cleanup();
    client.close(); // đóng WebSocket để event loop không bị treo
    renderer.destroy(); // khôi phục terminal
    // `closed` resolve khi terminal đã được trả lại; chờ rồi mới exit.
    Promise.resolve(renderer.closed)
      .catch(() => {})
      .finally(() => process.exit(code));
  }

  // Ctrl+C làm OpenTUI destroy renderer → ta vẫn phải đóng client và exit.
  renderer.once("destroy", () => {
    if (!shuttingDown) shutdown(0);
  });

  // ---- Khởi động --------------------------------------------------------

  online = true; // bin/tui.js đã connect xong trước khi gọi startTui
  updateHeader();
  refreshSidebar();

  // Đồng hồ ở footer cần cập nhật đều, kể cả khi không có tin nhắn.
  footerTimer = setInterval(updateFooter, 1000);

  if (current) {
    openThread(current.threadId);
  } else {
    system("Chào mừng! Tab để mở danh sách hội thoại, hoặc /help để xem lệnh.");
  }

  setFocus("input");
  return { renderer, shutdown };
}
