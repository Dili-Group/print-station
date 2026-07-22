// printer.js - In vận đơn từ nhiều dạng URL:
//   1. Link PDF trực tiếp  -> tải về, in thẳng qua SumatraPDF (không cần Chrome)
//   2. Link Viettel Post   -> render Chrome, chờ barcode/QR vẽ xong (logic riêng)
//   3. Link HTML bất kỳ    -> render Chrome generic, tự đo khổ nội dung
const puppeteer = require("puppeteer-core");
const { execFile } = require("child_process");
const { promisify } = require("util");
const path = require("path");
const fs = require("fs");
const os = require("os");

const execFileAsync = promisify(execFile);

const CHROME_PATH =
  process.env.CHROME_PATH ||
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const SUMATRA_PATH =
  process.env.SUMATRA_PATH ||
  path.join(process.env.LOCALAPPDATA || "", "SumatraPDF", "SumatraPDF.exe");
const DEFAULT_PRINTER = process.env.PRINTER_NAME || "SP46";
// Giới hạn host được phép in (phẩy ngăn cách). Bỏ trống = cho phép mọi host.
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const PX_PER_MM = 96 / 25.4;

function tmpPdfPath() {
  return path.join(
    os.tmpdir(),
    `label-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pdf`
  );
}

function validateUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`URL khong hop le: ${url}`);
  }
  if (!/^https?:$/.test(u.protocol)) {
    throw new Error(`Chi ho tro http/https: ${url}`);
  }
  if (ALLOWED_HOSTS.length && !ALLOWED_HOSTS.includes(u.hostname.toLowerCase())) {
    throw new Error(`Host khong nam trong ALLOWED_HOSTS: ${u.hostname}`);
  }
  return u;
}

// Sau khi gửi lệnh in bao lâu mà job vẫn kẹt trong queue thì coi là máy in lỗi/hết giấy
const PRINT_VERIFY_TIMEOUT_MS = Number(process.env.PRINT_VERIFY_TIMEOUT_MS || 15000);
// SumatraPDF -silent đôi khi in xong nhưng process không thoát (kẹt handle spooler)
// -> quá hạn thì kill; tem đã ra hay chưa sẽ do vòng verify queue quyết định
const SUMATRA_TIMEOUT_MS = Number(process.env.SUMATRA_TIMEOUT_MS || 30000);
const PS_TIMEOUT_MS = Number(process.env.PS_TIMEOUT_MS || 10000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function psRun(cmd) {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", cmd],
    { windowsHide: true, timeout: PS_TIMEOUT_MS, killSignal: "SIGKILL" }
  );
  return stdout.trim();
}

