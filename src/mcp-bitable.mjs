import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as lark from "@larksuiteoapi/node-sdk";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Load .env from jarvis-gateway directory (quiet: suppress stdout noise)
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, "..", ".env"), quiet: true });

const OWNER_OPEN_ID = process.env.FEISHU_OWNER_ID || "";

// Create Lark client (loggerLevel: error to suppress stdout noise)
const client = new lark.Client({
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
  appType: lark.AppType.SelfBuild,
  domain: lark.Domain.Feishu,
  loggerLevel: lark.LoggerLevel.error,
});

/**
 * Grant full_access permission on a Bitable app to the owner.
 */
async function grantAccess(appToken) {
  return await client.request({
    method: "POST",
    url: "/open-apis/drive/v1/permissions/" + appToken + "/members",
    params: { type: "bitable", need_notification: true },
    data: {
      member_type: "openid",
      member_id: OWNER_OPEN_ID,
      perm: "full_access",
    },
  });
}

// Create MCP server
const server = new McpServer({
  name: "feishu",
  version: "1.1.0",
});

// Tool: Parse Bitable URL
server.tool(
  "bitable_parse_url",
  "Extract app_token and table_id from a Feishu Bitable URL",
  { url: z.string().describe("Feishu Bitable URL") },
  async ({ url }) => {
    try {
      // Patterns:
      // https://feishu.cn/base/XXXX
      // https://xxx.feishu.cn/base/XXXX?table=YYYY
      // https://feishu.cn/base/XXXX/table/YYYY
      const appTokenMatch = url.match(/\/base\/([A-Za-z0-9]+)/);
      const tableIdMatch =
        url.match(/[?&]table=([A-Za-z0-9]+)/) ||
        url.match(/\/table\/([A-Za-z0-9]+)/);

      if (!appTokenMatch) {
        return { content: [{ type: "text", text: "Could not extract app_token from URL. Expected format: https://feishu.cn/base/XXXX" }] };
      }

      const result = { app_token: appTokenMatch[1] };
      if (tableIdMatch) result.table_id = tableIdMatch[1];

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error parsing URL: ${err.message}` }], isError: true };
    }
  }
);

// Tool: Create Bitable app
server.tool(
  "bitable_create_app",
  "Create a new Feishu Bitable app and automatically grant the user full_access permissions",
  { name: z.string().describe("Name for the new Bitable app") },
  async ({ name }) => {
    try {
      // 1. Create the Bitable app
      const res = await client.bitable.app.create({
        data: { name },
      });
      if (res.code !== 0) {
        return { content: [{ type: "text", text: `Feishu API error: ${res.msg} (code: ${res.code})` }], isError: true };
      }

      const appToken = res.data.app.app_token;
      const url = res.data.app.url;

      // 2. Grant full_access to the owner
      await grantAccess(appToken);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ app_token: appToken, url }, null, 2),
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error creating Bitable app: ${err.message}` }], isError: true };
    }
  }
);

