const router = require('express').Router();
const { body } = require('express-validator');
const auth     = require('../middleware/auth');
const upload   = require('../middleware/upload');
const authCtrl = require('../controllers/authController');
const postCtrl = require('../controllers/postController');
const mainCtrl = require('../controllers/mainController');

// ── AUTH ──────────────────────────────────────────────────
router.post('/auth/signup',
  [body('name').notEmpty(), body('username').isLength({min:3}),
   body('email').isEmail(), body('password').isLength({min:6})],
  authCtrl.signup);
router.post('/auth/login',
  [body('email').isEmail(), body('password').notEmpty()],
  authCtrl.login);
router.post('/auth/logout', auth, authCtrl.logout);
router.get('/auth/me',      auth, authCtrl.getMe);

// ── POSTS ─────────────────────────────────────────────────
router.get ('/posts',                  auth,                          postCtrl.getFeed);
router.post('/posts',                  auth, upload.fields([{name:'media',maxCount:20},{name:'audio',maxCount:1}]), postCtrl.createPost);
router.post('/posts/:id/like',         auth,                          postCtrl.likePost);
router.post('/posts/:id/bookmark',     auth,                          postCtrl.bookmarkPost);
router.get ('/posts/:id/comments',     auth,                          postCtrl.getComments);
router.post('/posts/:id/comments',     auth, upload.single('media'),  postCtrl.addComment);
router.delete('/posts/:id',            auth,                          postCtrl.deletePost);
router.delete('/comments/:commentId',  auth,                          postCtrl.deleteComment);

// ── USERS — SPECIFIC routes MUST come before /:username ──
router.get('/users/search',             auth, mainCtrl.searchUsers);
router.get('/posts/search',             auth, postCtrl.searchPosts);
router.get('/users/:username/followers',auth, mainCtrl.getFollowers);
router.get('/users/:username/following',auth, mainCtrl.getFollowing);
router.get('/users/notifications',       auth, mainCtrl.getNotifications);
router.get('/users/notifications/count',  auth, mainCtrl.getUnreadCount);
router.put('/users/notifications/read',  auth, mainCtrl.markNotificationsRead);
router.put('/users/notifications/:id/read', auth, mainCtrl.markOneNotificationRead);
router.delete('/users/notifications/:id',  auth, mainCtrl.deleteNotification);
router.put('/users/me/profile',
  auth,
  upload.fields([{name:'avatar',maxCount:1},{name:'cover',maxCount:1}]),
  mainCtrl.updateProfile);
router.post('/users/:id/follow',        auth, mainCtrl.followUser);
router.get('/users/:username/posts',    auth, mainCtrl.getUserPosts);
router.get('/users/:username/videos',   auth, mainCtrl.getUserVideos);
router.get('/users/:username',          auth, mainCtrl.getProfile);

// ── CHAT ──────────────────────────────────────────────────
router.get   ('/chat/conversations',              auth,                         mainCtrl.getConversations);
router.delete('/chat/conversations/:partnerId',   auth,                         mainCtrl.deleteConversation);
router.get   ('/chat/messages/:partnerId',        auth,                         mainCtrl.getMessages);
router.post  ('/chat/messages',                   auth, upload.single('media'), mainCtrl.sendMessage);

// ── GROUPS ────────────────────────────────────────────────
router.get   ('/groups',                    auth,                         mainCtrl.getGroups);
router.post  ('/groups',                    auth,                         mainCtrl.createGroup);
router.post  ('/groups/:id/join',           auth,                         mainCtrl.joinGroup);
router.put   ('/groups/:id',                auth,                         mainCtrl.updateGroup);
router.delete('/groups/:id',                auth,                         mainCtrl.deleteGroup);
router.get   ('/groups/:id/members',        auth,                         mainCtrl.getGroupMembers);
router.put   ('/groups/:id/members/:uid',   auth,                         mainCtrl.updateGroupMemberRole);
router.delete('/groups/:id/members/:uid',   auth,                         mainCtrl.removeGroupMember);
router.get   ('/groups/:id/messages',       auth,                         mainCtrl.getGroupMessages);
router.post  ('/groups/:id/messages',       auth, upload.single('media'), mainCtrl.sendGroupMessage);

// ── VIDEOS ────────────────────────────────────────────────
router.get ('/videos',           auth,                        mainCtrl.getVideos);
router.post('/videos',           auth, upload.fields([{name:'video',maxCount:1},{name:'audio',maxCount:1}]), mainCtrl.uploadVideo);
router.post('/videos/:id/view',  auth,                        mainCtrl.viewVideo);

// ── DEBUG: test posts query directly ──
// Stories
router.get   ('/stories',          auth,                             mainCtrl.getStories);
router.post  ('/stories',          auth, upload.fields([{name:'media',maxCount:1},{name:'audio',maxCount:1}]), mainCtrl.createStory);
router.post  ('/stories/:id/view', auth,                             mainCtrl.viewStory);
router.delete('/stories/:id',      auth,                             mainCtrl.deleteStory);

router.get('/debug/posts', auth, async (req, res) => {
  const { supabase } = require('../config/supabase');
  try {
    const t1 = await supabase.from('posts').select('id, content, created_at').limit(3);
    const t2 = await supabase.from('posts').select('id', { count: 'exact', head: true });
    res.json({
      test1_data:  t1.data,
      test1_error: t1.error,
      test2_count: t2.count,
      test2_error: t2.error,
      user_id: req.user.id
    });
  } catch(e) { res.json({ exception: e.message }); }
});

// ── FRIEND REQUESTS ──────────────────────────────────────
router.post  ('/friends/request/:id',    auth, mainCtrl.sendFriendRequest);
router.post  ('/friends/accept/:id',     auth, mainCtrl.acceptFriendRequest);
router.post  ('/friends/decline/:id',    auth, mainCtrl.declineFriendRequest);
router.delete('/friends/remove/:id',     auth, mainCtrl.removeFriend);
router.get   ('/friends/requests',       auth, mainCtrl.getFriendRequests);
router.get   ('/friends/status/:id',     auth, mainCtrl.getFriendStatus);
router.get   ('/friends/suggested',      auth, mainCtrl.getSuggestedUsers);
router.get   ('/users/:username/friends',auth, mainCtrl.getUserFriends);

// ── module.exports MUST be last so all routes above are registered ──
module.exports = router;