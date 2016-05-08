#!/usr/bin/env node
var fs = require('fs');

var async = require('async');
var csv = require('csv');
var request = require('request');

var models = require('../models');
var fbApiUrl = require('../fbapi-url');

var PATH_USER_ID_CACHE = './data/user_id_cache.json';
var CONCURRENT_LIMIT = 4;

var req_session = request.defaults({ headers: { 'User-Agent': 'request' }});
var Promise = models.db.Promise;

var userIdCache;
try {
  userIdCache = JSON.parse(fs.readFileSync(PATH_USER_ID_CACHE));
} catch (e) {
  console.log('Rebuilding cache...');
  userIdCache = {};
}

var teamsCSV = fs.readFileSync('./data/teams.csv', 'utf-8');

function promisifiedRequestGet() {
  var args = Array.from(arguments);
  return new Promise(function(resolve, reject) {
    // add callback manually
    args.push(function(err, result) {
      err ? reject(err) : resolve(result);
    });
    req_session.apply(req_session, args);
  });
}

function extractUsername(profileUrl) {
  var matched = profileUrl.match(/\.com\/([^?]+)/);
  if (matched) {
    return matched[1];
  }
  return null;
}

function parseCSV(content, callback) {
  return new Promise(function(resolve, reject) {
    csv.parse(content, function(err, grid) {
      /* CSV_FIELDS:
      0) '時間戳記', '隊名',
      2) '隊員1', '隊員1學號', '隊員1臉書頁面網址',
      5) '隊員2', '隊員2學號', '隊員2臉書頁面網址',
      8) '隊員3', '隊員3學號', '隊員3臉書頁面網址'
      */

      if (err) {
        reject(err);
        return;
      }

      function mkMember(row, i) {
        if (!row[i]) {
          if (row[i + 1] || row[i + 2])
            throw new Error('Member #' + Math.ceil(i / 3) + ' of ' + row[1] +
              ': other columns should be blank!');
          return null;
        }

        var usrname = extractUsername(row[i + 2]);
        if (usrname == null) {
          // username is required
          console.warn('Member #' + Math.ceil(i / 3) + ' of ' + row[1] +
            ': invalid profile url ' + row[i + 2] + '... Skipping this member!');
          return null;
        }

        var realUrl;
        if (row[i + 2].indexOf('profile.php') >= 0) {
          realUrl = row[i + 2];
        }

        return {
          name: row[i],
          student_id: row[i + 1],
          __username: usrname,
          __real_url: realUrl
        };
      }

      function mkMemberList(row) {
        var rtn = [mkMember(row, 2), mkMember(row, 5), mkMember(row, 8)]
          .filter((v) => v != null);
        return rtn.length ? rtn : null;
      }

      var teams = [];

      grid.forEach(function(row) {
        var ml = mkMemberList(row);
        if (ml) {
          teams.push({ name: row[1], __members: ml });
        } else {
          console.log('Team ' + row[1] + ' with no users... Skipping');
        }
      });

      resolve(teams);
    });
  });
}

// profile url -> fake uid -> photo url -> real user id -> team annotation (update in DB)
//     |-----------------------------------------|  cached
// photo url: http://graph.facebook.com/1198054240214103/picture

