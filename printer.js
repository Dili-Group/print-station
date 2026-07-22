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
const { logStep } = require("./logger");

// Đồng hồ đo từng bước: mỗi lần gọi step("ten_buoc") ghi 1 dòng STEP với ms
// trôi qua kể từ bước trước. tag = tracking/job id để lọc log theo đơn.
function makeStep(tag) {
  let last = Date.now();
  return (step, note) => {
    const now = Date.now();
    logStep({ tag, step, ms: now - last, note });
    last = now;
  };
}

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

async function psRun(cmd, timeoutMs = PS_TIMEOUT_MS) {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", cmd],
    { windowsHide: true, timeout: timeoutMs, killSignal: "SIGKILL" }
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
async function printPdfFile(pdfPath, printer, step = () => {}) {
  const before = new Set(await getQueueJobIds(printer));
  step("queue_snapshot", `queue co san ${before.size} job`);

  let sumatraKilled = false;
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
    sumatraKilled = true;
  }
  step("sumatra", sumatraKilled ? `TREO qua ${SUMATRA_TIMEOUT_MS}ms, da kill` : "exit binh thuong");

  // Verify bằng MỘT process PowerShell tự poll bên trong (250ms/nhịp):
  // spawn PowerShell mất ~0.5-1s nên spawn mỗi vòng poll như trước tốn 2-4s/đơn.
  // Script in "CLEAN <polls>" khi queue sạch, "STUCK <polls> <ids>" khi quá hạn.
  const esc = printer.replace(/'/g, "''");
  const beforeList = [...before].join(",");
  const verifyScript =
    `$before = @(${beforeList}); ` +
    `$deadline = (Get-Date).AddMilliseconds(${PRINT_VERIFY_TIMEOUT_MS}); ` +
    `$polls = 0; ` +
    `while ($true) { ` +
    `$ids = @(Get-PrintJob -PrinterName '${esc}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id); ` +
    `$polls++; ` +
    `$stuck = @($ids | Where-Object { $before -notcontains $_ }); ` +
    `if ($stuck.Count -eq 0) { Write-Output ('CLEAN ' + $polls); exit 0 } ` +
    `if ((Get-Date) -ge $deadline) { Write-Output ('STUCK ' + $polls + ' ' + ($stuck -join ',')); exit 0 } ` +
    `Start-Sleep -Milliseconds 250 }`;

  let out = "";
  try {
    out = await psRun(verifyScript, PRINT_VERIFY_TIMEOUT_MS + PS_TIMEOUT_MS);
  } catch (err) {
    throw new Error(`Khong verify duoc queue may in "${printer}": ${err.message}`);
  }

  if (out.startsWith("CLEAN")) {
    step("verify_queue", `queue sach sau ${out.split(" ")[1]} lan poll`);
    return; // job của mình đã thoát queue -> đã in
  }

  const [, polls, idList] = out.split(" ");
  const stuck = (idList || "").split(",").map(Number).filter(Number.isFinite);
  step("verify_queue", `KET ${stuck.length} job sau ${polls} lan poll -> huy`);
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

// Chrome sống dai giữa các job: launch lạnh mất ~1.5-3s/đơn nên chỉ launch 1 lần,
// job sau tái dùng. Chrome crash/bị kill -> connected=false -> tự launch lại.
let browserPromise = null;
async function getBrowser() {
  if (browserPromise) {
    try {
      const b = await browserPromise;
      if (b.connected) return b;
    } catch {
      // launch trước đó fail -> thử lại bên dưới
    }
    browserPromise = null;
  }
  browserPromise = puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu"],
  });
  try {
    return await browserPromise;
  } catch (err) {
    browserPromise = null;
    throw err;
  }
}