// Tool: List tables
server.tool(
  "bitable_list_tables",
  "List all tables in a Feishu Bitable app",
  { app_token: z.string().describe("Bitable app token") },
  async ({ app_token }) => {
    try {
      const resp = await client.bitable.appTable.list({ path: { app_token } });
      if (resp.code !== 0) {
        return { content: [{ type: "text", text: `Feishu API error: ${resp.msg} (code: ${resp.code})` }], isError: true };
      }
      const tables = (resp.data?.items || []).map((t) => ({
        table_id: t.table_id,
        name: t.name,
        revision: t.revision,
      }));
      return { content: [{ type: "text", text: JSON.stringify(tables, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error listing tables: ${err.message}` }], isError: true };
    }
  }
);

// Tool: List fields
server.tool(
  "bitable_list_fields",
  "List all fields (columns) in a Bitable table",
  {
    app_token: z.string().describe("Bitable app token"),
    table_id: z.string().describe("Table ID"),
  },
  async ({ app_token, table_id }) => {
    try {
      const resp = await client.bitable.appTableField.list({
        path: { app_token, table_id },
      });
      if (resp.code !== 0) {
        return { content: [{ type: "text", text: `Feishu API error: ${resp.msg} (code: ${resp.code})` }], isError: true };
      }
      const fields = (resp.data?.items || []).map((f) => ({
        field_id: f.field_id,
        field_name: f.field_name,
        type: f.type,
        ui_type: f.ui_type,
      }));
      return { content: [{ type: "text", text: JSON.stringify(fields, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error listing fields: ${err.message}` }], isError: true };
    }
  }
);

// Tool: List records
server.tool(
  "bitable_list_records",
  "Read records from a Bitable table. Supports pagination and filtering.",
  {
    app_token: z.string().describe("Bitable app token"),
    table_id: z.string().describe("Table ID"),
    page_size: z.number().optional().describe("Number of records per page (default 20, max 500)"),
    page_token: z.string().optional().describe("Page token for pagination"),
    filter: z.string().optional().describe("Filter expression, e.g. CurrentValue.[field] = \"value\""),
  },
  async ({ app_token, table_id, page_size, page_token, filter }) => {
    try {
      const params = {
        path: { app_token, table_id },
        params: {},
      };
      if (page_size) params.params.page_size = page_size;
      if (page_token) params.params.page_token = page_token;
      if (filter) params.params.filter = filter;

      const resp = await client.bitable.appTableRecord.list(params);
      if (resp.code !== 0) {
        return { content: [{ type: "text", text: `Feishu API error: ${resp.msg} (code: ${resp.code})` }], isError: true };
      }

      const result = {
        total: resp.data?.total,
        has_more: resp.data?.has_more,
        page_token: resp.data?.page_token,
        records: (resp.data?.items || []).map((r) => ({
          record_id: r.record_id,
          fields: r.fields,
        })),
      };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error listing records: ${err.message}` }], isError: true };
    }
  }
);

// Tool: Create record
server.tool(
  "bitable_create_record",
  "Create a new record in a Bitable table",
  {
    app_token: z.string().describe("Bitable app token"),
    table_id: z.string().describe("Table ID"),
    fields: z.record(z.any()).describe("Field name-value pairs, e.g. {\"Name\": \"Alice\", \"Age\": 30}"),
  },
  async ({ app_token, table_id, fields }) => {
    try {
      const resp = await client.bitable.appTableRecord.create({
        path: { app_token, table_id },
        data: { fields },
      });
      if (resp.code !== 0) {
        return { content: [{ type: "text", text: `Feishu API error: ${resp.msg} (code: ${resp.code})` }], isError: true };
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ record_id: resp.data?.record?.record_id, fields: resp.data?.record?.fields }, null, 2),
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error creating record: ${err.message}` }], isError: true };
    }
  }
);

// Tool: Update record
server.tool(
  "bitable_update_record",
  "Update an existing record in a Bitable table",
  {
    app_token: z.string().describe("Bitable app token"),
    table_id: z.string().describe("Table ID"),
    record_id: z.string().describe("Record ID to update"),
    fields: z.record(z.any()).describe("Field name-value pairs to update"),
  },
  async ({ app_token, table_id, record_id, fields }) => {
    try {
      const resp = await client.bitable.appTableRecord.update({
        path: { app_token, table_id, record_id },
        data: { fields },
      });
      if (resp.code !== 0) {
        return { content: [{ type: "text", text: `Feishu API error: ${resp.msg} (code: ${resp.code})` }], isError: true };
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ record_id: resp.data?.record?.record_id, fields: resp.data?.record?.fields }, null, 2),
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error updating record: ${err.message}` }], isError: true };
    }
  }
);

// ==================== Task API ====================

// Tool: Create task
server.tool(
  "task_create",
  "Create a new task in Feishu. The task will be assigned to the owner.",
  {
    summary: z.string().describe("Task title/summary"),
    description: z.string().optional().describe("Task description (optional)"),
    due_timestamp: z.number().optional().describe("Due date as Unix timestamp in seconds (optional)"),
    due_is_all_day: z.boolean().optional().describe("Whether the due date is all-day (default: true)"),
  },
  async ({ summary, description, due_timestamp, due_is_all_day = true }) => {
    try {
      const data = {
        summary,
        origin: {
          platform_i18n_name: `{"zh_cn": "${process.env.BOT_NAME || 'OpenMist'}", "en_us": "${process.env.BOT_NAME || 'OpenMist'}"}` ,
        },
        collaborator_ids: [OWNER_OPEN_ID],
      };

      if (description) {
        data.description = description;
      }

      if (due_timestamp) {
        data.due = {
          timestamp: String(due_timestamp),
          is_all_day: due_is_all_day,
        };
      }

      const resp = await client.task.task.create({
        params: { user_id_type: "open_id" },
        data,
      });

      if (resp.code !== 0) {
        return { content: [{ type: "text", text: `Feishu API error: ${resp.msg} (code: ${resp.code})` }], isError: true };
      }

      const task = resp.data?.task;
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            task_id: task?.id,
            summary: task?.summary,
            description: task?.description,
            due: task?.due,
            create_time: task?.create_time,
          }, null, 2),
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error creating task: ${err.message}` }], isError: true };
    }
  }
);

