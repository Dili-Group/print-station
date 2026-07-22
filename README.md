# VTP Print Worker

Worker BullMQ chạy trên máy in tem: nhận job từ Redis, mỗi job chứa link vận đơn,
tự xử lý và in silent ra máy in nhiệt, ghi log đối soát theo ngày.

Hỗ trợ nhiều dạng URL:

1. **Link PDF trực tiếp** (server trả về `application/pdf`) → tải về in luôn, không cần Chrome
2. **Link Viettel Post** (`digitalize.viettelpost.vn`) → render Chrome, chờ barcode/QR vẽ xong
3. **Link HTML bất kỳ** → render Chrome generic, tự đo khổ nội dung để cắt đúng khổ tem

## Chạy worker

```powershell
cd D:\auto\print-worker
npm start
```

(Node cài tại `D:\auto\node`, đã thêm vào PATH — mở PowerShell mới nếu chưa nhận lệnh `node`.)

## Job data

```js
{
  url: "https://...",              // BẮT BUỘC - link PDF hoặc trang HTML vận đơn
  tracking_number: "144883027115", // khuyến nghị - khóa chống in trùng + log đối soát
  force: true,                     // tuỳ chọn - IN LẠI dù DB ghi đã in (máy hỏng, thiếu giấy)
  selector: ".label",              // tuỳ chọn - vùng cần in nếu trang lạ đo sai khổ
  delayMs: 3000,                   // tuỳ chọn - chờ thêm nếu trang render chậm (mặc định 1500)
  printer: "Ten may in khac"       // tuỳ chọn - in ra máy khác máy mặc định
}
```

## Chống in trùng (SQLite)

Đơn in xong được ghi vào `printed.db` (SQLite, khóa = `tracking_number`, không có thì dùng `url`).
Job đến mà đơn đã in → **bỏ qua**, ghi log `SKIP`. Nhờ vậy dù BullMQ có giao lại job
(mất mạng giữa chừng, worker crash, producer đẩy trùng) tem cũng không in 2 lần.

**Khi tem in hỏng / máy thiếu giấy** — 2 cách in lại:

1. Producer gửi lại job kèm `force: true` → in lại ngay, DB đếm số lần in lại (`reprint_count`), log ghi `REPRINT`.
2. Trên máy in: `node db-tool.js remove <tracking>` rồi gửi job bình thường.

Quản lý sổ đã in:

```powershell
node db-tool.js list               # 50 don gan nhat
node db-tool.js list 2026-07-18    # don in trong ngay
node db-tool.js check 144883027115 # da in chua?
node db-tool.js remove 144883027115
```

## Log đối soát

Mỗi đơn in xong (hoặc lỗi) được ghi 1 dòng vào `logs/YYYY-MM-DD.log` (file mới mỗi ngày):

```
2026-07-18 14:56:08 | OK   | job=12 | tracking=144883027115 | pages=1 | type=html | url=https://...
2026-07-18 14:56:08 | FAIL | job=13 | tracking=144999999999 | pages=- | type=-    | url=https://... | error=Timeout 20s
```

## Cấu hình — file `.env`

| Biến | Ý nghĩa | Mặc định |
|---|---|---|
| `REDIS_HOST` / `REDIS_PORT` | Địa chỉ Redis server | `127.0.0.1:6379` |
| `REDIS_PASSWORD` | Mật khẩu Redis (bỏ trống nếu không có) | |
| `REDIS_TLS` | `1` nếu Redis dùng TLS (Upstash, Redis Cloud…) | `0` |
| `QUEUE_NAME` | Tên queue BullMQ | `print-vandon` |
| `PRINTER_NAME` | Tên máy in trong Windows | `SP46 (Copy 1)` |
| `ALLOWED_HOSTS` | Danh sách host được phép in, phẩy ngăn cách. Bỏ trống = mọi host | (trống) |
| `LOG_DIR` | Thư mục chứa log | `.\logs` |
| `DB_PATH` | File SQLite sổ đơn đã in | `.\printed.db` |
| `PRINT_VERIFY_TIMEOUT_MS` | Job kẹt trong queue quá lâu → coi là máy in lỗi | `15000` |
| `ZALO_BRIDGE_URL` / `ZALO_BRIDGE_KEY` | Endpoint + key của zalo-bridge để báo lỗi | (đã cấu hình) |
| `ZALO_THREAD_ID` / `ZALO_THREAD_TYPE` | Nhóm Zalo nhận thông báo | (đã cấu hình) |
| `NOTIFY_EVERY_FAIL` | `1` = báo Zalo mọi lần lỗi; `0` = chỉ báo khi hết lượt retry | `0` |

