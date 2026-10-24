// lib/workspace_service.js
const { supabaseAdmin } = require('./supabase');

// In-memory cache for user workspaces (TTL: 5 minutes)
const workspaceCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * WorkspaceService
 * Manages operations for Workspaces with high-performance in-memory caching.
 */
class WorkspaceService {
    /**
     * Get or create a workspace for a user.
     * @param {string} userId
     * @returns {Promise<Object>} Workspace object
     */
    static async getOrCreateWorkspace(userId) {
        // 1. Check in-memory cache first for instant response
        const cached = workspaceCache.get(userId);
        if (cached && Date.now() < cached.expiresAt) {
            return cached.workspace;
        }

        // 2. Query database if not cached or expired
        let { data: workspace, error } = await supabaseAdmin
            .from('workspaces')
            .select('*')
            .eq('owner_id', userId)
            .limit(1)
            .single();

        if (workspace) {
            workspaceCache.set(userId, { workspace, expiresAt: Date.now() + CACHE_TTL_MS });
            return workspace;
        }

        if (error && error.code !== 'PGRST116') { // Not found error
            console.error('Error fetching workspace:', error);
            throw new Error('Failed to fetch workspace');
        }

        // 3. Create new workspace if user has none
        const { data: newWorkspace, error: createError } = await supabaseAdmin
            .from('workspaces')
            .insert({
                name: 'Personal Workspace',
                owner_id: userId,
                plan: 'free'
            })
            .select()
            .single();

        if (createError) {
            console.error('Error creating workspace:', createError);
            throw new Error('Failed to create workspace');
        }

        workspaceCache.set(userId, { workspace: newWorkspace, expiresAt: Date.now() + CACHE_TTL_MS });
        return newWorkspace;
    }

    /**
     * Invalidate cache when workspace is modified
     */
    static invalidateCache(userId) {
        workspaceCache.delete(userId);
    }
}

module.exports = WorkspaceService;