// Tool: List tasks
server.tool(
  "task_list",
  "List tasks from Feishu. Returns pending tasks by default.",
  {
    page_size: z.number().optional().describe("Number of tasks per page (default 50, max 100)"),
    page_token: z.string().optional().describe("Page token for pagination"),
  },
  async ({ page_size = 50, page_token }) => {
    try {
      const params = { page_size };
      if (page_token) params.page_token = page_token;

      const resp = await client.task.task.list({
        params,
      });

      if (resp.code !== 0) {
        return { content: [{ type: "text", text: `Feishu API error: ${resp.msg} (code: ${resp.code})` }], isError: true };
      }

      const tasks = (resp.data?.items || []).map((t) => ({
        task_id: t.id,
        summary: t.summary,
        description: t.description,
        due: t.due,
        complete_time: t.complete_time,
        create_time: t.create_time,
      }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            has_more: resp.data?.has_more,
            page_token: resp.data?.page_token,
            tasks,
          }, null, 2),
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error listing tasks: ${err.message}` }], isError: true };
    }
  }
);

// Tool: Complete task
server.tool(
  "task_complete",
  "Mark a task as completed",
  {
    task_id: z.string().describe("Task ID to complete"),
  },
  async ({ task_id }) => {
    try {
      const resp = await client.task.task.complete({
        path: { task_id },
      });

      if (resp.code !== 0) {
        return { content: [{ type: "text", text: `Feishu API error: ${resp.msg} (code: ${resp.code})` }], isError: true };
      }

      return {
        content: [{ type: "text", text: JSON.stringify({ success: true, task_id }, null, 2) }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error completing task: ${err.message}` }], isError: true };
    }
  }
);

// Tool: Delete task
server.tool(
  "task_delete",
  "Delete a task",
  {
    task_id: z.string().describe("Task ID to delete"),
  },
  async ({ task_id }) => {
    try {
      const resp = await client.task.task.delete({
        path: { task_id },
      });

      if (resp.code !== 0) {
        return { content: [{ type: "text", text: `Feishu API error: ${resp.msg} (code: ${resp.code})` }], isError: true };
      }

      return {
        content: [{ type: "text", text: JSON.stringify({ success: true, task_id }, null, 2) }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error deleting task: ${err.message}` }], isError: true };
    }
  }
);

// ==================== Calendar API ====================

// Tool: List calendars
server.tool(
  "calendar_list",
  "List all calendars accessible to the app",
  {},
  async () => {
    try {
      const resp = await client.calendar.calendar.list({});

      if (resp.code !== 0) {
        return { content: [{ type: "text", text: `Feishu API error: ${resp.msg} (code: ${resp.code})` }], isError: true };
      }

      const calendars = (resp.data?.calendar_list || []).map((c) => ({
        calendar_id: c.calendar_id,
        summary: c.summary,
        description: c.description,
        type: c.type,
        role: c.role,
      }));

      return {
        content: [{ type: "text", text: JSON.stringify(calendars, null, 2) }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error listing calendars: ${err.message}` }], isError: true };
    }
  }
);

