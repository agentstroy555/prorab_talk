import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename=fileURLToPath(import.meta.url);
const __dirname=path.dirname(__filename);
const root=path.resolve(__dirname,"..");
const vadDist=path.join(root,"node_modules","@ricky0123","vad-web","dist");
const ortDist=path.join(root,"node_modules","onnxruntime-web","dist");
const outDir=path.join(root,"public","vendor","vad");

await fs.mkdir(outDir,{recursive:true});

async function copyRequired(fromDir,name){
  const src=path.join(fromDir,name),dst=path.join(outDir,name);
  await fs.copyFile(src,dst);
  console.log("[copy-vad-assets]",name);
}

await copyRequired(vadDist,"bundle.min.js");
await copyRequired(vadDist,"vad.worklet.bundle.min.js");
await copyRequired(vadDist,"silero_vad_v6.onnx");
await copyRequired(ortDist,"ort.wasm.min.js");

const ortFiles=await fs.readdir(ortDist);
for(const name of ortFiles){
  if(/^ort-wasm.*\.(?:wasm|mjs)$/.test(name)){
    await copyRequired(ortDist,name);
  }
}
