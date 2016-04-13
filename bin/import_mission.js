#!/usr/bin/env node

var fs = require('fs');

var models = require('../models');
var missions = require('../missions.json');

// var cnt = 0;
// missions.forEach((v) => {
//   v.hash = ++cnt;
// });

[
  {"title": "[Special] 笑話大賽", "difficulty": 0, "hash": "Q01"},
].forEach((v, i) => {
    v.category = 'SPECIAL';
    v.id = -(i + 1);
    missions.push(v);
});

models.Mission.sync().then(function() {
  models.Mission
  .bulkCreate(missions).then(function() {
    console.log('Successfully imported ' + missions.length + ' missions.');
  });
});
