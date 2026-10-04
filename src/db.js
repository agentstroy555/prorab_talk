import pg from "pg";

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "true" ? { rejectUnauthorized:false } : undefined
});
const sleep = ms => new Promise(r=>setTimeout(r,ms));

export async function initDb(catalog) {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  let lastError;
  for (let attempt=1; attempt<=12; attempt++) {
    try { await pool.query("select 1"); lastError=null; break; }
    catch(error){ lastError=error; console.warn("Database not ready, attempt "+attempt+"/12"); await sleep(Math.min(1000*attempt,5000)); }
  }
  if(lastError) throw lastError;

  await pool.query(`
    create table if not exists catalog_items (
      id text primary key,
      category text not null,
      name text not null,
      aliases jsonb not null default '[]'::jsonb,
      base_name text,
      sku_variant text,
      order_unit text,
      active boolean not null default true,
      created_at timestamptz not null default now()
    );
    alter table catalog_items add column if not exists base_name text;
    alter table catalog_items add column if not exists sku_variant text;
    alter table catalog_items add column if not exists order_unit text;

    create table if not exists purchase_requests (
      id bigserial primary key,
      status text not null default 'draft',
      created_at timestamptz not null default now()
    );

    create table if not exists purchase_request_items (
      id bigserial primary key,
      request_id bigint not null references purchase_requests(id) on delete cascade,
      raw_text text,
      query_text text not null,
      catalog_item_id text references catalog_items(id),
      catalog_item_name text,
      base_item_name text,
      sku_variant text,
      quantity numeric,
      unit text,
      position integer not null,
      created_at timestamptz not null default now()
    );
    alter table purchase_request_items add column if not exists base_item_name text;
    alter table purchase_request_items add column if not exists sku_variant text;
  `);

  await pool.query(
    `insert into catalog_items (id, category, name, aliases, base_name, sku_variant, order_unit)
     select x.id, x.category, x.name, x.aliases, x.base_name, x.sku_variant, x.order_unit
     from jsonb_to_recordset($1::jsonb)
       as x(id text, category text, name text, aliases jsonb, base_name text, sku_variant text, order_unit text)
     on conflict (id) do update
       set category=excluded.category, name=excluded.name, aliases=excluded.aliases,
           base_name=excluded.base_name, sku_variant=excluded.sku_variant,
           order_unit=excluded.order_unit, active=true`,
    [JSON.stringify(catalog.map(x=>({
      id:x.id,category:x.category,name:x.name,aliases:x.aliases,
      base_name:x.baseName,sku_variant:x.variant,order_unit:x.orderUnit
    })))]
  );
}

export async function healthcheck(){ await pool.query("select 1"); return true; }

export async function savePurchaseRequest(items) {
  const client=await pool.connect();
  try{
    await client.query("begin");
    const request=await client.query("insert into purchase_requests default values returning id,status,created_at");
    const requestId=request.rows[0].id;
    for(let i=0;i<items.length;i++){
      const item=items[i];
      await client.query(
        `insert into purchase_request_items
         (request_id,raw_text,query_text,catalog_item_id,catalog_item_name,base_item_name,sku_variant,quantity,unit,position)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [requestId,item.rawText||item.text||null,item.text||"",item.catalogItemId||null,item.catalogItemName||null,
         item.familyName||null,item.variantLabel||null,item.quantity??null,item.unit||null,i]
      );
    }
    await client.query("commit");
    return request.rows[0];
  }catch(error){ await client.query("rollback"); throw error; }
  finally{ client.release(); }
}
