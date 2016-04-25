#!/usr/bin/env node

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

var hbs = exphbs.create(require('./handlebars-config'));

app.engine('hbs', hbs.engine);

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
app.use('/vendor', express.static('./vendor'));

app.use(function(req, resp) {
  resp.send('404');
})

var SCORE_BY_DIFFICULTY = {
  '0': 0,
  '1': 2,
  '2': 3,
  '3': 5
};

var req_session = request.defaults({
    pool: { maxSockets: 4 },
    gzip: true,
    json: true,
    forever: true
});

/**
 *  extract the first legal hashtag
 *  @param {string} str - the post
 */
function extractHashtag(str) {
  // FIXME: figure out what to place before the # character
  // note: we are not going to make it perfect
  var matched = str.match(/\B#ntu([A-Z0-9]+?)(?![A-Z0-9])/i);
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
    req_session.get(reqObj, function(err, resp) {
      if (err)
        cb_nextPage(err);
      var list = resp.body.data;
      var paging = resp.body.paging;

      var scoreCalculationArr = [];

      // SQLite db will fail randomly, use `eachSeries`
      async.each(list, function(post, cb_nextPost) {
        // ignore if it is not a piece of message
        if (!post.message) return cb_nextPost();

        logger.debug('post', post);

        processPost(post, function(err, verdict, recordInstance) {
          report[verdict]++;
          if (recordInstance)
            scoreCalculationArr.push(recordInstance);

          return cb_nextPost();
        });

      }, function(err) {
        if (err) throw err;
        logger.debug('post page check ok');

        async.eachSeries(scoreCalculationArr, function(rec, cb_next) {
          // try to insert, if success then increase the score
          rec.save().then(function() {
            // XXX
            models.Mission.findById(rec.mission_id).then(function(mis) {
              models.User.findById(rec.user_id).then(function(usr) {
                var inc = SCORE_BY_DIFFICULTY[mis.difficulty];
                var nsc = usr.score + inc;
                log('increase score', usr.name, usr.score, '->', nsc, '(+' + inc + ')');
                return usr.increment('score', { by: inc });
              }).then(function() { cb_next(); });
            });
          }, function() {
            // do nothing, do not emit errors
            cb_next();
          });
        }, function() {
          log('Score processing end');
        });

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
  // no longer convert to number
  var legalHashId = extractHashtag(post.message);
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
          async.series([
            function(cb) { /* 1 */
              log('updating mission', localPost.mission_id, 'to', legalHashId);
              if (!localPost.mission_id || localPost.mission_id == legalHashId) return cb();
              models.ScoreRecord
                .findOne({ where: { post_id: localPost.id } })
                .then(function(sr) {
                  if (!sr) { cb(); return; }
                  models.Mission
                    .findById(sr.mission_id)
                    .then(function(mis) {
                      models.User
                        .findById(sr.user_id)
                        .then(function(usr) {
                          var dec = SCORE_BY_DIFFICULTY[mis.difficulty];
                          var nsc = usr.score - dec;
                          log('decrease score', usr.name, usr.score, '->', nsc, '(-' + dec + ')');
                          return usr.decrement('score', { by: dec });
                        }).then(function() {
                          sr.destroy().then(function() {
                            cb();
                          });
                        });
                    });
                });
            },
            function(cb) { /* 2 */
              localPost.update({
                content: post.message,
                mission_id: legalHashId
              }).then(function() {
                cb();
              });
            },
            function() { /* 3 */
              cb_next_local_wrapper();
            }
          ]);
        }
        return;
      }

      contentFetched = true;
      logger.verbose('detail needed');
      req_session.get(fbApiUrl.POST(post.id), function(err, resp) {
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

      var callNext = function(user) {
        userKey = user.id;
        cb_next(null, postDetailed, false, userKey);
      };

      var searchAndCallNext = function() {
        models.User
          .findOne({ where: { fb_id: userFbId } })
          .then(callNext);
      };

      models.User
        .findOne({ where: { fb_id: userFbId } })
        .then(function(user) {
          if (user) {
            userKey = user.id;
            logger.verbose('user key', userKey);
            callNext(user);
          } else {
            logger.verbose('user not in db; trying to add');
            models.User.create({
              fb_id: userFbId,
              name: userFbObj.name,
              avatar: userFbObj.picture.data.url
            }).then(callNext, function() {
              // unique constraint failed...
              logger.debug('adding because last sync failure...')
              searchAndCallNext();
            });
          }
        });
    },
    function(postDetailed, isLocal, userKey, cb_next) { /* 4: save post into DB */
      if (isLocal)
        return cb_next(null, postDetailed);

      status_changed = true;

      // XXX
      models.Post.create({
        fb_id: postDetailed.id,
        content: postDetailed.message,
        photo_url: postDetailed.full_picture,
        user_id: userKey,
        likes: postDetailed.likes ? postDetailed.likes.data.length : 0,
        fb_ts: post.updated_time
      }).then(function(postInstance) {  // spread?
        cb_next(null, postInstance);
      });
    },
    function(postInstance, cb_next) { /* 5: update hash tag and make the record of score */
      // XXX
      if (!contentChanged) {
        logger.debug('content not changed, skipping');
        return cb_next(null, postInstance);
      }

      models.Mission
        .findOne({ where: { hash: legalHashId } })
        .then(function(mis) {
          if (!mis)
            return cb_next(null, postInstance, null);

          postInstance
            .update({ mission_id: mis.id })
            .then(function() {
              models.ScoreRecord
                .findOrInitialize({
                  where: {
                    user_id: postInstance.user_id,
                    mission_id: mis.id
                  },
                  defaults: {
                    post_id: postInstance.id
                  }
                }).spread(function(record, created) {
                  // if created, return this record to be calculated on total score
                  // if not, return null indicating that it is duplicated and no score should be given
                  var recordInstance = created ? record : null;
                  return cb_next(null, postInstance, recordInstance);
                });
              });
        });
    }
  ], function(err, postInstance, recordInstance) {
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
    cb_report(null, verdict, recordInstance);
  });
}

models.db.sync().then(function() {
  log('Model synced; ready for requests');
  setInterval(probePageFeed, config.PROBE_INTERVAL || 300000);
  setTimeout(probePageFeed, 0);
});

app.listen(app.get('port'), function() {
  log('Server is listening on port ' + app.get('port') + '...');
});