// Tool: Create calendar event
server.tool(
  "calendar_create_event",
  "Create a new event in a calendar",
  {
    calendar_id: z.string().describe("Calendar ID (use calendar_list to get available calendars)"),
    summary: z.string().describe("Event title"),
    description: z.string().optional().describe("Event description"),
    start_timestamp: z.number().describe("Start time as Unix timestamp in seconds"),
    end_timestamp: z.number().describe("End time as Unix timestamp in seconds"),
    is_all_day: z.boolean().optional().describe("Whether it's an all-day event (default: false)"),
    timezone: z.string().optional().describe("Timezone (default: Asia/Shanghai)"),
  },
  async ({ calendar_id, summary, description, start_timestamp, end_timestamp, is_all_day = false, timezone = "Asia/Shanghai" }) => {
    try {
      const data = {
        summary,
        start_time: {
          timestamp: String(start_timestamp),
          timezone,
        },
        end_time: {
          timestamp: String(end_timestamp),
          timezone,
        },
      };

      if (description) {
        data.description = description;
      }

      // For all-day events, use date format instead of timestamp
      if (is_all_day) {
        const startDate = new Date(start_timestamp * 1000);
        const endDate = new Date(end_timestamp * 1000);
        data.start_time = {
          date: startDate.toISOString().split("T")[0],
        };
        data.end_time = {
          date: endDate.toISOString().split("T")[0],
        };
      }

      const resp = await client.calendar.calendarEvent.create({
        path: { calendar_id },
        data,
      });

      if (resp.code !== 0) {
        return { content: [{ type: "text", text: `Feishu API error: ${resp.msg} (code: ${resp.code})` }], isError: true };
      }

      const event = resp.data?.event;
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            event_id: event?.event_id,
            summary: event?.summary,
            start_time: event?.start_time,
            end_time: event?.end_time,
          }, null, 2),
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error creating event: ${err.message}` }], isError: true };
    }
  }
);

// Tool: List calendar events
server.tool(
  "calendar_list_events",
  "List events from a calendar within a time range",
  {
    calendar_id: z.string().describe("Calendar ID"),
    start_timestamp: z.number().describe("Start of time range as Unix timestamp in seconds"),
    end_timestamp: z.number().describe("End of time range as Unix timestamp in seconds"),
    page_size: z.number().optional().describe("Number of events per page (default 50, max 100)"),
    page_token: z.string().optional().describe("Page token for pagination"),
  },
  async ({ calendar_id, start_timestamp, end_timestamp, page_size = 50, page_token }) => {
    try {
      const params = {
        start_time: String(start_timestamp),
        end_time: String(end_timestamp),
        page_size,
      };
      if (page_token) params.page_token = page_token;

      const resp = await client.calendar.calendarEvent.list({
        path: { calendar_id },
        params,
      });

      if (resp.code !== 0) {
        return { content: [{ type: "text", text: `Feishu API error: ${resp.msg} (code: ${resp.code})` }], isError: true };
      }

      const events = (resp.data?.items || []).map((e) => ({
        event_id: e.event_id,
        summary: e.summary,
        description: e.description,
        start_time: e.start_time,
        end_time: e.end_time,
        status: e.status,
      }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            has_more: resp.data?.has_more,
            page_token: resp.data?.page_token,
            events,
          }, null, 2),
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error listing events: ${err.message}` }], isError: true };
    }
  }
);

