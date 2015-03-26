process.env.DEBUG = (process.env.DEBUG || "") + " vpn_test vpn";

var fs = require("fs");
var path = require("path");
var os = require("os");
var debug = require("debug")("vpn_test");
var async = require("async");
var configFile = path.join(__dirname, "..", "conf", "config.json");

var config = JSON.parse(fs.readFileSync(configFile).toString());

var tempDir = function (name) {
  var dir = path.join(os.tmpdir(), name);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir);
  }

  return dir;
};
var VPN_DIR = (function () {
  var vpnDir = path.join(__dirname, "..", "conf", "vpn");

  if (!fs.existsSync(vpnDir)) {
    fs.mkdirSync(vpnDir);
  }
  return vpnDir;
}());

var VPN = require("../lib/vpn");
var Gossip = require("../lib/gossip");

var vpn = new VPN(VPN_DIR, config.index);

var vpn1 = new VPN(tempDir("vpn1"), {
  vpn: {
    bindPort: 657
  },
  gossip: {
    bindAddress: "127.0.0.1",
    bindPort: 7777
  }
});
var vpn2 = new VPN(tempDir("vpn2"), {
  vpn: {
    bindPort: 658
  },
  gossip: {
    bindAddress: "127.0.0.1",
    bindPort: 7778
  }
});

var seed = new Gossip({ data: "seed" }, {
  validationNodes: [{
    address: "127.0.0.1",
    port: 7777
  }, {
    address: "127.0.0.1",
    port: 7778
  }]
});

vpn.on("log", function (line) {
  debug("log: %s", line);
});

seed.on("ready", function () {
  async.parallel([vpn.connect, vpn1.connect, vpn2.connect], function (err) {
    if (err) {
      debug("error: %s", err);
      return;
    }
    debug("VPN initialized.");
    vpn.join();

    setTimeout(function () {
      vpn.shutdown(function (err) {
        debug("VPN stopped.");
      });
    }, 120000);
  });
});
