(() => {
    const storageKey = 'the-watcher-language';
    const knownMessages = {
        'Enter valid subnet prefixes, for example 192.168.0.': 'กรุณากรอก subnet prefix ให้ถูกต้อง เช่น 192.168.0',
        'Start and end must share the same first two octets.': 'Subnet เริ่มต้นและสิ้นสุดต้องมี 2 octet แรกเหมือนกัน',
        'The end subnet must be the same as or after the start subnet.': 'Subnet สิ้นสุดต้องอยู่ลำดับเดียวกันหรือหลัง subnet เริ่มต้น',
        'The scan queue is busy. Please try again shortly.': 'คิวสแกนกำลังทำงาน กรุณาลองอีกครั้งในภายหลัง',
        'Could not load the scan queue.': 'ไม่สามารถโหลดคิวสแกนได้',
        'Could not add the scan range.': 'ไม่สามารถเพิ่มช่วง IP เข้าคิวได้',
        'Could not load scan status.': 'ไม่สามารถโหลดสถานะการสแกนได้',
        'Could not connect to scan status.': 'ไม่สามารถเชื่อมต่อสถานะการสแกนได้',
        'Enter subnet prefixes with the same first two octets. You can add multiple ranges to the queue.': 'กรอก subnet prefix ที่มี 2 octet แรกเหมือนกัน และเพิ่มหลายช่วงเข้าคิวได้',
        'A scan is in progress. New ranges will be added to the queue and scanned in order.': 'กำลังสแกนอยู่ ช่วงใหม่จะถูกเพิ่มในคิวและสแกนตามลำดับ',
        'Adding scan job…': 'กำลังเพิ่มงานสแกน…',
        'Could not add scan range.': 'ไม่สามารถเพิ่มช่วง IP ได้',
        'No active scan job.': 'ไม่มีงานสแกนที่กำลังทำงาน',
        'No scan history yet.': 'ยังไม่มีประวัติงานสแกน',
        'Scanning from the main scanner': 'กำลังสแกนจากตัวสแกนหลัก',
        'A scan is starting': 'กำลังเริ่มการสแกน',
        'Could not connect to scan status.': 'ไม่สามารถเชื่อมต่อสถานะการสแกนได้',
        'This host cannot be previewed.': 'ไม่สามารถแสดงตัวอย่างโฮสต์นี้ได้',
        'No output returned.': 'ไม่มีผลลัพธ์',
        'Nmap request failed.': 'คำขอ Nmap ล้มเหลว',
        'WHOIS lookup failed.': 'ค้นหา WHOIS ไม่สำเร็จ',
        'RTSP request failed.': 'คำขอ RTSP ล้มเหลว',
        'No WHOIS data returned.': 'ไม่พบข้อมูล WHOIS',
        'Failed to fetch': 'เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ'
    };
    const categoryNames = {
        'Default Page': 'หน้าเริ่มต้น',
        'Login Page': 'หน้าเข้าสู่ระบบ',
        'Error Page': 'หน้าแจ้งข้อผิดพลาด',
        'CCTV Page': 'หน้ากล้องวงจรปิด',
        'Directory Listing': 'หน้าแสดงรายการไฟล์',
        'Other Web Page': 'เว็บไซต์ทั่วไป',
        'No Title': 'ไม่มี Title',
        'DEFAULT': 'หน้าเริ่มต้น',
        'CCTV': 'กล้องวงจรปิด',
        'ROUTER': 'เราเตอร์',
        'ERROR': 'ข้อผิดพลาด',
        'DIRECTORY': 'รายการไฟล์',
        'OPEN PORT': 'พอร์ตเปิด',
        'Pornography': 'เนื้อหาสำหรับผู้ใหญ่',
        'Gambling': 'การพนัน',
        'Malware': 'มัลแวร์',
        'Phishing': 'ฟิชชิ่ง',
        'Suspicious': 'น่าสงสัย',
        'Other': 'อื่น ๆ'
    };
    let language = 'en';

    try {
        const stored = localStorage.getItem(storageKey);
        if (stored === 'th' || stored === 'en') language = stored;
    } catch (error) {
        console.warn('Unable to read the saved language preference:', error);
    }
    document.documentElement.lang = language;
    document.documentElement.dataset.language = language;

    function siteTranslate(english, thai, values = {}) {
        const text = language === 'th' ? thai : english;
        return String(text).replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');
    }

    function localizeMessage(message) {
        return language === 'th' ? (knownMessages[message] || message) : message;
    }

    function applySiteLanguage(root = document) {
        document.documentElement.lang = language;
        document.documentElement.dataset.language = language;

        const selector = [
            '[data-en-text]', '[data-th-text]', '[data-category-label]',
            '[data-en-placeholder]', '[data-th-placeholder]',
            '[data-en-title]', '[data-th-title]',
            '[data-en-aria-label]', '[data-th-aria-label]',
            '[data-en-content]', '[data-th-content]'
        ].join(',');
        const elements = [];
        if (root instanceof Element && root.matches(selector)) elements.push(root);
        if (root.querySelectorAll) elements.push(...root.querySelectorAll(selector));

        elements.forEach(element => {
            const languageText = element.getAttribute(`data-${language}-text`);
            const otherText = element.getAttribute(`data-${language === 'en' ? 'th' : 'en'}-text`);
            if (element.hasAttribute('data-category-label')) {
                const category = element.getAttribute('data-category-label');
                element.textContent = language === 'th' ? (categoryNames[category] || category) : category;
            } else if (languageText !== null || otherText !== null) {
                element.textContent = languageText ?? otherText;
            }

            ['placeholder', 'title', 'aria-label', 'content'].forEach(attribute => {
                const currentText = element.getAttribute(`data-${language}-${attribute}`);
                const fallbackText = element.getAttribute(`data-${language === 'en' ? 'th' : 'en'}-${attribute}`);
                if (currentText !== null || fallbackText !== null) {
                    element.setAttribute(attribute, currentText ?? fallbackText);
                }
            });
        });

        document.querySelectorAll('[data-localized-date]').forEach(element => {
            const date = new Date(element.getAttribute('data-localized-date'));
            if (!Number.isNaN(date.getTime())) {
                element.textContent = new Intl.DateTimeFormat(language === 'th' ? 'th-TH' : 'en-US', {
                    dateStyle: 'medium', timeStyle: 'short'
                }).format(date);
            }
        });

        const languageButton = document.querySelector('.language-toggle');
        if (languageButton) {
            languageButton.textContent = language === 'en' ? 'ไทย' : 'EN';
            languageButton.setAttribute('aria-label', siteTranslate('Switch language to Thai', 'เปลี่ยนภาษาเป็นอังกฤษ'));
            languageButton.setAttribute('title', siteTranslate('Switch language to Thai', 'เปลี่ยนภาษาเป็นอังกฤษ'));
        }

        const themeButton = document.querySelector('.theme-toggle');
        if (themeButton) {
            const nextTheme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
            themeButton.setAttribute('aria-label', siteTranslate(
                `Switch to ${nextTheme} theme`,
                nextTheme === 'light' ? 'สลับเป็นธีมสว่าง' : 'สลับเป็นธีมมืด'
            ));
        }
    }

    function setSiteLanguage(nextLanguage) {
        if (nextLanguage !== 'en' && nextLanguage !== 'th') return;
        language = nextLanguage;
        try {
            localStorage.setItem(storageKey, language);
        } catch (error) {
            console.warn('Unable to save the language preference:', error);
        }
        applySiteLanguage();
        document.dispatchEvent(new CustomEvent('site-language-change', { detail: { language } }));
    }

    window.siteTranslate = siteTranslate;
    window.siteLocalizeMessage = localizeMessage;
    window.applySiteLanguage = applySiteLanguage;
    window.siteLanguage = () => language;

    document.addEventListener('click', event => {
        const button = event.target.closest('.language-toggle');
        if (button) setSiteLanguage(language === 'en' ? 'th' : 'en');
    });
    document.addEventListener('DOMContentLoaded', () => applySiteLanguage());
})();
