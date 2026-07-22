// store.js - SQLite lưu đơn đã in (chống in trùng). Dùng node:sqlite có sẵn của Node 24.
const { DatabaseSync } = require("node:sqlite");
const path = require("path");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "printed.db");

const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS printed_orders (
    tracking_number TEXT PRIMARY KEY,
    url             TEXT,
    job_id          TEXT,
    pages           INTEGER,
    type            TEXT,
    printed_at      TEXT NOT NULL,
    reprint_count   INTEGER NOT NULL DEFAULT 0
  )
`);

function now() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Trả về record nếu đơn đã in, ngược lại undefined. Key = tracking_number (hoặc url nếu không có tracking). */
function getPrinted(key) {
  return db
    .prepare("SELECT * FROM printed_orders WHERE tracking_number = ?")
    .get(key);
}

/** Ghi nhận đơn đã in. Nếu đã tồn tại (in lại bằng force) thì tăng reprint_count. */
function markPrinted({ key, url, jobId, pages, type }) {
  db.prepare(`
    INSERT INTO printed_orders (tracking_number, url, job_id, pages, type, printed_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(tracking_number) DO UPDATE SET
      url = excluded.url,
      job_id = excluded.job_id,
      pages = excluded.pages,
      type = excluded.type,
      printed_at = excluded.printed_at,
      reprint_count = reprint_count + 1
  `).run(key, url ?? null, jobId != null ? String(jobId) : null, pages ?? null, type ?? null, now());
}

/** Xóa record để đơn có thể in lại như mới. Trả về true nếu có record bị xóa. */
function removePrinted(key) {
  const r = db.prepare("DELETE FROM printed_orders WHERE tracking_number = ?").run(key);
  return r.changes > 0;
}

/** Danh sách đơn đã in, mới nhất trước. datePrefix dạng "2026-07-18" để lọc theo ngày. */
function listPrinted({ datePrefix, limit = 50 } = {}) {
  if (datePrefix) {
    return db
      .prepare("SELECT * FROM printed_orders WHERE printed_at LIKE ? ORDER BY printed_at DESC LIMIT ?")
      .all(`${datePrefix}%`, limit);
  }
  return db
    .prepare("SELECT * FROM printed_orders ORDER BY printed_at DESC LIMIT ?")
    .all(limit);
}

module.exports = { getPrinted, markPrinted, removePrinted, listPrinted, DB_PATH };
