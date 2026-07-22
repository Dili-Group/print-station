// notify.js - Gửi thông báo lỗi in đơn tới nhóm Zalo qua zalo-bridge.
// Cấu hình trong .env: ZALO_BRIDGE_URL, ZALO_BRIDGE_KEY, ZALO_THREAD_ID, ZALO_THREAD_TYPE
const BRIDGE_URL = process.env.ZALO_BRIDGE_URL || "";
const BRIDGE_KEY = process.env.ZALO_BRIDGE_KEY || "";
const THREAD_ID = process.env.ZALO_THREAD_ID || "";
const THREAD_TYPE = process.env.ZALO_THREAD_TYPE || "group";

/**
 * Gửi message tới nhóm Zalo. Không bao giờ throw - lỗi mạng chỉ ghi console,
 * để việc thông báo hỏng không làm hỏng luồng in.
 */
async function notifyZalo(message) {
  if (!BRIDGE_URL || !BRIDGE_KEY || !THREAD_ID) {
    console.warn("Bo qua thong bao Zalo: thieu ZALO_BRIDGE_URL/ZALO_BRIDGE_KEY/ZALO_THREAD_ID trong .env");
    return false;
  }
  try {
    const res = await fetch(BRIDGE_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-dilim-zalo-bridge": BRIDGE_KEY,
      },
      body: JSON.stringify({ threadId: THREAD_ID, threadType: THREAD_TYPE, message }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      console.error(`Thong bao Zalo that bai: HTTP ${res.status} ${await res.text().catch(() => "")}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`Thong bao Zalo that bai: ${err.message}`);
    return false;
  }
}

/** Soạn + gửi thông báo đơn in lỗi. */
async function notifyPrintError({ tracking, jobId, error, attempt, maxAttempts, final }) {
  const lines = [
    "⚠️ IN ĐƠN LỖI",
    `Mã vận đơn: ${tracking || "(không có)"}`,
    `Lỗi: ${error}`,
  ];
  if (attempt != null) {
    lines.push(`Lần thử: ${attempt}/${maxAttempts ?? "?"}${final ? " — ĐÃ HẾT LƯỢT, cần xử lý tay" : ", sẽ tự thử lại"}`);
  }
  if (jobId != null) lines.push(`Job: ${jobId}`);
  return notifyZalo(lines.join("\n"));
}

module.exports = { notifyZalo, notifyPrintError };
