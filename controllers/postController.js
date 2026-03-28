const { supabase }    = require('../config/supabase');
const { uploadBuffer, enrichMediaUrl, enrichUser, deleteFile, buildUrl } = require('../config/cloudinary');

// ── GET FEED ─────────────────────────────────────────────
exports.getFeed = async (req, res) => {
  const page  = parseInt(req.query.page)  || 1;
  const limit = parseInt(req.query.limit) || 20;
  const from  = (page - 1) * limit;

  try {
    // Step 1: get posts
    const { data: posts, error } = await supabase
      .from('posts')
      .select('id, user_id, content, media_url, media_type, thumbnail_url, likes_count, comments_count, views_count, created_at')
      .order('created_at', { ascending: false })
      .range(from, from + limit - 1);

    if (error) {
      console.error('getFeed posts error:', error);
      return res.status(500).json({ error: error.message });
    }
    if (!posts || posts.length === 0) return res.json([]);

    // Step 2: get user info for each unique user_id
    const userIds = [...new Set(posts.map(p => p.user_id).filter(Boolean))];
    const { data: users, error: usersError } = await supabase
      .from('users')
      .select('id, name, username, avatar_url, is_verified, gender')
      .in('id', userIds);

    if (usersError) {
      console.error('getFeed users error:', usersError);
    }

    const userMap = {};
    (users || []).forEach(u => { userMap[u.id] = u; });

    // Step 3: liked + bookmarked by current user
    const postIds = posts.map(p => p.id);
    const [likedRes, bookRes] = await Promise.all([
      supabase.from('post_likes').select('post_id').eq('user_id', req.user.id).in('post_id', postIds),
      supabase.from('bookmarks').select('post_id').eq('user_id', req.user.id).in('post_id', postIds),
    ]);
    const likedSet = new Set((likedRes.data || []).map(l => l.post_id));
    const bookSet  = new Set((bookRes.data  || []).map(b => b.post_id));

    return res.json(posts.map(p => {
      const enriched = enrichMediaUrl({ ...p });
      return {
        ...enriched,
        users:      enrichUser(userMap[p.user_id]) || null,
        liked:      likedSet.has(p.id),
        bookmarked: bookSet.has(p.id),
      };
    }));
  } catch (err) {
    console.error('getFeed exception:', err);
    return res.status(500).json({ error: err.message });
  }
};

// ── CREATE POST ──────────────────────────────────────────
exports.createPost = async (req, res) => {
  const { content, media_type } = req.body;
  // Support both single file (req.file) and multiple files (req.files array)
  // Works with upload.array('media') OR upload.fields([{name:'media'},{name:'audio'}])
  const files = Array.isArray(req.files)
    ? req.files
    : (req.files?.media || (req.file ? [req.file] : []));
  if (!content && !files.length) {
    return res.status(400).json({ error: 'Post must have text or media' });
  }

  let media_url = null;

  if (files.length === 1) {
    const isVideo = files[0].mimetype.startsWith('video');
    const cldType = isVideo ? 'post_video' : 'post_image';
    try {
      const result = await uploadBuffer(files[0].buffer, files[0].mimetype, cldType);
      media_url = result.public_id;   // store Cloudinary public_id in DB
    } catch (uploadErr) {
      console.error('[createPost] Cloudinary upload failed:', uploadErr.message);
      return res.status(500).json({ error: 'Media upload failed: ' + uploadErr.message });
    }
  } else if (files.length > 1) {
    // Multi-image: upload all concurrently, store JSON array of public_ids
    try {
      const results = await Promise.all(
        files.map(f => uploadBuffer(f.buffer, f.mimetype, 'post_image'))
      );
      media_url = JSON.stringify(results.map(r => r.public_id));
    } catch (uploadErr) {
      console.error('[createPost] Multi-image upload failed:', uploadErr.message);
      return res.status(500).json({ error: 'Media upload failed: ' + uploadErr.message });
    }
  }

  try {
    const { data: post, error } = await supabase
      .from('posts')
      .insert({
        user_id:        req.user.id,
        content:        content || null,
        media_url,
        media_type:     media_type || 'text',
        likes_count:    0,
        comments_count: 0
      })
      .select('id, user_id, content, media_url, media_type, thumbnail_url, likes_count, comments_count, views_count, created_at')
      .single();

    if (error) {
      console.error('createPost error:', error);
      return res.status(500).json({ error: error.message });
    }

    const { data: user } = await supabase
      .from('users')
      .select('id, name, username, avatar_url, is_verified, gender')
      .eq('id', req.user.id)
      .single();

    supabase.from('users').select('posts_count').eq('id', req.user.id).single()
      .then(({ data: u }) => supabase.from('users').update({ posts_count: (u?.posts_count || 0) + 1 }).eq('id', req.user.id))
      .catch(() => {});

    const enriched = enrichMediaUrl({ ...post });
    return res.status(201).json({ ...enriched, users: enrichUser(user), liked: false, bookmarked: false });
  } catch (err) {
    console.error('createPost exception:', err);
    return res.status(500).json({ error: err.message });
  }
};

