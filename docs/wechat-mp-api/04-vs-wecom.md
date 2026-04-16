# 微信公众号 vs 企业微信：开发对比

> 背景：项目已有企业微信机器人（WebSocket 长连接模式），现在调研公众号开发。
> 本文聚焦开发层面的差异，帮助快速理解两者的不同。

---

## 一、架构模式对比

| 维度 | 微信公众号（MP）| 企业微信（WeCom）|
|------|:---:|:---:|
| 消息接收方式 | HTTP 回调（Webhook）| HTTP 回调 **或** WebSocket 长连接 |
| 现有项目实现 | - | WebSocket（与 `openmist.service` 同类的常驻 Node.js 服务架构）|
| 连接方向 | 微信推送→开发者 | 微信推送→开发者 / 开发者主动连接 |
| 是否需要公网 IP | 是（或内网穿透）| 是（HTTP 回调）/ 否（WebSocket 客户端模式）|

**关键差异**：企业微信支持 WebSocket 长连接（开发者主动连到微信服务器），不需要公网 IP 也能收消息。公众号只有 HTTP 回调，必须有公网入口。

---

## 二、URL 验证机制对比

两者均需验证回调 URL，但算法细节不同：

### 微信公众号验证

```
签名 = SHA1(sort([token, timestamp, nonce]).join(''))
```

验证通过后**原样返回 `echostr`**（明文字符串）。

```javascript
// 公众号验证
const hash = crypto.createHash('sha1')
  .update([token, timestamp, nonce].sort().join(''))
  .digest('hex');
if (hash === signature) res.send(echostr);  // 直接返回原始 echostr
```

### 企业微信验证

```
签名 = SHA1(sort([token, timestamp, nonce, echostr_encrypted]).join(''))
```

验证通过后需**先解密 `echostr`**，返回解密后的明文。

```javascript
// 企业微信验证（需额外解密步骤）
const hash = crypto.createHash('sha1')
  .update([token, timestamp, nonce, echostrEncrypted].sort().join(''))
  .digest('hex');
if (hash === msgSignature) {
  const plaintext = aesDecrypt(echostrEncrypted, encodingAESKey);
  res.send(plaintext);  // 返回解密后内容
}
```

**总结**：公众号算法里 `echostr` 不参与签名计算；企业微信里 `echostr`（加密态）参与签名，且返回前必须解密。

---

## 三、消息加密

| | 微信公众号 | 企业微信 |
|--|:---:|:---:|
| 是否强制加密 | 否（可选明文/安全模式）| 是（消息体始终 AES 加密）|
| 加密算法 | AES-256-CBC | AES-256-CBC |
| 密钥长度 | 43 字节 Base64（EncodingAESKey）| 同左 |

开发调试建议公众号用**明文模式**，省去解密步骤。生产环境建议安全模式。

---

## 四、消息格式

两者消息体都是 XML，但字段命名有差异：

### 公众号收到的消息

```xml
<xml>
  <ToUserName><![CDATA[gh_xxxxxx]]></ToUserName>      <!-- 公众号 ID -->
  <FromUserName><![CDATA[oUser_openid]]></FromUserName> <!-- 用户 OpenID -->
  <MsgType><![CDATA[text]]></MsgType>
  <Content><![CDATA[用户消息]]></Content>
  <MsgId>1234567890123456</MsgId>
</xml>
```

### 企业微信收到的消息（解密后）

```xml
<xml>
  <ToUserName><![CDATA[ww_corpid]]></ToUserName>        <!-- 企业微信 Corp ID -->
  <FromUserName><![CDATA[user_userid]]></FromUserName>  <!-- 员工 UserID（非 OpenID）|
  <AgentID>100001</AgentID>                             <!-- 应用 ID（公众号无此字段）-->
  <MsgType><![CDATA[text]]></MsgType>
  <Content><![CDATA[用户消息]]></Content>
  <MsgId>19527218734</MsgId>
</xml>
```

**关键差异**：
- 用户标识：公众号用 `OpenID`（匿名，不同公众号不同），企业微信用 `UserID`（真实工号）
- 企业微信有 `AgentID` 字段（区分是哪个应用）
- 企业微信 `UserID` 可直接对应企业通讯录成员

