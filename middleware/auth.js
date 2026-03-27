const jwt = require('jsonwebtoken');
const { supabase } = require('../config/supabase');

const auth = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const { data, error } = await supabase
      .from('users')
      .select('id, name, username, email, gender, avatar_url, is_verified')
      .eq('id', decoded.userId)
      .single();
    if (error || !data) return res.status(401).json({ error: 'User not found' });
    req.user = data;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') return res.status(401).json({ error: 'Token expired' });
    return res.status(401).json({ error: 'Invalid token' });
  }
};

module.exports = auth;
