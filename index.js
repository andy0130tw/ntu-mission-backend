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

var Promise = models.db.Promise;

var app = express();

var hbs = exphbs.create(require('./handlebars-config'));

var status = 'init';

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
  var offset = 0;
  if (req.query.offset) {
    req.query.offset = req.query.offset - 0;
    if (req.query.offset > 0 && req.query.offset != Infinity)
      offset = req.query.offset;
    else
      return resp.status(400).json({ ok: false, msg: 'invalid offset' });
  }

  models.User.findAndCount({
    order: [['score', 'DESC']],
    limit: 100,
    offset: offset
  }).then(function(data) {
    var result = data.rows.map(function(v, i) {
      v.dataValues.__cnt = offset + i + 1;
      return v.dataValues;
    });

    var nextPageOffset = offset + 100;
    if (data.count < offset + 100)
      nextPageOffset = null;

    var lastUpdatedCand = result.map((v) => (v.updated_at));
    var lastUpdated = result.length ? lastUpdatedCand.reduce((a, b) => (a > b ? a : b)) : 'N/A';

    resp.render('ranking', {
      count: data.count,
      nextPageOffset: nextPageOffset,
      dataset: result,
      lastUpdated: lastUpdated
    });
  });
});

app.use('/debug', require('./debug'));
app.use('/api', require('./api'));
app.use('/vendor', express.static('./vendor'));

app.use(function(req, resp) {
  resp.send('404');
});

var SCORE_BY_DIFFICULTY = {
  '0': 0,
  '1': 2,
  '2': 3,
  '3': 5
};

var req_session = request.defaults({
    pool: { maxSockets: 8 },
    gzip: true,
    json: true,
    forever: true
});

/**
 *  extract the legal hashtag for mission identification
 *  @param {string} [str] the content of the post
 *  @returns the first legal hashtag in the post
 */
function extractHashtag(str) {
  // FIXME: figure out what to place before the # character
  // note: we are not going to make it perfect
  var pattern = /\B#ntu([A-Z0-9]+?)(?![A-Z0-9])/ig;
  var matched, meta, cnt = 0;
  while (matched = pattern.exec(str)) {
    //(?:\b|^)#test([0-9]+)(?=[\s.,:,]|$)/i);
    // some control characters (\u200E and \u202C) are removed from string
    meta = matched[1];
    if (meta.length == 3 && meta[1] >= '0' && meta[1] <= '9') {
      return meta;
    }
    if (cnt > 10) break;
    cnt++;
  }
  return null;
}

/**
 *  probe page feed and sync it into db
 */
