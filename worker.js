// worker.js - BullMQ worker: nhận job in vận đơn từ Redis.
// Job data: {
//   url: "https://..."            (bắt buộc - link PDF hoặc trang HTML vận đơn)
//   tracking_number: "1448830..." (khuyến nghị - khóa chống in trùng + log đối soát)
//   force: true                   (tuỳ chọn - IN LẠI dù đã in rồi: máy hỏng, thiếu giấy...)
//   selector: ".label"            (tuỳ chọn - vùng cần in nếu trang lạ)
//   delayMs: 3000                 (tuỳ chọn - chờ thêm cho trang render chậm)
//   printer: "Ten may in"         (tuỳ chọn - in ra máy khác máy mặc định)
// }
require("dotenv").config();
const { Worker } = require("bullmq");
const { printLabel } = require("./printer");
const { logPrint, LOG_DIR } = require("./logger");
const { getPrinted, markPrinted, DB_PATH } = require("./store");
const { notifyPrintError } = require("./notify");

const QUEUE_NAME = process.env.QUEUE_NAME || "print-vandon";

const connection = {
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  password: process.env.REDIS_PASSWORD || undefined,
  ...(process.env.REDIS_TLS === "1" ? { tls: {} } : {}),
  // Redis cloud (Upstash...) hay ngắt kết nối idle -> giữ kết nối sống + tự nối lại
  keepAlive: 30000,
  retryStrategy: (times) => Math.min(times * 1000, 15000), // 1s, 2s... tối đa 15s
  maxRetriesPerRequest: null, // BullMQ bắt buộc: chờ nối lại thay vì fail lệnh sau 20 lần
};

const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const { url, tracking_number, force, selector, delayMs, printer } = job.data || {};
    if (!url) throw new Error("Job thieu truong 'url'");

    // Chống in trùng: key = tracking_number, không có thì dùng url
    const key = tracking_number || url;
    const existing = getPrinted(key);
    if (existing && !force) {
      logPrint({
        status: "SKIP",
        jobId: job.id,
        tracking: tracking_number,
        url,
        error: `da in luc ${existing.printed_at} (job ${existing.job_id}). Gui lai voi force:true neu can in lai`,
      });
      return { skipped: true, printed_at: existing.printed_at, tracking_number };
    }

    const result = await printLabel(url, { selector, delayMs, printer });
    markPrinted({ key, url, jobId: job.id, pages: result.pages, type: result.type });

    logPrint({
      status: existing ? "REPRINT" : "OK",
      jobId: job.id,
      tracking: tracking_number,
      url,
      pages: result.pages,
      type: result.type,
    });
    return { ...result, tracking_number, reprint: !!existing };
  },
  {
    connection,
    concurrency: 1, // in tuần tự, tránh chen tem
  }
);

worker.on("failed", (job, err) => {
  const attempt = job?.attemptsMade ?? 1;
  const maxAttempts = job?.opts?.attempts ?? 1;
  const final = attempt >= maxAttempts;

  logPrint({
    status: "FAIL",
    jobId: job?.id,
    tracking: job?.data?.tracking_number,
    url: job?.data?.url,
    error: `${err.message} (lan thu ${attempt}/${maxAttempts})`,
  });

  // Thông báo Zalo: mặc định chỉ báo khi đã hết lượt retry (tránh spam nhóm);
  // đặt NOTIFY_EVERY_FAIL=1 trong .env nếu muốn báo mọi lần lỗi.
  if (final || process.env.NOTIFY_EVERY_FAIL === "1") {
    notifyPrintError({
      tracking: job?.data?.tracking_number,
      jobId: job?.id,
      error: err.message,
      attempt,
      maxAttempts,
      final,
    });
  }
});
worker.on("error", (err) => {
  // err.message có thể rỗng -> log thêm code/stack để biết loại lỗi
  const detail = err.message || err.code || String(err);
  console.error(`[${new Date().toISOString()}] Worker/Redis loi: ${detail}`);
});

console.log(
  `Worker dang chay - queue "${QUEUE_NAME}" @ ${connection.host}:${connection.port}\n` +
  `May in mac dinh: ${process.env.PRINTER_NAME || "SP46 (Copy 1)"} | Log: ${LOG_DIR}\\YYYY-MM-DD.log | DB: ${DB_PATH}`
);