## Thông báo Zalo khi in lỗi

Khi job in thất bại, worker gửi tin vào nhóm Zalo (qua zalo-bridge) gồm: mã vận đơn,
lỗi, số lần thử. Mặc định chỉ báo khi **đã hết lượt retry** (`attempts` của producer)
để tránh spam nhóm 3 tin cho cùng 1 đơn — tin cuối ghi rõ "ĐÃ HẾT LƯỢT, cần xử lý tay".
Lỗi khi in thủ công bằng `print-once.js` cũng được báo. Việc gửi Zalo thất bại (mất mạng...)
chỉ ghi console, không ảnh hưởng luồng in.

## Đẩy job từ máy khác (producer)

```js
const { Queue } = require("bullmq");

const queue = new Queue("print-vandon", {
  connection: { host: "IP_REDIS", port: 6379, password: "..." },
});

const tracking = "144883027115";
await queue.add(
  "print",
  {
    url: "https://digitalize.viettelpost.vn/DigitalizePrint/report.do?type=2&bill=...&showPostage=1",
    tracking_number: tracking,
  },
  {
    jobId: `print-${tracking}`, // chống producer đẩy trùng job trong queue
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: 100,
    removeOnFail: 500,
  }
);

// In lại khi tem hỏng/thiếu giấy: đổi jobId + force
await queue.add(
  "print",
  { url: "...", tracking_number: tracking, force: true },
  { jobId: `reprint-${tracking}-${Date.now()}`, attempts: 3 }
);
```

Worker in tuần tự (concurrency 1) để tem không chen nhau; job lỗi được BullMQ retry theo `attempts`.

## In thử 1 link không cần Redis

```powershell
node print-once.js "https://..."          # in that ra may in
node print-once.js "https://..." --dry    # chi xuat PDF de kiem tra, khong in
```

## Phát hiện máy in hỏng / hết giấy

Driver SP46 không tự báo hết giấy (`DetectedErrorState` luôn = 0), nên worker xác minh
bằng hàng đợi in: máy khỏe thì job thoát queue sau 1–2 giây; hết giấy / tắt máy thì job
kẹt lại. Sau khi gửi lệnh in, worker theo dõi queue tối đa `PRINT_VERIFY_TIMEOUT_MS` (15s):

- Job thoát queue → tem đã ra → ghi DB đã in, log `OK`.
- Job kẹt quá 15s → **tự hủy job kẹt** (để lúc lắp giấy lại không nhả tem thừa gây in trùng),
  ném lỗi → log `FAIL`, **không** ghi DB → BullMQ retry theo `attempts`, đơn sẽ được in lại
  khi máy in hoạt động trở lại.

## Cách hoạt động

1. Kiểm tra URL có trả về PDF không (content-type + magic bytes `%PDF`) → nếu có thì in thẳng.
2. Nếu là HTML: `puppeteer-core` mở Chrome headless (dùng Chrome sẵn có của máy), vào link.
   Với Viettel Post thì chờ đến khi barcode + QR vẽ xong bằng JS.
3. Đo kích thước vùng in (`selector` của job → `.mainPrints` → cả trang), đếm số tem,
   xuất PDF mỗi tem 1 trang đúng khổ (~97×149mm) — không còn trang trắng thừa.
4. In silent qua SumatraPDF: `-print-to "<máy in>" -print-settings "fit" -silent`.
5. Ghi log vào `logs/YYYY-MM-DD.log`.

## Chạy tự động khi bật máy (tuỳ chọn)

Tạo shortcut trong thư mục Startup (`shell:startup`) trỏ tới:

```
D:\auto\node\node.exe D:\auto\print-worker\worker.js
```

hoặc dùng Task Scheduler / NSSM nếu muốn chạy như service có tự restart.
