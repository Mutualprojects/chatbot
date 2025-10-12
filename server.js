// server.js
import "dotenv/config";
import express from "express";
import cors from "cors";
import { MongoClient } from "mongodb";

// ---------- Config ----------
const PORT = process.env.PORT || 8787;
const PINECONE_ENDPOINT =
  "https://prod-1-data.ke.pinecone.io/assistant/chat/brichat";
const PINECONE_KEY = process.env.PINECONE_KEY; // required
const MONGODB_URI = process.env.MONGODB_URI; // required

// OpenRouter (DeepSeek R1) rewriter
const OPENROUTER_KEY = process.env.OPENROUTER_KEY; // required to enable rewrite
const OPENROUTER_MODEL =
  process.env.OPENROUTER_MODEL || "deepseek/deepseek-r1:free";
const USE_REWRITER = (process.env.USE_REWRITER ?? "true") !== "false"; // opt-out with USE_REWRITER=false

if (!PINECONE_KEY) console.warn("WARN: Missing PINECONE_KEY");
if (!MONGODB_URI) console.warn("WARN: Missing MONGODB_URI");
if (!OPENROUTER_KEY)
  console.warn("INFO: OPENROUTER_KEY missing — rewriter disabled.");

// ---------- App ----------
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ---------- Mongo ----------
const client = new MongoClient(MONGODB_URI);
await client.connect();
const db = client.db("chatbot");
const turns = db.collection("chat_turns");

// ---------- Helpers ----------
async function callPinecone(messages) {
  const r = await fetch(PINECONE_ENDPOINT, {
    method: "POST",
    headers: {
      "Api-Key": PINECONE_KEY,
      "Content-Type": "application/json",
      "X-Pinecone-API-Version": "2025-04",
    },
    body: JSON.stringify({ messages }),
  });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!r.ok) {
    const msg =
      (data && (data.error || data.message)) || text || `HTTP ${r.status}`;
    throw new Error(msg);
  }
  const answer =
    data?.message?.content ??
    data?.choices?.[0]?.message?.content ??
    data?.output ??
    data?.content ??
    (typeof data === "string" ? data : JSON.stringify(data, null, 2));
  return { answer: String(answer), raw: data };
}

// Strip DeepSeek’s <think>…</think> chain-of-thought, just keep the final answer
function stripThinkTags(s = "") {
  return s.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

async function refineWithOpenRouter({ question, rawAnswer }) {
  if (!OPENROUTER_KEY) return { refined: rawAnswer, raw: null, used: false };

  // Rewriter prompt keeps facts, fixes grammar, avoids hallucination
  const messages = [
    {
      role: "system",
      content:
        "You rewrite answers from a RAG system. Preserve every factual claim, URLs, and citations. " +
        "Improve grammar and clarity, keep bullet/numbered lists if present, avoid adding new facts. " +
        "If content is uncertain or says “I don’t know”, keep it that way. Return only the rewritten answer.",
    },
    {
      role: "user",
      content:
        `User question:\n${question}\n\nOriginal answer from RAG:\n${rawAnswer}\n\n` +
        `Rewrite the answer now. Do not add extra details.`,
    },
  ];

  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_KEY}`,
      "Content-Type": "application/json",
      // These two headers are recommended by OpenRouter (optional but nice)
      "HTTP-Referer": "http://localhost:8787",
      "X-Title": "Pinecone RAG Rewriter",
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages,
      temperature: 0.2,
      max_tokens: 800,
    }),
  });

  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!r.ok)
    throw new Error(
      (data && (data.error || data.message)) || text || `HTTP ${r.status}`
    );

  const rawContent =
    data?.choices?.[0]?.message?.content ??
    data?.message?.content ??
    (typeof data === "string" ? data : JSON.stringify(data, null, 2));

  const refined = stripThinkTags(String(rawContent));
  return { refined, raw: data, used: true };
}

// ---------- Route ----------
app.post("/chat", async (req, res) => {
  try {
    const {
      conversationId,
      userText,
      history = [],
      rewrite = USE_REWRITER,
    } = req.body || {};
    if (!userText) return res.status(400).json({ error: "userText required" });

    // Build messages for Pinecone (include history + current user)
    const messages = [
      ...(Array.isArray(history) ? history : []),
      { role: "user", content: userText },
    ];

    // 1) Get Pinecone answer
    const { answer: pineAnswer, raw: pineRaw } = await callPinecone(messages);

    // 2) Optionally refine via OpenRouter
    let finalAnswer = pineAnswer;
    let rewriteUsed = false;
    let openrouterRaw = null;

    if (rewrite) {
      try {
        const rr = await refineWithOpenRouter({
          question: userText,
          rawAnswer: pineAnswer,
        });
        finalAnswer = rr.refined || pineAnswer;
        openrouterRaw = rr.raw || null;
        rewriteUsed = rr.used;
      } catch (e) {
        // Fall back silently to Pinecone answer on any rewriter failure
        console.warn("Rewriter failed:", e.message || e);
      }
    }

    // 3) Save turn
    const doc = {
      conversationId: conversationId || null,
      userText,
      pineAnswer,
      finalAnswer,
      history, // history before this user turn (optional)
      toolPayload: { endpoint: PINECONE_ENDPOINT, version: "2025-04" },
      pineconeRaw: pineRaw,
      openrouter: rewriteUsed
        ? { model: OPENROUTER_MODEL, raw: openrouterRaw }
        : null,
      rewriteUsed,
      createdAt: new Date(),
    };
    await turns.insertOne(doc);

    // 4) Respond to client
    return res.json({
      answer: finalAnswer,
      rewriteUsed,
      conversationId: conversationId || null,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

app.get("/", (_req, res) => res.send("OK"));
app.listen(PORT, () =>
  console.log(`Server running at http://localhost:${PORT}`)
);
// // // // server.js
// // // import "dotenv/config";
// // // import express from "express";
// // // import cors from "cors";
// // // import { MongoClient } from "mongodb";

