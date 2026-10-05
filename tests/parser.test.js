import test from "node:test";
import assert from "node:assert/strict";
import { parseLine } from "../src/parser.js";

const catalog={families:[{
  id:"F1",category:"Сухие смеси",name:"Knauf Rotband штукатурка гипсовая",aliases:["ротбанд"],orderUnit:"мешок",
  variants:[
    {id:"1",label:"25 кг",fullName:"Knauf Rotband штукатурка гипсовая, 25 кг",aliases:[]},
    {id:"2",label:"30 кг",fullName:"Knauf Rotband штукатурка гипсовая, 30 кг",aliases:[]}
  ]
},{
  id:"F2",category:"Крепёж",name:"Саморез кровельный с шайбой EPDM",aliases:["кровельный саморез"],orderUnit:"шт",
  variants:[
    {id:"3",label:"4.8x40 мм",fullName:"Саморез кровельный 4,8×40 мм, с шайбой EPDM",aliases:[]},
    {id:"4",label:"4.8x60 мм",fullName:"Саморез кровельный 4,8×60 мм, с шайбой EPDM",aliases:[]}
  ]
}]};

test("variant and bag quantity",()=>{
  const p=parseLine("ротбанд 25 кг 30 мешков",catalog);
  assert.equal(p.family.id,"F1");assert.equal(p.variant.id,"1");assert.equal(p.quantity,30);assert.equal(p.unit,"мешок");
});
test("bare trailing quantity inherits order unit",()=>{
  const p=parseLine("ротбанд 25 кг 30",catalog);
  assert.equal(p.variant.id,"1");assert.equal(p.quantity,30);assert.equal(p.unit,"мешок");
});
test("combined screw size stays variant",()=>{
  const p=parseLine("кровельный саморез 4.8x60 мм 100 штук",catalog);
  assert.equal(p.family.id,"F2");assert.equal(p.variant.id,"4");assert.equal(p.quantity,100);assert.equal(p.unit,"шт");
});

test("quantity parses when SKU variant is omitted",()=>{
  const localCatalog={families:[{
    id:"F3",category:"Крепёж",name:"Дюбель-гвоздь",aliases:["дюбель гвоздь"],orderUnit:"шт",
    variants:[
      {id:"5",label:"6x40 мм",fullName:"Дюбель-гвоздь 6×40 мм",aliases:[]},
      {id:"6",label:"8x60 мм",fullName:"Дюбель-гвоздь 8×60 мм",aliases:[]}
    ]
  }]};
  const p=parseLine("дюбель гвозди три штуки",localCatalog);
  assert.equal(p.family.id,"F3");
  assert.equal(p.variant,null);
  assert.equal(p.quantity,3);
  assert.equal(p.unit,"шт");
});
