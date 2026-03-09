import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import COS from "cos-nodejs-sdk-v5";
import { readFileSync } from "fs";
import { basename } from "path";

const BUCKET = process.env.COS_BUCKET || "";
const REGION = process.env.COS_REGION || 'ap-hongkong';

const cos = new COS({
  SecretId: process.env.COS_SECRET_ID,
  SecretKey: process.env.COS_SECRET_KEY,
});

const server = new McpServer({
  name: "tencent-cos",
  version: "1.0.0",
});

// Tool: Upload file to COS
server.tool(
  "cos_upload",
  "Upload a local file to Tencent COS. Returns the COS key and a pre-signed URL.",
  {
    file_path: z.string().describe("Absolute path of the local file to upload"),
    key: z.string().optional().describe("COS object key (path in bucket). Defaults to media/{filename}"),
  },
  async ({ file_path, key }) => {
    try {
      const fileName = basename(file_path);
      const cosKey = key || `media/${fileName}`;
      const body = readFileSync(file_path);

      await new Promise((resolve, reject) => {
        cos.putObject({
          Bucket: BUCKET,
          Region: REGION,
          Key: cosKey,
          Body: body,
        }, (err, data) => err ? reject(err) : resolve(data));
      });

      const url = await presign(cosKey);
      return { content: [{ type: "text", text: JSON.stringify({ key: cosKey, url }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// Tool: List objects in COS
server.tool(
  "cos_list",
  "List files in Tencent COS bucket, optionally filtered by prefix.",
  {
    prefix: z.string().optional().describe("Filter by prefix (e.g. 'media/', 'sessions/')"),
    max_keys: z.number().optional().describe("Max number of results (default 100)"),
  },
  async ({ prefix, max_keys }) => {
    try {
      const data = await new Promise((resolve, reject) => {
        cos.getBucket({
          Bucket: BUCKET,
          Region: REGION,
          Prefix: prefix || "",
          MaxKeys: max_keys || 100,
        }, (err, data) => err ? reject(err) : resolve(data));
      });

      const files = data.Contents.map(f => ({
        key: f.Key,
        size: formatSize(Number(f.Size)),
        modified: f.LastModified,
      }));
      return { content: [{ type: "text", text: JSON.stringify(files, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// Tool: Generate pre-signed URL
server.tool(
  "cos_presign",
  "Generate a temporary pre-signed URL for a COS object (valid 1 hour by default).",
  {
    key: z.string().describe("COS object key"),
    expires: z.number().optional().describe("URL validity in seconds (default 3600)"),
  },
  async ({ key, expires }) => {
    try {
      const url = await presign(key, expires);
      return { content: [{ type: "text", text: url }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// Tool: Delete object from COS
server.tool(
  "cos_delete",
  "Delete a file from Tencent COS.",
  {
    key: z.string().describe("COS object key to delete"),
  },
  async ({ key }) => {
    try {
      await new Promise((resolve, reject) => {
        cos.deleteObject({
          Bucket: BUCKET,
          Region: REGION,
          Key: key,
        }, (err, data) => err ? reject(err) : resolve(data));
      });
      return { content: [{ type: "text", text: `Deleted: ${key}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// Tool: Download file from COS to local
server.tool(
  "cos_download",
  "Download a file from Tencent COS to local filesystem.",
  {
    key: z.string().describe("COS object key to download"),
    output_path: z.string().describe("Local path to save the file"),
  },
  async ({ key, output_path }) => {
    try {
      await new Promise((resolve, reject) => {
        cos.getObject({
          Bucket: BUCKET,
          Region: REGION,
          Key: key,
          Output: output_path,
        }, (err, data) => err ? reject(err) : resolve(data));
      });
      return { content: [{ type: "text", text: `Downloaded to: ${output_path}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// Helper: generate pre-signed URL
function presign(key, expires = 3600) {
  return new Promise((resolve, reject) => {
    cos.getObjectUrl({
      Bucket: BUCKET,
      Region: REGION,
      Key: key,
      Sign: true,
      Expires: expires,
    }, (err, data) => err ? reject(err) : resolve(data.Url));
  });
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + "B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + "KB";
  return (bytes / 1024 / 1024).toFixed(1) + "MB";
}

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