// Tool: Delete calendar event
server.tool(
  "calendar_delete_event",
  "Delete an event from a calendar",
  {
    calendar_id: z.string().describe("Calendar ID"),
    event_id: z.string().describe("Event ID to delete"),
  },
  async ({ calendar_id, event_id }) => {
    try {
      const resp = await client.calendar.calendarEvent.delete({
        path: { calendar_id, event_id },
      });

      if (resp.code !== 0) {
        return { content: [{ type: "text", text: `Feishu API error: ${resp.msg} (code: ${resp.code})` }], isError: true };
      }

      return {
        content: [{ type: "text", text: JSON.stringify({ success: true, event_id }, null, 2) }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error deleting event: ${err.message}` }], isError: true };
    }
  }
);

// ==================== Docx (Cloud Document) API ====================

// Tool: Create document
server.tool(
  "docx_create",
  "Create a new Feishu cloud document",
  {
    title: z.string().describe("Document title"),
    folder_token: z.string().optional().describe("Folder token to create the document in (optional, creates in root if not specified)"),
  },
  async ({ title, folder_token }) => {
    try {
      const data = { title };
      if (folder_token) {
        data.folder_token = folder_token;
      }

      const resp = await client.docx.document.create({ data });
      if (resp.code !== 0) {
        return { content: [{ type: "text", text: `Feishu API error: ${resp.msg} (code: ${resp.code})` }], isError: true };
      }

      const doc = resp.data?.document;
      // Grant access to owner
      if (doc?.document_id) {
        await grantAccess(doc.document_id);
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            document_id: doc?.document_id,
            title: doc?.title,
            revision_id: doc?.revision_id,
          }, null, 2),
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error creating document: ${err.message}` }], isError: true };
    }
  }
);

// Tool: Get document content
server.tool(
  "docx_get",
  "Get the content of a Feishu cloud document",
  {
    document_id: z.string().describe("Document ID"),
  },
  async ({ document_id }) => {
    try {
      const resp = await client.docx.document.get({
        path: { document_id },
      });
      if (resp.code !== 0) {
        return { content: [{ type: "text", text: `Feishu API error: ${resp.msg} (code: ${resp.code})` }], isError: true };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            document_id: resp.data?.document?.document_id,
            title: resp.data?.document?.title,
            revision_id: resp.data?.document?.revision_id,
          }, null, 2),
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error getting document: ${err.message}` }], isError: true };
    }
  }
);

// Tool: Get document raw content (as text)
server.tool(
  "docx_raw_content",
  "Get the raw text content of a Feishu cloud document",
  {
    document_id: z.string().describe("Document ID"),
  },
  async ({ document_id }) => {
    try {
      const resp = await client.docx.document.rawContent({
        path: { document_id },
      });
      if (resp.code !== 0) {
        return { content: [{ type: "text", text: `Feishu API error: ${resp.msg} (code: ${resp.code})` }], isError: true };
      }

      return {
        content: [{
          type: "text",
          text: resp.data?.content || "",
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error getting document content: ${err.message}` }], isError: true };
    }
  }
);

