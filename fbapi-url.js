var config = require('./config');

var FB_API_BASE = 'https://graph.facebook.com/v2.5/';

var simpleRequest = (x, y)=>(()=>reqWrapper({url: x, qs: y}));

function reqWrapper(obj) {
  obj.qs = obj.qs || {};
  obj.qs.access_token = obj.qs.access_token || config.FACEBOOK_API_KEY;
  obj.json = true;
  return obj;
}

module.exports = {
  API_BASE: FB_API_BASE,
  PAGE_FEED: simpleRequest(
    FB_API_BASE + config.FACEBOOK_EVENT_ID + '/feed',
    {
      limit: config.FACEBOOK_FEED_LIMIT || 300
    }
  ),
  POST: function(postId) {
    return reqWrapper({
      url: FB_API_BASE + postId + '/',
      qs: {
        fields: 'permalink_url,message,from{name,picture},full_picture,created_time'
      }
    });
  },
  USER: function(userId) {
    return reqWrapper({
      url: FB_API_BASE + userId + '/',
      qs: {
        fields: 'name,picture'
      }
    });
  }
};
