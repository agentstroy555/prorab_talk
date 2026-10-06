const STOPWORDS = new Set([
  "мне","надо","нужно","дай","дайте","пожалуйста","еще","ещё","и","а","на","для","из","по"
]);

export function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[«»"'()]/g, " ")
    .replace(/[×х]/g, "x")
    .replace(/ø/g, "o")
    .replace(/,/g, ".")
    .replace(/\.(?=\s|$)/g, " ")
    .replace(/[^a-zа-я0-9.o²\-\/\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(value, { dropNumbers = false } = {}) {
  return normalize(value).split(" ").filter(Boolean).filter(t => {
    if (STOPWORDS.has(t)) return false;
    if (dropNumbers && /\d/.test(t)) return false;
    return true;
  });
}

function weight(token) {
  if (/\d/.test(token)) return 2.2;
  if (token.length >= 7) return 1.35;
  return 1;
}

function overlap(queryTokens, candidateTokens) {
  if (!queryTokens.length || !candidateTokens.length) return 0;
  const cand = new Set(candidateTokens);
  let hit = 0, total = 0;
  for (const token of queryTokens) {
    const w = weight(token);
    total += w;
    if (cand.has(token)) { hit += w; continue; }
    if (token.length >= 5 && [...cand].some(c => c.length >= 5 && (
      c.startsWith(token) || token.startsWith(c) || c.slice(0,5) === token.slice(0,5)
    ))) {
      hit += w * 0.72;
    }
  }
  return total ? hit / total : 0;
}

function candidateScore(query, candidate, aliases = []) {
  const q = normalize(query);
  const qTokens = tokens(q, { dropNumbers:true });
  const base = normalize(candidate);
  let score = overlap(qTokens, tokens(base, { dropNumbers:true }));
  if (q === base) score = 1;
  if (q.includes(base) && base.length >= 4) score = Math.max(score, 0.96);
  for (const alias of aliases || []) {
    const a = normalize(alias);
    if (!a) continue;
    let s = overlap(qTokens, tokens(a, { dropNumbers:true }));
    if (q === a) s = 1;
    else if (q.includes(a)) s = Math.max(s, 0.98);
    else if (a.includes(q) && q.length >= 4) s = Math.max(s, 0.9);
    score = Math.max(score, s);
  }
  return score;
}

function leadText(query) {
  const n = normalize(query);
  const i = n.search(/\d/);
  return i > 0 ? n.slice(0, i).trim() : n;
}

export function rankFamilies(query, catalog, limit = 5) {
  const lead = leadText(query);
  const result = catalog.families.map(f => {
    const whole = candidateScore(query, f.name, f.aliases);
    const leadScore = candidateScore(lead, f.name, f.aliases);
    const score = Math.min(1, whole * 0.68 + leadScore * 0.42);
    return { id:f.id, name:f.name, category:f.category, orderUnit:f.orderUnit, aliases:f.aliases, score };
  }).filter(x => x.score >= 0.12);
  result.sort((a,b) => b.score-a.score || a.name.localeCompare(b.name,"ru"));
  return result.slice(0,limit);
}

function numericTokens(value) {
  return tokens(value).filter(t => /\d/.test(t));
}

export function rankVariants(query, family, limit = 5) {
  if (!family) return [];
  const q = normalize(query);
  const qNums = numericTokens(q);
  const ranked = family.variants.map(v => {
    const vn = normalize(v.label);
    const vNums = numericTokens(vn);
    let score = 0;
    if (v.label === "Стандарт") score = 0.2;
    if (vn && vn !== "стандарт" && q.includes(vn)) score = 1;
    if (vNums.length) {
      const set = new Set(qNums);
      const matches = vNums.filter(n => set.has(n)).length;
      score = Math.max(score, matches / vNums.length);
      if (matches === 0 && qNums.length) score *= 0.35;
    }
    return { ...v, familyId:family.id, familyName:family.name, orderUnit:family.orderUnit, score };
  });
  ranked.sort((a,b)=>b.score-a.score || a.fullName.localeCompare(b.fullName,"ru"));
  return ranked.slice(0,limit);
}

export function flattenCatalog(catalog) {
  return catalog.families.flatMap(f => f.variants.map(v => ({
    id:v.id,
    familyId:f.id,
    category:f.category,
    baseName:f.name,
    variant:v.label,
    name:v.fullName,
    aliases:v.aliases,
    familyAliases:f.aliases,
    orderUnit:f.orderUnit
  })));
}
