const { supabase } = require('../config/supabase');
const path         = require('path');
const fs           = require('fs');
const { execFile } = require('child_process');

// ── FFmpeg: trim + optional music mix ────────────────────────────────────────
const processVideo = (videoPath, opts) => new Promise((resolve, reject) => {
  const { trimStart, trimEnd, audioPath, audioVol } = opts;
  const ext     = path.extname(videoPath) || '.mp4';
  const outPath = videoPath.replace(ext, '_ve' + ext);
  const args    = [];

  if (trimStart != null) args.push('-ss', String(trimStart));
  args.push('-i', videoPath);

  if (audioPath) {
    args.push('-i', audioPath);
    const vol = parseFloat(audioVol) || 0.7;
    args.push(
      '-filter_complex',
      `[0:a]aformat=fltp:44100:stereo,volume=1.0[va];[1:a]aformat=fltp:44100:stereo,volume=${vol}[ma];[va][ma]amix=inputs=2:duration=shortest[aout]`,
      '-map', '0:v', '-map', '[aout]',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k'
    );
  } else {
    args.push('-c', 'copy');
  }

  if (trimStart != null && trimEnd != null) {
    args.push('-t', String(Math.max(0.1, parseFloat(trimEnd) - parseFloat(trimStart))));
  }

  args.push('-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', '-y', outPath);

  execFile('ffmpeg', args, { timeout: 300000 }, (err) => {
    if (err) return reject(new Error('FFmpeg: ' + err.message));
    resolve(outPath);
  });
});

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
      let parsed = { ...p };
      const raw = p.media_url;
      if (raw) {
        const trimmed = raw.trim();
        if (trimmed.charAt(0) === '[') {
          // Multi-image: media_url is a JSON array string
          try {
            const arr = JSON.parse(trimmed);
            if (Array.isArray(arr) && arr.length) {
              parsed.media_urls = arr;
              parsed.media_url  = arr[0]; // first image as preview
            }
          } catch(_) { /* leave as single url */ }
        }
      }
      return {
        ...parsed,
        users:      userMap[p.user_id] || null,
        liked:      likedSet.has(p.id),
        bookmarked: bookSet.has(p.id)
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
    const folder = files[0].mimetype.startsWith('video') ? 'videos' : 'images';
    let filePath = files[0].path;

    // Apply FFmpeg trim + music mix for video posts
    if (files[0].mimetype.startsWith('video')) {
      const trimStart = req.body.trim_start != null && req.body.trim_start !== '' ? parseFloat(req.body.trim_start) : null;
      const trimEnd   = req.body.trim_end   != null && req.body.trim_end   !== '' ? parseFloat(req.body.trim_end)   : null;
      const audioObj  = Array.isArray(req.files) ? req.files.find(f => f.fieldname === 'audio') : req.files?.audio?.[0] || null;
      const audioPath = audioObj ? audioObj.path : null;
      const audioVol  = req.body.audio_vol || '0.7';
      if (trimStart != null || audioPath) {
        try {
          const procPath = await processVideo(filePath, { trimStart, trimEnd, audioPath, audioVol });
          try { fs.unlinkSync(filePath); } catch (_) {}
          if (audioPath) try { fs.unlinkSync(audioPath); } catch (_) {}
          const cleanPath = procPath.replace('_ve', '');
          fs.renameSync(procPath, cleanPath);
          filePath = cleanPath;
        } catch (e) {
          console.error('[createPost] FFmpeg failed:', e.message, '— using original');
        }
      }
    }

    media_url = '/uploads/' + folder + '/' + path.basename(filePath);
  } else if (files.length > 1) {
    // Store all URLs as JSON array in media_url field (no extra column needed)
    const urls = files.map(f => '/uploads/images/' + f.filename);
    media_url = JSON.stringify(urls);
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

    // Parse media_url back to array if it's JSON (multi-image)
    let parsedPost = { ...post };
    if (post.media_url) {
      const trimmed = post.media_url.trim();
      if (trimmed.charAt(0) === '[') {
        try {
          const arr = JSON.parse(trimmed);
          if (Array.isArray(arr) && arr.length) {
            parsedPost.media_urls = arr;
            parsedPost.media_url  = arr[0];
          }
        } catch(_) {}
      }
    }
    return res.status(201).json({ ...parsedPost, users: user, liked: false, bookmarked: false });
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
    const { data, error } = await supabase
      .from('posts').delete()
      .eq('id', id).eq('user_id', req.user.id)
      .select('id').maybeSingle();
    if (!data) return res.status(404).json({ error: 'Post not found or not yours' });
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
    return res.json(comments.map(c => ({ ...c, users: um[c.user_id] || null })));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

exports.addComment = async (req, res) => {
  const { id } = req.params;
  const { content, comment_type, parent_id, duration_seconds } = req.body;
  let media_url = null;
  if (req.file) {
    const folder = req.file.mimetype.startsWith('audio') ? 'voice-comments' : 'video-comments';
    media_url = '/uploads/' + folder + '/' + req.file.filename;
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

    return res.status(201).json({ ...data, users: user });
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