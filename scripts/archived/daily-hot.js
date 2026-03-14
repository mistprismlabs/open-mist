/**
 * 每日热搜爬取脚本
 * 数据源：rebang.today
 * 平台：小红书、微博、抖音
 */

const { chromium } = require("playwright");

const PLATFORMS = ["小红书", "微博", "抖音"];

async function scrapeHot() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  const page = await browser.newPage();
  const results = {};

  await page.goto("https://rebang.today/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(8000);

  for (const platform of PLATFORMS) {
    const clicked = await page.evaluate((name) => {
      const els = document.querySelectorAll("a, span, div, button");
      for (const el of els) {
        if (el.textContent?.trim() === name) {
          el.click();
          return true;
        }
      }
      return false;
    }, platform);

    if (!clicked) {
      results[platform] = { error: "未找到该平台" };
      continue;
    }

    await page.waitForTimeout(4000);

    const items = await page.evaluate(() => {
      const text = document.body.innerText;
      const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
      const hotItems = [];
      let i = 0;
      while (i < lines.length && hotItems.length < 10) {
        const rankMatch = lines[i].match(/^(\d{1,2})$/);
        if (rankMatch) {
          const rank = parseInt(rankMatch[1]);
          if (rank >= 1 && rank <= 20) {
            const title = lines[i + 1] || "";
            let heat = "";
            for (let j = i + 2; j < Math.min(i + 5, lines.length); j++) {
              const heatMatch = lines[j].match(/([\d.]+[万w])/i);
              if (heatMatch) { heat = heatMatch[1]; break; }
              const wbHeat = lines[j].match(/热度值[：:]?([\d,]+)/);
              if (wbHeat) { heat = wbHeat[1]; break; }
            }
            let tag = "";
            for (let j = i + 2; j < Math.min(i + 4, lines.length); j++) {
              if (/^[热新爆沸梗]$/.test(lines[j])) { tag = lines[j]; break; }
            }
            hotItems.push({ rank, title, heat, tag });
          }
        }
        i++;
      }
      return hotItems;
    });

    results[platform] = items;
  }

  await browser.close();
  return results;
}

function formatReport(results) {
  const now = new Date();
  const dateStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;
  let report = `📊 每日热搜报告 | ${dateStr}\n`;
  report += `数据来源：rebang.today\n\n`;

  for (const [platform, items] of Object.entries(results)) {
    const emoji = platform === "小红书" ? "📕" : platform === "微博" ? "🔥" : "🎵";
    report += `${emoji} ${platform} Top 10\n`;
    if (items.error) {
      report += `  ⚠️ ${items.error}\n`;
    } else if (Array.isArray(items)) {
      items.forEach(item => {
        const tagEmoji = item.tag === "爆" ? "💥" : item.tag === "沸" ? "🔥" : item.tag === "新" ? "🆕" : item.tag === "热" ? "🔥" : "";
        const heatStr = item.heat ? ` (${item.heat})` : "";
        report += `  ${item.rank}. ${item.title}${heatStr} ${tagEmoji}\n`;
      });
    }
    report += "\n";
  }
  return report;
}

(async () => {
  try {
    const results = await scrapeHot();
    const report = formatReport(results);
    console.log(report);
  } catch (err) {
    console.error("爬取失败:", err.message);
    process.exit(1);
  }
})();
