/**
 * Cron 每日热搜：爬取 + 发送到飞书
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const { execSync } = require("child_process");
const lark = require("@larksuiteoapi/node-sdk");

const CHAT_ID = "oc_717031729e311f3c62f49a982f25e2c8";

const client = new lark.Client({
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
  appType: lark.AppType.SelfBuild,
  domain: lark.Domain.Feishu,
});

async function main() {
  let report;
  try {
    report = execSync(
      "node " + require("path").join(__dirname, "daily-hot.js"),
      {
        timeout: 120000,
        env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: "/opt/playwright-browsers" },
      }
    ).toString().trim();
  } catch (err) {
    report = "⚠️ 热搜爬取失败：" + err.message;
  }

  if (!report) {
    report = "⚠️ 热搜爬取返回空结果";
  }

  try {
    await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: CHAT_ID,
        content: JSON.stringify({ text: report }),
        msg_type: "text",
      },
    });
    console.log("[Cron] 热搜报告已发送");
  } catch (err) {
    console.error("[Cron] 发送失败:", err.message);
    process.exit(1);
  }
}

main();
