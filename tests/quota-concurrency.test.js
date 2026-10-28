const { test } = require('node:test');
const assert = require('node:assert/strict');
const period = new Date(Date.UTC(new Date().getUTCFullYear(),new Date().getUTCMonth(),1)).toISOString();
let row = {id:'owner',monthly_gen_count:0,usage_period_start:period,is_active:true};
function query() {
    let changes=null; const filters=[];
    const q={
        select(){return q;}, update(value){changes=value;return q;}, eq(key,value){filters.push([key,value]);return q;},
        single(){return q;},maybeSingle(){return q;},
        then(resolve){
            const matched=filters.every(([k,v])=>row[k]===v);
            if(changes && matched) Object.assign(row,changes);
            return Promise.resolve({data:matched?{...row}:null,error:null}).then(resolve);
        }
    };return q;
}
const modulePath=require.resolve('../lib/supabase');
require.cache[modulePath]={id:modulePath,filename:modulePath,loaded:true,exports:{isSupabaseConfigured:true,supabaseAdmin:{from:query}}};
const db=require('../database');
test('concurrent requests cannot exceed the monthly image allowance',async()=>{
    row.monthly_gen_count=0;
    const reservations=await Promise.all(Array.from({length:10},()=>db.reserveGenerationQuota('owner',1,3)));
    assert.equal(reservations.filter(Boolean).length,3);
    assert.equal(row.monthly_gen_count,3);
});
test('failed generation restores only its reserved allowance',async()=>{
    row.monthly_gen_count=0;
    const reservation=await db.reserveGenerationQuota('owner',2,3);
    assert.equal(row.monthly_gen_count,2);
    await db.releaseGenerationQuota('owner',reservation);
    assert.equal(row.monthly_gen_count,0);
});
test('a previous-month failure does not reduce this month’s usage',async()=>{
    row.monthly_gen_count=2;
    await db.releaseGenerationQuota('owner',{amount:1,period:'2020-01-01T00:00:00.000Z'});
    assert.equal(row.monthly_gen_count,2);
});
