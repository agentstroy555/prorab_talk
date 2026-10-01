import "dotenv/config";
import express from "express";
import multer from "multer";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initDb, healthcheck, savePurchaseRequest } from "./src/db.js";
import { matchCatalog, normalize } from "./src/matcher.js";
import { extractQuantity } from "./src/quantity.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const catalog = JSON.parse(
  await fs.readFile(path.join(__dirname, "data", "catalog.json"), "utf8")
);

const app = express();
const upload = multer({
  dest: "/tmp/prorab-talk",
  limits: { fileSize: 25 * 1024 * 1024 }
});

app.use(express.json({ limit:"1mb" }));
app.use(express.static(path.join(__dirname, "public")));

function buildMatch(text) {
  const quantity = extractQuantity(text);
  const candidates = matchCatalog(quantity.searchText || text, catalog, 8);
  return { ...quantity, candidates };
}

app.get("/api/health", async (_req, res) => {
  try {
    await healthcheck();
    res.json({ ok:true, catalog:catalog.length });
  } catch (error) {
    res.status(503).json({ ok:false, error:error.message });
  }
});

app.get("/api/catalog", (req, res) => {
  const q = normalize(req.query.q || "");
  const limit = Math.min(Number(req.query.limit || 1000), 1000);
  const rows = q
    ? catalog.filter(item =>
        normalize(item.name).includes(q) ||
        (item.aliases || []).some(alias => normalize(alias).includes(q))
      )
    : catalog;
  res.json(rows.slice(0, limit));
});

app.post("/api/match", (req, res) => {
  const text = String(req.body?.text || "").trim();
  res.json({ text, ...buildMatch(text) });
});

app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error:"audio is required" });
  if (!process.env.GROQ_API_KEY) {
    await fs.unlink(file.path).catch(() => {});
    return res.status(500).json({ error:"GROQ_API_KEY is not configured" });
  }

  try {
    const bytes = await fs.readFile(file.path);
    const form = new FormData();
    const blob = new Blob([bytes], { type:file.mimetype || "audio/webm" });
    form.append("file", blob, file.originalname || "voice.webm");
    form.append("model", "whisper-large-v3-turbo");
    form.append("language", "ru");
    form.append("prompt", "Русская разговорная речь. Добавляй точки, запятые и вопросительные знаки.");
    form.append("response_format", "json");
    form.append("temperature", "0");

    const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method:"POST",
      headers:{ Authorization:"Bearer " + process.env.GROQ_API_KEY },
      body:form
    });

    const payload = await response.json();
    if (!response.ok) {
      console.error("Groq error", payload);
      return res.status(502).json({
        error:"Groq transcription failed",
        details:payload?.error?.message || "Unknown Groq error"
      });
    }

    const text = String(payload.text || "").trim();
    res.json({ text, rawText:text, ...buildMatch(text) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error:error.message });
  } finally {
    await fs.unlink(file.path).catch(() => {});
  }
});

app.post("/api/requests", async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error:"items are required" });
  try {
    const saved = await savePurchaseRequest(items);
    res.status(201).json(saved);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error:error.message });
  }
});

app.get("*splat", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const port = Number(process.env.PORT || 3000);

initDb(catalog)
  .then(() => {
    app.listen(port, "0.0.0.0", () => {
      console.log("Prorab Talk listening on port " + port + "; catalog=" + catalog.length);
    });
  })
  .catch(error => {
    console.error("Failed to initialize database", error);
    process.exit(1);
  });
