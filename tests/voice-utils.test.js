import test from "node:test";
import assert from "node:assert/strict";
import { likelyWhisperHallucination } from "../public/voice-utils.js";

for(const value of [
  "Продолжение следует.",
  "Продолжение следует...",
  "Продолжение следует…",
  "Спасибо за просмотр!!!",
  "Редактор субтитров А. Семкин",
  "Субтитры сделал DimaTorzok",
  "Субтитры создавал Вася",
  "Корректор А. Егорова",
  "Смотрите продолжение в следующей серии..."
]){
  test("filters known Whisper hallucination: "+value,()=>assert.equal(likelyWhisperHallucination(value),true));
}

for(const value of [
  "Жидкие гвозди, 50 мешков.",
  "Продолжение работ завтра, 20 мешков",
  "Саморез 4,8x60 мм, 100 штук."
]){
  test("keeps normal procurement speech: "+value,()=>assert.equal(likelyWhisperHallucination(value),false));
}
