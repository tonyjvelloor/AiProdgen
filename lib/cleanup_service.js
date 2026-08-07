const { supabaseAdmin } = require('./supabase');

class CleanupService {
    /**
     * Delete orphaned storage files when a job fails mid-execution.
     * @param {string[]} storageUrls - List of public storage URLs to delete
     */
    static async cleanupOrphanedStorage(storageUrls) {
        if (!storageUrls || storageUrls.length === 0) return;
        
        try {
            // Extract file paths from public URLs.
            // Example URL: https://ajikoajcncvwuxtyjgwl.supabase.co/storage/v1/object/public/generated-images/userId/12345.webp
            const bucketName = 'generated-images';
            const prefix = `/storage/v1/object/public/${bucketName}/`;
            
            const pathsToDelete = storageUrls
                .filter(url => url.includes(prefix))
                .map(url => url.split(prefix)[1]);

            if (pathsToDelete.length > 0) {
                const { error } = await supabaseAdmin.storage.from(bucketName).remove(pathsToDelete);
                if (error) console.error("[CleanupService] Error deleting files:", error);
                else console.log(`[CleanupService] Successfully deleted ${pathsToDelete.length} orphaned files.`);
            }
        } catch (error) {
            console.error("[CleanupService] Exception during cleanup:", error);
        }
    }
}

module.exports = CleanupService;
