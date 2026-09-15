// tests/partner-ui.test.js
//
// Release D7: the minimal Partner Program UI -- four questions only
// (referral link, referred count, pending/available/paid, payout
// eligibility), no dashboard, no automation. lib/referrals.js and the
// /api/referral/* routes are already covered elsewhere; this file guards
// the page itself.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const partnerHtml = fs.readFileSync(path.join(root, 'public', 'partner.html'), 'utf8');

describe('the Partner Program page', () => {
    test('does not depend on a CDN host outside this app\'s CSP allowlist', () => {
        // Regression: the page originally loaded lucide icons from
        // unpkg.com, which this app's CSP does not allow. The blocked
        // script threw ReferenceError at the very first line of the page's
        // own inline script, which crashed before the DOMContentLoaded
        // listener ever registered -- the page looked like it was loading
        // forever, silently, with no visible error to a partner using it.
        // Caught only by loading the real page in a real browser.
        assert.ok(!partnerHtml.includes('unpkg.com'), 'must not load a script from unpkg.com (blocked by CSP)');
    });

    test('requires a token and redirects to login otherwise', () => {
        assert.ok(partnerHtml.includes("localStorage.getItem('token')"));
        assert.ok(partnerHtml.includes("window.location.href = '/login.html'"));
    });

    test('answers exactly the four questions, nothing more', () => {
        assert.ok(partnerHtml.includes('referralUrl'), 'question 1: referral link');
        assert.ok(partnerHtml.includes('referredCount'), 'question 2: how many referred');
        for (const id of ['pendingAmount', 'availableAmount', 'paidAmount']) {
            assert.ok(partnerHtml.includes(id), `question 3 needs ${id}`);
        }
        assert.ok(partnerHtml.includes('requestPayoutBtn') && partnerHtml.includes('payoutBlockedMsg'), 'question 4: can I get paid');

        // Explicitly rejected scope, per the spec: no leaderboard, no
        // analytics, no tiers, no automated payout API call.
        for (const rejected of ['leaderboard', 'chart', 'tier', 'Chart.js']) {
            assert.ok(!partnerHtml.toLowerCase().includes(rejected.toLowerCase()), `must not include ${rejected} -- out of scope for V1`);
        }
    });

    test('"Request Payout" opens a manual email, not an automated payout call', () => {
        // Payout is deliberately manual in V1 -- no Razorpay Route/PayPal
        // API integration. The button must be a mailto:, not a fetch() to
        // some payout endpoint that doesn't exist.
        assert.ok(partnerHtml.includes('mailto:support@aiprodgen.com'));
        assert.ok(!partnerHtml.includes('/api/referral/payout'), 'no payout-request API exists in V1');
    });

    test('reads real balances from the existing summary/code routes, not mock data', () => {
        assert.ok(partnerHtml.includes("fetch('/api/referral/code'"));
        assert.ok(partnerHtml.includes("fetch('/api/referral/summary'"));
    });

    test('is called "Partner Program," never "Affiliate Dashboard"', () => {
        assert.ok(partnerHtml.includes('Partner Program'));
        assert.ok(!partnerHtml.toLowerCase().includes('affiliate'));
    });
});

describe('the app links to the Partner Program', () => {
    test('app.html has a visible link to /partner.html', () => {
        const appHtml = fs.readFileSync(path.join(root, 'public', 'app.html'), 'utf8');
        assert.ok(appHtml.includes('href="/partner.html"'));
    });
});
