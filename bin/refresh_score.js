#!/usr/bin/env node
var async = require('async');

var models = require('../models');
var Promise = models.db.Promise;

var SCORE_BY_DIFFICULTY = {
  '0': 0,
  '1': 2,
  '2': 3,
  '3': 5
};

var userCache = {};

console.log('Truncating ScoreRecord...');
models.ScoreRecord.truncate()
  .then(function() {
    console.log('Loading users & posts into memory...');
    return Promise.all([
      models.User.findAll({
        attributes: ['id', 'name', 'score']
      }),
      models.Post.findAll({
        order: [[models.db.literal('datetime(fb_ts)'), 'ASC']],
        include: models.Mission
      })
    ]);
  }).spread(function(users, posts) {
    console.log('Building user cache...');

    users.forEach(function(user) {
      userCache[user.id] = user;
      user.__score = user.score;
      user.score = 0;
    });

    console.log('Re-generating ScoreRecord...');
    var recArr = [];
    async.forEachOfSeries(posts, function(post, postIdx, cb_next) {
      process.stdout.write('Processing post ' + (postIdx + 1) + '/' + posts.length + '...\r');
      if (!post.mission_id) return cb_next();
      models.ScoreRecord.findOrInitialize({
        where: {
          mission_id: post.mission_id,
          user_id: post.user_id
        },
        defaults: {
          post_id: post.id
        }
      }).spread(function(record, created) {
        if (created) {
          userCache[post.user_id].score += SCORE_BY_DIFFICULTY[post.mission.difficulty];
          recArr.push(record);
        }
        cb_next();
      });
    }, function(err) {
      console.log('Completed processing posts...');

      console.log('Test and apply score on users...');
      var usrArr = [];
      for (var x in userCache)
        usrArr.push(userCache[x]);
      var saveArg = { fields: ['score'] };

      models.db.transaction(function(t) {
        saveArg.transaction = t;
        return Promise
          .all(usrArr.map(function (user) {
            // pre-save hook; verbose
            var oldScore = user.__score;
            if (oldScore != user.score) {
              console.log('the score of user ' + user.name + ' changed (' + oldScore + ' -> ' + user.score + ')');
              return user.save(saveArg);
            }
            return Promise.resolve(null);
          }));
      }).then(function(usrSaveResult) {
        console.log('Inserting ScoreRecord instances...');
        return models.saveAllInstances(recArr);
      }).then(function() {
        // all done
        console.log('Done!');
      });
    });
  });
