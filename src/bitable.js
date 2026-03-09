const lark = require("@larksuiteoapi/node-sdk");

const OWNER_OPEN_ID = process.env.FEISHU_OWNER_ID || "";

class BitableLogger {
  constructor() {
    this.appToken = process.env.CHAT_LOG_APP_TOKEN || process.env.BITABLE_APP_TOKEN;
    this.tableId = process.env.CHAT_LOG_TABLE_ID || process.env.BITABLE_TABLE_ID;

    if (!this.appToken || !this.tableId) {
      console.warn("[Bitable] Missing config, logging disabled");
      this.enabled = false;
      return;
    }

    this.enabled = true;
    this.client = new lark.Client({
      appId: process.env.FEISHU_APP_ID,
      appSecret: process.env.FEISHU_APP_SECRET,
      appType: lark.AppType.SelfBuild,
      domain: lark.Domain.Feishu,
    });
  }

  /**
   * Grant full_access permission on a Bitable app to the owner.
   * Can be called independently with any Lark client and appToken.
   */
  static async grantAccess(client, appToken) {
    const resp = await client.request({
      method: "POST",
      url: "/open-apis/drive/v1/permissions/" + appToken + "/members",
      params: { type: "bitable", need_notification: false },
      data: {
        member_type: "openid",
        member_id: OWNER_OPEN_ID,
        perm: "full_access",
      },
    });
    return resp;
  }

  /**
   * Create a new Bitable app and grant full_access to the owner.
   * Returns { appToken, url }.
   */
  async createAppAndGrantAccess(name) {
    if (!this.client) {
      throw new Error("[Bitable] Client not initialized");
    }

    // 1. Create the Bitable app
    const res = await this.client.bitable.app.create({
      data: { name },
    });

    if (res.code !== 0) {
      throw new Error(`Failed to create Bitable app: ${res.msg} (code: ${res.code})`);
    }

    const appToken = res.data.app.app_token;
    const url = res.data.app.url;

    // 2. Grant full_access to the owner
    await BitableLogger.grantAccess(this.client, appToken);

    return { appToken, url };
  }

  async logChat({ chatId, userMessage, jarvisReply, responseTime, status, sessionId }) {
    if (!this.enabled) return;

    try {
      await this.client.bitable.appTableRecord.create({
        path: { app_token: this.appToken, table_id: this.tableId },
        data: {
          fields: {
            "时间": Date.now(),
            "群组": chatId,
            "用户消息": userMessage,
            "Jarvis 回复": (jarvisReply || "").substring(0, 5000),
            "响应时间(秒)": responseTime,
            "状态": status,
            "会话ID": sessionId || "",
          },
        },
      });
    } catch (err) {
      // Don't let logging failures affect the main flow
      console.warn("[Bitable] Log failed:", err.message);
    }
  }
}

module.exports = { BitableLogger, OWNER_OPEN_ID };