// // // /* ======================== Env & Guards ======================== */
// // // const {
// // //   PORT = 8787,

// // //   // Cloudflare AutoRAG
// // //   CF_ACCOUNT_ID,
// // //   CF_RAG_NAME,
// // //   CF_AUTORAG_TOKEN,
// // //   CF_MODE = "ai-search", // "ai-search" | "search"
// // //   CF_MAX_RESULTS = "8",
// // //   CF_REWRITE_QUERY = "true",
// // //   CF_TIMEOUT_MS = "30000",

// // //   // MongoDB
// // //   MONGODB_URI,

// // //   // Optional: OpenRouter rewriter
// // //   OPENROUTER_KEY,
// // //   OPENROUTER_MODEL = "deepseek/deepseek-r1:free",
// // //   USE_REWRITER = "true",
// // // } = process.env;

// // // // Small helper: coerce booleans & numbers from .env
// // // const bool = (v, def = false) =>
// // //   v === undefined ? def : String(v).toLowerCase() !== "false";
// // // const num = (v, def = 0) => {
// // //   const n = Number(v);
// // //   return Number.isFinite(n) ? n : def;
// // // };

// // // if (!CF_ACCOUNT_ID) console.warn("WARN: Missing CF_ACCOUNT_ID");
// // // if (!CF_RAG_NAME) console.warn("WARN: Missing CF_RAG_NAME");
// // // if (!CF_AUTORAG_TOKEN) console.warn("WARN: Missing CF_AUTORAG_TOKEN");
// // // if (!MONGODB_URI) console.warn("WARN: Missing MONGODB_URI");
// // // if (!OPENROUTER_KEY)
// // //   console.warn("INFO: OPENROUTER_KEY missing — rewriter disabled.");

// // // /* ======================== App ======================== */
// // // const app = express();
// // // app.use(cors());
// // // app.use(express.json({ limit: "1mb" }));

// // // /* ======================== Mongo ======================== */
// // // const client = new MongoClient(MONGODB_URI);
// // // await client.connect();
// // // const db = client.db("chatbot");
// // // const turns = db.collection("chat_turns");

// // // /* ======================== AutoRAG Call ======================== */
// // // function autoragUrl() {
// // //   const base = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/autorag/rags/${CF_RAG_NAME}`;
// // //   // support both modes: ai-search (LLM answer) or search (retrieval results)
// // //   return `${base}/${CF_MODE === "search" ? "search" : "ai-search"}`;
// // // }

