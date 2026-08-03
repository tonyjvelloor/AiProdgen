// database.js (Supabase Adapter)
const { supabaseAdmin } = require('./lib/supabase');

// Helper to mock the expected user object shape for the legacy Express app
function mapUser(sbUser) {
    if (!sbUser) return null;
    return {
        id: sbUser.id,
        email: sbUser.email,
        password_hash: '$2b$10$EixZaYVK1fsbw1ZfbX3OXePaWxn96p36WQoeG6Lruj3vjPGG.xyz', // Mocked hash for 'password123' to prevent auth crash
        is_active: 1,
        plan: 'free',
        created_at: sbUser.created_at
    };
}

module.exports = {
    // ============ User Functions ============
    getUserByEmail: async (email) => {
        const { data } = await supabaseAdmin.from('users').select('*').eq('email', email).single();
        return mapUser(data);
    },
    getUserById: async (id) => {
        const { data } = await supabaseAdmin.from('users').select('*').eq('id', id).single();
        return mapUser(data);
    },
    createUser: async (email, passwordHash, paymentId, orderId, amountPaid = 0, currency = 'USD') => {
        const { data } = await supabaseAdmin.from('users').insert({ email }).select().single();
        return mapUser(data);
    },
    emailExists: async (email) => {
        const { data } = await supabaseAdmin.from('users').select('id').eq('email', email).single();
        return !!data;
    },
    updateUser: async (id, updates) => { return true; },
    deleteUser: async (id) => { return true; },
    updatePassword: async (email, newPasswordHash) => { return true; },

    // ============ Plan / Entitlement Functions ============
    getUserPlan: async (userId) => {
        return { plan: 'free', monthly_gen_count: 0, monthly_ugc_count: 0 };
    },
    setUserPlan: async (userId, plan, billingCycle = 'monthly') => { return true; },
    incrementGenCount: async (userId) => { return true; },
    incrementUGCCount: async (userId) => { return true; },

    // ============ Credit Functions ============
    getUserCredits: async (userId) => { return 0; },
    getUserCreditInfo: async (userId) => { return { credits: 0, total_purchased: 0, total_used: 0 }; },
    initUserCredits: async (userId) => { return true; },
    addCredits: async (userId, credits) => { return true; },
    useCredits: async (userId, creditsToUse = 1) => { return true; },
    recordCreditPurchase: async (userId, credits, amount, payId, ordId) => { return true; },
    logUpscaleUsage: async (userId, credits, scale, face) => { return true; },
    getCreditPurchaseHistory: async (userId) => { return []; },
    getUpscaleUsageHistory: async (userId) => { return []; },

    // ============ Generation History ============
    logGeneration: async (userId, prompt, imageCount) => { return true; },
    getGenerationHistory: async (userId, limit = 20) => {
        const { data } = await supabaseAdmin.from('generations').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(limit);
        return data || [];
    },
    getUserStats: async (userId) => { return { total_generations: 0, total_images: 0, last_generation: null }; },

    // ============ Admin ============
    getAdminStats: async () => { return { userCount: 0, totalImages: 0, totalGenerations: 0, revenue: 0 }; },
    getAllUsers: async (limit = 50) => {
        const { data } = await supabaseAdmin.from('users').select('*').order('created_at', { ascending: false }).limit(limit);
        return (data || []).map(mapUser);
    },

    // ============ UGC / Pending Orders / Misc ============
    createPendingOrder: async () => { return true; },
    getPendingOrder: async () => { return null; },
    deletePendingOrder: async () => { return true; },
    createResetToken: async () => { return true; },
    getValidResetToken: async () => { return null; },
    markTokenUsed: async () => { return true; },
    createUGCProject: async () => { return true; },
    updateUGCProject: async () => { return true; },
    getUserProjects: async () => { return []; },
    getProjectById: async () => { return null; },
    addToGallery: async () => { return true; },
    getPublicGallery: async () => { return []; },
    getUserGallery: async () => { return []; },
    toggleGalleryPublic: async () => { return true; }
};
