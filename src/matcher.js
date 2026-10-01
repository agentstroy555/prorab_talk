const STOPWORDS = new Set([
  "мне","надо","нужно","дай","дайте","пожалуйста","еще","и","а","на","для","из","по",
  "штук","штука","штуки","мешок","мешка","мешков","лист","листа","листов","рулон","рулона","рулонов"
]);

export function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[«»"'()]/g, " ")
    .replace(/×/g, "x")
    .replace(/ø/g, " ")
    .replace(/[^a-zа-я0-9.,x\-\/\s]/gi, " ")
    .replace(/,/g, ".")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(value) {
  return normalize(value)
    .split(" ")
    .map(x => x.trim())
    .filter(x => x && !STOPWORDS.has(x));
}

function tokenWeight(token) {
  if (/^\d+(?:\.\d+)?$/.test(token)) return 3.5;
  if (/\d/.test(token)) return 2.5;
  if (token.length >= 7) return 1.35;
  return 1;
}

function weightedOverlap(queryTokens, candidateTokens) {
  if (!queryTokens.length || !candidateTokens.length) return 0;
  const candidate = new Set(candidateTokens);
  let hit = 0;
  let total = 0;
  for (const token of queryTokens) {
    const w = tokenWeight(token);
    total += w;
    if (candidate.has(token)) {
      hit += w;
      continue;
    }
    if (token.length >= 5) {
      const partial = [...candidate].some(c => c.length >= 5 && (c.startsWith(token) || token.startsWith(c)));
      if (partial) hit += w * 0.72;
    }
  }
  return total ? hit / total : 0;
}

function numericCompatibility(queryTokens, candidateTokens) {
  const qNums = queryTokens.filter(t => /\d/.test(t));
  if (!qNums.length) return { match:0, conflict:false };
  const cNums = new Set(candidateTokens.filter(t => /\d/.test(t)));
  if (!cNums.size) return { match:0, conflict:false };
  let matched = 0;
  for (const n of qNums) if (cNums.has(n)) matched++;
  return {
    match: matched / qNums.length,
    conflict: matched === 0
  };
}

function aliasScore(queryNorm, queryTokens, aliases) {
  let best = 0;
  for (const alias of aliases || []) {
    const a = normalize(alias);
    if (!a) continue;
    const at = tokens(a);
    let score = weightedOverlap(queryTokens, at);
    if (queryNorm === a) score = 1;
    else if (queryNorm.includes(a)) score = Math.max(score, 0.96);
    else if (a.includes(queryNorm) && queryNorm.length >= 4) score = Math.max(score, 0.9);
    best = Math.max(best, score);
  }
  return best;
}

export function matchCatalog(query, catalog, limit = 8) {
  const queryNorm = normalize(query);
  const qTokens = tokens(queryNorm);
  if (!qTokens.length) return [];

  const scored = [];
  for (const item of catalog) {
    const nameNorm = normalize(item.name);
    const nameTokens = tokens(nameNorm);
    const nameScore = weightedOverlap(qTokens, nameTokens);
    const aliases = Array.isArray(item.aliases) ? item.aliases : [];
    const aScore = aliasScore(queryNorm, qTokens, aliases);
    const numeric = numericCompatibility(qTokens, nameTokens);

    let score = Math.max(nameScore, aScore * 0.97);
    if (queryNorm === nameNorm) score = 1;
    if (nameNorm.includes(queryNorm) && queryNorm.length >= 5) score = Math.max(score, 0.91);
    if (numeric.match > 0) score = Math.min(1, score + numeric.match * 0.16);
    if (numeric.conflict && aScore < 0.95) score *= 0.62;

    if (score >= 0.16) scored.push({ ...item, score: Math.round(score * 1000) / 1000 });
  }

  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "ru"));
  return scored.slice(0, limit);
}
