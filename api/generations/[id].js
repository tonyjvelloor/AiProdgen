// api/generations/[id].js
const { supabaseAdmin } = require('../../lib/supabase');
const { requireAuth } = require('../../lib/auth');

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'GET') return res.status(405).end();

    const user = requireAuth(req, res);
    if (!user) return;

    const { id } = req.query;

    // /api/generate returns an ai_runs id, not a generations-table id.
    const { data: run, error: runError } = await supabaseAdmin.from('ai_runs')
      .select('id, status, started_at, user_id').eq('id', id).maybeSingle();
    if (runError) throw runError;
    if (run) {
      if (run.user_id !== user.id) return res.status(403).json({ error: 'Forbidden' });
      const { data: outputs, error: outputError } = await supabaseAdmin.from('outputs')
        .select('storage_path').contains('metadata', { run_id: id }).limit(1);
      if (outputError) throw outputError;
      return res.status(200).json({ id: run.id, status: run.status, image_url: outputs?.[0]?.storage_path || null, created_at: run.started_at });
    }
    // Keep old generation ids readable for existing clients.
    const { data, error } = await supabaseAdmin.from('generations')
      .select('id, status, image_url, created_at, user_id').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Not found' });
    if (data.user_id !== user.id) return res.status(403).json({ error: 'Forbidden' });
    return res.status(200).json({ id: data.id, status: data.status, image_url: data.image_url, created_at: data.created_at });

  } catch (e) {
    res.status(500).json({ error: 'Internal server error',  });
  }
}
