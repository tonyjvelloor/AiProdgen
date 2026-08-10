// api/generations/[id].js
const { supabaseAdmin } = require('../../lib/supabase');
const { requireAuth } = require('../../lib/auth');

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'GET') return res.status(405).end();

    const user = requireAuth(req, res);
    if (!user) return;

    const { id } = req.query;

    const { data, error } = await supabaseAdmin
      .from('generations')
      .select('id, status, image_url, created_at, user_id')
      .eq('id', id)
      .maybeSingle();

    if (error || !data) return res.status(404).json({ error: 'Not found' });
    if (data.user_id !== user.id) return res.status(403).json({ error: 'Forbidden' });

    res.status(200).json({
      id: data.id,
      status: data.status,
      image_url: data.image_url,
      created_at: data.created_at
    });
  } catch (e) {
    res.status(500).json({ error: 'Internal server error', message: e.message });
  }
}
