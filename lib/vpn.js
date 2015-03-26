/** Manages the TINC VPN configuration.
 */
module.exports = function VPN (configDir, options) {

  /** Current instance. */
  var vpn = this;

  /** Node's path API. */
  var path = require("path");

  /** Subnet mask for the VPN. It allows 1,048,576 hosts. */
  var SUBNET_MASK = "255.240.0.0";

  /** Length of the subnet mask. */
  var SUBNET_MASK_RANGE = 12;

  /** Command to retrieve the current tinc version. */
  var CMD_VERSION = "tincd --version";

  /** Command to generate RSA key pair for the secure connection. */
  var CMD_GEN_KEYS = "tincd -n %s -c %s -K &> /dev/null";

  /** Daemon pid file. */
  var PID_FILE = path.join(configDir, "tinc.pid");

  /** Daemon log file. */
  var LOG_FILE = path.join(configDir, "tinc.log");

  /** Command to bootstrap the VPN network interface.
   *
   * TODO(seykron): it is platform-dependant, add support for the different
   * platforms according to the tinc documentation. This command actually works
   * for most platforms. See:
   * http://tinc-vpn.org/documentation/Interface-configuration.html
   */
  var CMD_NET_BOOTSTRAP = "ifconfig $INTERFACE %s netmask 255.240.0.0";

  /** Command to initialize the VPN. */
  var CMD_VPN_INIT = "tincd -c %s --logfile %s --pidfile %s -U %s -R -d 3";

  /** Command to shutdown the VPN. */
  var CMD_VPN_SHUTDOWN = "tincd -n %s --pidfile %s -k";

  /** Command to reload tincd daemon configuration. */
  var CMD_VPN_RELOAD = "tincd -n %s --pidfile %s -k HUP";

  /** User to chroot the tinc daemon. */
  var CHROOT_USER = options && options.user || "root";

  /** Tinc daemon main configuration file. */
  var MAIN_CONFIG = path.join(configDir, "tinc.conf");

  /** Hosts files directory. */
  var HOSTS_DIR = path.join(configDir, "hosts");

  /** Node's file system API. */
  var fs = require("fs");

  /** Node's general utilities. */
  var util = require("util");

  /** Utility to execute external processes. */
  var exec = require("child_process").exec;

  /** Executes commands with root privileges
   * TODO(seykron): integrate node-windows in order to rise privileges on
   * Windoz.
   */
  var sudo = require("sudo");

  /** Class logger. */
  var debug = require("debug")("vpn");

  /** Utility to manage asynchronous operations. */
  var async = require("async");

  /** Utility to compose mixins. */
  var extend = require("extend");

  /** Generates random ids. */
  var hat = require("hat");

  /** Utility to generate random ip addresses. */
  var randomIp = require("random-ip");

  /** Gossip validation library. */
  var Gossip = require("./gossip");

  /** Utility to manage events. */
  var EventEmitter = require("events").EventEmitter;

  /** Utility to read log files. */
  var Tail = require('tail').Tail;

  /** Indicates whether tinc is properly configured. */
  var configured = fs.existsSync(path.join(configDir, "rsa_key.priv"));

  /** Host name and address, it is never null after init(). */
  var nodeInfo;

  /** Represents this node in the distributed network. */
  var node;

  /** Executes a command as root and it asks for the root password if needed.
   * @param {String} command Command to execute. Cannot be null or empty.
   * @param {Function} callback Receives an error and the command result. Cannot
   *    be null.
   */
  var execRoot = function (command, callback) {
    var sudoOptions = {
      cachePassword: true,
      prompt: "Enter root password to setup the VPN: "
    };

    var child = sudo(command.split(" "), sudoOptions);
    var result = "";
    var err = "";

    child.stdout.on('data', function (data) {
      result += data.toString();
    });

    child.stderr.on('data', function (data) {
      err += data.toString();
    });

    child.on('close', function (code) {
      if (err) {
        callback(new Error(err));
      } else {
        callback(null, result);
      }
    });
  };

  var readHostConfig = function (hostFile) {
    var lines = fs.readFileSync(hostFile).toString().split("\n");
    var host = {};
    var armoredKey = "";
    var publicKey;
    var readKey = false;

    lines.forEach(function (line) {
      var field = line.trim();
      var name;
      var value;

      if (field.indexOf("=") > -1) {
        // It is a field in the format Field = Value
        name = field.substr(0, field.indexOf("=")).toLowerCase().trim();
        value = field.substr(field.indexOf("=") + 1).trim();

        if (host.hasOwnProperty(name)) {
          host[name] = [host[name]];
          host[name].push(value);
        } else {
          host[name] = value;
        }
      }

      if (field.indexOf("-----END RSA PUBLIC KEY-----") > -1) {
        readKey = false;
      }

      if (readKey) {
        armoredKey += field;
      }

      if (field.indexOf("-----BEGIN RSA PUBLIC KEY-----") > -1) {
        readKey = true;
      }
    });

    if (armoredKey) {
      host.publicKey = new Buffer(armoredKey, "base64");
    }

    return host;
  };

  var addHost = function (name, host) {
    var hostFile = path.join(HOSTS_DIR, name);
    var armoredKey = host.publicKey.toString("base64");
    var writer;

    if (fs.existsSync(hostFile)) {
      debug("host %s already exist", name);
      return;
    }

    writer = fs.createWriteStream(hostFile);

    Object.keys(host).forEach(function (fieldName) {
      if (fieldName !== "publicKey") {
        writer.write(fieldName + " = " + host[fieldName].toString() + "\n");
      }
    });

    writer.write("\n");
    writer.write("-----BEGIN RSA PUBLIC KEY-----\n");

    armoredKey.split("").forEach(function (charCode, index) {
      if (index > 0 && index % 63 === 0) {
        writer.write("\n");
      }

      writer.write(charCode);
    });

    writer.write("\n-----END RSA PUBLIC KEY-----");
    writer.end();
  };

  /** Retrieves Tinc version.
   *
   * @param {Function} callback Receives the current tinc version, or null if
   *    tinc is not found in PATH.
   */
  var getVersion = function (callback) {
    debug("exec: %s", CMD_VERSION);

    exec(CMD_VERSION, function (err, stdout, stderr) {
      var versionInfo;

      if (err) {
        callback(err);
        return;
      }

      versionInfo = stdout.toString().split("\n").shift();

      if (versionInfo) {
        debug(versionInfo);
        callback(null, versionInfo);
      } else {
        debug("tinc not found in PATH");
        callback(new Error("tinc not found in PATH."));
      }
    });
  };

  /** Configures the tinc daemon.
   * @param {Function} callback Receives an error as parameter. Cannot be null.
   */
  var configure = function (callback) {
    var bootstrapFile = path.join(configDir, "tinc-up");
    var hostName = "btindex_" + hat(24);
    var hostFile = path.join(HOSTS_DIR, hostName);
    var hostAddress = randomIp("10.2.0.0", SUBNET_MASK_RANGE);
    var genKeysCommand = util.format(CMD_GEN_KEYS, hostName, configDir);

    if (!fs.existsSync(HOSTS_DIR)) {
      fs.mkdirSync(HOSTS_DIR);
    }

    fs.appendFileSync(MAIN_CONFIG, "Name = " + hostName + "\n");
    fs.appendFileSync(hostFile, "Subnet = 10.0.0.0/12\n");
    fs.appendFileSync(hostFile, "IndirectData = Yes\n");

    if (options.vpn && options.vpn.bindAddress) {
      fs.appendFileSync(hostFile, "Address = " + options.vpn.bindAddress +
        "\n");
    }
    if (options.vpn && options.vpn.bindPort) {
      fs.appendFileSync(hostFile, "Port = " + options.vpn.bindPort + "\n");
    }

    debug("exec: %s", genKeysCommand);

    // Generates RSA key pair for the secure connection.
    exec(genKeysCommand, function (err, stdout, stderr) {
      if (err) {
        callback(err);
        return;
      }

      fs.writeFileSync(bootstrapFile, "#!/bin/sh\n", {
        mode: parseInt(755, 8)
      });
      fs.appendFileSync(bootstrapFile,
        util.format(CMD_NET_BOOTSTRAP, hostAddress));
      fs.writeFileSync(path.join(configDir, "address"), hostAddress);

      configured = true;
      callback();
    });
  };

  /** Reloads the tinc daemon.
   */
  var reload = function () {
    var reloadCommand = util.format(CMD_VPN_RELOAD, nodeInfo.name, PID_FILE);

    execRoot(reloadCommand, function (err) {
      if (err) {
        debug("tinc daemon reload failed: %s", err);
      } else {
        debug("tinc daemon reloaded.");
      }
    });
  };

  /** Initializes the node in the distributed network.
   */
  var initNode = function (callback) {
    node = new Gossip(nodeInfo, {
      bindPort: options && options.gossip && options.gossip.bindPort,
      bindAddress: options && options.gossip && options.gossip.bindAddress,
      seed: options && options.gossip && options.gossip.seed
    });

    node.on("connectto", function (peers) {
      debug("connect %s to %s", nodeInfo.name, JSON.stringify(peers));

      // TODO(seykron): check whether connections to peers already
      // exist in the configuration file.
      peers.forEach(function (peer) {
        peer.data.host.address = peer.node.address;
        addHost(peer.data.name.toString(), peer.data.host);
        fs.appendFileSync(MAIN_CONFIG, "ConnectTo = " + peer.data.name + "\n");
      });

      // Reloads the tinc configuration after 5 seconds.
      setTimeout(reload, 5000);
    });

    node.on("accept", function (peer) {
      debug("accept %s", peer.name.toString());
      addHost(peer.name.toString(), peer.host);
    });

    callback();
  };

  /** Starts the tinc daemon.
   * @param {Function} callback Receives an error as parameter. Cannot be
   *    null.
   */
  var initDaemon = function (callback) {
    var initCommand = util.format(CMD_VPN_INIT, configDir, LOG_FILE, PID_FILE,
      CHROOT_USER);

    nodeInfo = readHostConfig(MAIN_CONFIG);
    nodeInfo.address = fs.readFileSync(path.join(configDir, "address"))
      .toString().trim();
    nodeInfo.host = readHostConfig(path.join(HOSTS_DIR, nodeInfo.name));

    debug("exec: %s", initCommand);

    execRoot(initCommand, function () {
      var tail = new Tail(LOG_FILE);

      tail.on("line", function (data) {
        vpn.emit("log", data);
      });

      tail.on("error", function (err) {
        debug("error reading log file: %s", err);
      });

      callback();
    });
  };

  /** Shutdowns the tinc daemon.
   * @param {Function} callback It receives an error as parameter. Cannot be
   *    null.
   */
  var shutdown = function (callback) {
    var pidFile = path.join(configDir, "tinc.pid");
    var shutdownCommand = util.format(CMD_VPN_SHUTDOWN, nodeInfo.name, pidFile);

    execRoot(shutdownCommand, callback);
  };

  (function __constructor() {
    // Shutdowns the VPN.
    process.on("SIGINT", function () {
      debug("shutdown");

      shutdown(function (err) {
        if (err) {
          debug("shutdown error: %s", err);
        }

        process.exit();
      });
    });
  }());

  return extend(vpn, new EventEmitter(), {

    /** Returns the host address within the VPN.
     * @return A valid ipv4 address, never null after init().
     */
    getAddress: function () {
      return nodeInfo.address;
    },

    /** Initializes the VPN daemon and the network node.
     */
    connect: function (callback) {
      var initTasks = [getVersion];

      if (!configured) {
        initTasks.push(configure);
      }

      initTasks.push(initDaemon);
      initTasks.push(initNode);

      async.series(initTasks, callback);
    },

    /** Shutdowns the VPN.
     */
    shutdown: shutdown,

    /** Joins the VPN if it is the first time this node is started.
     */
    join: function () {
      node.join();
    }
  });
}
