const bizSdk = require('facebook-nodejs-business-sdk');
const Content = bizSdk.Content;
const CustomData = bizSdk.CustomData;
const DeliveryCategory = bizSdk.DeliveryCategory;
const EventRequest = bizSdk.EventRequest;
const UserData = bizSdk.UserData;
const ServerEvent = bizSdk.ServerEvent;

// This file used to have a live Facebook Conversions API access token and
// pixel ID hardcoded directly in source, present since the very first commit.
// The repository is now public, which made that token visible to anyone --
// exactly the credential used to send Purchase/Lead events, so it could be
// used to fire fake conversions and corrupt the signal Meta uses to optimize
// ad spend. There is no fallback here on purpose: silently no-op'ing with a
// wrong default would look identical to working while reporting nothing.
const access_token = process.env.FB_ACCESS_TOKEN;
const pixel_id = process.env.FB_PIXEL_ID;
const currentUrl = process.env.APP_URL || 'https://www.aiprodgen.online';

const isConfigured = !!(access_token && pixel_id);

if (isConfigured) {
    bizSdk.FacebookAdsApi.init(access_token);
} else if (process.env.NODE_ENV === 'production') {
    console.warn('[facebook] FB_ACCESS_TOKEN / FB_PIXEL_ID not set — server-side conversion events are not being sent.');
}

const logError = (error) => {
    console.error('Facebook CAPI Error:', error.response ? error.response.data : error.message);
};

const createUserData = (userEmail, clientIp, userAgent, fbp, fbc) => {
    const userData = new UserData()
        .setClientIpAddress(clientIp)
        .setClientUserAgent(userAgent);

    if (userEmail) {
        userData.setEmail(userEmail);
    }

    // Cookie IDs if available
    if (fbp) userData.setFbp(fbp);
    if (fbc) userData.setFbc(fbc);

    return userData;
};

const sendEvent = (eventName, userData, customData = {}, eventSourceUrl) => {
    if (!isConfigured) return Promise.resolve(null);

    const serverEvent = new ServerEvent()
        .setEventName(eventName)
        .setEventTime(Math.floor(new Date() / 1000))
        .setUserData(userData)
        .setCustomData(customData)
        .setEventSourceUrl(eventSourceUrl || currentUrl)
        .setActionSource('website');

    const eventsData = [serverEvent];
    const eventRequest = new EventRequest(access_token, pixel_id).setEvents(eventsData);

    return eventRequest.execute().then(
        response => {
            console.log(`FB CAPI Event '${eventName}' sent:`, response);
            return response;
        },
        err => {
            logError(err);
        }
    );
};

module.exports = {
    isConfigured,

    trackLead: async (userEmail, clientIp, userAgent, fbp, fbc) => {
        try {
            const userData = createUserData(userEmail, clientIp, userAgent, fbp, fbc);
            await sendEvent('Lead', userData);
        } catch (e) {
            console.error('Failed to track Lead:', e.message);
        }
    },

    trackPurchase: async (userEmail, amount, currency, orderId, clientIp, userAgent, fbp, fbc) => {
        try {
            const userData = createUserData(userEmail, clientIp, userAgent, fbp, fbc);
            const customData = new CustomData()
                .setValue(amount)
                .setCurrency(currency)
                .setOrderId(orderId);

            await sendEvent('Purchase', userData, customData);
        } catch (e) {
            console.error('Failed to track Purchase:', e.message);
        }
    },

    trackInitiateCheckout: async (userEmail, value, currency, clientIp, userAgent, fbp, fbc) => {
        try {
            const userData = createUserData(userEmail, clientIp, userAgent, fbp, fbc);
            const customData = new CustomData()
                .setValue(value)
                .setCurrency(currency);

            await sendEvent('InitiateCheckout', userData, customData);
        } catch (e) {
            console.error('Failed to track InitiateCheckout:', e.message);
        }
    }
};