// // // /**
// // //  * Calls Cloudflare AutoRAG.
// // //  * For CF_MODE="ai-search": returns an LLM answer over retrieved context.
// // //  * For CF_MODE="search": returns retrieved chunks; we stringify them unless rewriter is used.
// // //  */
// // // async function callAutoRAG({ query }) {
// // //   const controller = new AbortController();
// // //   const timeout = setTimeout(
// // //     () => controller.abort(),
// // //     num(CF_TIMEOUT_MS, 30000)
// // //   );

// // //   const payload =
// // //     CF_MODE === "search"
// // //       ? {
// // //           query,
// // //           max_num_results: num(CF_MAX_RESULTS, 8),
// // //         }
// // //       : {
// // //           query,
// // //           rewrite_query: bool(CF_REWRITE_QUERY, true),
// // //           max_num_results: num(CF_MAX_RESULTS, 8),
// // //         };

// // //   const r = await fetch(autoragUrl(), {
// // //     method: "POST",
// // //     signal: controller.signal,
// // //     headers: {
// // //       Authorization: `Bearer ${CF_AUTORAG_TOKEN}`,
// // //       "Content-Type": "application/json",
// // //     },
// // //     body: JSON.stringify(payload),
// // //   }).catch((e) => {
// // //     throw new Error(`AutoRAG request failed: ${e?.message || e}`);
// // //   });

// // //   clearTimeout(timeout);

// // //   const text = await r.text();
// // //   let data;
// // //   try {
// // //     data = JSON.parse(text);
// // //   } catch {
// // //     data = text;
// // //   }
// // //   if (!r.ok) {
// // //     // Try to pull a useful error message
// // //     const msg =
// // //       (data && (data.error || data.message)) ||
// // //       (data && data?.errors?.[0]?.message) ||
// // //       text ||
// // //       `HTTP ${r.status}`;
// // //     throw new Error(msg);
// // //   }

// // //   // Try to normalize into a single answer string.
// // //   // AutoRAG responses vary; we prefer 'result.answer' when ai-search is used.
// // //   const result = data?.result ?? data;

// // //   // If ai-search, try the answer field; otherwise fallback to stringifying result.
// // //   const answerGuess =
// // //     result?.answer ??
// // //     result?.output_text ??
// // //     result?.message?.content ??
// // //     (typeof result === "string" ? result : null);

// // //   const answer = answerGuess ?? JSON.stringify(result, null, 2); // for /search mode or unknown shapes

// // //   return { answer: String(answer), raw: data };
// // // }

// // // /* ======================== OpenRouter Rewriter ======================== */
// // // // Strip deliberate <think>…</think> content from some models (e.g., DeepSeek)
// // // function stripThinkTags(s = "") {
// // //   return s.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
// // // }

// // // async function refineWithOpenRouter({ question, rawAnswer }) {
// // //   if (!OPENROUTER_KEY) return { refined: rawAnswer, raw: null, used: false };

// // //   const messages = [
// // //     {
// // //       role: "system",
// // //       content:
// // //         "You rewrite answers from a RAG system. Preserve every factual claim, URLs, and citations. " +
// // //         "Improve grammar and clarity, keep bullet/numbered lists if present, avoid adding new facts. " +
// // //         "If content is uncertain or says “I don’t know”, keep it that way. Return only the rewritten answer.",
// // //     },
// // //     {
// // //       role: "user",
// // //       content:
// // //         `User question:\n${question}\n\nOriginal answer from RAG:\n${rawAnswer}\n\n` +
// // //         `Rewrite the answer now. Do not add extra details.`,
// // //     },
// // //   ];

// // //   const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
// // //     method: "POST",
// // //     headers: {
// // //       Authorization: `Bearer ${OPENROUTER_KEY}`,
// // //       "Content-Type": "application/json",
// // //       "HTTP-Referer": "http://localhost:8787",
// // //       "X-Title": "AutoRAG Rewriter",
// // //     },
// // //     body: JSON.stringify({
// // //       model: OPENROUTER_MODEL,
// // //       messages,
// // //       temperature: 0.2,
// // //       max_tokens: 800,
// // //     }),
// // //   });

