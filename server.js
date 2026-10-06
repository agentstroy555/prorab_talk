import "dotenv/config";
import express from "express";
import multer from "multer";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initDb, healthcheck, savePurchaseRequest } from "./src/db.js";
import { flattenCatalog, normalize } from "./src/matcher.js";
import { parseLine } from "./src/parser.js";

const __filename=fileURLToPath(import.meta.url);
const __dirname=path.dirname(__filename);
const structuredCatalog=JSON.parse(await fs.readFile(path.join(__dirname,"data","catalog-structured.json"),"utf8"));
const catalog=flattenCatalog(structuredCatalog);

const app=express();
const upload=multer({dest:"/tmp/prorab-talk",limits:{fileSize:25*1024*1024}});
app.use(express.json({limit:"1mb"}));
app.use(express.static(path.join(__dirname,"public")));

function buildMatch(text){ return parseLine(text,structuredCatalog); }

app.get("/api/health",async(_req,res)=>{
  try{await healthcheck();res.json({ok:true,catalog:catalog.length,families:structuredCatalog.families.length});}
  catch(error){res.status(503).json({ok:false,error:error.message});}
});

app.get("/api/catalog",(req,res)=>{
  const q=normalize(req.query.q||"");
  const limit=Math.min(Number(req.query.limit||1000),1000);
  const rows=q?catalog.filter(item=>normalize(item.name).includes(q)||normalize(item.baseName).includes(q)||(item.aliases||[]).some(a=>normalize(a).includes(q))):catalog;
  res.json(rows.slice(0,limit));
});
app.get("/api/families",(_req,res)=>res.json(structuredCatalog.families));

app.post("/api/match",(req,res)=>{
  const text=String(req.body?.text||"").trim();
  res.json({text,...buildMatch(text)});
});

app.post("/api/transcribe",upload.single("audio"),async(req,res)=>{
  const file=req.file;
  if(!file) return res.status(400).json({error:"audio is required"});
  if(!process.env.GROQ_API_KEY){await fs.unlink(file.path).catch(()=>{});return res.status(500).json({error:"GROQ_API_KEY is not configured"});}
  const controller=new AbortController();let clientGone=false;
  const abortGroq=()=>{if(!res.writableEnded){clientGone=true;controller.abort()}};
  req.once("aborted",abortGroq);res.once("close",abortGroq);
  try{
    const bytes=await fs.readFile(file.path);
    if(clientGone)return;
    const form=new FormData();
    form.append("file",new Blob([bytes],{type:file.mimetype||"audio/webm"}),file.originalname||"voice.webm");
    form.append("model","whisper-large-v3-turbo");
    form.append("language","ru");
    form.append("prompt","Русская разговорная речь. Стройматериалы. Формат позиции: товар, вариант или размер, затем количество. Добавляй точки и запятые.");
    form.append("response_format","json");
    form.append("temperature","0");
    const response=await fetch("https://api.groq.com/openai/v1/audio/transcriptions",{method:"POST",headers:{Authorization:"Bearer "+process.env.GROQ_API_KEY},body:form,signal:controller.signal});
    if(clientGone)return;
    const payload=await response.json();
    if(!response.ok) return res.status(502).json({error:"Groq transcription failed",details:payload?.error?.message||"Unknown Groq error"});
    const text=String(payload.text||"").trim();
    res.json({text,rawText:text,...buildMatch(text)});
  }catch(error){
    if(clientGone||error?.name==="AbortError")return;
    console.error(error);
    if(!res.headersSent&&!res.writableEnded)res.status(500).json({error:error.message});
  }finally{
    req.off("aborted",abortGroq);res.off("close",abortGroq);
    await fs.unlink(file.path).catch(()=>{});
  }
});

app.post("/api/requests",async(req,res)=>{
  const items=Array.isArray(req.body?.items)?req.body.items:[];
  if(!items.length) return res.status(400).json({error:"items are required"});
  try{res.status(201).json(await savePurchaseRequest(items));}
  catch(error){console.error(error);res.status(500).json({error:error.message});}
});

app.get("/{*splat}",(_req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
const port=Number(process.env.PORT||3000);
initDb(catalog).then(()=>app.listen(port,"0.0.0.0",()=>console.log("Prorab Talk v0.2 on "+port+"; sku="+catalog.length+" families="+structuredCatalog.families.length)))
.catch(error=>{console.error("Failed to initialize database",error);process.exit(1);});
