export function exportDraft(draft, lines, version) {
  const rows = lines.map((l, i) => { const p = JSON.parse(l.parsed); return {
    number: i + 1, lineId: l.id, text: l.raw_text, product: p.family?.name || '',
    familyId: p.family?.id || null, skuId: p.variant?.id || null, variant: p.variant?.label || '',
    quantity: p.quantity ?? null, unit: p.unit || p.orderUnit || '', status: l.status
  }; });
  const safe = x => { let s = String(x ?? ''); if (/^[\s]*[=+@-]/.test(s)) s = "'" + s; return '"' + s.replaceAll('"', '""') + '"'; };
  const csv = '\uFEFF' + [['№','ID строки','Текст','Товар','Вариант','Количество','Единица','Статус'],
    ...rows.map(r => [r.number,r.lineId,r.text,r.product,r.variant,r.quantity,r.unit,r.status])]
    .map(r => r.map(safe).join(';')).join('\r\n');
  return { csv, json: JSON.stringify({ version, request: draft, items: rows }, null, 2) };
}
