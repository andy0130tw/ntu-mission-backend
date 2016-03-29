#!/usr/bin/env node

var fs = require('fs');

var models = require('../models');
var missions = require('../missions.json');

var cnt = 0;
missions.forEach((v) => {
  v.hash = ++cnt;
})

models.Mission.sync().then(function() {
  models.Mission
  .bulkCreate(missions).then(function() {
    console.log('Success');
  });
})
