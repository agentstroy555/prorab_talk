export function likelyWhisperHallucination(text){
  const t=String(text||"").trim().toLowerCase().replace(/ё/g,"е").replace(/\s+/g," ");
  if(!t)return true;
  const plain=t.replace(/[.!?…,:;—–-]+$/g,"").trim();
  if(plain==="продолжение следует"||plain==="спасибо за просмотр")return true;
  if(/^смотрите продолжение(?:\s+в\s+следующей\s+серии)?[.!?…]*$/.test(t))return true;
  if(/^продолжение\s+в\s+следующей\s+серии[.!?…]*$/.test(t))return true;
  if(t.startsWith("редактор субтитров")||t.startsWith("корректор"))return true;
  if(t.startsWith("переводчик субтитров"))return true;
  if(t.startsWith("субтитры")){
    return /(?:^|\s)(?:редактор|корректор|перевод|переводчик|делал|делала|сделал|сделала|создал|создала|создавал|создавала|подготовил|подготовила|подогнал|подогнала)(?:\s|$|[.,!?…])/.test(t);
  }
  return false;
}
