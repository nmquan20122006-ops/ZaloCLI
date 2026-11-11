// src/auth.js
import fs from "node:fs"; //fs = tep he thong
import path from "node:path"; // path = duong dan thu muc
import os from "node:os"; // os = he dieu hanh
import { spawn } from "node:child_process"; // khoi tao mot chuong trinh con
import qrcode from "qrcode-terminal"; // ve Qr len terminal
import { Zalo, LoginQRCallbackEventType } from "zca-js"; // giao tiep voi server zalo

const DIR = path.join(os.homedir(), ".config", "zalo-cli"); // tao DIR = home/.config/zalo-cli (voi linux)
const CRED = path.join(DIR, "credentials.json"); // dat ten cho the ra vao = home/.config/zalo-cli/credentials.json
const QR_PATH = path.join(DIR, "qr.png"); // dat ten cho qr = home/.config/zalo-cli/qr.png

function clearCred() { // xoa phien dang nhap
  fs.rmSync(CRED, { force: true }); // xoa file json
  fs.rmSync(QR_PATH, { force: true }); // xoa qr
}

export function logout() {
  clearCred();
}

function isCred(c) { // check xem 1 cred co hop le khong? 
  return c?.imei && c?.userAgent && c?.cookie; // dam bao co imei, trinh duyet, ma dang nhap
}

async function sayHello(api) { // loi chao dang nhap (bat dong bo)
  const me = await api.fetchAccountInfo(); //doi may chu zalo gui thong tin 
  const p = me.profile; // lay ho so ca nhan
  const name = p.displayName || p.zaloName || p.username; // lay thong tin 
  console.log(`Xin chào người dùng đăng nhập: ${name} (uid ${api.getOwnId()})`); // lay gia tri cua name va id sau do in ra console
}

// Mở ảnh QR bằng trình xem ảnh mặc định của hệ điều hành.
// Không mở được (máy không có GUI, WSL...) thì bỏ qua, đường dẫn vẫn được in ra.
function openFile(file) { // ham mo file 
  // neu os = linux va neu chay o CLI thi return 
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return;

  // gan cmd = cac trinh xu ly tuong ung voi tung he dieu hanh
  const cmd = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "cmd"
    : "xdg-open";

  // xu ly rieng cho window
  const args = process.platform === "win32" ? ["/c", "start", "", file] : [file];
  try {
    // gan child = 1 tien trinh con tach khoi tien trinh cha bo qua toan bo nhap/xuat cua tien trinh con
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    //bat loi an toan
    child.on("error", () => {});
    // cho phep tien trinh cha ket thuc ma khong can tien trinh con ket thuc
    child.unref();
  } catch {
    // không có trình mở ảnh, người dùng tự mở theo đường dẫn
  }
}

export async function login({ force = false } = {}) { // neu goi ham login() -> force = false
                                                      // neu goi ham login({force : true}) -> buoc xoa thong tin
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 }); // tao thu muc cau hinh (cred,qr) mode:0o700 la quyen root 
                                                       // recursive la tao long nhau
  // ZALO_DEBUG=1 để xem log chi tiết quá trình đăng nhập của zca-js
  const zalo = new Zalo({ logging: process.env.ZALO_DEBUG === "1" }); // khoi tao zalo client neu bien moi truong = 1 -> debugging

  // 1. Có cookie cũ thì dùng luôn, khỏi quét QR
  if (!force && fs.existsSync(CRED)) { // neu force = false va file CRED ton tai
    try {
      const cred = JSON.parse(fs.readFileSync(CRED, "utf8")); // thuc hien giai ma JSON (doc file CRED duoi dang utf8)
      if (!isCred(cred)) // kiem tra CRED khong du dieu kien
        throw new Error("thiếu cookie/imei/userAgent"); // -> nem loi
      const api = await zalo.login(cred); // gui thong tin cookies len may chu zalo (doi zalo phan hoi)
      await sayHello(api); // goi ham chao hoi api cua user 
      return api; // tra api va ket thuc ham
    } catch (e) {
      if (e instanceof SyntaxError) { 
        console.error("File credentials.json bị hỏng, quét QR lại...");
      } else {
        console.error("Cookie hết hạn hoặc lỗi đăng nhập, quét QR lại...");
        console.error(`  (${e.message})`);
      }
      clearCred();
    }
  }

  if (force) clearCred(); // neu force = true -> xoa CRED

  // 2. Login QR
  const api = await zalo.loginQR({ qrPath: QR_PATH }, (event) => { // goi dang nhap bang qr cua zalo  (luu QR tam thoi)
                                                                   // va ham callback lang nghe su kien quet Qr
    switch (event.type) {
      case LoginQRCallbackEventType.QRCodeGenerated: // neu da tao qr moi
        console.clear?.(); // xoa man hinh console
        console.log("Quét QR bằng app Zalo: Bên trên góc bên phải → nhấn vào biểu tượng quét QR.");
        //qrcode.generate(event.data.code, { small: true }); // ve truc tiep ra terminal duoi dang man hinh thu nho

        // zca-js KHÔNG tự lưu ảnh khi có callback → phải gọi saveToFile.
        event.actions
          .saveToFile(QR_PATH) // luu ma qr vao thu muc qr
          .then(() => {
            try { fs.chmodSync(QR_PATH, 0o600); // chi cho phep chu so huu quet ma

             } catch {}
            console.log(`\nĐường dẫn ảnh QR: ${QR_PATH}`);
            openFile(QR_PATH); // thuc hien mo file o qr path
          })
          .catch((e) => console.error("Không lưu được ảnh QR:", e.message));
        break;
      case LoginQRCallbackEventType.QRCodeExpired: // su kien het han qr
        console.error("QR hết hạn, đang lấy mã mới...");
        event.actions.retry();
        break;
      case LoginQRCallbackEventType.QRCodeScanned: // su kien da quet qr
        console.log(`Đã quét bởi ${event.data.display_name}. Bấm ĐĂNG NHẬP trên điện thoại...`);
        break;
      case LoginQRCallbackEventType.QRCodeDeclined: // su kien tu choi quet QR
        console.error("Bạn đã từ chối đăng nhập.");
        event.actions.abort();
        break;
      case LoginQRCallbackEventType.GotLoginInfo:
        break; // xử lý bên dưới
    }
  });

  // 3. Lưu credential — đây là "mật khẩu" của bạn
  const ctx = api.getContext();
  const cred = {
    cookie: ctx.cookie.toJSON()?.cookies ?? [],
    imei: ctx.imei,
    userAgent: ctx.userAgent,
  };
  const tmp = `${CRED}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cred, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CRED);
  fs.chmodSync(CRED, 0o600);
  fs.rmSync(QR_PATH, { force: true }); // QR đã dùng xong, không cần giữ

  await sayHello(api);
  return api;
}
