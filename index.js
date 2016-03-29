var fs = require('fs');

var async      = require('async');
var express    = require('express');
var exphbs     = require('express-handlebars');
var morgan     = require('morgan');
var winston    = require('winston');
var request    = require('request');
var bodyParser = require('body-parser');

var models   = require('./models');
var config   = require('./config');
var fbApiUrl = require('./fbapi-url');

var app = express();

app.engine('hbs', exphbs());

app.set('port', process.env['PORT'] || config.PORT || 8080);
app.set('view engine', 'hbs');

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

var logOutputStream;
if (!config.DEBUG)
  logOutputStream = fs.createWriteStream(__dirname + '/access.log', {flags: 'a'});
app.use(morgan('combined', { stream: logOutputStream }));

var logger = new (winston.Logger)({
  transports: [
    new (winston.transports.Console)({
      timestamp: true,
      level: config.DEBUG ? 'debug' : 'info'
    })
  ]
});
global.log = logger.info;

app.get('/', function(req, resp) {
  resp.send('It works!');
});

app.use('/debug', require('./debug'));

app.use(function(req, resp) {
  resp.send('404');
})

var SCORE_BY_DIFFICULTY = {
  '1': 1,
  '2': 3,
  '3': 5
};

/**
 *  extract the first legal hashtag
 */
