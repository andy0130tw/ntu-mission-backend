var Seq = require('sequelize');
var config = require('./config');

var db = new Seq('sqlite://testdb.sqlite', {
    define: {
        // no plural form please
        freezeTableName: true,
        // convert the default column names to `*_by`, `*_id`
        // to be differentiate column names with their decorations
        underscored: true
    },
    // turn off logging if not debugging
    logging: config.DB_LOGGING || config.DEBUG
});

var User = db.define('user', {
  fb_id:      { type: Seq.STRING, unique: true },
  student_id: { type: Seq.STRING, unique: true },
  uid:        { type: Seq.STRING, unique  : true },
  name:       { type: Seq.STRING },                    // }
  avatar:     { type: Seq.STRING },                    // }- these fields only work as a cache!
  score:      { type: Seq.INTEGER, defaultValue: 0 },  // }
  confirmed:  { type: Seq.BOOLEAN },
  disabled:   { type: Seq.BOOLEAN }
});

var Mission = db.define('mission', {
  hash:        { type: Seq.INTEGER, unique: true },
  title:       { type: Seq.TEXT },
  category:    { type: Seq.STRING },
  subcategory: { type: Seq.STRING },
  content:     { type: Seq.TEXT },
  difficulty:  { type: Seq.INTEGER, defaultValue: 1 },  // ENUM?
  score:       { type: Seq.INTEGER }
});

var Post = db.define('post', {
  fb_id:     { type: Seq.STRING, unique: true },
  content:   { type: Seq.TEXT },
  photo_url: { type: Seq.TEXT },
  deleted:   { type: Seq.BOOLEAN },
  fb_ts:     { type: Seq.DATE },
  status:    { type: Seq.INTEGER }  // ENUM?
  // uid related to User
  // mid related to Mission
});

var ScoreRecord = db.define('scoreRecord', {
  // pid related to Post
  // uid related to User
  // mid related to Mission
});

// foreign keys
User.hasMany(Post);
Mission.hasMany(Post);

Post.hasOne(ScoreRecord);
User.hasMany(ScoreRecord);
Mission.hasMany(ScoreRecord);

db.sync().then(function() {
  // create void user
  User.findOrCreate({
    where: { id: -1 },
    defaults: {
      fb_id: 'DOES_NOT_EXIST',
      student_id: 'X88888888'
    }
  });
});

module.exports = {
  db: db,

  User:        User,
  Mission:     Mission,
  Post:        Post,
  ScoreRecord: ScoreRecord
};
