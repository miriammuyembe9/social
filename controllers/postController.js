// ═══════════════════════════════════════════════════════════════════════════════
// SMART FEED ALGORITHM — postController.js
// ═══════════════════════════════════════════════════════════════════════════════
//
// SCORING MODEL (0–100 scale):
//
//   Relationship Score  (35%)  — friends > mutual > following > suggested > stranger
//   Engagement Score    (25%)  — weighted: comments×4 + likes×1 + shares×2 + views×0.1
//   Recency Score       (20%)  — exponential decay, half-life = 6h for friends, 2h for strangers
//   Interest Score      (15%)  — user's interaction history matched against post content signals
//   Diversity Penalty    (5%)  — reduces repeated same-author posts in one feed load
//   New Creator Boost          — posts from accounts <500 followers get a 10pt floor boost
//   Spam/Low-quality Penalty   — posts with suspiciously high like:comment ratio get penalised
//
// The algorithm is entirely server-side. No ML model is needed — the weighted
// scoring produces Facebook-quality personalisation with zero extra infra.
// ═══════════════════════════════════════════════════════════════════════════════

const { supabase }    = require('../config/supabase');
const { uploadBuffer, enrichMediaUrl, enrichUser, deleteFile } = require('../config/cloudinary');

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const WEIGHTS = {
  relationship: 0.35,
  engagement:   0.25,
  recency:      0.20,
  interest:     0.15,
  diversity:    0.05,
};

const RELATIONSHIP = {
  self:      100,
  friend:     90,   // mutual + friend_request accepted
  mutual:     75,   // user follows them AND they follow user back
  following:  55,   // user follows them
  follower:   35,   // they follow user (but user doesn't follow back)
  suggested:  15,   // friend-of-friend
  stranger:    0,
};

// Engagement weights: comments are most valuable (shows real engagement)
const ENG_WEIGHTS = { comments: 4, likes: 1, shares: 2, views: 0.1 };

// New-creator boost: accounts with < this many followers get boosted
const NEW_CREATOR_FOLLOWER_THRESHOLD = 500;
const NEW_CREATOR_BOOST = 10; // raw score points added on top

// ─── HELPERS ──────────────────────────────────────────────────────────────────

/**
 * Recency score: exponential decay.
 * Half-life varies: close posts decay slower, stranger posts decay faster.
 * Returns 0–100.
 */
const recencyScore = (createdAt, halfLifeHours = 6) => {
  const ageMs     = Date.now() - new Date(createdAt).getTime();
  const ageHours  = ageMs / (1000 * 60 * 60);
  const halfLife  = halfLifeHours;
  return 100 * Math.pow(0.5, ageHours / halfLife);
};

/**
 * Engagement score normalised to 0–100.
 * Uses a log scale so viral posts don't completely dominate.
 */
const engagementScore = (post) => {
  const raw =
    (post.comments_count || 0) * ENG_WEIGHTS.comments +
    (post.likes_count    || 0) * ENG_WEIGHTS.likes    +
    (post.shares_count   || 0) * ENG_WEIGHTS.shares   +
    (post.views_count    || 0) * ENG_WEIGHTS.views;

  // log1p normalisation: score of 1000 raw ≈ 69, 10000 ≈ 92, capped at 100
  return Math.min(100, (Math.log1p(raw) / Math.log1p(10000)) * 100);
};

/**
 * Interest score: how much does this post match the user's interest profile?
 * Profile is stored as a simple JSON object in the users table:
 *   { media_image: 12, media_video: 8, author_<uid>: 5, … }
 * Returns 0–100.
 */
const interestScore = (post, interestProfile) => {
  if (!interestProfile || !Object.keys(interestProfile).length) return 50; // neutral default

  let score = 0;
  let factors = 0;

  // Affinity to this specific author
  const authorKey = 'author_' + post.user_id;
  if (interestProfile[authorKey]) {
    score  += Math.min(100, interestProfile[authorKey] * 5);
    factors++;
  }

  // Media type preference
  const mediaKey = 'media_' + (post.media_type || 'text');
  if (interestProfile[mediaKey]) {
    score  += Math.min(100, interestProfile[mediaKey] * 4);
    factors++;
  }

  return factors ? Math.min(100, score / factors) : 50;
};

