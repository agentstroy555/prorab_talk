import { catalog, parse } from './catalog.js';
import { normalize } from '../../src/matcher.js';
import { extractMeasures } from '../../src/parser.js';

const LEAD = new Set(['и','а','еще','ещё','также','затем','нужно','надо','мне','дайте','пожалуйста','плюс','нужен','нужна','нужны','закажи','закажите','купить','возьми','возьмите']);
const DESCRIPTOR = new Set(['без','для','по','цвет','цвета','длина','длиной','диаметр','диаметром','размер','размером','толщина','толщиной','ширина','шириной','вес','весом','фасовка','фасовкой','это','он','она','доставить','привезти','белый','белая','серый','серая','красный','красная','зеленый','зеленая']);
const UNIT = /^(?:кг|килограмм.*|грамм.*|литр.*|мл|шт|штук.*|мешо.*|мешк.*|лист.*|рулон.*|упаков.*|пачк.*|бухт.*|ведр.*|канистр.*|мм|см|м|метр.*)$/u;
function stem(s) { return s.length > 4 ? s.replace(/(?:ами|ями|ого|ому|ов|ев|ей|ый|ий|ая|ое|ые|ом|ам|ям|ах|ях|а|я|ы|и|у|ю)$/u, '') : s; }
const index = new Map();
for (const family of catalog.families) {
  for (const label of [family.name, ...(family.aliases || [])]) {
    const words=normalize(label).split(' ').filter(Boolean);
    if(!words.length)continue;
    const first=stem(words[0]);
    if(!index.has(first))index.set(first,new Set());
    index.get(first).add(family.id);
  }
}
function analysisText(text) { return text.replace(/(\d)(?=(?:кг|шт|л|мешков|мешка|мешок|листов|рулонов)(?=\s|[.,;!?]|$))/giu,'$1 '); }
function leadingWord(text) {
  const words=normalize(text).split(' ').filter(Boolean);
  while(LEAD.has(words[0]))words.shift();
  return words[0] || '';
}
function heads(text) { const word=leadingWord(text);return UNIT.test(word)||DESCRIPTOR.has(word)?new Set():index.get(stem(word))||new Set(); }
function separateFamilies(left,right) { const a=heads(left),b=heads(right);return a.size&&b.size&&![...a].some(id=>b.has(id)); }
function hasQuantity(text) { const p=parse(analysisText(text));return Number.isFinite(p.quantity)&&p.quantity>0; }
function hasMeasure(text) { return extractMeasures(analysisText(text)).measures.length>0; }
function clean(text) { return text.trim().replace(/^(?:[-•*]\s+|\d+[.)]\s+)/u,'').trim(); }
function cleanLeadingConnector(text) { return text.trim().replace(/^(?:(?:и|а|ещ[её]|также|затем|плюс)\s+)+/iu,'').trim(); }

// Conservative, local segmentation. Explicit line breaks/markers work for unknown catalog items too.
// Sentence/comma boundaries alone are insufficient: the right side must look like a new product.
export function splitPositions(input) {
  const text=String(input||'').replace(/\r\n?/g,'\n').trim();
  if(!text||text.length>12000)throw new Error('message_length');
  const explicit=text.split(/\n+|;\s*|(?:следующ(?:ая|ую)\s+(?:строка|строчка|строчку|позиция|позицию)|новая\s+(?:строка|строчка|позиция))\s*[,.:—-]?\s*/iu).map(clean).filter(Boolean);
  const result=[];
  for(const section of explicit) {
    const words=[...section.matchAll(/\S+/gu)];let start=0;
    for(let i=1;i<words.length;i++) {
      const offset=words[i].index;
      const left=section.slice(start,offset).trim(),right=section.slice(offset).trim();
      const head=heads(right),prior=heads(left);
      const first=normalize(words[i][0]);
      // Connector starts a candidate; don't cut between the connector and its product.
      if(i>0&&LEAD.has(normalize(words[i-1][0])))continue;
      const punctuation=/[.!?,:]\s*$/u.test(left);
      let shouldSplit=false;
      if(head.size&&prior.size) {
        shouldSplit=(hasQuantity(left)&&hasMeasure(right)) || (punctuation&&separateFamilies(left,right));
      } else if(punctuation&&hasQuantity(left)&&!DESCRIPTOR.has(leadingWord(right))&&!UNIT.test(leadingWord(right))) {
        // Preserve unknown named materials after a clear completed item and sentence boundary.
        shouldSplit=/^[а-яa-z]/iu.test(first)&&hasMeasure(right);
      }
      if(shouldSplit){result.push(clean(section.slice(start,offset)));start=offset;}
    }
    const tail=clean(section.slice(start));if(tail)result.push(tail);
  }
  const parts=result.map((p,i)=>i?cleanLeadingConnector(p):p).filter(Boolean);
  if(!parts.length||parts.length>50||parts.some(p=>p.length>2000))throw new Error('message_length');
  return parts;
}