function extractHashtag(str) {
  // FIXME: figure out what to place before the # character
  // note: we are not going to make it perfect
  var matched = str.match(/\B#ntumission([0-9]+)(?![0-9])/i);
  //(?:\b|^)#test([0-9]+)(?=[\s.,:,]|$)/i);
  // some control characters (\u200E and \u202C) are removed from string
  if (matched) return matched[1];
  return null;
}

/**
 *  probe page feed and sync it into db
 */
// FIXME: should not re-enter the probing function
function probePageFeed() {
  log('Probing started...');
  var reqObj = fbApiUrl.PAGE_FEED();
  var recordCount = 0;

  var report = { intact: 0, created: 0, updated: 0, deleted: 0 };

  async.whilst(function(hasNext) {
    if (hasNext == null) return true;
    return hasNext;
  }, function(cb_nextPage) {
    logger.verbose('send feed req', reqObj);
    request.get(reqObj, function(err, resp) {
      if (err)
        cb_nextPage(err);
      var list = resp.body.data;
      var paging = resp.body.paging;

      // SQLite db will fail randomly, use `eachSeries`
      async.each(list, function(post, cb_nextPost) {
        // ignore if it is not a piece of message
        if (!post.message) return cb_nextPost();

        logger.debug('post', post);

        processPost(post, function(err, verdict) {
          report[verdict]++;
          return cb_nextPost();
        });

      }, function(err) {
        if (err) throw err;
        logger.debug('post page check ok');
        if (paging) {
          recordCount += list.length;
          // FB already encode access_token into paging urls
          reqObj = { url: paging.next, json: true };
          cb_nextPage(null, true);
        } else {
          cb_nextPage(null, false);
        }
      });

    });
  }, function(err) {
    if (err) {
      logger.error('Error occurred when getting posts', err);
      return;
    }
    log('Probing ended with success');
    log('Record count =', recordCount);
    // TODO: +x -y ~z; sync to db
    log('Record diff:', report);
  });
}

function processPost(post, cb_report) {
  // convert to number
  var legalHashId = extractHashtag(post.message) - 0;
  var contentChanged = true;

  // used in logging
  var contentFetched = false;

  // if (!legalHashId) return cb_nextPost();

  async.waterfall([
    function(cb_next) { /* 1: check if post exists */
      logger.verbose('processing post', post.id);
      models.Post
        .findOne({ where: { fb_id: post.id } })
        .then(function(localPost) {
          if (localPost) {
            // can skip 3 since only content may be changed
            cb_next(null, localPost);
          } else {
            cb_next(null, null);
          }
        });
    },
    function(localPost, cb_next) { /* 2: get detailed post if not exist */
      logger.verbose('post id', post.id);

      function cb_next_local_wrapper() { cb_next(null, localPost, true, localPost.user_id); }

      if (localPost) {
        logger.verbose('already fetched; skip getting post');
        if (localPost.content == post.message) {
          contentChanged = false;
          cb_next_local_wrapper();
        } else {
          localPost.update({
            content: post.message
          }).then(cb_next_local_wrapper);
        }
        return;
      }

      contentFetched = true;
      logger.verbose('detail needed');
      request.get(fbApiUrl.POST(post.id), function(err, resp) {
        // TODO: err handling
        cb_next(null, resp.body, false, resp.body.from);
      });
    },
    function(postDetailed, isLocal, userFbObj, cb_next) { /* 3: get user id */
      if (isLocal) {
        logger.verbose('already fetched; skip getting user');
        return cb_next(null, postDetailed, true, null);
      }

      logger.debug('recv post', postDetailed);
      logger.verbose('user id', userFbObj.id);

      var userKey, userFbId = userFbObj.id;
      models.User
        .findOne({ where: { fb_id: userFbId } })
        .then(function(user) {
          if (user) {
            userKey = user.id;
            logger.verbose('user key', userKey);
            cb_next(null, postDetailed, false, userKey);
          } else {
            logger.verbose('user not in db; setting -1');
            models.User.create({
              fb_id: userFbObj.id,
              name: userFbObj.name,
              score: 0
            }).then(function(user) {
              userKey = user.id;
              cb_next(null, postDetailed, false, userKey);
            });
          }
        });

      // this code will cause deadlock, fuck
      // models.User.findOrCreate({
      //   where: { fb_id: userFbObj.id },
      //   defaults: {
      //     name: userFbObj.name,
      //     score: 0
      //     // TODO: fetch avatar / lazy loading? / queued?
      //   }
      // })
      // .spread(function(user, created) {
      //   if (created) {
      //     log('user key', user.id);
      //   } else {
      //     user.id = -1;
      //     // log('user not in db, added', user.id);
      //   }
      //   cb_next(null, postDetailed, false, user.id);
      // });
    },
    function(postDetailed, isLocal, userKey, cb_next) { /* 4: save post into DB */
      if (isLocal)
        return cb_next(null, postDetailed);

      status_changed = true;

      // XXX
      models.Post.create({
        fb_id: postDetailed.id,
        content: postDetailed.message,
        user_id: userKey,
        fb_ts: postDetailed.timestamp
      }).then(function(postInstance) {  // spread?
        cb_next(null, postInstance);
      });
    },
    function(postInstance, cb_next) { /* 5: update hash tag and increase corresponding score */
      // XXX
      if (!contentChanged) {
        logger.debug('content not changed, skipping');
        return cb_next(null, postInstance);
      }

      models.Mission
        .findOne({ where: { hash: legalHashId } })
        .then(function(mis) {
          var misId = mis ? mis.id : null;
          postInstance
            .update({ mission_id: misId })
            .then(function() {
              models.User
                .findOne({ where: { id: postInstance.user_id } })
                .then(function(user) {
                  if (mis) {
                    log('increase score ', user.name, user.score, '-> +' + SCORE_BY_DIFFICULTY[mis.difficulty]);
                    user.update({ score: user.score + SCORE_BY_DIFFICULTY[mis.difficulty] })
                      .then(function() {
                        return cb_next(null, postInstance);
                      });
                  } else return cb_next(null, postInstance);
                });
            });
        });
      }
  ], function(err, postInstance) {
    if (err) {
      winston.error('post sync failed!!');
      throw err;
      cb_report(null, 'error');
    }
    var verdict = 'intact';
    if (contentFetched)
      verdict = 'created';
    else if (contentChanged)
      verdict = 'updated';
    if (verdict != 'intact')
      log('post sync success', verdict, postInstance.id, postInstance.fb_id);
    cb_report(null, verdict);
  });
}

models.db.sync().then(function() {
  log('Model synced; ready for requests');
  setInterval(probePageFeed, config.PROBE_INTERVAL || 60000);
  setTimeout(probePageFeed, 0);
});

app.listen(app.get('port'), function() {
  log('Server is listening on port ' + app.get('port') + '...');
});