console.log('Syncing models... (Teams are truncated!)');
models.Team.sync().then(function() {
  return models.Team.truncate();
}).then(function() {
  console.log('Parsing team table...');
  return parseCSV(teamsCSV);
}).then(function(teams) {
  console.log('Collecting profile, making mappings...');
  var usrArr = [];
  return Promise.each(teams, function(_team_hash, teamIdx, teamLen) {
    console.log('  - For team ' + _team_hash.name + ' (' + (teamIdx + 1) + '/' + teamLen + '):');
    return models.Team.create(_team_hash)
      .then(function(team) {
        return Promise.each(_team_hash.__members, function(user, userIdx) {
          var urlStr = user.__real_url || 'https://facebook.com/' + user.__username;
          process.stdout.write('    - Probing user ' + user.name + ' (' + urlStr + ')\t...');

          function updateUserInst(usrInst, obj) {
            usrArr.push(usrInst);
            usrInst.team_id = team.id;
            // do not call update immediately!!
            for (var x in user) {
              usrInst[x] = user[x];
            }
          }

          function userNotFoundInDBHandler() {
            // we made sure that the user has the avatar/fb_id, but we can't find him
            // maybe he didn't has posts on the event page QQ
            process.stdout.write('\b\b\b \033[33mUser not found QQ. Not updating.\033[0m\n');
          }

          if (userIdCache.hasOwnProperty(urlStr)) {
            var fb_id = userIdCache[urlStr];
            process.stdout.write('\b\b\b -- ' + fb_id + ' (cached)\n');
            return models.User.findOne({ where: { fb_id: fb_id }, include: models.Team })
              .then(function(usrInst) {
                if (!usrInst) return Promise.reject(user);
                updateUserInst(usrInst, user);
              }).catch(userNotFoundInDBHandler);
          }

          return promisifiedRequestGet(urlStr)
            .then(function(resp) {
              var matched = resp.body.match(/<meta property="al:android:url" content="fb:\/\/profile\/(\d+)" \/>/);
              if (matched) {
                var publicUid = matched[1];
                // do not collect this! app-scoped uid is different from user's public uid
                process.stdout.write('\b\b\b -- (' + publicUid + ')...');
                return Promise.resolve(publicUid);
              } else {
                return Promise.reject('id not found');
              }
            }).then(function(publicUid) {
              return promisifiedRequestGet(fbApiUrl.USER(publicUid));
            }).then(function(resp) {
              var avatarUrl = user.__avatarUrl = resp.body.picture.data.url;
              return models.User.findOne({ where: { avatar: avatarUrl }, include: models.Team });
            }).then(function(usrInst) {
              // if no user can be found we can be very sad...
              if (!usrInst) {
                // TODO: ...but we decide to preserve the cache with a mark
                return Promise.reject(user);
              }

              process.stdout.write('\b\b\b \033[32mmatched ' + usrInst.name + ' ==> ' + usrInst.fb_id + '\033[0m\n');
              updateUserInst(usrInst, user);
            }).catch(userNotFoundInDBHandler);
        });
      });  // end of user
  })  // end of team
  .then(function() {
    return Promise.resolve([teams, usrArr]);
  });
}).spread(function(teams, usrArr) {
  console.log('Saving updated user instances...');
  return models.saveAllInstances(usrArr);
}).then(function() {
  console.log('Writing back cache...');
  return new Promise(function(resolve, reject) {
    fs.writeFile(
      PATH_USER_ID_CACHE,
      JSON.stringify(userIdCache),
      'utf-8',
      function(err, result) {
        err ? reject(err) : resolve(result);
      }
    );
  });
}).then(function() {
  console.log('Done!');
});

// async.waterfall([
//   function(cb_next) {  /* 1 */
//     console.log('Syncing models... (Teams and users are truncated!)');
//     models.Team.sync().then(function() {
//       return models.Team.truncate();
//     }).then(function() {
//       return models.User.sync();
//     }).then(function() {
//       return models.User.truncate();
//     }).then(function() {
//       cb_next();
//     });
//   },
//   function(cb_next) {  /* 2 */
//     console.log('Parsing teams table...');
//     var teams = [];
//     parseCSV(teamsCSV, function(err, rows) {
//       teams = rows;
//       cb_next();
//     });
//   },
//   function(cb_next) {  /* 3 */

//   },
//   function(cb_next) {  /* 4 */
//     console.log('Writing back cache...');
//     var outfile = fs.writeFile(PATH_USER_ID_CACHE, JSON.stringify(userIdCache), 'utf-8', function(err, result) {
//       cb_next();
//     });
//   }
// ], function(err) {

// });


