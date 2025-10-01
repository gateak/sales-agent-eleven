import "dotenv/config";
import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const HARDCODED_TO_EMAIL = "akbargate@gmail.com";

const openaiApiKey = process.env.OPENAI_API_KEY;
const sendgridApiKey = process.env.SENDGRID_API_KEY;
const sendgridFrom = process.env.SENDGRID_FROM_EMAIL;

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type RequestOpenAIOptions = {
  model?: string;
  temperature?: number;
};

type SendEmailArgs = {
  to: string;
  from: string;
  subject: string;
  text: string;
};

const SaveMeetingInputSchema = z.object({
  company: z.string().min(1, "company is required"),
  contacts: z
    .array(
      z.object({
        name: z.string().min(1, "contact name is required"),
        role: z.string().optional(),
      })
    )
    .optional(),
  companyProductsOrServices: z.string().optional(),
  rolesHiring: z.array(z.string().min(1)).optional(),
  budget: z.string().optional(),
  problemsOrPainPoints: z.array(z.string().min(1)).optional(),
  objections: z.array(z.string().min(1)).optional(),
  competition: z.array(z.string().min(1)).optional(),
  promises: z.array(z.string().min(1)).optional(),
  timeline: z.string().optional(),
  toneOrSentiment: z.string().optional(),
  keyQuotes: z.array(z.string().min(1)).optional(),
  nextSteps: z.array(z.string().min(1)).optional(),
  summary: z.string().min(1, "summary is required"),
  repName: z.string().min(1, "repName is required"),
});

function buildSystemPrompt(): string {
  return [
    "You write crisp, executive-ready stakeholder update emails.",
    "Given ONLY a JSON object describing a sales meeting recap, draft an email update.",
    "Infer reasonable context from what is present; do not ask questions.",
    'If no name is provided for the email signature, sign as "sales agent".',
    "Output requirements:",
    '- Start with a single line: "Subject: <concise subject>"',
    "- Then the email body, ready to copy-paste to stakeholders",
    "- Be succinct, structured with short paragraphs and bullets where helpful",
    "- Neutral-professional tone; no placeholders; no code fences; no backticks; no commentary",
  ].join(" ");
}

function buildUserContentFromJson(input: unknown): string {
  return [
    "JSON recap follows. Use it verbatim; do not require specific fields.\n\n",
    "JSON:",
    "```json",
    JSON.stringify(input, null, 2),
    "```",
  ].join("\n");
}

async function requestOpenAIChat(
  messages: ChatMessage[],
  options: RequestOpenAIOptions = {}
): Promise<unknown> {
  if (!openaiApiKey) {
    console.warn("OPENAI_API_KEY not set; skipping OpenAI request.");
    return {};
  }

  const { model = "gpt-4o-mini", temperature = 0.3 } = options;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, temperature, messages }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const error = new Error(`OpenAI chat request failed: ${response.status}`);
    (error as Error & { details?: string }).details = text;
    throw error;
  }

  return response.json();
}

async function draftStakeholderEmailFromJson(input: unknown): Promise<string> {
  try {
    const systemPrompt = buildSystemPrompt();
    const userContent = buildUserContentFromJson(input);

    const data = await requestOpenAIChat([
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ]);

    const email =
      (data as any)?.choices?.[0]?.message?.content !== undefined
        ? String((data as any).choices[0].message.content).trim()
        : "";

    return email;
  } catch (error) {
    console.error("Error calling OpenAI chat API:", error);
    return "";
  }
}

async function sendEmail({ to, from, subject, text }: SendEmailArgs): Promise<void> {
  if (!sendgridApiKey || !sendgridFrom) {
    console.warn("SendGrid environment variables not set; skipping email send.");
    return;
  }

  const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${sendgridApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [
        {
          to: [{ email: to }],
        },
      ],
      from: { email: from },
      subject,
      content: [
        {
          type: "text/plain",
          value: text,
        },
      ],
    }),
  });

  if (!response.ok) {
    const textResponse = await response.text().catch(() => "");
    const error = new Error(`SendGrid request failed: ${response.status}`);
    (error as Error & { details?: string }).details = textResponse;
    throw error;
  }
}

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
        "SaveMeeting",
        {
          title: "Save Meeting Recap",
          description: "Save a structured recap of a sales meeting and optionally email stakeholders.",
          inputSchema: SaveMeetingInputSchema.shape,
        },
        async (rawInput) => {
          const input = SaveMeetingInputSchema.parse(rawInput);

          console.log("SaveMeeting payload:", JSON.stringify(input, null, 2));

          try {
            const email = await draftStakeholderEmailFromJson(input);
            console.log("Drafted stakeholder email:", email);

            let subject = "";
            let body = email || "";

            if (email) {
              const lines = email.split(/\r?\n/);
              const firstLine = lines[0] ?? "";
              const match = firstLine.match(/^Subject:\s*(.*)$/i);
              if (match) {
                subject = match[1].trim();
                body = lines.slice(1).join("\n").trim();
              }
            }

            if (!subject) {
              subject = `Sales meeting recap: ${input.company}`;
            }

            if (sendgridFrom) {
              try {
                await sendEmail({
                  to: HARDCODED_TO_EMAIL,
                  from: sendgridFrom,
                  subject,
                  text: body || "saved",
                });
                console.log("SendGrid email sent successfully");
              } catch (sendErr) {
                console.error("Failed to send email via SendGrid:", sendErr);
              }
            } else {
              console.warn("SENDGRID_FROM_EMAIL not set; skipping email send.");
            }

            return {
              content: [
                {
                  type: "text",
                  text: email || "saved",
                },
              ],
            };
          } catch (err) {
            const error = err as Error & { details?: string };
            console.error(
              "Error drafting stakeholder email:",
              error?.details ?? error
            );

            return {
              content: [
                {
                  type: "text",
                  text: "saved",
                },
              ],
            };
          }
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

