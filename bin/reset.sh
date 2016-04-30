#!/bin/sh
rm testdb.sqlite
./bin/import_mission.js
./bin/import_team.js
