#!/usr/bin/env node
var fs = require('fs');

var csv = require('csv');

var models = require('../models');
var Promise = models.db.Promise;

var teamsCSV = fs.readFileSync('./data/teams.csv', 'utf-8');

function parseCSV(content) {
  return new Promise(function(resolve, reject) {
    csv.parse(content, function(err, grid) {
      var hash = {};

      grid.forEach(function(row) {
        var id    = row[0];
        var tname = row[1];
        if (!hash.hasOwnProperty(tname))
          hash[tname] = {name: tname, members: []};
        hash[tname].members.push(id);
      });

      var teamArr = [];
      for (var x in hash) teamArr.push(hash[x]);

      if (err) {
        reject(err);
        return;
      }

      resolve(teamArr);
    });
  });
}

console.log('Syncing models... (Teams are truncated!)');
models.Team.sync().then(function() {
  return models.Team.truncate();
}).then(function() {
  console.log('Parsing team table...');
  return parseCSV(teamsCSV);
}).then(function(teams) {
  var userArr = [];
  return Promise.each(teams, function(team, i) {
    console.log('Team name = ' + team.name);

    return models.Team.create({
      name: team.name
    }).then(function(teamInst) {
      return Promise.each(team.members, function(memberFbId, j) {
        return models.User.findOne({ where: { fb_id: memberFbId } }).then(function(userInst) {
          if (!userInst) return Promise.reject([memberFbId, 'not found']);
          console.log('  User', userInst.name, '->', memberFbId);
          userArr.push(userInst);
          userInst.team_id = teamInst.id;
        });
      });
    }).catch(function(err) {
      console.log('  User w/ id = ' + err[0] + ' not found');
    });
  })
  .then(function() {
    return Promise.resolve(userArr);
  }).then(function(userArr) {
    console.log('Commiting...');
    models.saveAllInstances(userArr);
  });
});
