#!/usr/bin/env node
var request = require('request');

var models = require('../models');
var fbApiUrl = require('../fbapi-url');

var argArr = process.argv.slice(2);
if (!argArr.length) {
  console.log('Usage: node add_user.js <fb_id>');
  console.log('The user will be initiated / updated in DB.');
  process.exit(1);
}

models.User.sync().then(function() {
  var fbId = argArr[0];
  console.log('getting FB id', fbId);
  request.get(fbApiUrl.USER(fbId), function(err, resp) {
    var errorObj = resp.body.error;
    if (errorObj) {
      console.log('Error occurred:', errorObj.type, errorObj.message);
      return process.exit(2);
    }

    var avatarUrl = null;
    var avatarObj = resp.body.picture;
    if (avatarObj)
      avatarUrl = avatarObj.url;

    models.User.findOrCreate({
      where: { fb_id: fbId },
      defaults: {
        name: resp.body.name,
        avatar: avatarUrl
      }
    }).then(function(user, created) {
      if (created)
        console.log('User created...');
      else
        console.log('User updated...');

      console.log(user[0].dataValues);
    });
  });
});