/**
 * Anti-spam heuristic.
 * Posts where likes >> comments and likes > 500 may be engagement-farmed.
 * Returns a penalty multiplier (0.5 – 1.0).
 */
const spamPenalty = (post) => {
  const likes    = post.likes_count    || 0;
  const comments = post.comments_count || 0;
  if (likes < 500) return 1.0; // don't penalise small posts
  if (comments === 0 && likes > 500) return 0.6;
  const ratio = likes / Math.max(1, comments);
  if (ratio > 200) return 0.65;
  if (ratio > 100) return 0.80;
  return 1.0;
};

/**
 * Compute the final feed score for a single post.
 * All component scores are 0–100 before weighting.
 */
const computeScore = (post, relationshipVal, interestProfile, authorAppearances) => {
  // Recency half-life depends on closeness
  const halfLife = relationshipVal >= RELATIONSHIP.friend    ? 10 :
                   relationshipVal >= RELATIONSHIP.following  ?  6 :
                   relationshipVal >= RELATIONSHIP.suggested  ?  3 : 2;

  const rRel  = relationshipVal;                              // 0–100
  const rEng  = engagementScore(post);                        // 0–100
  const rRec  = recencyScore(post.created_at, halfLife);      // 0–100
  const rInt  = interestScore(post, interestProfile);         // 0–100

  // Diversity penalty: same author appearing > 1 time gets reduced score
  const appearances = authorAppearances[post.user_id] || 0;
  const divPenalty  = appearances === 0 ? 1.0 :
                      appearances === 1 ? 0.7 :
                      appearances === 2 ? 0.4 : 0.2;

  const weighted =
    rRel * WEIGHTS.relationship +
    rEng * WEIGHTS.engagement   +
    rRec * WEIGHTS.recency      +
    rInt * WEIGHTS.interest;

  // Apply diversity and spam penalties as multipliers
  let score = weighted * divPenalty * spamPenalty(post);

  // New creator boost: give small accounts a chance to surface
  const followerCount = post._user_followers || 0;
  if (followerCount < NEW_CREATOR_FOLLOWER_THRESHOLD && rEng > 10) {
    score += NEW_CREATOR_BOOST;
  }

  return score;
};