// // //   const text = await r.text();
// // //   let data;
// // //   try {
// // //     data = JSON.parse(text);
// // //   } catch {
// // //     data = text;
// // //   }
// // //   if (!r.ok)
// // //     throw new Error(
// // //       (data && (data.error || data.message)) || text || `HTTP ${r.status}`
// // //     );

// // //   const rawContent =
// // //     data?.choices?.[0]?.message?.content ??
// // //     data?.message?.content ??
// // //     (typeof data === "string" ? data : JSON.stringify(data, null, 2));

// // //   const refined = stripThinkTags(String(rawContent));
// // //   return { refined, raw: data, used: true };
// // // }

// // // /* ======================== Routes ======================== */
// // // app.post("/chat", async (req, res) => {
// // //   try {
// // //     const {
// // //       conversationId,
// // //       userText,
// // //       history = [],
// // //       rewrite = bool(USE_REWRITER, true),
// // //     } = req.body || {};
// // //     if (!userText) return res.status(400).json({ error: "userText required" });

// // //     // Build a single query. If you want to include history context in the query,
// // //     // you can join a short window. For now, we pass only the latest userText.
// // //     const query = String(userText);

// // //     // 1) Call AutoRAG (ai-search or search)
// // //     const { answer: ragAnswer, raw: ragRaw } = await callAutoRAG({ query });

// // //     // 2) Optionally refine via OpenRouter
// // //     let finalAnswer = ragAnswer;
// // //     let rewriteUsed = false;
// // //     let openrouterRaw = null;

// // //     if (rewrite) {
// // //       try {
// // //         const rr = await refineWithOpenRouter({
// // //           question: userText,
// // //           rawAnswer: ragAnswer,
// // //         });
// // //         finalAnswer = rr.refined || ragAnswer;
// // //         openrouterRaw = rr.raw || null;
// // //         rewriteUsed = rr.used;
// // //       } catch (e) {
// // //         console.warn("Rewriter failed:", e.message || e);
// // //       }
// // //     }

// // //     // 3) Save turn
// // //     const doc = {
// // //       conversationId: conversationId || null,
// // //       userText,
// // //       ragAnswer,
// // //       finalAnswer,
// // //       history,
// // //       toolPayload: {
// // //         provider: "cloudflare-autorag",
// // //         endpoint: autoragUrl(),
// // //         mode: CF_MODE,
// // //         version: "v4",
// // //       },
// // //       autoragRaw: ragRaw,
// // //       openrouter: rewriteUsed
// // //         ? { model: OPENROUTER_MODEL, raw: openrouterRaw }
// // //         : null,
// // //       rewriteUsed,
// // //       createdAt: new Date(),
// // //     };
// // //     await turns.insertOne(doc);

// // //     // 4) Respond
// // //     return res.json({
// // //       answer: finalAnswer,
// // //       rewriteUsed,
// // //       conversationId: conversationId || null,
// // //     });
// // //   } catch (e) {
// // //     return res.status(500).json({ error: String(e?.message || e) });
// // //   }
// // // });

// // // // Simple health & auth test
// // // app.get("/selftest", async (_req, res) => {
// // //   try {
// // //     const { answer } = await callAutoRAG({ query: "Hello from health check" });
// // //     res.json({ ok: true, mode: CF_MODE, sample: answer.slice(0, 160) });
// // //   } catch (e) {
// // //     res.status(500).json({ ok: false, error: String(e?.message || e) });
// // //   }
// // // });

// // // app.get("/", (_req, res) => res.send("OK"));
// // // app.listen(PORT, () =>
// // //   console.log(`Server running at http://localhost:${PORT}`)
// // // );
// // // server.js
// // import "dotenv/config";
// // import express from "express";
// // import cors from "cors";
// // import { MongoClient } from "mongodb";

// // /* ======================== Env & Guards ======================== */
// // const {
// //   PORT = 8787,

// //   // Cloudflare AutoRAG
// //   CF_ACCOUNT_ID,
// //   CF_RAG_NAME,
// //   CF_AUTORAG_TOKEN,
// //   CF_MODE = "ai-search", // "ai-search" | "search"
// //   CF_MAX_RESULTS = "8",
// //   CF_REWRITE_QUERY = "true",
// //   CF_TIMEOUT_MS = "30000",

