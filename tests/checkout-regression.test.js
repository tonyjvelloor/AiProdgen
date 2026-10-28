const {test,after,afterEach,mock}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
process.env.RAZORPAY_KEY_ID='test_public_key';process.env.RAZORPAY_KEY_SECRET='isolated-payment-secret';
const razorpayPath=require.resolve('razorpay');
let sequence=0;
require.cache[razorpayPath]={id:razorpayPath,filename:razorpayPath,loaded:true,exports:class{constructor(){this.orders={create:async details=>({id:`order_${++sequence}`,...details})};}}};
const harness=require('./helpers/app');
const db=require('../database');const auth=require('../auth');
const grants=require('../lib/entitlements');const referrals=require('../lib/referrals');const email=require('../email');
const orders=new Map();const users=new Map();const payments=[];
after(async()=>harness.stop());afterEach(()=>mock.restoreAll());
function setup(){
    orders.clear();users.clear();payments.length=0;
    mock.method(db,'emailExists',async email=>users.has(email));
    mock.method(db,'createPendingOrder',async(id,email,amount,currency)=>orders.set(id,{razorpay_order_id:id,email,amount,currency}));
    mock.method(db,'getPendingOrder',async id=>orders.get(id)||null);
    mock.method(db,'deletePendingOrder',async id=>orders.delete(id));
    mock.method(db,'getUserByEmail',async email=>users.get(email)||null);
    mock.method(auth,'registerUser',async(email)=>{users.set(email,{id:'buyer',email});return {email,password:'test-password'};});
    mock.method(db,'setUserPlan',async(id,plan)=>{for(const user of users.values())if(user.id===id)user.plan=plan;});
    mock.method(db,'initUserCredits',async()=>{});mock.method(db,'addCredits',async()=>{});
    mock.method(grants,'seedPlanEntitlements',async()=>{});
    mock.method(referrals,'attributeReferral',async()=>{});mock.method(referrals,'recordEligiblePayment',async()=>{});
    mock.method(db,'recordPayment',async payment=>payments.push(payment));
    mock.method(email,'sendCredentialsEmail',async()=>true);
}
const post=(url,body)=>harness.request('POST',url,{'content-type':'application/json'},JSON.stringify(body));
for(const [amount,currency,plan]of [[47,'USD','hobbyist_ltd'],[3999,'INR','hobbyist_ltd'],[97,'USD','pro_founder_ltd'],[197,'USD','agency_ltd']]){
    test(`${currency} ${amount} creates and activates the advertised plan`,async()=>{
        setup();const email=`buyer${amount}@example.com`;
        const response=await post('/api/payment/create-order',{email,amount,currency});assert.equal(response.statusCode,200,response.body);
        const order=JSON.parse(response.body);assert.equal(order.amount,amount*100);assert.equal(order.currency,currency);
        const paymentId=`payment_${order.orderId}`;
        const signature=crypto.createHmac('sha256',process.env.RAZORPAY_KEY_SECRET).update(`${order.orderId}|${paymentId}`).digest('hex');
        const verification=await post('/api/payment/verify',{razorpay_order_id:order.orderId,razorpay_payment_id:paymentId,razorpay_signature:signature});
        assert.equal(verification.statusCode,200,verification.body);assert.equal(users.get(email).plan,plan);
        assert.equal(payments[0].amount,amount*100);assert.equal(payments[0].currency,currency);
        assert.equal((await post('/api/payment/verify',{razorpay_order_id:order.orderId,razorpay_payment_id:paymentId,razorpay_signature:signature})).statusCode,400);
    });
}
test('an arbitrary cheap amount cannot buy a lifetime plan',async()=>{
    setup();const response=await post('/api/payment/create-order',{email:'buyer@example.com',amount:1,currency:'USD'});
    assert.equal(response.statusCode,400);assert.equal(orders.size,0);
});