// ── LIKE POST ────────────────────────────────────────────
exports.likePost = async (req, res) => {
  const { id } = req.params;
  try {
    const { data: existing } = await supabase
      .from('post_likes').select('post_id')
      .eq('user_id', req.user.id).eq('post_id', id).maybeSingle();

    const { data: post } = await supabase
      .from('posts').select('likes_count').eq('id', id).single();
    const current = post?.likes_count || 0;

    if (existing) {
      await supabase.from('post_likes').delete().eq('user_id', req.user.id).eq('post_id', id);
      const n = Math.max(0, current - 1);
      await supabase.from('posts').update({ likes_count: n }).eq('id', id);
      return res.json({ liked: false, likes_count: n });
    }
    await supabase.from('post_likes').insert({ user_id: req.user.id, post_id: id });
    const n = current + 1;
    await supabase.from('posts').update({ likes_count: n }).eq('id', id);
    return res.json({ liked: true, likes_count: n });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

// ── DELETE POST ──────────────────────────────────────────
exports.deletePost = async (req, res) => {
  const { id } = req.params;
  try {
    // Fetch media_url before deleting so we can clean up Cloudinary
    const { data: postData } = await supabase
      .from('posts').select('id, media_url, media_type')
      .eq('id', id).eq('user_id', req.user.id).maybeSingle();
    if (!postData) return res.status(404).json({ error: 'Post not found or not yours' });

    // Delete from Cloudinary (fire-and-forget)
    if (postData.media_url) {
      const rtype = postData.media_type === 'video' ? 'video' : 'image';
      if (postData.media_url.startsWith('[')) {
        try {
          JSON.parse(postData.media_url).forEach(pid => deleteFile(pid, 'image'));
        } catch (_) {}
      } else if (!postData.media_url.startsWith('http')) {
        deleteFile(postData.media_url, rtype);
      }
    }

    await supabase.from('posts').delete().eq('id', id).eq('user_id', req.user.id);
    return res.json({ message: 'Deleted' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

// ── BOOKMARK ─────────────────────────────────────────────
exports.bookmarkPost = async (req, res) => {
  const { id } = req.params;
  try {
    const { data: ex } = await supabase.from('bookmarks').select('post_id')
      .eq('user_id', req.user.id).eq('post_id', id).maybeSingle();
    if (ex) {
      await supabase.from('bookmarks').delete().eq('user_id', req.user.id).eq('post_id', id);
      return res.json({ bookmarked: false });
    }
    await supabase.from('bookmarks').insert({ user_id: req.user.id, post_id: id });
    return res.json({ bookmarked: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

// ── COMMENTS ─────────────────────────────────────────────
exports.getComments = async (req, res) => {
  const { id } = req.params;
  try {
    const { data: comments, error } = await supabase
      .from('comments')
      .select('id, post_id, user_id, content, comment_type, media_url, duration_seconds, likes_count, created_at')
      .eq('post_id', id).is('parent_id', null)
      .order('created_at', { ascending: true });
    if (error) throw error;
    if (!comments || !comments.length) return res.json([]);

    const userIds = [...new Set(comments.map(c => c.user_id))];
    const { data: users } = await supabase.from('users')
      .select('id, name, username, avatar_url, is_verified').in('id', userIds);
    const um = {};
    (users || []).forEach(u => { um[u.id] = u; });
    return res.json(comments.map(c => ({ ...enrichMediaUrl(c), users: enrichUser(um[c.user_id]) || null })));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

exports.addComment = async (req, res) => {
  const { id } = req.params;
  const { content, comment_type, parent_id, duration_seconds } = req.body;
  let media_url = null;
  if (req.file) {
    try {
      const cldType = req.file.mimetype.startsWith('audio') ? 'voice' : 'post_video';
      const result  = await uploadBuffer(req.file.buffer, req.file.mimetype, cldType);
      media_url = result.public_id;
    } catch (e) {
      console.error('[addComment] Cloudinary upload failed:', e.message);
    }
  }
  try {
    const { data, error } = await supabase.from('comments')
      .insert({
        post_id:          id,
        user_id:          req.user.id,
        content:          content || null,
        comment_type:     comment_type || 'text',
        media_url,
        duration_seconds: duration_seconds ? parseFloat(duration_seconds) : null,
        parent_id:        parent_id || null
      })
      .select('id, post_id, user_id, content, comment_type, media_url, duration_seconds, created_at')
      .single();
    if (error) throw error;

    const { data: user } = await supabase.from('users')
      .select('id, name, username, avatar_url, is_verified').eq('id', req.user.id).single();

    // Bump comment count async
    supabase.from('posts').select('comments_count').eq('id', id).single()
      .then(({ data: p }) => supabase.from('posts').update({ comments_count: (p?.comments_count || 0) + 1 }).eq('id', id))
      .catch(() => {});

    return res.status(201).json({ ...enrichMediaUrl(data), users: enrichUser(user) });
  } catch (err) {
    console.error('addComment error:', err);
    return res.status(500).json({ error: err.message });
  }
};

exports.deleteComment = async (req, res) => {
  const { commentId } = req.params;
  try {
    const { data } = await supabase.from('comments').delete()
      .eq('id', commentId).eq('user_id', req.user.id)
      .select('id').maybeSingle();
    if (!data) return res.status(404).json({ error: 'Not found' });
    return res.json({ message: 'Deleted' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

// ── SEARCH POSTS ─────────────────────────────────────────────────────────────
exports.searchPosts = async (req, res) => {
  const { q } = req.query;
  if (!q || !q.trim()) return res.json([]);
  try {
    const { data: posts, error } = await supabase
      .from('posts')
      .select('id, user_id, content, media_url, media_type, likes_count, comments_count, created_at')
      .ilike('content', `%${q.trim()}%`)
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) throw error;
    if (!posts || !posts.length) return res.json([]);

    const userIds = [...new Set(posts.map(p => p.user_id))];
    const { data: users } = await supabase
      .from('users').select('id, name, username, avatar_url, is_verified').in('id', userIds);
    const um = {}; (users || []).forEach(u => { um[u.id] = enrichUser(u); });
    return res.json(posts.map(p => ({ ...enrichMediaUrl(p), users: um[p.user_id] || null })));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};