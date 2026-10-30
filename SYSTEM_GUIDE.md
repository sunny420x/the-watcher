# The Watcher Network Scanner — LLM System & Architecture Guide

เอกสารฉบับนี้จัดทำขึ้นเพื่อให้โมเดลภาษา (LLM) หรือนักพัฒนาสามารถอ่านและทำความเข้าใจสถาปัตยกรรม, โครงสร้างไฟล์, ฟังก์ชันการทำงาน (Functions), ฐานข้อมูล (Database Schema), ตลอดจน Data Flow ของโปรเจกต์ **The Watcher Network Scanner** ได้อย่างรวดเร็วและแม่นยำ

---

## 1. Project Overview & Tech Stack

* **ชื่อโปรเจกต์:** The Watcher (Cyberspace Search Engine)
* **วัตถุประสงค์:** สำรวจและทำแผนที่เครือข่าย (Subnet /24 Scanner) สำหรับค้นหาเปิดพอร์ตและบริการ Web (80), SSH (22), FTP (21), RTSP (554) พร้อมสกัด Page Title, วิเคราะห์ประเภทเว็บ, ทำดัชนีสำหรับค้นหา และมีระบบแก้ปัญหา Redirect Titles
* **Runtime:** Node.js (CommonJS `require`)
* **Framework:** Express 5.x
* **Database:** MySQL (MariaDB) ผ่าน `mysql2/promise` (Connection Pool)
* **Template Engine:** EJS (`views/`)
* **External Binaries:** `curl` (สำหรับ fetch หน้าเว็บและตาม redirect), `nmap`, `whois`

---

## 2. Directory Structure

```text
the_watcher_network_scanner/
├── run.js                       # Entry point หลักของระบบ: Scanner, HTTP Server, APIs
├── package.json                 # Dependencies & scripts
├── schema/
│   ├── database.sql             # DDL โครงสร้างตารางฐานข้อมูล
│   └── migrate.js               # Auto-migration system รันตอนเริ่มระบบ
├── views/                       # EJS Template files
│   ├── home.ejs                 # หน้าแรก / ผลการค้นหาด่วน
│   ├── search.ejs               # หน้าผลลัพธ์การค้นหาแบบละเอียด
│   ├── summary.ejs              # หน้ารวมสถิติการสแกน (Summary Dashboard)
│   ├── scan-queue.ejs           # หน้าจัดการและติดตามคิวสแกน Subnet เบื้องหลัง
│   ├── redirects.ejs            # หน้าจัดการ & สแกนใหม่เว็บที่ติด Redirect Titles
│   ├── api.ejs                  # หน้าเอกสาร API สำหรับผู้ใช้ภายนอก
│   ├── error.ejs                # หน้าแสดงข้อผิดพลาด (403/404/500)
│   └── components/
│       ├── navigator.ejs        # Topbar Navigation bar (รองรับ Desktop & Hamburger บน Mobile)
│       ├── search-results.ejs   # Component รายการผลลัพธ์การค้นหา
│       ├── result.ejs           # Component แสดงผลลัพธ์ Host/Port
│       └── welcome-splash.ejs   # Splash screen ต้อนรับ
└── public/                      # Static assets
    ├── css/styles.css           # สไตล์ชีตหลัก (รองรับ Dark/Light theme, Responsive)
    ├── js/
    │   ├── theme.js             # ควบคุมสลับ Dark / Light Mode (localStorage)
    │   ├── language.js          # ควบคุมสลับภาษา ไทย / อังกฤษ (data-en-text, data-th-text)
    │   ├── scan-queue.js        # Polling และควบคุมหน้า Scan Queue
    │   └── redirects.js         # จัดการตาราง, ฟิลเตอร์, Single & Batch Rescan หน้า Redirects
    └── favicon.svg
```

---

## 3. Database Schema Overview

ระบบใช้ตารางหลัก 5 ตารางในฐานข้อมูล MySQL:

