const { supabase } = require('../config/supabase');
const { uploadBuffer, enrichMediaUrl, enrichUser, deleteFile, buildUrl, buildVideoThumb } = require('../config/cloudinary');

// ===== USER CONTROLLER =====
exports.getProfile = async (req, res) => {
  const { username } = req.params;
  try {
    const { data, error } = await supabase
      .from('users')
      .select('id,name,username,gender,avatar_url,cover_url,bio,website,location,followers_count,following_count,posts_count,is_online,is_verified,created_at')
      .eq('username', username.toLowerCase())
      .single();
    if (error || !data) return res.status(404).json({ error: 'User not found' });
    const { data: isFollowing } = await supabase
      .from('follows').select('follower_id')
      .eq('follower_id', req.user.id).eq('following_id', data.id).single();
    res.json({ ...enrichUser(data), is_following: !!isFollowing });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.updateProfile = async (req, res) => {
  const { name, bio, website, location } = req.body;
  const updates = { updated_at: new Date() };
  if (name) updates.name = name;
  if (bio   !== undefined) updates.bio      = bio;
  if (website !== undefined) {
    // Store clean URL — strip leading slashes/localhost prefix
    let cleanUrl = (website || '').trim();
    updates.website = cleanUrl;
  }
  if (location !== undefined) updates.location = location;

  // Avatar upload → Cloudinary
  if (req.files?.avatar && req.files.avatar[0]) {
    try {
      const r = await uploadBuffer(req.files.avatar[0].buffer, req.files.avatar[0].mimetype, 'avatar');
      updates.avatar_url = r.public_id;
    } catch (e) { console.error('[updateProfile] avatar upload:', e.message); }
  }
  // Cover upload → Cloudinary
  if (req.files?.cover && req.files.cover[0]) {
    try {
      const r = await uploadBuffer(req.files.cover[0].buffer, req.files.cover[0].mimetype, 'cover');
      updates.cover_url = r.public_id;
    } catch (e) { console.error('[updateProfile] cover upload:', e.message); }
  }

  try {
    const { data, error } = await supabase
      .from('users').update(updates).eq('id', req.user.id)
      .select('id,name,username,email,gender,avatar_url,cover_url,bio,website,location,followers_count,following_count,posts_count,is_verified')
      .single();
    if (error) throw error;
    res.json(enrichUser(data));
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.followUser = async (req, res) => {
  const { id } = req.params;
  if (id === req.user.id) return res.status(400).json({ error: 'Cannot follow yourself' });
  try {
    const { data: existing } = await supabase
      .from('follows').select('follower_id')
      .eq('follower_id', req.user.id).eq('following_id', id).single();
    if (existing) {
      await supabase.from('follows').delete().eq('follower_id', req.user.id).eq('following_id', id);
      try { await supabase.rpc('decrement_followers', { target_id: id }); } catch (_) {}
      try { await supabase.rpc('decrement_following', { target_id: req.user.id }); } catch (_) {}
      // Return updated counts
      const { data: tData } = await supabase.from('users').select('followers_count').eq('id', id).single();
      const { data: mData } = await supabase.from('users').select('following_count').eq('id', req.user.id).single();
      return res.json({ following: false, followers_count: tData?.followers_count || 0, my_following_count: mData?.following_count || 0 });
    }
    await supabase.from('follows').insert({ follower_id: req.user.id, following_id: id });
    try { await supabase.rpc('increment_followers', { target_id: id }); } catch (_) {}
    try { await supabase.rpc('increment_following', { target_id: req.user.id }); } catch (_) {}
    const { data: tData } = await supabase.from('users').select('followers_count').eq('id', id).single();
    const { data: mData } = await supabase.from('users').select('following_count').eq('id', req.user.id).single();
    res.json({ following: true, followers_count: tData?.followers_count || 0, my_following_count: mData?.following_count || 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.getFollowers = async (req, res) => {
  const { username } = req.params;
  try {
    const { data: user } = await supabase.from('users').select('id').eq('username', username.toLowerCase()).single();
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { data: follows } = await supabase.from('follows').select('follower_id').eq('following_id', user.id);
    if (!follows || !follows.length) return res.json([]);
    const ids = follows.map(f => f.follower_id);
    const { data: users } = await supabase.from('users').select('id,name,username,avatar_url,is_verified,followers_count').in('id', ids);
    // Check which ones current user follows
    const { data: myFollows } = await supabase.from('follows').select('following_id').eq('follower_id', req.user.id).in('following_id', ids);
    const mySet = new Set((myFollows||[]).map(f => f.following_id));
    res.json((users||[]).map(u => ({ ...u, is_following: mySet.has(u.id) })));
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.getFollowing = async (req, res) => {
  const { username } = req.params;
  try {
    const { data: user } = await supabase.from('users').select('id').eq('username', username.toLowerCase()).single();
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { data: follows } = await supabase.from('follows').select('following_id').eq('follower_id', user.id);
    if (!follows || !follows.length) return res.json([]);
    const ids = follows.map(f => f.following_id);
    const { data: users } = await supabase.from('users').select('id,name,username,avatar_url,is_verified,followers_count').in('id', ids);
    const { data: myFollows } = await supabase.from('follows').select('following_id').eq('follower_id', req.user.id).in('following_id', ids);
    const mySet = new Set((myFollows||[]).map(f => f.following_id));
    res.json((users||[]).map(u => ({ ...u, is_following: mySet.has(u.id) })));
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.searchUsers = async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json([]);
  const { data } = await supabase
    .from('users')
    .select('id,name,username,avatar_url,gender,followers_count,is_verified')
    .or(`name.ilike.%${q}%,username.ilike.%${q}%`)
    .neq('id', req.user.id)
    .limit(20);
  res.json((data || []).map(u => enrichUser(u)));
};

exports.getUserPosts = async (req, res) => {
  const { username } = req.params;
  try {
    const { data: user } = await supabase.from('users').select('id,name,username,avatar_url,is_verified,gender').eq('username', username.toLowerCase()).single();
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { data: posts } = await supabase
      .from('posts')
      .select('id, user_id, content, media_url, media_type, likes_count, comments_count, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });
    if (!posts || !posts.length) return res.json([]);
    const ids = posts.map(p => p.id);
    const { data: liked } = await supabase.from('post_likes').select('post_id').eq('user_id', req.user.id).in('post_id', ids);
    const likedSet = new Set((liked || []).map(l => l.post_id));
    res.json(posts.map(p => {
      let parsed = { ...p };
      if (p.media_url) {
        const trimmed = p.media_url.trim();
        if (trimmed.charAt(0) === '[') {
          try {
            const arr = JSON.parse(trimmed);
            if (Array.isArray(arr) && arr.length) {
              parsed.media_urls = arr;
              parsed.media_url  = arr[0];
            }
          } catch(_) {}
        }
      }
      return { ...enrichMediaUrl(parsed), users: enrichUser(user), liked: likedSet.has(p.id) };
    }));
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.getUserVideos = async (req, res) => {
  const { username } = req.params;
  try {
    const { data: user } = await supabase.from('users').select('id,name,username,avatar_url').eq('username', username.toLowerCase()).single();
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { data: videos } = await supabase
      .from('videos')
      .select('id, user_id, title, video_url, thumbnail_url, views_count, likes_count, duration_seconds, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });
    res.json((videos||[]).map(v => ({ ...v, users: user })));
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.getUnreadCount = async (req, res) => {
  const uid = req.user.id;
  try {
    // Only count unread activity notifications — friend requests have their own section
    const { data } = await supabase.from('notifications').select('id')
      .eq('user_id', uid).eq('is_read', false);
    // Also count pending friend requests for the bell badge
    const { data: reqs } = await supabase.from('friend_requests').select('id')
      .eq('to_id', uid).eq('status', 'pending');
    const total = (data || []).length + (reqs || []).length;
    res.json({ count: total, notifCount: (data||[]).length, reqCount: (reqs||[]).length });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.getNotifications = async (req, res) => {
  try {
    const { data } = await supabase
      .from('notifications')
      .select('id, user_id, actor_id, type, reference_id, message, is_read, created_at')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(50);
    if (!data || !data.length) return res.json([]);
    // Fetch actor user info for each notification
    const actorIds = [...new Set(data.map(n => n.actor_id).filter(Boolean))];
    const { data: actors } = actorIds.length
      ? await supabase.from('users').select('id, name, username, avatar_url, is_verified').in('id', actorIds)
      : { data: [] };
    const actorMap = {};
    (actors || []).forEach(u => { actorMap[u.id] = u; });
    res.json(data.map(n => ({ ...n, users: enrichUser(actorMap[n.actor_id]) || null })));
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.markNotificationsRead = async (req, res) => {
  await supabase.from('notifications').update({ is_read: true }).eq('user_id', req.user.id).eq('is_read', false);
  res.json({ message: 'Marked read' });
};

exports.markOneNotificationRead = async (req, res) => {
  const { id } = req.params;
  await supabase.from('notifications').update({ is_read: true }).eq('id', id).eq('user_id', req.user.id);
  res.json({ success: true });
};

exports.deleteNotification = async (req, res) => {
  const { id } = req.params;
  await supabase.from('notifications').delete().eq('id', id).eq('user_id', req.user.id);
  res.json({ success: true });
};

// ===== CHAT CONTROLLER =====
exports.getConversations = async (req, res) => {
  const uid = req.user.id;
  try {
    const { data } = await supabase
      .from('messages')
      .select('sender_id,receiver_id,content,created_at,message_type')
      .or('sender_id.eq.' + uid + ',receiver_id.eq.' + uid)
      .order('created_at', { ascending: false });
    if (!data) return res.json([]);
    const seen = new Set();
    const convos = [];
    for (const m of data) {
      const partnerId = m.sender_id === uid ? m.receiver_id : m.sender_id;
      // Skip self-conversations
      if (partnerId === uid) continue;
      if (seen.has(partnerId)) continue;
      seen.add(partnerId);
      const { data: partner } = await supabase.from('users').select('id,name,username,avatar_url,gender,is_online,is_verified').eq('id', partnerId).single();
      if (!partner) continue;
      // Count unread messages for this conversation
      const { data: unreadMsgs } = await supabase.from('messages').select('id')
        .eq('receiver_id', uid).eq('sender_id', partnerId).eq('is_read', false);
      convos.push({ partner: enrichUser(partner), last_message: m.content, last_message_time: m.created_at, last_message_type: m.message_type, unread_count: (unreadMsgs || []).length });
    }
    res.json(convos);
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.getMessages = async (req, res) => {
  const { partnerId } = req.params;
  const { page = 1, limit = 50 } = req.query;
  const from = (page - 1) * limit;
  const uid = req.user.id;
  try {
    const { data } = await supabase
      .from('messages')
      .select('id, sender_id, receiver_id, content, media_url, message_type, font_style, is_read, created_at')
      .or('and(sender_id.eq.' + uid + ',receiver_id.eq.' + partnerId + '),and(sender_id.eq.' + partnerId + ',receiver_id.eq.' + uid + ')')
      .order('created_at', { ascending: true })
      .range(from, from + parseInt(limit) - 1);
    await supabase.from('messages').update({ is_read: true }).eq('receiver_id', uid).eq('sender_id', partnerId).eq('is_read', false);
    res.json((data || []).map(m => enrichMediaUrl(m)));
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.deleteConversation = async (req, res) => {
  const uid = req.user.id;
  const { partnerId } = req.params;
  if (!partnerId) return res.status(400).json({ error: 'partnerId is required' });
  try {
    // Delete messages in both directions using two separate deletes
    await supabase.from('messages').delete()
      .eq('sender_id', uid).eq('receiver_id', partnerId);
    await supabase.from('messages').delete()
      .eq('sender_id', partnerId).eq('receiver_id', uid);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.sendMessage = async (req, res) => {
  const { receiverId, content, message_type } = req.body;
  let media_url = null;
  if (req.file) {
    try {
      const cldType = req.file.mimetype.startsWith('audio') ? 'voice' : 'message_image';
      const r = await uploadBuffer(req.file.buffer, req.file.mimetype, cldType);
      media_url = r.public_id;
    } catch (e) { console.error('[sendMessage] upload:', e.message); }
  }
  try {
    const { data, error } = await supabase
      .from('messages')
      .insert({ sender_id: req.user.id, receiver_id: receiverId, content, media_url, message_type: message_type || 'text' })
      .select('*').single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
};

// ===== GROUPS CONTROLLER =====
exports.getGroups = async (req, res) => {
  try {
    const { data } = await supabase.from('groups')
      .select('id, name, description, category, creator_id, is_private, created_at')
      .order('created_at', { ascending: false });
    if (!data) return res.json([]);
    const ids = data.map(g => g.id);
    // Count actual members per group (reliable, no RPC needed)
    const { data: allMembers } = await supabase.from('group_members')
      .select('group_id').in('group_id', ids);
    const memberCounts = {};
    (allMembers || []).forEach(m => {
      memberCounts[m.group_id] = (memberCounts[m.group_id] || 0) + 1;
    });
    // Check which groups the current user has joined
    const { data: myMemberships } = await supabase.from('group_members')
      .select('group_id').eq('user_id', req.user.id).in('group_id', ids);
    const memberSet = new Set((myMemberships || []).map(m => m.group_id));
    res.json(data.map(g => ({
      ...g,
      members_count: memberCounts[g.id] || 0,
      is_member: memberSet.has(g.id)
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.createGroup = async (req, res) => {
  const { name, description, category } = req.body;
  try {
    const { data, error } = await supabase.from('groups')
      .insert({ name, description, category, creator_id: req.user.id, members_count: 1 })
      .select('*').single();
    if (error) throw error;
    await supabase.from('group_members').insert({ group_id: data.id, user_id: req.user.id, role: 'admin' });
    res.status(201).json({ ...data, members_count: 1, is_member: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.joinGroup = async (req, res) => {
  const { id } = req.params;
  try {
    const { data: existing } = await supabase.from('group_members').select('group_id')
      .eq('group_id', id).eq('user_id', req.user.id).maybeSingle();
    if (existing) {
      // Leave group
      await supabase.from('group_members').delete().eq('group_id', id).eq('user_id', req.user.id);
      // Recount actual members and update stored column
      const { data: members } = await supabase.from('group_members').select('group_id').eq('group_id', id);
      await supabase.from('groups').update({ members_count: (members || []).length }).eq('id', id);
      return res.json({ joined: false, members_count: (members || []).length });
    }
    // Join group
    await supabase.from('group_members').insert({ group_id: id, user_id: req.user.id });
    const { data: members } = await supabase.from('group_members').select('group_id').eq('group_id', id);
    const newCount = (members || []).length;
    await supabase.from('groups').update({ members_count: newCount }).eq('id', id);
    res.json({ joined: true, members_count: newCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

// ===== VIDEOS CONTROLLER =====
exports.getVideos = async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const from = (page - 1) * parseInt(limit);
  try {
    const { data: videos } = await supabase
      .from('videos')
      .select('id, user_id, title, description, video_url, thumbnail_url, views_count, likes_count, comments_count, duration_seconds, created_at')
      .order('created_at', { ascending: false })
      .range(from, from + parseInt(limit) - 1);
    if (!videos || !videos.length) return res.json([]);
    const userIds = [...new Set(videos.map(v => v.user_id))];
    const { data: users } = await supabase.from('users').select('id,name,username,avatar_url,is_verified').in('id', userIds);
    const um = {}; (users||[]).forEach(u => { um[u.id] = u; });
    res.json(videos.map(v => ({ ...enrichMediaUrl(v), thumbnail_url: buildVideoThumb(v.video_url), users: enrichUser(um[v.user_id]) || null })));
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.uploadVideo = async (req, res) => {
  const { title, description, duration_seconds } = req.body;
  const fileObj = Array.isArray(req.files)
    ? req.files.find(f => f.fieldname === 'video')
    : req.files?.video?.[0] || req.file;
  if (!fileObj) return res.status(400).json({ error: 'No video file' });
  try {
    const result    = await uploadBuffer(fileObj.buffer, fileObj.mimetype, 'video');
    const video_url = result.public_id;
    const dur       = result.duration || (duration_seconds ? parseFloat(duration_seconds) : null);
    const { data, error } = await supabase
      .from('videos')
      .insert({ user_id: req.user.id, title, description, video_url, duration_seconds: dur })
      .select('*').single();
    if (error) throw error;
    // Return with full CDN URL
    res.status(201).json(enrichMediaUrl({ ...data, video_url: result.public_id }));
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.viewVideo = async (req, res) => {
  try { await supabase.rpc('increment_video_views', { video_id: req.params.id }); } catch (_) {}
  res.json({ success: true });
};
// ===== GROUP EXTENDED CONTROLLERS =====

exports.getGroupMembers = async (req, res) => {
  const { id } = req.params;
  try {
    const { data, error } = await supabase
      .from('group_members')
      .select('role, joined_at, users:user_id(id, name, username, avatar_url, is_verified, is_online)')
      .eq('group_id', id)
      .order('joined_at', { ascending: true });
    if (error) throw error;
    res.json(data || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.updateGroupMemberRole = async (req, res) => {
  const { id, uid } = req.params;
  const { role } = req.body;
  const validRoles = ['admin', 'moderator', 'member'];
  if (!validRoles.includes(role)) return res.status(400).json({ error: 'Invalid role' });
  try {
    // Only admins can change roles
    const { data: me } = await supabase
      .from('group_members').select('role')
      .eq('group_id', id).eq('user_id', req.user.id).single();
    if (!me || me.role !== 'admin') return res.status(403).json({ error: 'Only admins can change roles' });

    const { error } = await supabase
      .from('group_members').update({ role })
      .eq('group_id', id).eq('user_id', uid);
    if (error) throw error;
    res.json({ success: true, role });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.removeGroupMember = async (req, res) => {
  const { id, uid } = req.params;
  try {
    // Only admins/moderators can remove members, or a user removing themselves
    const isSelf = uid === req.user.id;
    if (!isSelf) {
      const { data: me } = await supabase
        .from('group_members').select('role')
        .eq('group_id', id).eq('user_id', req.user.id).single();
      if (!me || !['admin', 'moderator'].includes(me.role)) {
        return res.status(403).json({ error: 'Not authorized' });
      }
    }
    await supabase.from('group_members').delete().eq('group_id', id).eq('user_id', uid);
    // Decrement member count
    const { data: g } = await supabase.from('groups').select('members_count').eq('id', id).single();
    await supabase.from('groups').update({ members_count: Math.max(0, (g?.members_count || 1) - 1) }).eq('id', id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.getGroupMessages = async (req, res) => {
  const { id } = req.params;
  const { page = 1, limit = 50 } = req.query;
  const from = (page - 1) * parseInt(limit);
  try {
    // Must be a member to read messages
    const { data: membership } = await supabase
      .from('group_members').select('role')
      .eq('group_id', id).eq('user_id', req.user.id).single();
    if (!membership) return res.status(403).json({ error: 'Join the group to see messages' });

    const { data, error } = await supabase
      .from('group_messages')
      .select('id, group_id, sender_id, content, media_url, message_type, created_at')
      .eq('group_id', id)
      .order('created_at', { ascending: true })
      .range(from, from + parseInt(limit) - 1);
    if (error) throw error;
    if (!data || !data.length) return res.json([]);

    const userIds = [...new Set(data.map(m => m.sender_id).filter(Boolean))];
    const { data: users } = await supabase
      .from('users').select('id, name, username, avatar_url').in('id', userIds);
    const um = {}; (users || []).forEach(u => { um[u.id] = u; });
    res.json(data.map(m => ({ ...enrichMediaUrl(m), sender: enrichUser(um[m.sender_id]) || null })));
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.sendGroupMessage = async (req, res) => {
  const { id } = req.params;
  const { content, message_type } = req.body;
  try {
    // Must be a member
    const { data: membership } = await supabase
      .from('group_members').select('role')
      .eq('group_id', id).eq('user_id', req.user.id).single();
    if (!membership) return res.status(403).json({ error: 'Join the group to send messages' });

    let media_url = null;
    if (req.file) {
      try {
        const cldType = req.file.mimetype.startsWith('video') ? 'post_video' : 'message_image';
        const r = await uploadBuffer(req.file.buffer, req.file.mimetype, cldType);
        media_url = r.public_id;
      } catch (e) { console.error('[sendGroupMessage] upload:', e.message); }
    }
    const { data, error } = await supabase
      .from('group_messages')
      .insert({
        group_id: id,
        sender_id: req.user.id,
        content: content || null,
        media_url,
        message_type: message_type || 'text'
      })
      .select('id, group_id, sender_id, content, media_url, message_type, created_at')
      .single();
    if (error) throw error;

    const { data: sender } = await supabase
      .from('users').select('id, name, username, avatar_url').eq('id', req.user.id).single();
    res.status(201).json({ ...data, sender });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.updateGroup = async (req, res) => {
  const { id } = req.params;
  const { name, description, category, is_private } = req.body;
  try {
    // Only admin can update
    const { data: me } = await supabase
      .from('group_members').select('role')
      .eq('group_id', id).eq('user_id', req.user.id).single();
    if (!me || me.role !== 'admin') return res.status(403).json({ error: 'Only admins can edit the group' });

    const updates = {};
    if (name) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (category) updates.category = category;
    if (is_private !== undefined) updates.is_private = is_private;

    const { data, error } = await supabase
      .from('groups').update(updates).eq('id', id).select('*').single();
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.deleteGroup = async (req, res) => {
  const { id } = req.params;
  try {
    // Only the creator can delete
    const { data: g } = await supabase.from('groups').select('creator_id').eq('id', id).single();
    if (!g) return res.status(404).json({ error: 'Group not found' });
    if (g.creator_id !== req.user.id) return res.status(403).json({ error: 'Only the creator can delete this group' });

    await supabase.from('group_messages').delete().eq('group_id', id);
    await supabase.from('group_members').delete().eq('group_id', id);
    await supabase.from('groups').delete().eq('id', id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

// ===== FRIEND REQUEST CONTROLLERS =====

exports.sendFriendRequest = async (req, res) => {
  const { id: toId } = req.params;
  const fromId = req.user.id;
  if (toId === fromId) return res.status(400).json({ error: 'Cannot add yourself' });
  try {
    // Check if already friends or pending
    const { data: existing } = await supabase.from('friend_requests')
      .select('id, status')
      .or(`and(from_id.eq.${fromId},to_id.eq.${toId}),and(from_id.eq.${toId},to_id.eq.${fromId})`)
      .maybeSingle();
    if (existing) {
      if (existing.status === 'accepted') return res.status(400).json({ error: 'Already friends' });
      if (existing.status === 'pending')  return res.status(400).json({ error: 'Request already sent' });
    }
    const { data, error } = await supabase.from('friend_requests')
      .insert({ from_id: fromId, to_id: toId, status: 'pending' })
      .select('id, status').single();
    if (error) throw error;
    // Create notification
    try {
      const { data: sender } = await supabase.from('users').select('name').eq('id', fromId).single();
      await supabase.from('notifications').insert({
        user_id: toId, actor_id: fromId, type: 'friend_request',
        message: `${sender?.name || 'Someone'} sent you a friend request`
      });
    } catch(_) { /* notification failure is non-critical */ }
    res.status(201).json({ success: true, status: 'pending' });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.acceptFriendRequest = async (req, res) => {
  const { id: fromId } = req.params;
  const toId = req.user.id;
  try {
    const { data, error } = await supabase.from('friend_requests')
      .update({ status: 'accepted' })
      .eq('from_id', fromId).eq('to_id', toId).eq('status', 'pending')
      .select('id').maybeSingle();
    if (error || !data) return res.status(404).json({ error: 'Request not found' });
    // Auto-follow each other
    try {
      await supabase.from('follows').upsert([
        { follower_id: toId, following_id: fromId },
        { follower_id: fromId, following_id: toId }
      ]);
    } catch(_) { /* follow failure is non-critical */ }
    res.json({ success: true, status: 'accepted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.declineFriendRequest = async (req, res) => {
  const { id: fromId } = req.params;
  const toId = req.user.id;
  try {
    await supabase.from('friend_requests')
      .update({ status: 'declined' })
      .eq('from_id', fromId).eq('to_id', toId).eq('status', 'pending');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.removeFriend = async (req, res) => {
  const { id } = req.params;
  const uid = req.user.id;
  try {
    await supabase.from('friend_requests').delete()
      .or(`and(from_id.eq.${uid},to_id.eq.${id}),and(from_id.eq.${id},to_id.eq.${uid})`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.getFriendRequests = async (req, res) => {
  try {
    const { data } = await supabase.from('friend_requests')
      .select('id, from_id, status, created_at, sender:from_id(id, name, username, avatar_url, is_verified)')
      .eq('to_id', req.user.id).eq('status', 'pending')
      .order('created_at', { ascending: false });
    res.json((data || []).map(r => ({ ...r, sender: enrichUser(r.sender) })));
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.getFriendStatus = async (req, res) => {
  const { id } = req.params;
  const uid = req.user.id;
  try {
    const { data } = await supabase.from('friend_requests')
      .select('id, from_id, to_id, status')
      .or(`and(from_id.eq.${uid},to_id.eq.${id}),and(from_id.eq.${id},to_id.eq.${uid})`)
      .maybeSingle();
    if (!data) return res.json({ status: 'none' });
    const isSender = data.from_id === uid;
    res.json({ status: data.status, isSender });
  } catch (err) { res.json({ status: 'none' }); }
};

exports.getSuggestedUsers = async (req, res) => {
  const uid = req.user.id;
  try {
    // Get IDs already following
    const { data: following } = await supabase
      .from('follows').select('following_id').eq('follower_id', uid);
    const followingIds = (following || []).map(f => f.following_id);
    followingIds.push(uid); // exclude self

    // Get IDs with pending/accepted friend requests
    const { data: friendReqs } = await supabase
      .from('friend_requests').select('from_id, to_id')
      .or(`from_id.eq.${uid},to_id.eq.${uid}`);
    const friendIds = new Set();
    (friendReqs || []).forEach(r => {
      friendIds.add(r.from_id === uid ? r.to_id : r.from_id);
    });

    // Fetch users not followed and not friended, ordered by followers
    let query = supabase.from('users')
      .select('id, name, username, avatar_url, gender, followers_count, is_verified, bio')
      .order('followers_count', { ascending: false })
      .limit(20);
    if (followingIds.length) query = query.not('id', 'in', `(${followingIds.join(',')})`);

    const { data: users } = await query;
    // Filter out friend IDs in JS (Supabase not-in with large sets can be tricky)
    const filtered = (users || []).filter(u => !friendIds.has(u.id)).slice(0, 10);
    res.json(filtered);
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.getUserFriends = async (req, res) => {
  const { username } = req.params;
  try {
    const { data: user } = await supabase.from('users')
      .select('id').eq('username', username.toLowerCase()).single();
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { data } = await supabase.from('friend_requests')
      .select('from_id, to_id, users_from:from_id(id,name,username,avatar_url,is_verified), users_to:to_id(id,name,username,avatar_url,is_verified)')
      .or(`from_id.eq.${user.id},to_id.eq.${user.id}`)
      .eq('status', 'accepted');

    const friends = (data || []).map(r => {
      return r.from_id === user.id ? r.users_to : r.users_from;
    }).filter(Boolean);
    res.json(friends);
  } catch (err) { res.status(500).json({ error: err.message }); }
};

// ===== STORIES =====
exports.getStories = async (req, res) => {
  const uid = req.user.id;
  try {
    // Get stories from followed users + friends + own, within last 24 hours
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    // Get ALL people this user is connected to (follows + friends in both directions)
    const { data: follows } = await supabase.from('follows').select('following_id').eq('follower_id', uid);
    const followIds = (follows || []).map(f => f.following_id);
    // Friends: all accepted requests where uid is involved (either direction)
    const { data: friendReqs } = await supabase.from('friend_requests')
      .select('from_id, to_id')
      .eq('status', 'accepted')
      .or('from_id.eq.' + uid + ',to_id.eq.' + uid);
    const friendIds = (friendReqs || []).map(function(r) {
      return r.from_id === uid ? r.to_id : r.from_id;
    });
    const allIds = [...new Set([uid, ...followIds, ...friendIds])];

    const { data: stories, error } = await supabase.from('stories')
      .select('id, user_id, media_url, media_type, caption, created_at')
      .in('user_id', allIds)
      .gte('created_at', since)
      .order('created_at', { ascending: true });
    if (error) {
      console.error('[getStories] error:', error.message);
      return res.json([]); // return empty rather than crash if table missing
    }
    if (!stories || !stories.length) return res.json([]);

    const userIds = [...new Set(stories.map(s => s.user_id))];
    const { data: users } = await supabase.from('users')
      .select('id, name, username, avatar_url, is_verified').in('id', userIds);
    const umap = {}; (users||[]).forEach(u => { umap[u.id] = u; });

    // Get which stories current user has viewed (graceful if table doesn't exist yet)
    let viewedSet = new Set();
    try {
      const { data: views } = await supabase.from('story_views')
        .select('story_id').eq('viewer_id', uid);
      viewedSet = new Set((views||[]).map(v => v.story_id));
    } catch(_) {}

    // Group by user
    const grouped = {};
    stories.forEach(s => {
      if (!grouped[s.user_id]) grouped[s.user_id] = { user: enrichUser(umap[s.user_id]), stories: [], has_unseen: false };
      const seen = viewedSet.has(s.id);
      grouped[s.user_id].stories.push({ ...enrichMediaUrl(s), seen });
      if (!seen) grouped[s.user_id].has_unseen = true;
    });

    // Own stories first, then others
    const result = Object.values(grouped).sort((a, b) => {
      if (a.user.id === uid) return -1;
      if (b.user.id === uid) return 1;
      return b.has_unseen - a.has_unseen;
    });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.createStory = async (req, res) => {
  const { caption } = req.body;
  const rawFile = Array.isArray(req.files)
    ? req.files.find(f => f.fieldname === 'media')
    : req.files?.media?.[0] || req.file;

  if (!rawFile) return res.status(400).json({ error: 'No media file received — make sure the field name is "media"' });

  const isVideo    = rawFile.mimetype.startsWith('video');
  const media_type = isVideo ? 'video' : 'image';
  const cldType    = isVideo ? 'story_video' : 'story_image';

  let media_url;
  try {
    const result = await uploadBuffer(rawFile.buffer, rawFile.mimetype, cldType);
    media_url = result.public_id;
  } catch (uploadErr) {
    console.error('[createStory] Cloudinary upload failed:', uploadErr.message);
    return res.status(500).json({ error: 'Story upload failed: ' + uploadErr.message });
  }
  try {
    const { data, error } = await supabase
      .from('stories')
      .insert({ user_id: req.user.id, media_url, media_type, caption: caption || null })
      .select('id, user_id, media_url, media_type, caption, created_at')
      .single();
    if (error) {
      console.error('[createStory] DB error:', JSON.stringify(error));
      return res.status(500).json({ error: 'DB error: ' + error.message + ' — Have you run the stories SQL migration in Supabase?' });
    }
    res.status(201).json(data);
  } catch (err) {
    console.error('[createStory] exception:', err.message);
    res.status(500).json({ error: err.message });
  }
};

exports.viewStory = async (req, res) => {
  const { id } = req.params;
  try {
    await supabase.from('story_views').upsert({ story_id: id, viewer_id: req.user.id });
  } catch(_) { /* story_views table may not exist yet — non-critical */ }
  res.json({ success: true });
};

exports.deleteStory = async (req, res) => {
  const { id } = req.params;
  try {
    await supabase.from('stories').delete().eq('id', id).eq('user_id', req.user.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
};