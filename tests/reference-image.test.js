const {test}=require('node:test');const assert=require('node:assert/strict');
function substitute(name,exports){const id=require.resolve(name);require.cache[id]={id,filename:id,loaded:true,exports};}
let request;let reference='https://test.supabase.co/storage/v1/object/public/product-images/owner/original.png';let uploaded;
substitute('@google/genai',{GoogleGenAI:class{constructor(){this.models={generateContent:async options=>{request=options;return {candidates:[{content:{parts:[{thought:true,inlineData:{data:'RFJBRlQ='}},{inlineData:{mimeType:'image/png',data:'RklOQUw='}}]}}]};}};}}});
substitute('../database',{logGeneration:async()=> 'log',getUserPlan:async()=>({plan:'hobbyist_ltd'})});
substitute('../lib/userKeys',{getUserProviderKey:async()=> 'customer-test-key'});
const query={select(){return query;},eq(){return query;},maybeSingle:async()=>({data:{storage_path:reference},error:null}),update(){return query;},then(resolve){return Promise.resolve({error:null}).then(resolve);}};
substitute('../lib/supabase',{supabaseAdmin:{from:()=>query,storage:{from:()=>({upload:async(name,buffer,options)=>{uploaded={name,buffer,options};return {error:null};},getPublicUrl:()=>({data:{publicUrl:'https://test.supabase.co/storage/v1/object/public/generated-images/output.png'}})})}}});
process.env.SUPABASE_URL='https://test.supabase.co';
global.fetch=async()=>({ok:true,headers:new Headers({'content-type':'image/png'}),arrayBuffer:async()=>Buffer.from('ACTUAL_PRODUCT')});
const ImageService=require('../lib/image_service');
test('the actual uploaded photo is sent as an image reference; thought images are discarded',async()=>{
    const result=await ImageService.generate('owner','original',{productId:'product',goal:'hero',category:'bottle',style:'white',aspectRatio:'1:1'});
    assert.equal(result.success,true);assert.equal(request.contents[1].inlineData.mimeType,'image/png');
    assert.equal(Buffer.from(request.contents[1].inlineData.data,'base64').toString(),'ACTUAL_PRODUCT');
    assert.equal(uploaded.buffer.toString(),'FINAL');assert.equal(uploaded.options.contentType,'image/png');assert.equal(result.fundedBy,'byok');assert.equal(result.cost,0);
});
test('a product shoot cannot silently become text-only generation',async()=>{
    await assert.rejects(ImageService.generate('owner',null,{productId:'product'}),/Upload a product image/);
});
test('reference-image fetching rejects a non-storage origin before making a request',async()=>{
    reference='http://127.0.0.1/private';let fetched=false;global.fetch=async()=>{fetched=true;};
    await assert.rejects(ImageService.generate('owner','reference',{productId:'product'}),/Invalid product image storage/);
    assert.equal(fetched,false);
});
