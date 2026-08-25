import http, { IncomingMessage } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { buildServer } from "./server.js";
import { onBufferedRoll } from "./tools/ddbPump.js";
import { summarizeRoll } from "./bridge/ddb-gamelog.js";

// Long-running HTTP MCP server. One process owns the game-log WebSocket pump, so a
// long-lived gem session and prep-time Claude Code can share it: each client's
// `initialize` mints a session + its own McpServer instance, but tool state (the
// pump, the roll buffer) is module-singleton and shared.
//
// GET /events streams captured rolls as SSE — the push alternative to polling
// ddb_poll_rolls, mirroring how the gem consumes roll20-dm-mcp's event stream.

const PORT = Number(process.env.DDB_HTTP_PORT) || 39210;
const HOST = process.env.DDB_HTTP_HOST || "127.0.0.1";
const MAX_BODY_BYTES = 8 * 1024 * 1024;

// Shared-secret bearer token. Auto-generated into .env on first run if not set.
function bootstrapToken(): string {
  const token = randomUUID();
  const envPath = resolve(ROOT, ".env");
  let envContent = "";
  try { envContent = readFileSync(envPath, "utf-8"); } catch {}
  if (!/^DDB_MCP_TOKEN=.+/m.test(envContent)) {
    if (envContent && !envContent.endsWith("\n")) envContent += "\n";
    writeFileSync(envPath, envContent + `DDB_MCP_TOKEN=${token}\n`, "utf-8");
  }
  console.error(
    "\n[ddb-mcp] First-time setup: DDB_MCP_TOKEN generated and saved to .env.\n" +
    "[ddb-mcp] Point clients at this server with header `Authorization: Bearer <token>`.\n",
  );
  process.env.DDB_MCP_TOKEN = token;
  return token;
}

const AUTH_TOKEN = process.env.DDB_MCP_TOKEN || bootstrapToken();
const AUTH_TOKEN_BUF = Buffer.from(AUTH_TOKEN, "utf8");

// DNS-rebinding protection allowlists. A malicious web page could otherwise point
// a victim's browser at http://127.0.0.1:39210 via a rebound DNS name; the MCP
// transport rejects requests whose Host/Origin aren't on these lists.
const ALLOWED_HOSTS = [
  `${HOST}:${PORT}`,
  `localhost:${PORT}`,
  `127.0.0.1:${PORT}`,
];
const ALLOWED_ORIGINS = [
  `http://${HOST}:${PORT}`,
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
];

// Constant-time bearer-token check. Guards the length mismatch up front because
// timingSafeEqual throws on unequal-length buffers.
function isAuthorized(req: IncomingMessage): boolean {
  const header = req.headers["authorization"];
  if (!header || Array.isArray(header)) return false;
  const m = /^Bearer (.+)$/.exec(header);
  if (!m) return false;
  const presented = Buffer.from(m[1], "utf8");
  if (presented.length !== AUTH_TOKEN_BUF.length) return false;
  return timingSafeEqual(presented, AUTH_TOKEN_BUF);
}

const transports: Record<string, StreamableHTTPServerTransport> = {};

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    let aborted = false;
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > MAX_BODY_BYTES) {
        aborted = true;
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (aborted) return;
      if (!data) return resolve(undefined);
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

const httpServer = http.createServer(async (req, res) => {
  if (!req.url) { res.writeHead(404).end("Not found"); return; }

  // SSE stream of captured rolls — the push alternative to polling ddb_poll_rolls.
  if (req.url === "/events") {
    if (!isAuthorized(req)) { res.writeHead(401).end("Unauthorized"); return; }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    res.write(":\n\n"); // handshake comment

    const unsub = onBufferedRoll((roll) => {
      try {
        res.write(`event: roll\ndata: ${JSON.stringify({ ...roll, summary: summarizeRoll(roll.message) })}\n\n`);
      } catch { /* client gone */ }
    });
    const keepaliveInterval = setInterval(() => {
      try { res.write(":keepalive\n\n"); } catch { /* client gone */ }
    }, 30_000);
    req.on("close", () => {
      unsub();
      clearInterval(keepaliveInterval);
    });
    return;
  }

  if (!req.url.startsWith("/mcp")) {
    res.writeHead(404).end("Not found");
    return;
  }

  // Bearer-token gate in front of all MCP handling.
  if (!isAuthorized(req)) {
    res
      .writeHead(401, {
        "Content-Type": "application/json",
        "WWW-Authenticate": "Bearer",
      })
      .end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Unauthorized" },
          id: null,
        }),
      );
    return;
  }

  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  try {
    if (req.method === "POST") {
      const body = await readJsonBody(req);
      let transport = sessionId ? transports[sessionId] : undefined;

      if (!transport) {
        if (!isInitializeRequest(body)) {
          res.writeHead(400, { "Content-Type": "application/json" }).end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32000, message: "Bad Request: no valid session ID provided" },
              id: null,
            }),
          );
          return;
        }

        // New session — create transport + a fresh server bound to it.
        const newTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableDnsRebindingProtection: true,
          allowedHosts: ALLOWED_HOSTS,
          allowedOrigins: ALLOWED_ORIGINS,
          onsessioninitialized: (sid) => {
            transports[sid] = newTransport;
          },
        });
        newTransport.onclose = () => {
          if (newTransport.sessionId) delete transports[newTransport.sessionId];
        };

        const server = buildServer();
        await server.connect(newTransport);
        transport = newTransport;
      }

      await transport.handleRequest(req, res, body);
    } else if (req.method === "GET" || req.method === "DELETE") {
      // GET = open the server→client SSE stream; DELETE = terminate session.
      const transport = sessionId ? transports[sessionId] : undefined;
      if (!transport) {
        res.writeHead(400).end("Invalid or missing session ID");
        return;
      }
      await transport.handleRequest(req, res);
    } else {
      res.writeHead(405).end("Method not allowed");
    }
  } catch (err) {
    console.error("[ddb-mcp http] request error:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        }),
      );
    }
  }
});

httpServer.listen(PORT, HOST, () => {
  // stderr so it never pollutes any stdio JSON-RPC consumer.
  console.error(`[ddb-mcp http] MCP server listening on http://${HOST}:${PORT}/mcp (rolls SSE at /events)`);
});
