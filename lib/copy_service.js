const { GoogleGenAI } = require('@google/genai');

class CopyService {
    /**
     * Generate text based on product context and a prompt.
     * @param {Object} options 
     * @returns {Promise<{success: boolean, text: string, error: string}>}
     */
    static async generate(options) {
        try {
            if (!process.env.GEMINI_API_KEY) {
                console.warn("[CopyService] GEMINI_API_KEY is missing. Using mock response.");
                return {
                    success: true,
                    text: `[Mock Copy] Generated text for: ${options.goal}`
                };
            }

            const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
            
            // Construct the system context from the product memory snapshot
            const productContext = options.productContext || {};
            const contextStr = `
Product Context:
Brand: ${productContext.brand || 'N/A'}
Category: ${productContext.category || 'N/A'}
Unique Selling Proposition: ${productContext.usp || 'N/A'}
Audience: ${productContext.audience || 'N/A'}
`;

            const fullPrompt = `${contextStr}\n\nTask: ${options.goal}\n\nRequirements: ${options.style}`;

            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: fullPrompt
            });

            return {
                success: true,
                text: response.text
            };
        } catch (error) {
            console.error('[CopyService] Error generating copy:', error);
            return {
                success: false,
                error: error.message || 'Failed to generate copy'
            };
        }
    }
}

module.exports = CopyService;
