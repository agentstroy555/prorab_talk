import fs from 'node:fs';
import { parseLine, extractMeasures } from '../../src/parser.js';
import { rankFamilies, normalize } from '../../src/matcher.js';
export const catalog = JSON.parse(fs.readFileSync(new URL('../../data/catalog-structured.json', import.meta.url), 'utf8'));
export function parse(text) {
  const p = parseLine(text, catalog);
  const words = normalize(text).split(' ');
  const singleNumber = words.filter(x => /^\d+(\.\d+)?$/.test(x)).length === 1;
  const measures = extractMeasures(text).measures;
  // Never infer a mass SKU from a requested volume or consume one bare number twice.
  if (p.variant) {
    const vm = extractMeasures(p.variant.label).measures;
    // Order counts (30 bags) are independent of package measures (30 kg).
    // A matching explicit physical measure also takes priority over another
    // physical measure that belongs to the requested order quantity.
    const physical = measures.filter(m => m.kind === 'physical');
    const conflictingUnit = vm.some(v =>
      !physical.some(m => m.value === v.value && m.unit === v.unit) &&
      physical.some(m => m.value === v.value && m.unit !== v.unit));
    if (conflictingUnit || (singleNumber && measures.length === 0 && p.quantity !== null)) p.variant = null;
  }
  if (p.family && p.family.score < 0.4) { p.family = null; p.variant = null; }
  return p;
}
export function search(text) { return rankFamilies(text, catalog, 5); }
export function warnings(line) {
  const p = JSON.parse(line.parsed);
  const out = [];
  if (!p.family?.name) out.push('товар не определён');
  if (!p.variant) out.push('вариант не выбран');
  if (!(Number.isFinite(p.quantity) && p.quantity > 0)) out.push('нет количества');
  if (!p.unit) out.push('нет единицы');
  if (line.status === 'failed') out.push('голос не распознан');
  if (line.status === 'pending') out.push('ожидает распознавания');
  return out;
}
