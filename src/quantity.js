const UNIT_ALIASES = new Map([
  ["шт", "шт"], ["штука", "шт"], ["штуки", "шт"], ["штук", "шт"],
  ["мешок", "мешок"], ["мешка", "мешок"], ["мешков", "мешок"],
  ["кг", "кг"], ["килограмм", "кг"], ["килограмма", "кг"], ["килограммов", "кг"],
  ["г", "г"], ["грамм", "г"], ["грамма", "г"], ["граммов", "г"],
  ["лист", "лист"], ["листа", "лист"], ["листов", "лист"],
  ["рулон", "рулон"], ["рулона", "рулон"], ["рулонов", "рулон"],
  ["упаковка", "упаковка"], ["упаковки", "упаковка"], ["упаковок", "упаковка"],
  ["пачка", "пачка"], ["пачки", "пачка"], ["пачек", "пачка"],
  ["коробка", "коробка"], ["коробки", "коробка"], ["коробок", "коробка"],
  ["бухта", "бухта"], ["бухты", "бухта"], ["бухт", "бухта"],
  ["метр", "м"], ["метра", "м"], ["метров", "м"],
  ["литр", "л"], ["литра", "л"], ["литров", "л"],
  ["л", "л"], ["м", "м"]
]);

const ONES = {
  "ноль":0, "один":1, "одна":1, "одно":1, "два":2, "две":2, "три":3, "четыре":4,
  "пять":5, "шесть":6, "семь":7, "восемь":8, "девять":9,
  "десять":10, "одиннадцать":11, "двенадцать":12, "тринадцать":13, "четырнадцать":14,
  "пятнадцать":15, "шестнадцать":16, "семнадцать":17, "восемнадцать":18, "девятнадцать":19
};
const TENS = {
  "двадцать":20, "тридцать":30, "сорок":40, "пятьдесят":50,
  "шестьдесят":60, "семьдесят":70, "восемьдесят":80, "девяносто":90
};
const HUNDREDS = {
  "сто":100, "двести":200, "триста":300, "четыреста":400, "пятьсот":500,
  "шестьсот":600, "семьсот":700, "восемьсот":800, "девятьсот":900
};

function cleanToken(token) {
  return token.toLowerCase().replace(/ё/g, "е").replace(/^[^a-zа-я0-9.,]+|[^a-zа-я0-9.,]+$/gi, "");
}

function parseNumberTokens(tokens) {
  if (!tokens.length) return null;
  if (tokens.length === 1) {
    const raw = tokens[0].replace(",", ".");
    if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
    if (raw === "полтора" || raw === "полторы") return 1.5;
  }
  let value = 0;
  let recognized = 0;
  for (const t of tokens) {
    if (HUNDREDS[t] !== undefined) { value += HUNDREDS[t]; recognized++; continue; }
    if (TENS[t] !== undefined) { value += TENS[t]; recognized++; continue; }
    if (ONES[t] !== undefined) { value += ONES[t]; recognized++; continue; }
    return null;
  }
  return recognized ? value : null;
}

export function extractQuantity(input) {
  const original = String(input || "").trim();
  if (!original) return { quantity:null, unit:null, searchText:"" };

  const rawTokens = original.split(/\s+/);
  const tokens = rawTokens.map(cleanToken);
  const matches = [];

  for (let i = 0; i < tokens.length; i++) {
    const unit = UNIT_ALIASES.get(tokens[i]);
    if (!unit) continue;

    for (let width = Math.min(3, i); width >= 1; width--) {
      const start = i - width;
      const value = parseNumberTokens(tokens.slice(start, i));
      if (value !== null && Number.isFinite(value)) {
        matches.push({ start, end:i, quantity:value, unit });
        break;
      }
    }
  }

  if (!matches.length) return { quantity:null, unit:null, searchText:original };

  const chosen = matches[matches.length - 1];
  const searchTokens = rawTokens.filter((_, idx) => idx < chosen.start || idx > chosen.end);
  return {
    quantity: chosen.quantity,
    unit: chosen.unit,
    searchText: searchTokens.join(" ").replace(/\s+/g, " ").trim()
  };
}
