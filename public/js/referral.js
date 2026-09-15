// public/js/referral.js
//
// Captures a partner's referral code from ?ref= on first visit and carries
// it, client-side, to whatever page the signup form actually lives on. The
// referrals row is never created here -- only at the moment an account is
// actually created (server.js's signup/payment routes call
// lib/referrals.js's attributeReferral). This file's only job is not losing
// the code between the click and that moment.
//
// First-click-wins, enforced here too: an already-captured code is never
// overwritten by a later ?ref= on a subsequent page view, matching the
// server-side rule that one referred customer gets exactly one attribution.
(function () {
    var STORAGE_KEY = 'aip_ref_code';
    try {
        var params = new URLSearchParams(window.location.search);
        var incoming = params.get('ref');
        if (incoming && !localStorage.getItem(STORAGE_KEY)) {
            localStorage.setItem(STORAGE_KEY, incoming);
        }
    } catch (e) {
        // Private browsing / storage disabled -- attribution simply won't
        // carry across pages for this visitor. Not fatal to anything else.
    }

    window.AIP_REFERRAL = {
        code: function () {
            try { return localStorage.getItem(STORAGE_KEY) || null; } catch (e) { return null; }
        }
    };
})();
