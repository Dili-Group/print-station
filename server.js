// server.js - Fastify HTTP agent: nhan lenh in van don qua Cloudflare Tunnel + Access.
// Thay the worker.js (BullMQ/Redis) - may tram khong con giu ket noi outbound dai han.
//
// POST /print body: {
//   url: "https://..."            (bat buoc - link PDF hoac trang HTML van don)
//   tracking_number: "1448830..." (khuyen nghi - khoa chong in trung + log doi soat)
//   force: true                   (tuy chon - IN LAI du da in roi: may hong, thieu giay...)
//   selector: ".label"            (tuy chon - vung can in neu trang la)
//   delayMs: 3000                 (tuy chon - cho them cho trang render cham)
//   printer: "Ten may in"         (tuy chon - in ra may khac may mac dinh)
//   job_id: "..."                 (tuy chon - id message tu Cloudflare Queue, de log doi soat)
// }
require("dotenv").config();
const fastify = require("fastify");
const { printLabel } = require("./printer");
const { logPrint, LOG_DIR } = require("./logger");
const { getPrinted, markPrinted, DB_PATH } = require("./store");
const { notifyPrintError } = require("./notify");

const PORT = Number(process.env.PORT || 9100);
const STATION = process.env.STATION || "kho-bd";

// In tuan tu: thay concurrency:1 cua BullMQ bang promise chain mutex.
// Moi loi goi printLabel phai di qua serialize() de tranh chen tem.
let chain = Promise.resolve();
let pending = 0;
const serialize = (fn) => {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
};

const app = fastify({
  logger: false,
  // printLabel chay Chrome headless 10-30s, job xep hang tuan tu co the lau hon
  // -> tat request timeout, de Cloudflare Worker phia tren tu quyet dinh timeout
  requestTimeout: 0,
});

// Khong verify Access JWT trong app: auth chan het o edge (Cloudflare Access)
// + cloudflared validate JWT truoc khi proxy. Server chi bind 127.0.0.1.

app.get("/health", async () => ({
  ok: true,
  station: STATION,
  printer: process.env.PRINTER_NAME || "SP46 (Copy 1)",
  uptime: Math.round(process.uptime()),
  queued: pending,
}));

app.post("/print", async (req, reply) => {
  const { url, tracking_number, force, selector, delayMs, printer, job_id } = req.body || {};
  if (!url) {
    return reply.code(400).send({ error: "Thieu truong 'url'" });
  }

  // Chong in trung: key = tracking_number, khong co thi dung url
  const key = tracking_number || url;

  pending++;
  try {
    // Toan bo check-dedup + in + markPrinted nam trong serialize() de giu dung
    // semantics concurrency:1 cua worker cu: hai request trung key den cung luc
    // se duoc xu ly lan luot, request sau thay record da in va SKIP.
    return await serialize(async () => {
      const existing = getPrinted(key);
      if (existing && !force) {
        logPrint({
          status: "SKIP",
          jobId: job_id,
          tracking: tracking_number,
          url,
          error: `da in luc ${existing.printed_at} (job ${existing.job_id}). Gui lai voi force:true neu can in lai`,
        });
        return { skipped: true, printed_at: existing.printed_at, tracking_number };
      }

      const result = await printLabel(url, { selector, delayMs, printer });

      // Cloudflare Queues la at-least-once: job co the duoc gui lai du tem da in.
      // markPrinted PHAI hoan tat truoc khi response tra ve - dedup qua store.js
      // la lop chan cuoi cung.
      markPrinted({ key, url, jobId: job_id, pages: result.pages, type: result.type });

      logPrint({
        status: existing ? "REPRINT" : "OK",
        jobId: job_id,
        tracking: tracking_number,
        url,
        pages: result.pages,
        type: result.type,
      });
      return { ...result, tracking_number, reprint: !!existing };
    });
  } catch (err) {
    logPrint({
      status: "FAIL",
      jobId: job_id,
      tracking: tracking_number,
      url,
      error: err.message,
    });
    // final: false - Cloudflare Worker con retry 5 lan, canh bao cuoi cung
    // da chuyen sang DLQ consumer. De true se spam nhom Zalo.
    notifyPrintError({
      tracking: tracking_number,
      jobId: job_id,
      error: err.message,
      final: false,
    });
    return reply.code(500).send({ error: err.message });
  } finally {
    pending--;
  }
});

// SIGTERM/SIGINT (nssm stop dung Ctrl+C tren Windows) -> dong server roi thoat sach
const shutdown = (signal) => {
  console.log(`Nhan ${signal}, dang dong server...`);
  app.close().then(
    () => process.exit(0),
    () => process.exit(0)
  );
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Loi khong bat duoc: log roi tiep tuc chay, khong crash (nssm se khong phai restart)
process.on("uncaughtException", (err) => {
  console.error(`[${new Date().toISOString()}] uncaughtException: ${err.stack || err.message}`);
});
process.on("unhandledRejection", (reason) => {
  const detail = reason instanceof Error ? reason.stack || reason.message : String(reason);
  console.error(`[${new Date().toISOString()}] unhandledRejection: ${detail}`);
});

// BAT BUOC bind 127.0.0.1 - moi truy cap phai di qua cloudflared + Access,
// khong bao gio expose truc tiep ra LAN.
app
  .listen({ port: PORT, host: "127.0.0.1" })
  .then(() => {
    console.log(
      `Print agent "${STATION}" dang nghe 127.0.0.1:${PORT} (qua Cloudflare Tunnel + Access)\n` +
        `May in mac dinh: ${process.env.PRINTER_NAME || "SP46 (Copy 1)"} | Log: ${LOG_DIR}\\YYYY-MM-DD.log | DB: ${DB_PATH}`
    );
  })
  .catch((err) => {
    console.error(`Khong mo duoc port ${PORT}: ${err.message}`);
    process.exit(1);
  });