---

## 五、用户身份识别

| | 微信公众号 | 企业微信 |
|--|:---:|:---:|
| 用户标识 | `OpenID`（每个公众号不同）| `UserID`（企业内唯一，可关联真实员工）|
| 跨应用关联 | `UnionID`（需绑定开放平台）| `UserID` 天然统一 |
| 用户信息 | 需 OAuth 授权才能获取昵称/头像 | 通讯录接口直接查询姓名/部门 |
| 目标用户 | C 端（普通微信用户，匿名）| B 端（企业员工，实名）|

---

## 六、发消息方式对比

| | 微信公众号 | 企业微信 |
|--|:---:|:---:|
| 被动回复 | XML，5 秒内，限一条 | XML，5 秒内，限一条 |
| 主动发消息 | 客服消息 API，48h 限制，每用户每天 100 条 | 应用消息 API，几乎无限制 |
| 群发 | 订阅号每天 1 条，服务号每月 4 条 | 无限制 |
| 消息类型 | 文本/图片/图文/语音/视频/音乐 | 文本/图片/图文/语音/视频/文件/卡片/小程序等 |
| 微信卡片（交互式）| 需对接 H5 页面 | 原生支持图文卡片和 Markdown |

**企业微信优势**：主动推送几乎无限制，对 AI 机器人更友好（可以异步推送，不受 5 秒超时困扰）。

---

## 七、接入成本对比

| | 微信公众号 | 企业微信 |
|--|:---:|:---:|
| 注册 | 需手机号注册，企业需营业执照 | 需企业认证 |
| 测试账号 | 有（公众平台测试账号，全权限）| 有（企业微信测试企业）|
| 公网 IP 要求 | 必须有 | HTTP 回调需要；WebSocket 不需要 |
| 消息加密 | 可选 | 强制 |
| 5 秒超时问题 | 存在，需异步处理 | 同样存在，但可通过主动发消息绕过 |

---

## 八、AI 机器人场景选型建议

### 面向 C 端用户（普通微信用户）→ 选公众号

场景：对外服务，用户不需要企业身份，只要有微信账号就能用。

开发要点：
1. 注册**服务号**（已认证），获取客服消息接口权限
2. 收到消息 → 立即回复"处理中" → 异步调 AI → 通过客服接口推送结果
3. 不需要认证时用重试窗口扩展方案（最多 15 秒窗口）

### 面向 B 端内部员工 → 选企业微信

场景：内部工具、员工助手，用户都在企业通讯录。

开发要点：
1. 创建自建应用
2. HTTP 回调或 WebSocket 长连接（参考现有飞书架构）
3. 可通过应用消息接口无限制主动推送，彻底避免 5 秒超时问题

### 两者都要 → 通过"公众号关联企业微信"

企业微信支持将公众号消息转发到企业微信，或通过客户联系功能统一管理 C 端用户。

---

## 九、与现有飞书机器人架构对比

```
飞书机器人（现有）:
  飞书服务器 <--WebSocket长连接-- openmist.service(Node.js)
  ↓ 收到消息
  Agent SDK → Claude API → 回复

企业微信（支持类似架构）:
  企业微信服务器 <--WebSocket长连接-- bot.service(Node.js)
  ↓ 收到消息
  直接调用 → Claude API → 客服消息接口推送

微信公众号（HTTP 回调，差异最大）:
  用户发消息 → 微信服务器 --HTTP POST--> 开发者服务器（必须公网）
  ↓ 5秒内响应（超时重试）
  异步调 AI → 客服消息接口推送（需已认证服务号）
```

**结论**：公众号的 HTTP 回调模式与飞书/企业微信的 WebSocket 架构差异较大，主要区别：
1. 方向相反：公众号是微信推过来，飞书/企微 WebSocket 是开发者主动连过去
2. 公众号必须有公网 IP（80/443 端口）
3. 公众号的 5 秒超时需要额外设计（而 WebSocket 模式可以随时异步推消息）
