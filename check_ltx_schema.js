const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;

async function checkSchema() {
    console.log("Checking LTX-Video schema...");
    try {
        const response = await fetch("https://api.replicate.com/v1/models/lightricks/ltx-2-fast", {
            headers: {
                "Authorization": `Token ${REPLICATE_API_TOKEN}`,
                "Content-Type": "application/json",
            }
        });
        const data = await response.json();
        console.log(JSON.stringify(data, null, 2));
    } catch (error) {
        console.error("Error:", error);
    }
}

checkSchema();
