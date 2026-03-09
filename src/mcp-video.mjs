import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from "child_process";
import { promisify } from "util";
import { readdir, stat, unlink } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DOWNLOADS_DIR = process.env.DOWNLOADS_DIR || join(__dirname, '..', 'downloads');
const BASE_URL = process.env.DOWNLOADS_BASE_URL || '';
const YT_DLP = process.env.YT_DLP_PATH || 'yt-dlp';
const MAX_AGE_DAYS = 7;

const server = new McpServer({
  name: "video-downloader",
  version: "1.0.0",
});

// Tool: Download video
server.tool(
  "download_video",
  "Download a video from a URL (supports YouTube, Bilibili, Douyin, Xiaohongshu, and 1000+ sites). Returns a download link.",
  {
    url: z.string().describe("Video URL to download"),
    format: z
      .enum(["best", "720p", "480p", "audio"])
      .optional()
      .describe("Video quality: best (default), 720p, 480p, or audio-only"),
  },
  async ({ url, format = "best" }) => {
    try {
      // Build yt-dlp arguments
      const timestamp = Date.now();
      const outputTemplate = join(DOWNLOADS_DIR, `${timestamp}-%(title).80s.%(ext)s`);

      const args = [
        "--no-playlist",
        "--restrict-filenames",
        "--no-overwrites",
        "-o", outputTemplate,
        "--print", "after_move:filename",
        "--print", "%(title)s",
        "--print", "%(duration)s",
        "--print", "%(filesize_approx)s",
      ];

      // Format selection
      switch (format) {
        case "720p":
          args.push("-f", "bestvideo[height<=720]+bestaudio/best[height<=720]");
          break;
        case "480p":
          args.push("-f", "bestvideo[height<=480]+bestaudio/best[height<=480]");
          break;
        case "audio":
          args.push("-x", "--audio-format", "mp3");
          break;
        default:
          args.push("-f", "bestvideo[height<=1080]+bestaudio/best[height<=1080]");
          break;
      }

      args.push(url);

      const { stdout, stderr } = await execFileAsync(YT_DLP, args, {
        timeout: 300000, // 5 minutes
        maxBuffer: 10 * 1024 * 1024,
      });

      const lines = stdout.trim().split("\n");
      // yt-dlp prints: filename, title, duration, filesize
      const filepath = lines[0];
      const title = lines[1] || "Unknown";
      const duration = lines[2] || "N/A";
      const filesize = lines[3] || "N/A";

      if (!filepath) {
        return {
          content: [{ type: "text", text: `Download failed. yt-dlp output:\n${stderr || stdout}` }],
          isError: true,
        };
      }

      const filename = filepath.split("/").pop();
      const downloadUrl = `${BASE_URL}/${encodeURIComponent(filename)}`;

      // Get actual file size
      let actualSize = "unknown";
      try {
        const fileStat = await stat(filepath);
        const mb = (fileStat.size / 1024 / 1024).toFixed(1);
        actualSize = `${mb} MB`;
      } catch {}

      const result = {
        title,
        download_url: downloadUrl,
        filename,
        duration: duration !== "NA" ? `${Math.round(Number(duration))}s` : "N/A",
        filesize: actualSize,
        format,
        expires_in: `${MAX_AGE_DAYS} days`,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const msg = err.stderr || err.message;
      return {
        content: [{ type: "text", text: `Download failed: ${msg}` }],
        isError: true,
      };
    }
  }
);

// Tool: List downloads
server.tool(
  "list_downloads",
  "List all downloaded video files with their download links and sizes",
  {},
  async () => {
    try {
      const files = await readdir(DOWNLOADS_DIR);
      if (files.length === 0) {
        return { content: [{ type: "text", text: "No downloaded files." }] };
      }

      const fileInfos = [];
      for (const file of files) {
        const filepath = join(DOWNLOADS_DIR, file);
        const fileStat = await stat(filepath);
        const ageDays = (Date.now() - fileStat.mtimeMs) / (1000 * 60 * 60 * 24);
        fileInfos.push({
          filename: file,
          download_url: `${BASE_URL}/${encodeURIComponent(file)}`,
          size: `${(fileStat.size / 1024 / 1024).toFixed(1)} MB`,
          age: `${Math.round(ageDays)} days`,
          created: fileStat.mtime.toISOString().split("T")[0],
        });
      }

      // Sort by newest first
      fileInfos.sort((a, b) => b.created.localeCompare(a.created));

      return { content: [{ type: "text", text: JSON.stringify(fileInfos, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// Tool: Cleanup old downloads
server.tool(
  "cleanup_downloads",
  "Delete downloaded files older than specified days (default 7 days)",
  {
    older_than_days: z.number().optional().describe("Delete files older than N days (default 7)"),
  },
  async ({ older_than_days = MAX_AGE_DAYS }) => {
    try {
      const files = await readdir(DOWNLOADS_DIR);
      const deleted = [];
      let freedBytes = 0;

      for (const file of files) {
        const filepath = join(DOWNLOADS_DIR, file);
        const fileStat = await stat(filepath);
        const ageDays = (Date.now() - fileStat.mtimeMs) / (1000 * 60 * 60 * 24);

        if (ageDays > older_than_days) {
          freedBytes += fileStat.size;
          await unlink(filepath);
          deleted.push(file);
        }
      }

      const freedMB = (freedBytes / 1024 / 1024).toFixed(1);
      return {
        content: [{
          type: "text",
          text: `Cleaned up ${deleted.length} files, freed ${freedMB} MB.\n${deleted.length > 0 ? "Deleted:\n" + deleted.join("\n") : ""}`,
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("MCP video server failed:", err);
  process.exit(1);
});
