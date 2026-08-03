const bizSdk = require('facebook-nodejs-business-sdk');
const Content = bizSdk.Content;
const CustomData = bizSdk.CustomData;
const DeliveryCategory = bizSdk.DeliveryCategory;
const EventRequest = bizSdk.EventRequest;
const UserData = bizSdk.UserData;
const ServerEvent = bizSdk.ServerEvent;

const access_token = 'EAAWakQGCDXoBQlkO3pFttf2voZCBzuo5ILNSZA7Ar9ZCjKDfjMrZByzIZCXbZCAxsZBhaQjnq287bsd2EI9zEXIZAFjAQ8EWJP0dQZAzGZCin1tjrR8nsoXnvBXqdDTMiXoYI0hXv7gvfGi98yxRr6BL2BFiTUhbD1bvI3ckR0XLxNZAHPYBGoNfCptUx9snEHNbAZDZD';
const pixel_id = '4190907814571632';
const api = bizSdk.FacebookAdsApi.init(access_token);

let currentUrl = 'https://aiprodgen.online'; // Default URL

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