// FIXME: should not re-enter the probing function
function probePageFeed() {
  if (status == 'running') return;
  status = 'running';

  log('Probing started...');
  var reqObj = fbApiUrl.PAGE_FEED();
  var recordCount = 0;

  var report = { intact: 0, created: 0, updated: 0, deleted: 0 };

  // mission is generally not changed during execution
  var missionGlobalCache = {};

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

        var userCache = {};

        Promise.each(scoreCalculationArr, function(rec, i) {
          // check for duplication
          return models.ScoreRecord.findOne({
            where: {
              mission_id: rec.mission_id,
              user_id: rec.user_id
            }
          }).then(function(_rec_virtual) {
            if (_rec_virtual) return Promise.resolve();  // duplication!!

            var getUser = Promise.resolve(userCache[rec.user_id])
              .then(function(usr) {
                if (!usr) {
                  // for logging we need to query the name
                  return rec.getUser({ attributes: ['id', 'name', 'score'] })
                    .then(function(usr) {
                      return userCache[rec.user_id] = usr;
                    });
                }
                return usr;
              });

            var getMission = Promise.resolve(missionGlobalCache[rec.mission_id])
              .then(function(mis) {
                if (!mis) {
                  return rec.getMission({ attributes: ['id', 'difficulty'] })
                    .then(function(mis) {
                      return missionGlobalCache[rec.mission_id] = mis;
                    });
                }
                return mis;
              });

            return Promise.all([getUser, getMission])
              .spread(function(usr, mis) {
                var inc = SCORE_BY_DIFFICULTY[mis.difficulty];
                var nsc = usr.score + inc;
                if (nsc) {
                  log('increase score', usr.name, usr.score, '->', nsc, '(+' + inc + ')');
                  usr.score = nsc;
                } else {
                  logger.warn('not increasing due to internal error');
                }
              });
          });
        }).then(function() {
          var usrArr = [];
          var saveArg = { fields: ['score'] };
          for (var x in userCache) {
            usrArr.push(userCache[x]);
          }
          if (usrArr.length) {
            log('Commiting', usrArr.length, 'users...');

            return models.saveAllInstances(usrArr);
          } else {
            // log('Score scanning without change within this page');
            return Promise.resolve();
          }
        }).then(function() {
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
    status = 'idle';
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
    function(cb_next) { /* 1: check if post exists in db */
      logger.verbose('processing post', post.id);
      models.Post
        .findOne({ where: { fb_id: post.id } })
        .then(function(localPost) {
          if (localPost) {
            // only content may be changed, can skip step 3
            cb_next(null, localPost);
          } else {
            cb_next(null, null);
          }
        });
    },
    function(localPost, cb_next) { /* 2: get detailed post if not exist */
      logger.verbose('post id', post.id);

      if (localPost) {
        logger.verbose('already fetched; skip getting post');
        if (localPost.content == post.message) {
          contentChanged = false;
          return cb_next(null, localPost, true, localPost.user_id);
        } else {
          // patching existing records is painful; grab the post at the next run instead
          // FIXME: decrease score accordingly
          /*localPost.getScoreRecord().then(function(sr) {
            return sr.destroy();
          }).then(function() {
            return localPost.destroy();
          })*/localPost.destroy().then(function() {
            // throw an error to skip this post
            cb_next('deleted', localPost, null);
          });
          return;
        }
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
            user.update({
              name: userFbObj.name,
              avatar: userFbObj.picture.data.url
            }).then(callNext, function(){});
          } else {
            logger.verbose('user not in db; trying to add');
            models.User.create({
              fb_id: userFbId,
              name: userFbObj.name,
              avatar: userFbObj.picture.data.url
            }).then(callNext, function() {
              // unique constraint failed...
              logger.debug('adding because last sync failure...');
              searchAndCallNext();
            });
          }
        });
    },
    function(postDetailed, isLocal, userKey, cb_next) { /* 4: save post into DB */
      if (isLocal)
        return cb_next(null, postDetailed);

      status_changed = true;

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

      if (!legalHashId) {
        // no mission; yielding no score record indeed
        return cb_next(null, postInstance, null);
      }

      models.Mission
        .findOne({ where: { hash: legalHashId.toUpperCase() } })
        .then(function(mis) {
          if (!mis)
            return cb_next(null, postInstance, null);

          postInstance
            .update({ mission_id: mis.id })
            .then(function() {
              var recordInstance = models.ScoreRecord.build({
                user_id: postInstance.user_id,
                mission_id: mis.id,
                post_id: postInstance.id
              });
              cb_next(null, postInstance, recordInstance);
            });
        });
    }
  ], function(err, postInstance, recordInstance) {
    if (err == 'deleted') {
      // this is generally not an error
      log('post deleted due to change');
      log('prev instance is', postInstance.toJSON());
      log('now is', post);
      return cb_report(null, 'deleted');
    } else if (err) {
      // whoops, something really bad just happened
      winston.error('post sync failed!!');
      cb_report(null, 'error');
      throw err;
    }

    // success
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
  setInterval(probePageFeed, config.PROBE_INTERVAL || 600000);
  setTimeout(probePageFeed, 0);
});

app.listen(app.get('port'), function() {
  log('Server is listening on port ' + app.get('port') + '...');
});