| ตาราง | วัตถุประสงค์ |
| :--- | :--- |
| `scan_cache` | เก็บผลการสแกนดิบระดับ Subnet (`ip_range` เช่น `192.168.1`) คอลัมน์ `open_ip`, `open_ssh`, `open_ftp`, `open_rtsp` เก็บเป็น JSON |
| `scan_search_index` | ตารางดัชนีระดับ Host แยกแถว (`host`, `service`, `port`, `title`, `page_size`, `scanned_at`) สำหรับค้นหาแบบ Full-text / LIKE |
| `scan_title_keywords` | ตารางพจนานุกรมคำค้นสำหรับจัดหมวดหมู่เว็บ (`keyword`, `category`, `match_priority`) เช่น Router, CCTV, Login Page |
| `scan_queue_jobs` | จัดการงานคิวสแกน Subnet เบื้องหลัง (`base_prefix`, `start_octet`, `end_octet`, `status: queued\|running\|completed\|failed`) |
| `scan_summary_refresh` | แคชสถิติสรุปภาพรวมทั้งหมด (`summary_json`, `summarized_at`) เพื่อลดโหลด Database |

---

## 4. Key Functions Reference (in `run.js`)

### 4.1 Port & Network Scanning
* **`scanPort(host, port)`**
  * *Signature:* `async function scanPort(host: string, port: number): Promise<boolean>`
  * *Description:* ยิง TCP Socket ด้วย timeout 1,000ms เพื่อเช็คว่าพอร์ตปลายทางเปิดอยู่หรือไม่ คืนค่า `true` หากเชื่อมต่อสำเร็จ
* **`findWebServer(ip)`**
  * *Signature:* `async function findWebServer(ip: string): Promise<object|0>`
  * *Description:* ตรวจสอบพอร์ต 80 หากเปิด จะเรียก `getWebServerTitle(host)` เพื่อดึง title และ page_size
* **`findSSH(ip)` / `findFTP(ip)` / `findRTSP(ip)`**
  * *Description:* ตรวจสอบพอร์ต 22, 21, 554 ตามลำดับ คืนค่า IP host หากเปิด
* **`scanWebServer(ip_range)` / `scanSSH` / `scanFTP` / `scanRTSP`**
  * *Signature:* `async function scanWebServer(ip_range: string): Promise<Array>`
  * *Description:* ยิงสแกนพร้อมกันทั้ง 256 โฮสต์ (`.0` ถึง `.255`) ใน Subnet `/24` โดยใช้ `Promise.all`

---

### 4.2 Web Title & Redirect Resolution Engine (ระบบตาม Redirect)
สร้างขึ้นเพื่อแก้ปัญหาเว็บที่ส่ง Title ชั่วคราว เช่น `Just a moment...` (Cloudflare/WAF) หรือ `Redirecting...`

* **`decodeHtmlEntities(str)`**
  * *Signature:* `function decodeHtmlEntities(str: string): string`
  * *Description:* แปลง HTML entities เช่น `&amp;`, `&#39;`, `&quot;`, `&lt;`, `&gt;`, `&nbsp;`, `&#123;`, `&#x7B;` ให้เป็นข้อความปกติ
* **`isRedirectTitle(title)`**
  * *Signature:* `function isRedirectTitle(title: string): boolean`
  * *Description:* ใช้ Regex ตรวจสอบว่า Title เข้าข่าย Redirect หรือ Placeholder หรือไม่:
    * `Just a moment...` / `Attention Required! | Cloudflare`
    * `Redirecting...` / `Redirecting to...` / `Redirect...`
    * `301 Moved Permanently` / `302 Found` / `307 Temporary` / `308 Permanent`
    * `Document Moved` / `Object Moved` / `Moved Temporarily`
    * `Please wait...` / `Loading...` / `One moment, please...`