// Tool: List document blocks
server.tool(
  "docx_list_blocks",
  "List all blocks in a Feishu cloud document",
  {
    document_id: z.string().describe("Document ID"),
    page_size: z.number().optional().describe("Number of blocks per page (default 500)"),
    page_token: z.string().optional().describe("Page token for pagination"),
  },
  async ({ document_id, page_size = 500, page_token }) => {
    try {
      const params = { path: { document_id }, params: { page_size } };
      if (page_token) params.params.page_token = page_token;

      const resp = await client.docx.documentBlock.list(params);
      if (resp.code !== 0) {
        return { content: [{ type: "text", text: `Feishu API error: ${resp.msg} (code: ${resp.code})` }], isError: true };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            has_more: resp.data?.has_more,
            page_token: resp.data?.page_token,
            items: resp.data?.items,
          }, null, 2),
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error listing blocks: ${err.message}` }], isError: true };
    }
  }
);

// Tool: Create document block (add content)
server.tool(
  "docx_create_block",
  "Add a new block to a Feishu cloud document. Use this to add paragraphs, headings, lists, etc.",
  {
    document_id: z.string().describe("Document ID"),
    block_id: z.string().describe("Parent block ID (use document_id for root level, or a specific block_id)"),
    index: z.number().optional().describe("Index to insert at (-1 for end, default -1)"),
    block_type: z.number().describe("Block type: 2=text, 3=heading1, 4=heading2, 5=heading3, 12=bullet_list, 13=ordered_list, 14=code, 22=callout"),
    content: z.string().describe("Text content for the block"),
  },
  async ({ document_id, block_id, index = -1, block_type, content }) => {
    try {
      // Build the block structure based on type
      const textElements = [{
        text_run: {
          content,
          text_element_style: {},
        },
      }];

      let blockData = {};

      // Map block types to their corresponding structures
      switch (block_type) {
        case 2: // Text paragraph
          blockData = { block_type: 2, text: { elements: textElements, style: {} } };
          break;
        case 3: // Heading 1
          blockData = { block_type: 3, heading1: { elements: textElements, style: {} } };
          break;
        case 4: // Heading 2
          blockData = { block_type: 4, heading2: { elements: textElements, style: {} } };
          break;
        case 5: // Heading 3
          blockData = { block_type: 5, heading3: { elements: textElements, style: {} } };
          break;
        case 12: // Bullet list
          blockData = { block_type: 12, bullet: { elements: textElements, style: {} } };
          break;
        case 13: // Ordered list
          blockData = { block_type: 13, ordered: { elements: textElements, style: {} } };
          break;
        case 14: // Code block
          blockData = { block_type: 14, code: { elements: textElements, style: { language: 1 } } };
          break;
        case 22: // Callout
          blockData = { block_type: 22, callout: { elements: textElements, style: {} } };
          break;
        default:
          blockData = { block_type: 2, text: { elements: textElements, style: {} } };
      }

      const resp = await client.docx.documentBlockChildren.create({
        path: { document_id, block_id },
        params: { document_revision_id: -1 },
        data: {
          children: [blockData],
          index,
        },
      });

      if (resp.code !== 0) {
        return { content: [{ type: "text", text: `Feishu API error: ${resp.msg} (code: ${resp.code})` }], isError: true };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            children: resp.data?.children,
          }, null, 2),
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error creating block: ${err.message}` }], isError: true };
    }
  }
);

// Tool: Batch update document blocks
server.tool(
  "docx_batch_update",
  "Batch update multiple blocks in a Feishu cloud document",
  {
    document_id: z.string().describe("Document ID"),
    requests: z.array(z.object({
      block_id: z.string().describe("Block ID to update"),
      block_type: z.number().describe("Block type"),
      content: z.string().describe("New content"),
    })).describe("Array of update requests"),
  },
  async ({ document_id, requests }) => {
    try {
      const updateRequests = requests.map((req) => {
        const textElements = [{
          text_run: { content: req.content, text_element_style: {} },
        }];

        let updateBlock = {};
        switch (req.block_type) {
          case 2:
            updateBlock = { text: { elements: textElements, style: {} } };
            break;
          case 3:
            updateBlock = { heading1: { elements: textElements, style: {} } };
            break;
          case 4:
            updateBlock = { heading2: { elements: textElements, style: {} } };
            break;
          case 5:
            updateBlock = { heading3: { elements: textElements, style: {} } };
            break;
          default:
            updateBlock = { text: { elements: textElements, style: {} } };
        }

        return {
          block_id: req.block_id,
          update_text_elements: { elements: textElements },
        };
      });

      const resp = await client.docx.documentBlock.batchUpdate({
        path: { document_id },
        params: { document_revision_id: -1 },
        data: { requests: updateRequests },
      });

      if (resp.code !== 0) {
        return { content: [{ type: "text", text: `Feishu API error: ${resp.msg} (code: ${resp.code})` }], isError: true };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            blocks: resp.data?.blocks,
          }, null, 2),
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error batch updating blocks: ${err.message}` }], isError: true };
    }
  }
);

// ==================== Drive (Cloud Storage) API ====================

// Tool: List files in folder
server.tool(
  "drive_list_files",
  "List files in a Feishu Drive folder",
  {
    folder_token: z.string().optional().describe("Folder token (empty for root folder)"),
    page_size: z.number().optional().describe("Number of files per page (default 50)"),
    page_token: z.string().optional().describe("Page token for pagination"),
  },
  async ({ folder_token, page_size = 50, page_token }) => {
    try {
      const params = { params: { page_size } };
      if (folder_token) params.params.folder_token = folder_token;
      if (page_token) params.params.page_token = page_token;

      const resp = await client.drive.file.listFolder(params);
      if (resp.code !== 0) {
        return { content: [{ type: "text", text: `Feishu API error: ${resp.msg} (code: ${resp.code})` }], isError: true };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            has_more: resp.data?.has_more,
            page_token: resp.data?.page_token,
            files: resp.data?.files,
          }, null, 2),
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error listing files: ${err.message}` }], isError: true };
    }
  }
);