// Render HTML bằng Chrome, xuất PDF đúng khổ nội dung.
async function renderHtmlToPdf(u, opts, step = () => {}) {
  const browser = await getBrowser();
  step("chrome_ready");
  const page = await browser.newPage();
  try {
    const isVtp = u.hostname.toLowerCase().endsWith("viettelpost.vn");
    // VTP: chỉ cần DOM + script chạy, phần barcode đã có waitForFunction riêng lo.
    // Host lạ: networkidle2 (nhanh hơn networkidle0, không kẹt vì analytics/polling).
    await page.goto(u.href, {
      waitUntil: isVtp ? "domcontentloaded" : "networkidle2",
      timeout: 60000,
    });
    step("page_goto", isVtp ? "domcontentloaded" : "networkidle2");

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
      step("vtp_wait_barcode");
    }
    // Đệm chờ render (font, ảnh, JS khác) - tăng qua job data { delayMs }.
    // VTP đã chờ barcode/QR xong ở trên nên chỉ cần đệm ngắn.
    const delayMs = opts.delayMs ?? (isVtp ? 300 : 1500);
    await new Promise((r) => setTimeout(r, delayMs));
    step("render_delay", `delayMs=${delayMs}`);

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
    step("pdf_export", `${info.count} trang, ${widthMm}x${heightMm}mm`);
    return { pdfPath, pages: info.count, widthMm, heightMm };
  } finally {
    // Chỉ đóng page, giữ browser sống cho job sau
    await page.close().catch(() => {});
    step("page_close");
  }
}

/**
 * In vận đơn từ URL (PDF trực tiếp hoặc trang HTML).
 * @param {string} url  Link vận đơn
 * @param {object} opts { selector, delayMs, printer, skipPrint }
 * @returns {Promise<{type: "pdf"|"html", pages: number|null, pdfPath?: string}>}
 */
// Host chắc chắn trả HTML (không bao giờ là PDF trực tiếp) -> khỏi probe, đỡ 0.5-1s
const KNOWN_HTML_HOST_SUFFIXES = ["viettelpost.vn", "digitalize.dilisupplement.com"];
function isKnownHtmlHost(u) {
  const h = u.hostname.toLowerCase();
  return (
    !u.pathname.toLowerCase().endsWith(".pdf") &&
    KNOWN_HTML_HOST_SUFFIXES.some((s) => h === s || h.endsWith("." + s))
  );
}

async function printLabel(url, opts = {}) {
  const u = validateUrl(url);
  const printer = opts.printer || DEFAULT_PRINTER;
  const step = makeStep(opts.tag);

  // 1) PDF trực tiếp? Host đã biết là HTML thì bỏ probe; host lạ thì probe
  //    song song với việc dựng sẵn Chrome (đằng nào cũng cần 1 trong 2)
  let directPdf = null;
  if (isKnownHtmlHost(u)) {
    step("fetch_direct_pdf", "host HTML da biet -> bo probe");
  } else {
    getBrowser().catch(() => {}); // warm Chrome song song; lỗi thật sẽ nổi ở renderHtmlToPdf
    directPdf = await tryFetchDirectPdf(u);
    step("fetch_direct_pdf", directPdf ? "la PDF truc tiep" : "khong phai PDF -> render Chrome");
  }
  if (directPdf) {
    if (opts.skipPrint) return { type: "pdf", pages: null, pdfPath: directPdf };
    await printPdfFile(directPdf, printer, step);
    fs.unlink(directPdf, () => {});
    return { type: "pdf", pages: null };
  }

  // 2/3) Render HTML (VTP hoặc generic)
  const r = await renderHtmlToPdf(u, opts, step);
  if (opts.skipPrint) return { type: "html", pages: r.pages, pdfPath: r.pdfPath };
  await printPdfFile(r.pdfPath, printer, step);
  fs.unlink(r.pdfPath, () => {});
  return { type: "html", pages: r.pages };
}

// Đóng Chrome sống dai - cần cho script chạy 1 lần (print-once) để process thoát được
async function closeBrowser() {
  if (!browserPromise) return;
  const p = browserPromise;
  browserPromise = null;
  try {
    const b = await p;
    await b.close();
  } catch {
    // Chrome đã chết sẵn thì thôi
  }
}

module.exports = { printLabel, closeBrowser };