* **`extractRedirectUrl(html)`**
  * *Signature:* `function extractRedirectUrl(html: string): string|null`
  * *Description:* สกัด Target URL สำหรับ Redirect จาก 3 แหล่งใน HTML Body:
    1. `<meta http-equiv="refresh" content="...;url=...">`
    2. JavaScript: `window.location.href`, `location.replace()`, `location.assign()`
    3. Fallback Links: `<a href="...">` ในหน้า Redirecting
* **`resolveSafeRedirectUrl(target, baseUrl)`**
  * *Signature:* `function resolveSafeRedirectUrl(target: string, baseUrl: string): string|null`
  * *Description:* รวม relative path เข้ากับ base URL ด้วย `new URL(target, baseUrl)` และกรองเฉพาะโปรโตคอล `http:` หรือ `https:`
* **`fetchPageOnce(targetUrl)`**
  * *Signature:* `function fetchPageOnce(targetUrl: string): Promise<{body, title, page_size, effectiveUrl}>`
  * *Description:* เรียก `curl` พร้อมแฟลก:
    * `-Ls`: ตาม HTTP 3xx redirect อัตโนมัติ
    * `-k`: ข้ามการตรวจ SSL certificate (จำเป็นมากสำหรับ HTTPS ผ่าน IP หรือ Self-signed certs)
    * `-A BROWSER_USER_AGENT`: ปลอม User-Agent เป็น Google Chrome เพื่อไม่ให้ติด WAF Challenge
    * `--write-out`: ดึง `size_download` และ `url_effective`
* **`fetchPageWithRedirectResolution(initialUrl)`**
  * *Signature:* `async function fetchPageWithRedirectResolution(initialUrl: string): Promise<{title, page_size}|null>`
  * *Description:* ตาม Redirect ต่อเนื่องได้สูงสุด 4 hops (`MAX_REDIRECT_HOPS`) โดยเก็บประวัติ `visited` เพื่อป้องกัน infinite loop หากปลายทางได้ Title ที่ไม่ใช่ Redirect จะหยุดและคืนค่าทันที
* **`resolveWebTitleRedirect(target)`**
  * *Signature:* `async function resolveWebTitleRedirect(target: string): Promise<{title, page_size}|null>`
  * *Description:* Helper ฟังก์ชันรับ target host (เช่น `http://192.168.1.1` หรือ IP) เพื่อสแกนและดึง Title หน้าจริงหลัง Redirect
* **`getWebServerTitle(ip)`**
  * *Signature:* `async function getWebServerTitle(ip: string): Promise<{title, page_size}|null>`
  * *Description:* เริ่มต้นด้วย `http://${ip}` หากล้มเหลวจะ fallback ไปลอง `https://${ip}`

---

### 4.3 Task Queue & Background Worker
* **`withExclusiveScan(ip_range, task)`**
  * *Description:* ร้อยคิวการสแกนด้วย `scanTaskChain` เพื่อให้การสแกนแต่ละ Subnet ทำงานทีละงาน (Sequential per range) ป้องกันทรัพยากรล้น
* **`performScan(ip_range)`**
  * *Description:* ทำการรัน `scanWebServer`, `scanSSH`, `scanFTP`, `scanRTSP` พร้อมกันใน Subnet นั้น แล้วบันทึกลง `saveScanCache`
* **`saveScanCache(ip_range, open_ip, open_ssh, open_ftp, open_rtsp)`**
  * *Description:* ตรวจสอบความถูกต้องของข้อมูล, สแกนซ้ำสำหรับรายการ `open_ip` ที่ Title ยังเป็น Redirect, บันทึกลงตาราง `scan_cache` (JSON) และแยกบันทึกทีละแถวลงตาราง `scan_search_index` ภายใต้ Database Transaction
* **`runScanQueueWorker()`**
  * *Description:* Background Worker ตรวจสอบตาราง `scan_queue_jobs` เพื่อหยิบงานสถานะ `queued` หรือ `running` มาประมวลผลทีละ Subnet จนกระทั่งครบช่วงที่กำหนด

---

