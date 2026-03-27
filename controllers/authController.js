const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { supabase } = require('../config/supabase');
const { validationResult } = require('express-validator');

const sign = (id) => jwt.sign({ userId: id }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });

exports.signup = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  const { name, username, email, password, gender } = req.body;
  try {
    const { data: existing } = await supabase.from('users').select('id').or(`email.eq.${email.toLowerCase()},username.eq.${username.toLowerCase()}`).limit(1);
    if (existing?.length) return res.status(409).json({ error: 'Email or username already taken' });
    const hash = await bcrypt.hash(password, 12);
    const { data, error } = await supabase.from('users').insert({ name, username: username.toLowerCase(), email: email.toLowerCase(), password_hash: hash, gender: gender || 'default' }).select('id,name,username,email,gender,avatar_url,is_verified,created_at').single();
    if (error) throw error;
    res.status(201).json({ token: sign(data.id), user: data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Signup failed' });
  }
};

exports.login = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  const { email, password } = req.body;
  try {
    const { data, error } = await supabase.from('users').select('*').eq('email', email.toLowerCase()).single();
    if (error || !data) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, data.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    await supabase.from('users').update({ is_online: true, updated_at: new Date() }).eq('id', data.id);
    const { password_hash, ...safe } = data;
    res.json({ token: sign(data.id), user: { ...safe, is_online: true } });
  } catch (err) {
    res.status(500).json({ error: 'Login failed' });
  }
};

exports.logout = async (req, res) => {
  await supabase.from('users').update({ is_online: false }).eq('id', req.user.id);
  res.json({ message: 'Logged out' });
};

exports.getMe = async (req, res) => {
  const { data } = await supabase.from('users').select('id,name,username,email,gender,avatar_url,cover_url,bio,website,location,followers_count,following_count,posts_count,is_online,is_verified,created_at').eq('id', req.user.id).single();
  res.json(data);
};
