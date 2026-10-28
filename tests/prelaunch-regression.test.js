const { test, after, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
process.env.JWT_SECRET = 'isolated-regression-secret-only';
const jwt = require('jsonwebtoken');
const harness = require('./helpers/app');
const db = require('../database');
const ProductService = require('../lib/product_service');
const WorkspaceService = require('../lib/workspace_service');
const OutputService = require('../lib/output_service');
const Coordinator = require('../lib/execution_coordinator');
const CopyService = require('../lib/copy_service');
const Production = require('../lib/engines/production');
const headers = { authorization: `Bearer ${jwt.sign({userId:'owner',email:'owner@example.com'},process.env.JWT_SECRET)}`, 'content-type':'application/json' };
after(async () => harness.stop());
afterEach(() => mock.restoreAll());

for (const job of ['photography','commerce','campaign_blueprint','campaign_production']) {
    test(`${job} rejects another workspace before dispatching`, async () => {
        mock.method(db,'getUserById',async()=>({is_active:1,email_verified_at:'2026-01-01'}));
        mock.method(ProductService,'getProductById',async()=>({id:'product',workspace_id:'foreign'}));
        mock.method(WorkspaceService,'getOrCreateWorkspace',async()=>({id:'owned'}));
        const dispatch = mock.method(Coordinator,'processJob',async()=>{});
        const response=await harness.request('POST',`/api/products/product/jobs/${job}`,headers,'{}');
        assert.equal(response.statusCode,403);
        assert.equal(dispatch.mock.calls.length,0);
    });
}

test('verified database state unlocks a session issued before verification', async () => {
    mock.method(db,'getUserById',async()=>({is_active:1,email_verified_at:'2026-01-01'}));
    mock.method(ProductService,'getProductById',async()=>null);
    const response=await harness.request('POST','/api/products/missing/jobs/photography',headers,'{}');
    assert.equal(response.statusCode,404); // Passed verification despite JWT having no verified claim.
});

test('a stale verified JWT cannot unlock an unverified account', async () => {
    mock.method(db,'getUserById',async()=>({is_active:1,email_verified_at:null}));
    const response=await harness.request('POST','/api/products/product/jobs/photography',headers,'{}');
    assert.equal(response.statusCode,403);
    assert.match(response.body,/verification/);
});

test('legacy upscale rejects anonymous callers', async()=>{
    const response=await harness.request('POST','/api/upscale-image',{'content-type':'application/json'},'{}');
    assert.equal(response.statusCode,401);
});

test('campaign production rejects a foreign product blueprint',async()=>{
    mock.method(OutputService,'getCollection',async()=>({product_id:'foreign',job:'campaign_blueprint',outputs:[]}));
    await assert.rejects(Production.startRun('owner','product','foreign-blueprint','concept',{}),/does not belong/);
});

test('a declined credit reservation never creates a refund',async()=>{
    mock.method(db,'createAIRun',async()=> 'run');
    mock.method(db,'reserveCredits',async()=>false);
    mock.method(db,'updateAIRun',async()=>{});
    mock.method(OutputService,'updateCollectionStatus',async()=>{});
    const refund=mock.method(db,'rollbackCredits',async()=>{});
    await Coordinator.processJob({userId:'owner',productId:'product',collectionId:'collection'}, {outputs:4}, [], {});
    assert.equal(refund.mock.calls.length,0);
});

test('text-only blueprint can complete with zero output credits',async()=>{
    mock.method(db,'createAIRun',async()=> 'run');
    const reserve=mock.method(db,'reserveCredits',async()=>false);
    mock.method(db,'createOutputAuthorization',async()=>null);
    const update=mock.method(db,'updateAIRun',async()=>{});
    mock.method(OutputService,'updateCollectionStatus',async()=>{});
    await Coordinator.processJob({userId:'owner',productId:'product',collectionId:'collection'}, {outputs:0,providerCost:0,storageCost:0,platformCost:0}, [], {});
    assert.equal(reserve.mock.calls.length,0);
    assert.equal(update.mock.calls[0].arguments[1].status,'completed');
});

test('missing copy configuration fails instead of returning mock content',async()=>{
    const response=await CopyService.generate({goal:'title'});
    assert.equal(response.success,false);
    assert.match(response.error,/unavailable/);
});
