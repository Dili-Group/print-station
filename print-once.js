// print-once.js - In thử 1 link không cần Redis:
//   node print-once.js "<link>" [tracking_number]          -> in (bo qua neu da in)
//   node print-once.js "<link>" [tracking_number] --force  -> in lai du da in
//   node print-once.js "<link>" --dry                      -> chi xuat PDF kiem tra, khong in
require("dotenv").config();
const { printLabel } = require("./printer");
const { logPrint } = require("./logger");
const { getPrinted, markPrinted } = require("./store");
const { notifyPrintError } = require("./notify");

const args = process.argv.slice(2);
const url = args[0];
const dry = args.includes("--dry");
const force = args.includes("--force");
const tracking = args.find((a, i) => i > 0 && !a.startsWith("--"));

if (!url) {
  console.error('Cach dung: node print-once.js "<link>" [tracking_number] [--force|--dry]');
  process.exit(1);
}

(async () => {
  if (dry) {
    const r = await printLabel(url, { skipPrint: true });
    console.log(`[DRY] type=${r.type} pages=${r.pages ?? "?"} pdf=${r.pdfPath}`);
    return;
  }

  const key = tracking || url;
  const existing = getPrinted(key);
  if (existing && !force) {
    console.log(`DA IN luc ${existing.printed_at}. Them --force neu muon in lai.`);
    return;
  }

  const r = await printLabel(url);
  markPrinted({ key, url, jobId: "manual", pages: r.pages, type: r.type });
  logPrint({
    status: existing ? "REPRINT" : "OK",
    jobId: "manual",
    tracking,
    url,
    pages: r.pages,
    type: r.type,
  });
})().catch(async (e) => {
  logPrint({ status: "FAIL", jobId: "manual", tracking, url, error: e.message });
  await notifyPrintError({ tracking, jobId: "manual", error: e.message });
  process.exitCode = 1; // không dùng process.exit() - tránh crash libuv khi Chrome đang đóng
});