// //   // MongoDB
// //   MONGODB_URI,

// //   // Optional: OpenRouter rewriter (DeepSeek, etc.)
// //   OPENROUTER_KEY,
// //   OPENROUTER_MODEL = "deepseek/deepseek-r1:free",
// //   USE_REWRITER = "true",
// // } = process.env;

// // const bool = (v, def = false) =>
// //   v === undefined ? def : String(v).toLowerCase() !== "false";
// // const num = (v, def = 0) => {
// //   const n = Number(v);
// //   return Number.isFinite(n) ? n : def;
// // };

// // if (!CF_ACCOUNT_ID) console.warn("WARN: Missing CF_ACCOUNT_ID");
// // if (!CF_RAG_NAME) console.warn("WARN: Missing CF_RAG_NAME");
// // if (!CF_AUTORAG_TOKEN) console.warn("WARN: Missing CF_AUTORAG_TOKEN");
// // if (!MONGODB_URI) console.warn("WARN: Missing MONGODB_URI");
// // if (!OPENROUTER_KEY)
// //   console.warn("INFO: OPENROUTER_KEY missing — rewriter disabled.");

// // /* ======================== App ======================== */
// // const app = express();
// // app.use(cors());
// // app.use(express.json({ limit: "1mb" }));

// // /* ======================== Mongo ======================== */
// // const client = new MongoClient(MONGODB_URI);
// // await client.connect();
// // const db = client.db("chatbot");
// // const turns = db.collection("chat_turns");

// // /* ======================== AutoRAG Call ======================== */
// // function autoragUrl() {
// //   const base = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/autorag/rags/${CF_RAG_NAME}`;
// //   return `${base}/${CF_MODE === "search" ? "search" : "ai-search"}`;
// // }

// // async function callAutoRAG({ query }) {
// //   const controller = new AbortController();
// //   const timeout = setTimeout(
// //     () => controller.abort(),
// //     num(CF_TIMEOUT_MS, 30000)
// //   );

// //   const payload =
// //     CF_MODE === "search"
// //       ? {
// //           query,
// //           max_num_results: num(CF_MAX_RESULTS, 8),
// //         }
// //       : {
// //           query,
// //           rewrite_query: bool(CF_REWRITE_QUERY, true),
// //           max_num_results: num(CF_MAX_RESULTS, 8),
// //         };

// //   const r = await fetch(autoragUrl(), {
// //     method: "POST",
// //     signal: controller.signal,
// //     headers: {
// //       Authorization: `Bearer ${CF_AUTORAG_TOKEN}`,
// //       "Content-Type": "application/json",
// //     },
// //     body: JSON.stringify(payload),
// //   }).catch((e) => {
// //     throw new Error(`AutoRAG request failed: ${e?.message || e}`);
// //   });

// //   clearTimeout(timeout);

// //   const text = await r.text();
// //   let data;
// //   try {
// //     data = JSON.parse(text);
// //   } catch {
// //     data = text;
// //   }
// //   if (!r.ok) {
// //     const msg =
// //       (data && (data.error || data.message)) ||
// //       (data && data?.errors?.[0]?.message) ||
// //       text ||
// //       `HTTP ${r.status}`;
// //     throw new Error(msg);
// //   }

// //   const result = data?.result ?? data;
// //   const answerGuess =
// //     result?.answer ??
// //     result?.output_text ??
// //     result?.message?.content ??
// //     (typeof result === "string" ? result : null);

// //   const answer = answerGuess ?? JSON.stringify(result, null, 2);
// //   return { answer: String(answer), raw: data };
// // }

// // /* ======================== Rewriter (OpenRouter) ======================== */
// // function stripThinkTags(s = "") {
// //   return s.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
// // }

// // async function refineWithOpenRouter({ question, rawAnswer, concise = false }) {
// //   if (!OPENROUTER_KEY) return { refined: rawAnswer, raw: null, used: false };

// //   const style = concise
// //     ? "Be brief. Output 3–5 short bullet points OR <=3 short sentences. Keep only the essential facts."
// //     : "Improve clarity while preserving all facts.";

