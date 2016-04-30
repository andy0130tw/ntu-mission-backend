#!/usr/bin/env node
var fs = require('fs');

var async = require('async');
var csv = require('csv');
var request = require('request');

var models = require('../models');

var PATH_USER_ID_CACHE = './data/user_id_cache.json';
var CONCURRENT_LIMIT = 4;

var req_session = request.defaults({ headers: { 'User-Agent': 'request' }});

var userIdCache;
try {
  userIdCache = JSON.parse(fs.readFileSync(PATH_USER_ID_CACHE));
} catch (e) {
  console.log('Rebuilding cache...');
  userIdCache = {};
}

var teamsCSV = fs.readFileSync('./data/teams.csv', 'utf-8');

var teams = [];

function extractUsername(profileUrl) {
  var matched = profileUrl.match(/\.com\/([^?]+)/);
  if (matched) {
    return matched[1];
  }
  return null;
}

function parseCSV(content, callback) {
  csv.parse(content, function(err, grid) {
  /* CSV_FIELDS:
  0) '時間戳記', '隊名',
  2) '隊員1', '隊員1學號', '隊員1臉書頁面網址',
  5) '隊員2', '隊員2學號', '隊員2臉書頁面網址',
  8) '隊員3', '隊員3學號', '隊員3臉書頁面網址'
  */

    function mkMember(row, i) {
      if (!row[i]) {
        if (row[i + 1] || row[i + 2])
          throw new Error('Member #' + Math.ceil(i / 3) + ' of ' + row[1] + ': other columns should be blank!');
        return null;
      }

      var usrname = extractUsername(row[i + 2]);
      if (usrname == null) {
        // username is required
        console.warn('Member #' + Math.ceil(i / 3) + ' of ' + row[1] + ': invalid profile url ' + row[i + 2] + '... Skipping this member!');
        return null;
      }

      return {
        name: row[i],
        student_id: row[i + 1],
        __username: usrname
      };
    }

    function mkMemberList(row) {
      var rtn = [mkMember(row, 2), mkMember(row, 5), mkMember(row, 8)]
        .filter((v) => v != null);
      return rtn.length ? rtn : null;
    }

    grid.forEach(function(row) {
      var ml = mkMemberList(row);
      if (ml) {
        teams.push({ name: row[1], __members: ml });
      } else {
        console.log('Team ' + row[1] + ' with no users... Skipping');
      }
    });

    callback.call(this);
  });
}

async.waterfall([
  function(cb_next) {  /* 1 */
    console.log('Syncing models... (Teams and users are truncated!)');
    models.Team.sync().then(function() {
      return models.Team.truncate();
    }).then(function() {
      return models.User.sync();
    }).then(function() {
      return models.User.truncate();
    }).then(function() {
      cb_next();
    });
  },
  function(cb_next) {  /* 2 */
    console.log('Parsing teams table...');
    var teams = [];
    parseCSV(teamsCSV, function(err, rows) {
      teams = rows;
      cb_next();
    });
  },
  function(cb_next) {  /* 3 */
    console.log('Collecting profiles...');
    async.each(teams, function(team, cb_completedTeam) {
      console.log('For team: ' + team.name);
      models.Team.create(team).then(function(teamObj) {
        async.each(team.__members, function(user, cb_completedUser) {
          if (userIdCache[user.__username]) {
            user.fb_id = userIdCache[user.__username];
            console.log('  username to uid mapping:', user.__username, '->', user.fb_id, '(cached)');
            cb_completedUser();
          } else {
            req_session.get('https://facebook.com/' + user.__username, function(err, resp) {
              var matched = resp.body.match(/<meta property="al:android:url" content="fb:\/\/profile\/(\d+)" \/>/);
              if (matched) {
                userIdCache[user.__username] = matched[1];
                user.fb_id = matched[1];
                console.log('  username to uid mapping:', user.__username, '->', user.fb_id);
              }
              cb_completedUser();
            });
          }
        }, function(err) {
          team.__members.forEach(function(v) {
            v.team_id = teamObj.id;
          });
          models.User
            .bulkCreate(team.__members)
            .then(function() {
              cb_completedTeam();
            });
        });
      });
    }, function(err) { cb_next(); });
  },
  function(cb_next) {  /* 4 */
    console.log('Writing back cache...');
    var outfile = fs.writeFile(PATH_USER_ID_CACHE, JSON.stringify(userIdCache), 'utf-8', function(err, result) {
      cb_next();
    });
  }
], function(err) {

});


