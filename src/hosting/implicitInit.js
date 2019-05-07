"use strict";

var fs = require("fs");

var fetchWebSetup = require("../fetchWebSetup");

var INIT_TEMPLATE = fs.readFileSync(__dirname + "/../../templates/hosting/init.js", "utf8");

module.exports = function(options) {
  const eventualConfig = options.webAppConfig
    ? Promise.resolve(options.webAppConfig)
    : fetchWebSetup(options);
  return eventualConfig.then(function(config) {
    var configJson = JSON.stringify(config, null, 2);
    return {
      js: INIT_TEMPLATE.replace("{/*--CONFIG--*/}", configJson),
      json: configJson,
    };
  });
};