// //   const messages = [
// //     {
// //       role: "system",
// //       content:
// //         "You rewrite answers from a RAG system. Preserve every factual claim, URLs, and citations. " +
// //         "Keep bullet/numbered lists if present. Avoid adding new facts. If uncertain, keep it uncertain. " +
// //         style +
// //         " Return only the rewritten answer.",
// //     },
// //     {
// //       role: "user",
// //       content:
// //         `User question:\n${question}\n\nOriginal answer from RAG:\n${rawAnswer}\n\n` +
// //         `Rewrite the answer now.`,
// //     },
// //   ];

// //   const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
// //     method: "POST",
// //     headers: {
// //       Authorization: `Bearer ${OPENROUTER_KEY}`,
// //       "Content-Type": "application/json",
// //       "HTTP-Referer": "http://localhost:8787",
// //       "X-Title": "AutoRAG Rewriter",
// //     },
// //     body: JSON.stringify({
// //       model: OPENROUTER_MODEL,
// //       messages,
// //       temperature: 0.2,
// //       max_tokens: 600,
// //     }),
// //   });

// //   const text = await r.text();
// //   let data;
// //   try {
// //     data = JSON.parse(text);
// //   } catch {
// //     data = text;
// //   }
// //   if (!r.ok)
// //     throw new Error(
// //       (data && (data.error || data.message)) || text || `HTTP ${r.status}`
// //     );

// //   const rawContent =
// //     data?.choices?.[0]?.message?.content ??
// //     data?.message?.content ??
// //     (typeof data === "string" ? data : JSON.stringify(data, null, 2));

// //   const refined = stripThinkTags(String(rawContent));
// //   return { refined, raw: data, used: true };
// // }

// // /* ======================== Routes ======================== */
// // app.post("/chat", async (req, res) => {
// //   try {
// //     const {
// //       conversationId,
// //       userText,
// //       history = [],
// //       rewrite = bool(USE_REWRITER, true),
// //       includeRaw = false, // NEW: include AutoRAG + rewriter raw payloads
// //       concise = false, // NEW: ask rewriter to be short & sweet
// //     } = req.body || {};

// //     if (!userText) return res.status(400).json({ error: "userText required" });

// //     const query = String(userText);

// //     // 1) Call AutoRAG
// //     const { answer: ragAnswer, raw: ragRaw } = await callAutoRAG({ query });

// //     // 2) Optional DeepSeek rewrite
// //     let finalAnswer = ragAnswer;
// //     let rewriteUsed = false;
// //     let openrouterRaw = null;

// //     if (rewrite) {
// //       try {
// //         const rr = await refineWithOpenRouter({
// //           question: userText,
// //           rawAnswer: ragAnswer,
// //           concise,
// //         });
// //         finalAnswer = rr.refined || ragAnswer;
// //         openrouterRaw = rr.raw || null;
// //         rewriteUsed = rr.used;
// //       } catch (e) {
// //         console.warn("Rewriter failed:", e.message || e);
// //       }
// //     }

// //     // 3) Save turn
// //     const doc = {
// //       conversationId: conversationId || null,
// //       userText,
// //       ragAnswer,
// //       finalAnswer,
// //       history,
// //       toolPayload: {
// //         provider: "cloudflare-autorag",
// //         endpoint: autoragUrl(),
// //         mode: CF_MODE,
// //         version: "v4",
// //       },
// //       autoragRaw: ragRaw,
// //       openrouter: rewriteUsed
// //         ? { model: OPENROUTER_MODEL, raw: openrouterRaw }
// //         : null,
// //       rewriteUsed,
// //       createdAt: new Date(),
// //     };
// //     await turns.insertOne(doc);

// //     // 4) Response (include raw only on demand)
// //     return res.json({
// //       answer: finalAnswer,
// //       rewriteUsed,
// //       conversationId: conversationId || null,
// //       ...(includeRaw
// //         ? { raw: { autorag: ragRaw, rewriter: openrouterRaw } }
// //         : {}),
// //     });
// //   } catch (e) {
// //     return res.status(500).json({ error: String(e?.message || e) });
// //   }
// // });

