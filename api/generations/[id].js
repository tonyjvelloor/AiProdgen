// api/generations/[id].js
const { supabaseAdmin } = require('../../lib/supabase');
const { requireAuth } = require('../../lib/auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const user = requireAuth(req, res);
  if (!user) return;

  const { id } = req.query;

  const { data, error } = await supabaseAdmin
    .from('generations')
    .select('id, status, image_url, created_at')
    .eq('id', id)
    .eq('user_id', user.id) // scoped to the requesting user, not just any ID
    .maybeSingle();

  if (error || !data) return res.status(404).json({ error: 'Not found' });

  res.status(200).json(data);
}
