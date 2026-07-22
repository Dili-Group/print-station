// db-tool.js - Quản lý sổ đơn đã in:
//   node db-tool.js list                 -> 50 don in gan nhat
//   node db-tool.js list 2026-07-18      -> don in trong ngay
//   node db-tool.js check <tracking>     -> xem 1 don da in chua
//   node db-tool.js remove <tracking>    -> xoa record de don do in lai duoc nhu moi
const { getPrinted, removePrinted, listPrinted, DB_PATH } = require("./store");

const [cmd, arg] = process.argv.slice(2);

function show(rows) {
  if (!rows.length) return console.log("(khong co don nao)");
  for (const r of rows) {
    console.log(
      `${r.printed_at} | ${r.tracking_number} | pages=${r.pages ?? "-"} | type=${r.type ?? "-"} | job=${r.job_id ?? "-"}` +
      (r.reprint_count ? ` | in lai ${r.reprint_count} lan` : "")
    );
  }
}

switch (cmd) {
  case "list":
    show(listPrinted(arg ? { datePrefix: arg, limit: 1000 } : { limit: 50 }));
    break;
  case "check": {
    if (!arg) return console.error("Thieu tracking number");
    const r = getPrinted(arg);
    console.log(r ? `DA IN luc ${r.printed_at} (job ${r.job_id}, in lai ${r.reprint_count} lan)` : "CHUA IN");
    break;
  }
  case "remove": {
    if (!arg) return console.error("Thieu tracking number");
    console.log(removePrinted(arg) ? `Da xoa ${arg} - don nay se in lai duoc nhu moi` : `Khong tim thay ${arg}`);
    break;
  }
  default:
    console.log(`DB: ${DB_PATH}\nCach dung:\n  node db-tool.js list [YYYY-MM-DD]\n  node db-tool.js check <tracking>\n  node db-tool.js remove <tracking>`);
}
