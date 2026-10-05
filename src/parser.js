import { normalize, rankFamilies, rankVariants } from "./matcher.js";

const ONES = new Map(Object.entries({
  "ноль":0,"один":1,"одна":1,"одно":1,"два":2,"две":2,"три":3,"четыре":4,"пять":5,"шесть":6,"семь":7,"восемь":8,"девять":9,
  "десять":10,"одиннадцать":11,"двенадцать":12,"тринадцать":13,"четырнадцать":14,"пятнадцать":15,"шестнадцать":16,"семнадцать":17,"восемнадцать":18,"девятнадцать":19
}));
const TENS = new Map(Object.entries({"двадцать":20,"тридцать":30,"сорок":40,"пятьдесят":50,"шестьдесят":60,"семьдесят":70,"восемьдесят":80,"девяносто":90}));
const HUNDREDS = new Map(Object.entries({"сто":100,"двести":200,"триста":300,"четыреста":400,"пятьсот":500,"шестьсот":600,"семьсот":700,"восемьсот":800,"девятьсот":900}));

const UNIT_FORMS = {
  "шт":["шт","штука","штуки","штук"],
  "мешок":["мешок","мешка","мешков"],
  "лист":["лист","листа","листов"],
  "рулон":["рулон","рулона","рулонов"],
  "упаковка":["упаковка","упаковки","упаковок"],
  "пачка":["пачка","пачки","пачек"],
  "бухта":["бухта","бухты","бухт"],
  "ведро":["ведро","ведра","ведер","ведер"],
  "канистра":["канистра","канистры","канистр"],
  "кг":["кг","килограмм","килограмма","килограммов"],
  "г":["г","грамм","грамма","граммов"],
  "л":["л","литр","литра","литров"],
  "мл":["мл","миллилитр","миллилитра","миллилитров"],
  "м":["м","метр","метра","метров"],
  "м²":["м2","м²"]
};
const FORM_TO_UNIT = new Map();
for (const [u,forms] of Object.entries(UNIT_FORMS)) for (const f of forms) FORM_TO_UNIT.set(f,u);
const COUNT_UNITS = new Set(["шт","мешок","лист","рулон","упаковка","пачка","бухта","ведро","канистра"]);

function numberValue(words) {
  if (!words.length) return null;
  if (words.length === 1 && /^\d+(?:[.,]\d+)?$/.test(words[0])) return Number(words[0].replace(",","."));
  let total=0,seen=false;
  for (const word of words) {
    if (HUNDREDS.has(word)) { total += HUNDREDS.get(word); seen=true; continue; }
    if (TENS.has(word)) { total += TENS.get(word); seen=true; continue; }
    if (ONES.has(word)) { total += ONES.get(word); seen=true; continue; }
    if (word==="полтора" || word==="полторы") { total += 1.5; seen=true; continue; }
    return null;
  }
  return seen ? total : null;
}

function speechTokens(text) {
  return normalize(text).split(" ").filter(Boolean);
}

export function extractMeasures(text) {
  const t=speechTokens(text);
  const measures=[];
  for(let i=0;i<t.length;i++){
    const unit=FORM_TO_UNIT.get(t[i]);
    if(!unit) continue;
    for(let width=Math.min(4,i);width>=1;width--){
      const start=i-width;
      const value=numberValue(t.slice(start,i));
      if(value!==null){
        measures.push({start,end:i,value,unit,kind:COUNT_UNITS.has(unit)?"count":"physical",raw:t.slice(start,i+1).join(" ")});
        break;
      }
    }
  }
  return {tokens:t,measures};
}

function variantMeasureKeys(variant) {
  if(!variant || variant.label==="Стандарт") return new Set();
  const {measures}=extractMeasures(variant.label);
  return new Set(measures.map(m=>String(m.value)+"|"+m.unit));
}

function trailingBareNumber(tokens, measures) {
  const covered=new Set();
  for(const m of measures) for(let i=m.start;i<=m.end;i++) covered.add(i);
  for(let end=tokens.length;end>0;end--){
    const idx=end-1;
    if(covered.has(idx)) continue;
    for(let width=Math.min(4,end);width>=1;width--){
      const start=end-width;
      if([...Array(width)].some((_,j)=>covered.has(start+j))) continue;
      const value=numberValue(tokens.slice(start,end));
      if(value!==null && end===tokens.length) return value;
    }
    break;
  }
  return null;
}

export function parseLine(text, catalog) {
  const {tokens,measures}=extractMeasures(text);
  const familyCandidates=rankFamilies(text,catalog,5);
  const familyRef=familyCandidates[0] ? catalog.families.find(f=>f.id===familyCandidates[0].id) : null;

  const firstCount=measures.find(m=>m.kind==="count");
  let variantTokens=firstCount ? tokens.slice(0,firstCount.start) : [...tokens];
  if(!firstCount && measures.length && /^\d+(?:[.,]\d+)?$/.test(variantTokens.at(-1)||"")){
    variantTokens=variantTokens.slice(0,-1);
  }
  const variantQuery=variantTokens.join(" ");
  const variantCandidates=rankVariants(variantQuery,familyRef,5);
  const bestVariant=variantCandidates[0] || null;
  const onlyVariantIsDefault = familyRef?.variants.length===1 && bestVariant?.label==="Стандарт";
  const selectedVariant = bestVariant && (bestVariant.score >= 0.45 || onlyVariantIsDefault) ? bestVariant : null;

  const variantKeys=variantMeasureKeys(selectedVariant);
  let quantity=null, unit=null;

  const explicitCount=measures.filter(m=>m.kind==="count");
  if(explicitCount.length){
    const m=explicitCount[explicitCount.length-1];
    quantity=m.value; unit=m.unit;
  } else {
    const unmatchedPhysical=measures.filter(m=>!variantKeys.has(String(m.value)+"|"+m.unit));
    if(unmatchedPhysical.length){
      const m=unmatchedPhysical[unmatchedPhysical.length-1];
      quantity=m.value; unit=m.unit;
    } else if(selectedVariant || familyRef) {
      const bare=trailingBareNumber(tokens,measures);
      if(bare!==null){
        quantity=bare;
        unit=familyRef?.orderUnit || selectedVariant?.orderUnit || "шт";
      }
    }
  }

  return {
    family: familyCandidates[0] || null,
    familyCandidates,
    variant: selectedVariant,
    variantCandidates,
    quantity,
    unit,
    orderUnit: familyRef?.orderUnit || null
  };
}