// Tool: Create folder
server.tool(
  "drive_create_folder",
  "Create a new folder in Feishu Drive",
  {
    name: z.string().describe("Folder name"),
    folder_token: z.string().optional().describe("Parent folder token (empty for root)"),
  },
  async ({ name, folder_token }) => {
    try {
      const data = { name };
      if (folder_token) data.folder_token = folder_token;

      const resp = await client.drive.file.createFolder({ data });
      if (resp.code !== 0) {
        return { content: [{ type: "text", text: `Feishu API error: ${resp.msg} (code: ${resp.code})` }], isError: true };
      }

      // Grant access
      if (resp.data?.token) {
        await grantAccess(resp.data.token);
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            token: resp.data?.token,
            url: resp.data?.url,
          }, null, 2),
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error creating folder: ${err.message}` }], isError: true };
    }
  }
);

// Tool: Copy file
server.tool(
  "drive_copy_file",
  "Copy a file in Feishu Drive",
  {
    file_token: z.string().describe("Source file token"),
    name: z.string().describe("New file name"),
    type: z.string().describe("File type: doc, sheet, bitable, docx, file"),
    folder_token: z.string().optional().describe("Target folder token"),
  },
  async ({ file_token, name, type, folder_token }) => {
    try {
      const data = { name, type };
      if (folder_token) data.folder_token = folder_token;

      const resp = await client.drive.file.copy({
        path: { file_token },
        data,
      });
      if (resp.code !== 0) {
        return { content: [{ type: "text", text: `Feishu API error: ${resp.msg} (code: ${resp.code})` }], isError: true };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify(resp.data?.file, null, 2),
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error copying file: ${err.message}` }], isError: true };
    }
  }
);

// Tool: Move file
server.tool(
  "drive_move_file",
  "Move a file to another folder in Feishu Drive",
  {
    file_token: z.string().describe("File token to move"),
    type: z.string().describe("File type: doc, sheet, bitable, docx, file"),
    folder_token: z.string().describe("Target folder token"),
  },
  async ({ file_token, type, folder_token }) => {
    try {
      const resp = await client.drive.file.move({
        path: { file_token },
        data: { type, folder_token },
      });
      if (resp.code !== 0) {
        return { content: [{ type: "text", text: `Feishu API error: ${resp.msg} (code: ${resp.code})` }], isError: true };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ success: true, task_id: resp.data?.task_id }, null, 2),
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error moving file: ${err.message}` }], isError: true };
    }
  }
);

// Tool: Delete file
server.tool(
  "drive_delete_file",
  "Delete a file from Feishu Drive",
  {
    file_token: z.string().describe("File token to delete"),
    type: z.string().describe("File type: doc, sheet, bitable, docx, file, folder"),
  },
  async ({ file_token, type }) => {
    try {
      const resp = await client.drive.file.delete({
        path: { file_token },
        params: { type },
      });
      if (resp.code !== 0) {
        return { content: [{ type: "text", text: `Feishu API error: ${resp.msg} (code: ${resp.code})` }], isError: true };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ success: true, task_id: resp.data?.task_id }, null, 2),
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error deleting file: ${err.message}` }], isError: true };
    }
  }
);

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("MCP server failed to start:", err);
  process.exit(1);
});
