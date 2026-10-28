// lib/providers.js
const { GoogleGenAI } = require('@google/genai');
const { GEMINI_TEXT_MODEL, GEMINI_IMAGE_MODEL } = require('./models');
const replicate = require('../services/replicate');

async function validateProviderKey(provider, apiKey) {
    if (provider === 'gemini') {
        try {
            const ai = new GoogleGenAI({ apiKey });
            // Simple fast test call
            await ai.models.generateContent({
                model: GEMINI_TEXT_MODEL,
                contents: 'test',
            });
            return true;
        } catch (e) {
            console.error('Gemini Key Validation Failed:', e);
            return false;
        }
    }
    if (provider === 'replicate') {
        return !!apiKey && typeof apiKey === 'string' && apiKey.startsWith('r8_');
    }
    return false;
}

async function callProvider({ provider, apiKey, imageBase64, prompt, userId }) {
    if (provider === 'gemini') {
        const key = apiKey || process.env.GEMINI_API_KEY;
        if (!key) throw new Error('Gemini API key is required');
        const ai = new GoogleGenAI({ apiKey: key });
        
        const contents = [];
        if (prompt) contents.push({ text: prompt });
        if (imageBase64) {
            const matched = imageBase64.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/s);
            if (!matched) throw new Error('A PNG, JPEG or WebP data URL is required.');
            const cleanBase64 = matched[2];
            contents.push({
                inlineData: {
                    mimeType: matched[1],
                    data: cleanBase64
                }
            });
        }

        const response = await ai.models.generateContent({
            model: GEMINI_IMAGE_MODEL,
            contents,
            config: { responseModalities: ['TEXT', 'IMAGE'] }
        });

        // Extract non-thought image part
        const candidate = response.candidates?.[0];
        const imagePart = candidate?.content?.parts?.find(p => p.inlineData && !p.thought);
        if (imagePart?.inlineData?.data) {
            return `data:${imagePart.inlineData.mimeType || 'image/png'};base64,${imagePart.inlineData.data}`;
        }
        throw new Error('Gemini did not return an image part.');
    }

    if (provider === 'replicate') {
        return await replicate.generateImageFlux(prompt || 'Product commercial photography', { aspectRatio: '1:1' });
    }

    throw new Error(`Provider ${provider} is not supported.`);
}

module.exports = { validateProviderKey, callProvider };
