// lib/workspace_service.js
const { supabaseAdmin } = require('./supabase');

/**
 * WorkspaceService
 * Manages operations for Workspaces.
 */
class WorkspaceService {
    /**
     * Get or create a workspace for a user.
     * @param {string} userId
     * @returns {Promise<Object>} Workspace object
     */
    static async getOrCreateWorkspace(userId) {
        // Try to get existing workspace
        let { data: workspace, error } = await supabaseAdmin
            .from('workspaces')
            .select('*')
            .eq('owner_id', userId)
            .limit(1)
            .single();

        if (workspace) {
            return workspace;
        }

        if (error && error.code !== 'PGRST116') { // Not found error
            console.error('Error fetching workspace:', error);
            throw new Error('Failed to fetch workspace');
        }

        // Create new workspace
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

        return newWorkspace;
    }
}

module.exports = WorkspaceService;
