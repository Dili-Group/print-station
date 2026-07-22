#!/usr/bin/env node
// setup.js - scaffold qua npx: `npx github:Dili-Group/print-station [thu-muc]`
// Copy toan bo source tu npm cache vao thu muc dich, npm install, cai pm2 neu thieu.
// Sau do nguoi dung chi can sua .env roi `pm2 start ecosystem.config.cjs`.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const SRC = __dirname; // goi qua npx: day la package da giai nen trong npm cache
const targetName = process.argv[2] || "print-station";
const DEST = path.resolve(process.cwd(), targetName);

// Khong copy vao chinh source (truong hop chay `node setup.js` ngay trong repo)
if (DEST === SRC) {
  console.error("Thu muc dich trung voi thu muc source, chon ten khac: npx github:Dili-Group/print-station <thu-muc>");
  process.exit(1);
}

// File/thu muc khong scaffold sang may tram
const EXCLUDE = new Set(["node_modules", ".git", "logs", "printed.db", ".env", "setup.js", "package-lock.json"]);

if (fs.existsSync(path.join(DEST, "server.js"))) {
  console.error(`"${DEST}" da co print-station. Muon cai lai thi xoa thu muc truoc, hoac chon ten khac.`);
  process.exit(1);
}

console.log(`Copy source -> ${DEST}`);
fs.mkdirSync(DEST, { recursive: true });
for (const entry of fs.readdirSync(SRC)) {
  if (EXCLUDE.has(entry)) continue;
  fs.cpSync(path.join(SRC, entry), path.join(DEST, entry), { recursive: true });
}

// .env: tao tu .env.example, khong bao gio ghi de
const envPath = path.join(DEST, ".env");
if (!fs.existsSync(envPath)) {
  fs.copyFileSync(path.join(DEST, ".env.example"), envPath);
  console.log("Da tao .env tu .env.example - PHAI sua truoc khi chay.");
}

const run = (cmd, args, opts = {}) =>
  // shell:true de tim duoc npm.cmd/pm2.cmd tren Windows
  spawnSync(cmd, args, { stdio: "inherit", shell: true, ...opts });

console.log("\nnpm install...");
const install = run("npm", ["install", "--omit=dev"], { cwd: DEST });
if (install.status !== 0) {
  console.error("npm install loi - kiem tra mang/quyen roi chay lai `npm install` trong thu muc " + DEST);
  process.exit(1);
}

// pm2: cai global neu chua co
const hasPm2 = run("pm2", ["-v"], { stdio: "ignore" }).status === 0;
if (!hasPm2) {
  console.log("\nChua co pm2, cai global...");
  const pm2Install = run("npm", ["install", "-g", "pm2"]);
  if (pm2Install.status !== 0) {
    console.error("Cai pm2 loi (co the thieu quyen). Tu cai: npm install -g pm2");
  }
}

console.log(`
====================================================
Cai dat xong: ${DEST}

Buoc tiep theo:
  1. Sua file .env (CF_ACCESS_AUD, PRINTER_NAME, duong dan Chrome/Sumatra...)
  2. cd ${targetName}
  3. pm2 start ecosystem.config.cjs
  4. pm2 save        (giu process sau khi reboot, kem pm2 startup neu can)

Kiem tra: pm2 logs print-station | curl http://127.0.0.1:9100/health
====================================================`);