// // // Simple health & auth test
// // app.get("/selftest", async (_req, res) => {
// //   try {
// //     const { answer } = await callAutoRAG({ query: "Hello from health check" });
// //     res.json({ ok: true, mode: CF_MODE, sample: String(answer).slice(0, 160) });
// //   } catch (e) {
// //     res.status(500).json({ ok: false, error: String(e?.message || e) });
// //   }
// // });

// // app.get("/", (_req, res) => res.send("OK"));
// // app.listen(PORT, () =>
// //   console.log(`Server running at http://localhost:${PORT}`)
// // );
// // server.js
// import "dotenv/config";
// import express from "express";
// import cors from "cors";
// import { MongoClient } from "mongodb";

// /* ======================== Env ======================== */
// const {
//   PORT = 8787,

//   // Cloudflare AutoRAG
//   CF_ACCOUNT_ID,
//   CF_RAG_NAME,
//   CF_AUTORAG_TOKEN,
//   CF_MODE = "ai-search", // strongly recommended: ai-search
//   CF_MAX_RESULTS = "8",
//   CF_REWRITE_QUERY = "true",
//   CF_TIMEOUT_MS = "30000",

//   // MongoDB
//   MONGODB_URI,

//   // OpenRouter (DeepSeek)
//   OPENROUTER_KEY,
//   OPENROUTER_MODEL = "deepseek/deepseek-r1:free",
// } = process.env;

// const bool = (v, def = false) =>
//   v === undefined ? def : String(v).toLowerCase() !== "false";
// const num = (v, def = 0) => {
//   const n = Number(v);
//   return Number.isFinite(n) ? n : def;
// };

// if (!CF_ACCOUNT_ID) console.warn("WARN: Missing CF_ACCOUNT_ID");
// if (!CF_RAG_NAME) console.warn("WARN: Missing CF_RAG_NAME");
// if (!CF_AUTORAG_TOKEN) console.warn("WARN: Missing CF_AUTORAG_TOKEN");
// if (!MONGODB_URI) console.warn("WARN: Missing MONGODB_URI");
// if (!OPENROUTER_KEY)
//   console.warn(
//     "WARN: OPENROUTER_KEY missing — DeepSeek rewrite is required for plain text."
//   );

// /* ======================== App ======================== */
// const app = express();
// app.use(cors());
// app.use(express.json({ limit: "1mb" }));

// /* ======================== Mongo ======================== */
// const client = new MongoClient(MONGODB_URI);
// await client.connect();
// const db = client.db("chatbot");
// const turns = db.collection("chat_turns");

// /* ======================== AutoRAG ======================== */
// function autoragUrl() {
//   const base = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/autorag/rags/${CF_RAG_NAME}`;
//   return `${base}/${CF_MODE === "search" ? "search" : "ai-search"}`;
// }

// async function callAutoRAG({ query }) {
//   const controller = new AbortController();
//   const timeout = setTimeout(
//     () => controller.abort(),
//     num(CF_TIMEOUT_MS, 30000)
//   );

//   const payload =
//     CF_MODE === "search"
//       ? { query, max_num_results: num(CF_MAX_RESULTS, 8) }
//       : {
//           query,
//           rewrite_query: bool(CF_REWRITE_QUERY, true),
//           max_num_results: num(CF_MAX_RESULTS, 8),
//         };

//   const r = await fetch(autoragUrl(), {
//     method: "POST",
//     signal: controller.signal,
//     headers: {
//       Authorization: `Bearer ${CF_AUTORAG_TOKEN}`,
//       "Content-Type": "application/json",
//     },
//     body: JSON.stringify(payload),
//   }).catch((e) => {
//     throw new Error(`AutoRAG request failed: ${e?.message || e}`);
//   });

//   clearTimeout(timeout);

//   const text = await r.text();
//   let data;
//   try {
//     data = JSON.parse(text);
//   } catch {
//     data = text;
//   }
//   if (!r.ok) {
//     const msg =
//       (data && (data.error || data.message)) ||
//       (data && data?.errors?.[0]?.message) ||
//       text ||
//       `HTTP ${r.status}`;
//     throw new Error(msg);
//   }

//   const result = data?.result ?? data;
//   const answerGuess =
//     result?.answer ??
//     result?.output_text ??
//     result?.message?.content ??
//     (typeof result === "string" ? result : null);

