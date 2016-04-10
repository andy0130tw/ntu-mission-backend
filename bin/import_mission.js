#!/usr/bin/env node

var fs = require('fs');

var models = require('../models');
var missions = require('../missions.json');

// var cnt = 0;
// missions.forEach((v) => {
//   v.hash = ++cnt;
// });

[
  {"title": "old mission #1", "difficulty": 1, "hash": "MISSION01"},
  {"title": "old mission #2", "difficulty": 3, "hash": "MISSION02"},
  {"title": "old mission #3", "difficulty": 3, "hash": "MISSION03"},
  {"title": "old mission #4", "difficulty": 1, "hash": "MISSION04"},
].forEach((v, i) => {
    v.category = '__OLD__';
    v.id = -(i + 1);
    missions.push(v);
});

models.Mission.sync().then(function() {
  models.Mission
  .bulkCreate(missions).then(function() {
    console.log('Successfully imported ' + missions.length + ' missions.');
  });
});
