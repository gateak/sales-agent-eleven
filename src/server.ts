import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const app = express();
app.use(express.json());

const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport: StreamableHTTPServerTransport | undefined;

  try {
    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          if (transport) {
            transports[newSessionId] = transport;
          }
        },
      });

      transport.onclose = () => {
        if (transport?.sessionId) {
          delete transports[transport.sessionId];
        }
      };

      const server = new McpServer({
        name: "example-server",
        version: "1.0.0",
      });

      server.registerTool(
        "echo",
        {
          title: "Echo Tool",
          description: "Returns the same text that was provided",
          inputSchema: {
            message: z.string().describe("Text to echo back"),
          },
        },
        async ({ message }) => {
          return {
            content: [
              {
                type: "text",
                text: message,
              },
            ],
          };
        }
      );

      await server.connect(transport);
    } else {
      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: No valid session ID provided",
        },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("Failed to handle /mcp POST request", error);
    res.status(500).json({
      jsonrpc: "2.0",
      error: {
        code: -32001,
        message: "Internal Server Error",
        data: error instanceof Error ? error.message : String(error),
      },
      id: null,
    });
  }
});

const handleSessionRequest = async (
  req: express.Request,
  res: express.Response
) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }

  const transport = transports[sessionId];

  try {
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error(`Failed to handle ${req.method} /mcp request`, error);
    res.status(500).send("Internal Server Error");
  }
};

app.get("/mcp", handleSessionRequest);
app.delete("/mcp", handleSessionRequest);

const port = Number(process.env.PORT ?? 3000);

app.listen(port, () => {
  console.log(`MCP server listening on port ${port}`);
});

