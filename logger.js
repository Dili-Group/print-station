// logger.js - Ghi log in đơn ra file theo ngày: logs/YYYY-MM-DD.log
const fs = require("fs");
const path = require("path");

const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, "logs");

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return {
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    time: `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`,
  };
}

/**
 * Ghi 1 dòng log in đơn.
 * @param {object} e { status: "OK"|"FAIL", jobId, tracking, url, pages, type, error }
 */
function logPrint(e) {
  const { date, time } = ts();
  const parts = [
    `${date} ${time}`,
    e.status,
    `job=${e.jobId ?? "-"}`,
    `tracking=${e.tracking ?? "-"}`,
    `pages=${e.pages ?? "-"}`,
    `type=${e.type ?? "-"}`,
    `url=${e.url ?? "-"}`,
  ];
  if (e.error) parts.push(`error=${String(e.error).replace(/\r?\n/g, " ")}`);
  const line = parts.join(" | ") + "\n";

  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, `${date}.log`), line, "utf8");
  } catch (err) {
    console.error("Khong ghi duoc log file:", err.message);
  }
  process.stdout.write(line);
}

/**
 * Ghi 1 dòng log chi tiết từng bước in (đo nghẽn). Tắt bằng STEP_LOG=0 trong .env.
 * @param {object} e { tag, step, ms, note }
 */
function logStep(e) {
  if (process.env.STEP_LOG === "0") return;
  const { date, time } = ts();
  const parts = [
    `${date} ${time}`,
    "STEP",
    `tag=${e.tag ?? "-"}`,
    `step=${e.step}`,
    `ms=${e.ms}`,
  ];
  if (e.note) parts.push(String(e.note).replace(/\r?\n/g, " "));
  const line = parts.join(" | ") + "\n";

  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, `${date}.log`), line, "utf8");
  } catch (err) {
    console.error("Khong ghi duoc log file:", err.message);
  }
  process.stdout.write(line);
}

module.exports = { logPrint, logStep, LOG_DIR };