async function getQueueJobIds(printer) {
  const esc = printer.replace(/'/g, "''");
  const out = await psRun(
    `Get-PrintJob -PrinterName '${esc}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id | ConvertTo-Json`
  ).catch(() => "");
  if (!out) return [];
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function cancelJob(printer, id) {
  const esc = printer.replace(/'/g, "''");
  await psRun(`Remove-PrintJob -PrinterName '${esc}' -ID ${id} -Confirm:$false`).catch(() => {});
}

// Gửi lệnh in rồi XÁC MINH máy in thật sự nhả tem: driver SP46 không báo hết giấy
// (DetectedErrorState luôn 0), nhưng khi hết giấy/tắt máy thì job kẹt lại trong queue.
// Máy khỏe: queue rỗng sau 1-2s. Job kẹt quá PRINT_VERIFY_TIMEOUT_MS -> hủy job + báo lỗi
// (không hủy thì lúc lắp giấy lại job cũ tự nhả ra, gây in trùng với lần retry).
async function printPdfFile(pdfPath, printer) {
  const before = new Set(await getQueueJobIds(printer));

  try {
    await execFileAsync(SUMATRA_PATH, [
      "-print-to", printer,
      "-print-settings", "fit",
      "-silent",
      pdfPath,
    ], { windowsHide: true, timeout: SUMATRA_TIMEOUT_MS, killSignal: "SIGKILL" });
  } catch (err) {
    // Bị kill vì quá SUMATRA_TIMEOUT_MS: job thường đã spool xong từ lâu,
    // để vòng verify bên dưới phán xử. Lỗi khác (file hỏng, sai máy in) thì ném luôn.
    if (!err.killed) throw err;
  }

  // Chờ ngắn cho job kịp xuất hiện trong queue rồi poll nhanh — response trả về
  // ngay khi job thoát queue thay vì đợi trọn nhịp 1s như trước
  await sleep(300);
  const deadline = Date.now() + PRINT_VERIFY_TIMEOUT_MS;
  let stuck = [];
  while (true) {
    const ids = await getQueueJobIds(printer);
    stuck = ids.filter((id) => !before.has(id));
    if (stuck.length === 0) return; // job của mình đã thoát queue -> đã in
    if (Date.now() >= deadline) break;
    await sleep(500);
  }

  for (const id of stuck) await cancelJob(printer, id);
  throw new Error(
    `May in "${printer}" khong nha tem sau ${PRINT_VERIFY_TIMEOUT_MS / 1000}s ` +
    `(het giay / tat may / loi?). Da huy lenh in ket trong queue de tranh in trung.`
  );
}

// Thử tải URL xem có phải PDF trực tiếp không. Trả về đường dẫn file PDF hoặc null.
async function tryFetchDirectPdf(u) {
  let res;
  try {
    res = await fetch(u.href, { redirect: "follow", signal: AbortSignal.timeout(30000) });
  } catch {
    return null; // fetch lỗi thì để Chrome thử render
  }
  if (!res.ok) return null;
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  const isPdf = ct.includes("application/pdf") || u.pathname.toLowerCase().endsWith(".pdf");
  if (!isPdf) {
    res.body?.cancel?.().catch?.(() => {});
    return null;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  // Kiểm tra magic bytes %PDF
  if (buf.length < 4 || buf.subarray(0, 4).toString() !== "%PDF") return null;
  const p = tmpPdfPath();
  fs.writeFileSync(p, buf);
  return p;
}

// Render HTML bằng Chrome, xuất PDF đúng khổ nội dung.
async function renderHtmlToPdf(u, opts) {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu"],
  });
  try {
    const page = await browser.newPage();
    await page.goto(u.href, { waitUntil: "networkidle0", timeout: 60000 });

    const isVtp = u.hostname.toLowerCase().endsWith("viettelpost.vn");
    if (isVtp) {
      // Viettel Post: chờ QR + barcode vẽ xong bằng JS
      await page.waitForFunction(
        () => {
          const qrDone = [...document.querySelectorAll(".qrCode")].every(
            (q) => q.querySelector("svg path, svg rect, canvas, img")
          );
          const barcodeDone = [...document.querySelectorAll(".barcodeTarget")].every(
            (b) => b.querySelector("rect, path") || b.tagName === "IMG"
          );
          return document.body.style.visibility !== "hidden" && qrDone && barcodeDone;
        },
        { timeout: 20000 }
      );
    }
    // Đệm chờ render (font, ảnh, JS khác) - tăng qua job data { delayMs }
    await new Promise((r) => setTimeout(r, opts.delayMs ?? 1500));

    // Chọn vùng cần in: job chỉ định selector > khối tem tự nhận diện > body.
    // .mainPrints = Viettel Post, .label-a6 = digitalize.dilisupplement.com
    const AUTO_SELECTORS = [".mainPrints", ".label-a6"];
    const info = await page.evaluate((selector, autoSelectors, requireLabel) => {
      let els;
      const auto = autoSelectors.find((s) => document.querySelector(s));
      if (selector) {
        els = [...document.querySelectorAll(selector)];
        if (!els.length) return { error: `Khong tim thay selector: ${selector}` };
      } else if (auto) {
        els = [...document.querySelectorAll(auto)];
      } else if (requireLabel) {
        // Host tem đã biết (VTP...) mà không thấy khối tem -> trang lỗi/hết hạn,
        // tuyệt đối không in fallback cả body (sẽ ra tem trắng + ghi DB sai)
        return {
          error:
            "Trang khong co khoi tem (.mainPrints) - link sai hoac het han? " +
            "Noi dung trang: " + document.body.innerText.trim().slice(0, 100),
        };
      } else {
        const b = document.body;
        return {
          count: 1,
          widthPx: Math.max(b.scrollWidth, b.getBoundingClientRect().width),
          heightPx: Math.max(b.scrollHeight, b.getBoundingClientRect().height),
        };
      }
      // page.pdf in từ góc trên-trái trang, nên phải triệt margin/padding đẩy tem
      // lệch khỏi gốc (vd body của trang Next.js có margin)
      document.body.style.margin = "0";
      document.body.style.padding = "0";
      let rect = els[0].getBoundingClientRect();
      if (els.length === 1 && (rect.left > 2 || rect.top > 2)) {
        const el = els[0];
        el.style.position = "absolute";
        el.style.top = "0";
        el.style.left = "0";
        el.style.margin = "0";
        el.style.width = rect.width + "px";
        rect = el.getBoundingClientRect();
      }
      return { count: els.length, widthPx: rect.width, heightPx: rect.height };
    }, opts.selector || null, AUTO_SELECTORS, isVtp);

    if (info.error) throw new Error(info.error);
    if (!info.widthPx || !info.heightPx) {
      throw new Error("Khong do duoc kich thuoc noi dung trang");
    }

    const widthMm = Math.ceil(info.widthPx / PX_PER_MM);
    const heightMm = Math.ceil(info.heightPx / PX_PER_MM);

    const pdfPath = tmpPdfPath();
    await page.pdf({
      path: pdfPath,
      width: `${widthMm}mm`,
      height: `${heightMm}mm`,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      printBackground: true,
      pageRanges: `1-${info.count}`,
    });
    return { pdfPath, pages: info.count, widthMm, heightMm };
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * In vận đơn từ URL (PDF trực tiếp hoặc trang HTML).
 * @param {string} url  Link vận đơn
 * @param {object} opts { selector, delayMs, printer, skipPrint }
 * @returns {Promise<{type: "pdf"|"html", pages: number|null, pdfPath?: string}>}
 */
async function printLabel(url, opts = {}) {
  const u = validateUrl(url);
  const printer = opts.printer || DEFAULT_PRINTER;

  // 1) PDF trực tiếp?
  const directPdf = await tryFetchDirectPdf(u);
  if (directPdf) {
    if (opts.skipPrint) return { type: "pdf", pages: null, pdfPath: directPdf };
    await printPdfFile(directPdf, printer);
    fs.unlink(directPdf, () => {});
    return { type: "pdf", pages: null };
  }

  // 2/3) Render HTML (VTP hoặc generic)
  const r = await renderHtmlToPdf(u, opts);
  if (opts.skipPrint) return { type: "html", pages: r.pages, pdfPath: r.pdfPath };
  await printPdfFile(r.pdfPath, printer);
  fs.unlink(r.pdfPath, () => {});
  return { type: "html", pages: r.pages };
}

module.exports = { printLabel };