//   const answer = answerGuess ?? JSON.stringify(result, null, 2);
//   return { answer: String(answer), raw: data };
// }

// /* ======================== DeepSeek Rewriter ======================== */
// function stripThinkTags(s = "") {
//   return s.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
// }

// async function rewriteToPlainTextShort({ question, content }) {
//   if (!OPENROUTER_KEY) {
//     // Fallback: if DeepSeek missing, do a very basic strip
//     const noCode = content.replace(/```[\s\S]*?```/g, "").trim();
//     return noCode;
//   }

//   const messages = [
//     {
//       role: "system",
//       content:
//         "You are a formatter. Convert any input (including JSON, lists, or verbose text) " +
//         "into short, plain English suitable for a chat bubble. 2–4 crisp sentences. " +
//         "Fix grammar, keep essential facts only. No code blocks. No JSON. No headings.",
//     },
//     {
//       role: "user",
//       content:
//         `User asked:\n${question}\n\n` +
//         `Model output to clean:\n${content}\n\n` +
//         `Return only the final plain text.`,
//     },
//   ];

//   const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
//     method: "POST",
//     headers: {
//       Authorization: `Bearer ${OPENROUTER_KEY}`,
//       "Content-Type": "application/json",
//       "HTTP-Referer": "http://localhost:8787",
//       "X-Title": "AutoRAG PlainText Rewriter",
//     },
//     body: JSON.stringify({
//       model: OPENROUTER_MODEL,
//       messages,
//       temperature: 0.2,
//       max_tokens: 400,
//     }),
//   });

//   const text = await r.text();
//   let data;
//   try {
//     data = JSON.parse(text);
//   } catch {
//     data = text;
//   }
//   if (!r.ok) {
//     const fallback =
//       typeof content === "string" ? content : JSON.stringify(content);
//     return fallback;
//   }

//   const rawContent =
//     data?.choices?.[0]?.message?.content ??
//     data?.message?.content ??
//     (typeof data === "string" ? data : JSON.stringify(data, null, 2));

//   return stripThinkTags(String(rawContent)).trim();
// }

// /* ======================== Helpers ======================== */
// function looksLikeJson(s = "") {
//   const t = String(s).trim();
//   return t.startsWith("{") || t.startsWith("[") || /"\w+"\s*:/.test(t);
// }

// /* ======================== Routes ======================== */
// app.post("/chat", async (req, res) => {
//   try {
//     const { conversationId, userText, history = [] } = req.body || {};
//     if (!userText) return res.status(400).json({ error: "userText required" });

//     // 1) Ask AutoRAG
//     const { answer: ragAnswer, raw: ragRaw } = await callAutoRAG({
//       query: String(userText),
//     });

//     // 2) Always DeepSeek: short/plain text
//     const prepped = looksLikeJson(ragAnswer)
//       ? ragAnswer // JSON-ish → let DeepSeek convert it
//       : ragAnswer.replace(/```[\s\S]*?```/g, "").trim(); // strip code fences if any

//     const finalAnswer = await rewriteToPlainTextShort({
//       question: userText,
//       content: prepped,
//     });

//     // 3) Save turn (no raw in response, but recorded in DB)
//     const doc = {
//       conversationId: conversationId || null,
//       userText,
//       ragAnswer,
//       finalAnswer,
//       history,
//       toolPayload: {
//         provider: "cloudflare-autorag",
//         endpoint: autoragUrl(),
//         mode: CF_MODE,
//         version: "v4",
//       },
//       autoragRaw: ragRaw,
//       openrouter: { model: OPENROUTER_MODEL, used: !!OPENROUTER_KEY },
//       createdAt: new Date(),
//     };
//     await turns.insertOne(doc);

//     // 4) Respond with PLAIN TEXT only
//     return res.json({
//       answer: finalAnswer,
//       conversationId: conversationId || null,
//     });
//   } catch (e) {
//     return res.status(500).json({ error: String(e?.message || e) });
//   }
// });

// /* Health */
// app.get("/", (_req, res) => res.send("OK"));
// app.listen(PORT, () =>
//   console.log(`Server running at http://localhost:${PORT}`)
// );