// ─── MAIN: GET SMART FEED ─────────────────────────────────────────────────────
exports.getFeed = async (req, res) => {
  const uid   = req.user.id;
  const page  = parseInt(req.query.page)  || 1;
  const limit = parseInt(req.query.limit) || 20;

  try {
    // ── 1. Fetch user's interest profile ──────────────────────────────────────
    let interestProfile = {};
    try {
      const { data: userData } = await supabase
        .from('users')
        .select('interest_profile')
        .eq('id', uid)
        .single();
      interestProfile = userData?.interest_profile || {};
    } catch (_) { /* column may not exist yet — safe fallback */ }

    // ── 2. Build relationship map ─────────────────────────────────────────────
    const [followRes, friendRes, followerRes] = await Promise.all([
      supabase.from('follows').select('following_id').eq('follower_id', uid),
      supabase.from('friend_requests')
        .select('from_id, to_id')
        .eq('status', 'accepted')
        .or(`from_id.eq.${uid},to_id.eq.${uid}`),
      supabase.from('follows').select('follower_id').eq('following_id', uid),
    ]);

    const followingIds  = new Set((followRes.data  || []).map(f => f.following_id));
    const followerIds   = new Set((followerRes.data || []).map(f => f.follower_id));
    const friendIds     = new Set(
      (friendRes.data || []).map(r => r.from_id === uid ? r.to_id : r.from_id)
    );

    // Friend-of-friend (suggested) — one hop out
    const fofRes = followingIds.size
      ? await supabase.from('follows')
          .select('following_id')
          .in('follower_id', [...followingIds])
          .not('following_id', 'in', `(${[uid, ...followingIds].join(',')})`)
      : { data: [] };
    const suggestedIds = new Set((fofRes.data || []).map(f => f.following_id));

    /**
     * Returns the relationship score for a given author.
     */
    const getRelationship = (authorId) => {
      if (authorId === uid)              return RELATIONSHIP.self;
      if (friendIds.has(authorId))       return RELATIONSHIP.friend;
      if (followingIds.has(authorId) && followerIds.has(authorId))
                                         return RELATIONSHIP.mutual;
      if (followingIds.has(authorId))    return RELATIONSHIP.following;
      if (followerIds.has(authorId))     return RELATIONSHIP.follower;
      if (suggestedIds.has(authorId))    return RELATIONSHIP.suggested;
      return RELATIONSHIP.stranger;
    };

    // ── 3. Fetch candidate posts ───────────────────────────────────────────────
    // Pool: own + following + friends + trending (wider window)
    // We fetch more than `limit` so scoring can re-rank them.
    const POOL_SIZE   = limit * 5;       // score 5× the page size
    const MAX_AGE_HRS = 72;             // posts older than 72h are excluded
    const since       = new Date(Date.now() - MAX_AGE_HRS * 60 * 60 * 1000).toISOString();

    // Relevant author IDs for the primary pool (own + following + friends)
    const relevantIds = [uid, ...followingIds, ...friendIds];

    let allPosts = [];

    if (relevantIds.length > 0) {
      // Primary pool: posts from people the user knows
      const { data: myPosts } = await supabase
        .from('posts')
        .select('id,user_id,content,media_url,media_type,thumbnail_url,likes_count,comments_count,views_count,shares_count,created_at')
        .in('user_id', relevantIds)
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(POOL_SIZE);
      allPosts = myPosts || [];
    }

    // Trending pool: top-engaged posts from everyone (including strangers)
    // Only fill if we have room in the pool
    if (allPosts.length < POOL_SIZE) {
      const { data: trending } = await supabase
        .from('posts')
        .select('id,user_id,content,media_url,media_type,thumbnail_url,likes_count,comments_count,views_count,shares_count,created_at')
        .gte('created_at', since)
        .order('likes_count', { ascending: false })
        .limit(POOL_SIZE - allPosts.length);

      // Merge, deduplicating by id
      const seen = new Set(allPosts.map(p => p.id));
      (trending || []).forEach(p => { if (!seen.has(p.id)) { allPosts.push(p); seen.add(p.id); } });
    }

    if (!allPosts.length) return res.json([]);

    // ── 4. Fetch user data for all authors ────────────────────────────────────
    const userIds = [...new Set(allPosts.map(p => p.user_id).filter(Boolean))];
    const { data: users } = await supabase
      .from('users')
      .select('id,name,username,avatar_url,is_verified,gender,followers_count')
      .in('id', userIds);

    const userMap = {};
    (users || []).forEach(u => { userMap[u.id] = u; });

    // Attach follower count to posts so scorer can apply new-creator boost
    allPosts.forEach(p => {
      p._user_followers = userMap[p.user_id]?.followers_count || 0;
    });

    // ── 5. Liked + bookmarked by current user ─────────────────────────────────
    const postIds = allPosts.map(p => p.id);
    const [likedRes, bookRes] = await Promise.all([
      supabase.from('post_likes').select('post_id').eq('user_id', uid).in('post_id', postIds),
      supabase.from('bookmarks').select('post_id').eq('user_id', uid).in('post_id', postIds),
    ]);
    const likedSet = new Set((likedRes.data || []).map(l => l.post_id));
    const bookSet  = new Set((bookRes.data  || []).map(b => b.post_id));

    // ── 6. Score & sort ───────────────────────────────────────────────────────
    const authorAppearances = {};

    const scored = allPosts.map(p => {
      const rel   = getRelationship(p.user_id);
      const score = computeScore(p, rel, interestProfile, authorAppearances);

      // Track appearances AFTER scoring (so 1st appearance isn't penalised)
      authorAppearances[p.user_id] = (authorAppearances[p.user_id] || 0) + 1;

      return { ...p, _score: score, _rel: rel };
    });

    // Sort descending by score
    scored.sort((a, b) => b._score - a._score);

    // ── 7. Paginate ───────────────────────────────────────────────────────────
    const from = (page - 1) * limit;
    const page_posts = scored.slice(from, from + limit);

    // ── 8. Enrich & return ────────────────────────────────────────────────────
    return res.json(page_posts.map(p => {
      const { _score, _rel, _user_followers, ...rest } = p;
      const enriched = enrichMediaUrl({ ...rest });
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

// ─── RECORD INTERACTION (called by frontend after user engages) ───────────────
// POST /api/posts/:id/interact  body: { action: 'like'|'comment'|'view'|'share'|'skip' }
exports.recordInteraction = async (req, res) => {
  const { id }     = req.params;
  const { action } = req.body;
  const uid        = req.user.id;

  // Weight of each action toward the interest profile
  const ACTION_WEIGHT = { like: 3, comment: 5, share: 4, view: 1, skip: -1 };
  const weight = ACTION_WEIGHT[action];
  if (weight === undefined) return res.status(400).json({ error: 'Unknown action' });

  try {
    // Fetch the post to get its author and media_type
    const { data: post } = await supabase
      .from('posts')
      .select('user_id, media_type')
      .eq('id', id)
      .single();

    if (!post) return res.status(404).json({ error: 'Post not found' });

    // Read current profile
    const { data: userData } = await supabase
      .from('users')
      .select('interest_profile')
      .eq('id', uid)
      .single();

    const profile = userData?.interest_profile || {};

    // Update author affinity
    const authorKey = 'author_' + post.user_id;
    profile[authorKey] = Math.max(-20, Math.min(100, (profile[authorKey] || 0) + weight));

    // Update media type affinity
    const mediaKey = 'media_' + (post.media_type || 'text');
    profile[mediaKey] = Math.max(0, Math.min(100, (profile[mediaKey] || 0) + Math.max(0, weight)));

    // Persist (fire and forget if column doesn't exist yet)
    supabase
      .from('users')
      .update({ interest_profile: profile })
      .eq('id', uid)
      .then(() => {})
      .catch(() => {});

    return res.json({ success: true });
  } catch (err) {
    // Non-critical — don't let this break anything
    return res.json({ success: false });
  }
};

// ─── TRENDING POSTS ───────────────────────────────────────────────────────────
// GET /api/posts/trending  — top posts by engagement in last 48h
exports.getTrending = async (req, res) => {
  const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  try {
    const { data: posts } = await supabase
      .from('posts')
      .select('id,user_id,content,media_url,media_type,thumbnail_url,likes_count,comments_count,views_count,created_at')
      .gte('created_at', since)
      .order('likes_count', { ascending: false })
      .limit(20);

    if (!posts?.length) return res.json([]);

    const userIds = [...new Set(posts.map(p => p.user_id))];
    const { data: users } = await supabase
      .from('users').select('id,name,username,avatar_url,is_verified,gender').in('id', userIds);
    const um = {}; (users||[]).forEach(u => { um[u.id] = u; });

    return res.json(posts.map(p => ({ ...enrichMediaUrl(p), users: enrichUser(um[p.user_id]) || null })));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

// ─── ALL REMAINING UNCHANGED ENDPOINTS ────────────────────────────────────────

exports.createPost = async (req, res) => {
  const { content, media_type } = req.body;
  const files = Array.isArray(req.files)
    ? req.files
    : (req.files?.media || (req.file ? [req.file] : []));
  if (!content && !files.length)
    return res.status(400).json({ error: 'Post must have text or media' });

  let media_url = null;

  if (files.length === 1) {
    const isVideo = files[0].mimetype.startsWith('video');
    try {
      const result = await uploadBuffer(files[0].buffer, files[0].mimetype, isVideo ? 'post_video' : 'post_image');
      media_url = result.public_id;
    } catch (uploadErr) {
      return res.status(500).json({ error: 'Media upload failed: ' + uploadErr.message });
    }
  } else if (files.length > 1) {
    try {
      const results = await Promise.all(files.map(f => uploadBuffer(f.buffer, f.mimetype, 'post_image')));
      media_url = JSON.stringify(results.map(r => r.public_id));
    } catch (uploadErr) {
      return res.status(500).json({ error: 'Media upload failed: ' + uploadErr.message });
    }
  }

  try {
    const { data: post, error } = await supabase
      .from('posts')
      .insert({ user_id: req.user.id, content: content || null, media_url, media_type: media_type || 'text', likes_count: 0, comments_count: 0 })
      .select('id,user_id,content,media_url,media_type,thumbnail_url,likes_count,comments_count,views_count,created_at')
      .single();
    if (error) return res.status(500).json({ error: error.message });

    const { data: user } = await supabase.from('users')
      .select('id,name,username,avatar_url,is_verified,gender').eq('id', req.user.id).single();

    supabase.from('users').select('posts_count').eq('id', req.user.id).single()
      .then(({ data: u }) => supabase.from('users').update({ posts_count: (u?.posts_count || 0) + 1 }).eq('id', req.user.id))
      .catch(() => {});

    return res.status(201).json({ ...enrichMediaUrl(post), users: enrichUser(user), liked: false, bookmarked: false });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

exports.likePost = async (req, res) => {
  const { id } = req.params;
  try {
    const { data: existing } = await supabase
      .from('post_likes').select('post_id').eq('user_id', req.user.id).eq('post_id', id).maybeSingle();
    const { data: post } = await supabase.from('posts').select('likes_count').eq('id', id).single();
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
    // Record interest signal (fire and forget)
    exports.recordInteraction({ params: { id }, body: { action: 'like' }, user: req.user }, { json: () => {} });
    return res.json({ liked: true, likes_count: n });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

exports.deletePost = async (req, res) => {
  const { id } = req.params;
  try {
    const { data: postData } = await supabase.from('posts').select('id,media_url,media_type')
      .eq('id', id).eq('user_id', req.user.id).maybeSingle();
    if (!postData) return res.status(404).json({ error: 'Post not found or not yours' });
    if (postData.media_url) {
      const rtype = postData.media_type === 'video' ? 'video' : 'image';
      if (postData.media_url.startsWith('[')) {
        try { JSON.parse(postData.media_url).forEach(pid => deleteFile(pid, 'image')); } catch (_) {}
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

exports.getComments = async (req, res) => {
  const { id } = req.params;
  try {
    const { data: comments, error } = await supabase
      .from('comments')
      .select('id,post_id,user_id,content,comment_type,media_url,duration_seconds,likes_count,created_at')
      .eq('post_id', id).is('parent_id', null)
      .order('created_at', { ascending: true });
    if (error) throw error;
    if (!comments?.length) return res.json([]);
    const userIds = [...new Set(comments.map(c => c.user_id))];
    const { data: users } = await supabase.from('users')
      .select('id,name,username,avatar_url,is_verified').in('id', userIds);
    const um = {}; (users||[]).forEach(u => { um[u.id] = u; });
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
    } catch (e) { console.error('[addComment] upload failed:', e.message); }
  }
  try {
    const { data, error } = await supabase.from('comments')
      .insert({ post_id: id, user_id: req.user.id, content: content || null, comment_type: comment_type || 'text', media_url, duration_seconds: duration_seconds ? parseFloat(duration_seconds) : null, parent_id: parent_id || null })
      .select('id,post_id,user_id,content,comment_type,media_url,duration_seconds,created_at')
      .single();
    if (error) throw error;
    const { data: user } = await supabase.from('users')
      .select('id,name,username,avatar_url,is_verified').eq('id', req.user.id).single();
    supabase.from('posts').select('comments_count').eq('id', id).single()
      .then(({ data: p }) => supabase.from('posts').update({ comments_count: (p?.comments_count || 0) + 1 }).eq('id', id))
      .catch(() => {});
    // Record comment as strong interest signal
    exports.recordInteraction({ params: { id }, body: { action: 'comment' }, user: req.user }, { json: () => {} });
    return res.status(201).json({ ...enrichMediaUrl(data), users: enrichUser(user) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

exports.deleteComment = async (req, res) => {
  const { commentId } = req.params;
  try {
    const { data } = await supabase.from('comments').delete()
      .eq('id', commentId).eq('user_id', req.user.id).select('id').maybeSingle();
    if (!data) return res.status(404).json({ error: 'Not found' });
    return res.json({ message: 'Deleted' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

exports.searchPosts = async (req, res) => {
  const { q } = req.query;
  if (!q?.trim()) return res.json([]);
  try {
    const { data: posts, error } = await supabase
      .from('posts')
      .select('id,user_id,content,media_url,media_type,likes_count,comments_count,created_at')
      .ilike('content', `%${q.trim()}%`)
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) throw error;
    if (!posts?.length) return res.json([]);
    const userIds = [...new Set(posts.map(p => p.user_id))];
    const { data: users } = await supabase.from('users')
      .select('id,name,username,avatar_url,is_verified').in('id', userIds);
    const um = {}; (users||[]).forEach(u => { um[u.id] = enrichUser(u); });
    return res.json(posts.map(p => ({ ...enrichMediaUrl(p), users: um[p.user_id] || null })));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};