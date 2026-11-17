// One worker = one job. Reads the job's skill, drives the job's MCP link with an LLM tool loop.
// Env: JOB_URL, JOB_NAME, SKILL_FILE, LLM_BASE_URL, LLM_MODEL, LLM_KEY (optional), EXTRA (optional), OUT_DIR
import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const e = process.env;
const need = (k) => { if (!e[k]) throw new Error(`missing env ${k}`); return e[k]; };
const jobUrl = need("JOB_URL"), jobName = need("JOB_NAME"), model = need("LLM_MODEL");
const base = need("LLM_BASE_URL").replace(/\/$/, "");
const outDir = e.OUT_DIR || "out";
const maxSteps = Number(e.MAX_STEPS || 40);
await mkdir(outDir, { recursive: true });
const logFile = `${outDir}/${jobName}.log`;
const mask = (s) => String(s).replaceAll(jobUrl, "****").replace(/v1\.[A-Za-z0-9_-]{20,}/g, "****");
const log = async (s) => { const line = mask(s); console.log(line); await appendFile(logFile, line + "\n"); };

const skill = await readFile(need("SKILL_FILE"), "utf8");
const client = new Client({ name: `worker-${jobName}`, version: "1" });
await client.connect(new StreamableHTTPClientTransport(new URL(jobUrl)));
const { tools } = await client.listTools();
await log(`tools: ${tools.map((t) => t.name).join(", ")}`);
const llmTools = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description || "", parameters: t.inputSchema } }));

const messages = [
  { role: "system", content: `You are a worker for one job. Follow this skill exactly, using only the tools given. Call one tool at a time and pass the step token as the skill says.\n\n${skill}` },
  { role: "user", content: `Do the job now.${e.EXTRA ? "\n" + e.EXTRA : ""}\nWhen submit has returned, reply with the word DONE.` },
];

let submitResult = null;
for (let step = 1; step <= maxSteps; step++) {
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(e.LLM_KEY ? { authorization: `Bearer ${e.LLM_KEY}` } : {}) },
    body: JSON.stringify({ model, messages, tools: llmTools, temperature: 0 }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const raw = await res.text();
  let body;
  try { body = JSON.parse(raw); } catch { throw new Error(`LLM ${res.status} non-JSON body: ${raw.slice(0, 300)} | headers: ${[...res.headers].map(([k, v]) => `${k}=${v}`).join("; ").slice(0, 500)}`); }
  const msg = body.choices[0].message;
  messages.push(msg);
  if (msg.content) await log(`[${step}] assistant: ${msg.content.slice(0, 500)}`);
  if (!msg.tool_calls?.length) break;
  for (const tc of msg.tool_calls) {
    let args = {};
    try { args = JSON.parse(tc.function.arguments || "{}"); } catch {}
    await log(`[${step}] call ${tc.function.name} ${JSON.stringify(args)}`);
    let text;
    try {
      const r = await client.callTool({ name: tc.function.name, arguments: args });
      text = r.structuredContent ? JSON.stringify(r.structuredContent) : (r.content || []).map((c) => c.text ?? "").join("\n");
      if (r.isError) text = `ERROR: ${text}`;
    } catch (err) { text = `ERROR: ${err.message}`; }
    // In CI (public logs): mask receipts and step tokens before they are printed.
    if (e.GITHUB_ACTIONS) for (const m of text.matchAll(/"(?:receipt|step)":\s*"([^"]+)"/g)) console.log(`::add-mask::${m[1]}`);
    await log(`[${step}] result ${text}`);
    if (tc.function.name === "submit" && !text.startsWith("ERROR")) submitResult = text;
    messages.push({ role: "tool", tool_call_id: tc.id, content: text });
  }
}
await client.close();
if (!submitResult) { await log("NO SUBMIT RESULT"); process.exit(1); }
await writeFile(`${outDir}/${jobName}.result.json`, submitResult);
await log(`saved ${outDir}/${jobName}.result.json`);