### 4.4 Web Title Classification
* **`getScanTitleKeywords()`**: ดึงรายการ keyword จาก `scan_title_keywords`
* **`classifyWebTitle(title, keywordRows)`**: ทำการแมป Title เข้ากับหมวดหมู่ตามลำดับ `match_priority` คืนค่าประเภท เช่น `Router`, `CCTV`, `Login page`, หรือ `Other Web Page`

---

## 5. Web Routes & API Endpoints

### 5.1 Frontend Web Pages
* `GET /`: หน้าหลัก ค้นหาโฮสต์และผลลัพธ์
* `GET /search`: หน้ารายการค้นหาและผลลัพธ์แบบละเอียด
* `GET /take-a-walk`: หน้าสุ่มหรือแนะนำการสำรวจ Subnet จาก IP ของผู้ใช้
* `GET /summary`: หน้า Dashboard สรุปยอดรวม IP และสถิติต่างๆ
* `GET /scan-queue`: หน้าติดตามและเพิ่ม Subnet เข้าคิวสแกนเบื้องหลัง
* `GET /redirects`: **หน้าใหม่** จัดการรายการเว็บที่ Title ติด Redirect พร้อมปุ่มสแกนใหม่
* `GET /preview?url=...`: Proxy แสดงหน้าเว็บผ่าน iframe สำหรับโฮสต์ที่มีในแคช

### 5.2 JSON APIs
* `GET /api/search?search=...&service=...&page=...&limit=...`
  * ค้นหาดัชนีโฮสต์ใน `scan_search_index`
* `GET /api/scan-queue`
  * อ่านสถานะคิวสแกนปัจจุบันและประวัติงานย้อนหลัง
* `POST /api/scan-queue`
  * เพิ่มช่วง Subnet เข้าคิวเบื้องหลัง (`start_range`, `end_range`)
* `GET /api/redirects?q=...&category=...&page=...&limit=...`
  * **API ใหม่** ดึงรายการเว็บที่มี Title เข้าข่าย Redirect (`Just a moment...`, `Redirecting...`, `Moved`)
* `POST /api/redirects/rescan`
  * **API ใหม่** สแกนโฮสต์เป้าหมายใหม่ด้วยระบบ Redirect Resolution และอัปเดตฐานข้อมูลทั้ง `scan_search_index` และ `scan_cache` ให้สอดคล้องกัน

---

## 6. Mobile Responsive Navigation
* **Component:** `views/components/navigator.ejs`
* **Breakpoint:** `860px`
* **พฤติกรรม:**
  * หน้าจอ Desktop (> 860px): เมนูลิงก์จะแสดงเรียงในแถวแนวนอน
  * หน้าจอมือถือ (≤ 860px): ยุบเมนูด้านบน และแสดงปุ่ม **Hamburger Icon (☰)** ข้างปุ่มเปลี่ยนภาษาและธีม เมื่อคลิกจะคลี่ Dropdown Drawer จากด้านบนลงมาในแนวตั้ง แสดงปุ่มขนาด 44px แตะง่าย และปิดอัตโนมัติเมื่อกดเลือกลิงก์หรือคลิกนอกพื้นที่

---

## 7. Guidelines for Extending the Codebase
1. **เมื่อเพิ่มการตรวจจับพอร์ตใหม่:** ให้สร้างฟังก์ชัน `find<Service>(ip)` ใน `run.js`, เพิ่มการเรียกใน `performScan()`, และเพิ่มคอลัมน์/โครงสร้างที่เกี่ยวข้องใน `saveScanCache()`.
2. **เมื่อปรับปรุง Title Extraction:** จัดการภายใน `fetchPageWithRedirectResolution` และฟังก์ชันตรวจจับ regex เพื่อคงความเป็นศูนย์กลาง (Single Source of Truth).
3. **เมื่อเพิ่มหน้า Frontend ใหม่:** ดึง `components/navigator.ejs` มาใช้เสมอ เพื่อให้ได้ Topbar, Responsive Hamburger, และตัวสลับภาษา/ธีมโดยอัตโนมัติ.

