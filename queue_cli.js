process.env.DEBUG = "queue queue_cli";

var debug = require("debug")("queue_cli");
var Promise = require("promise/setimmediate");
var Queue = require("./lib/queue");
var queue = new Queue();
var args = process.argv.slice(2, process.argv.length);
var command = args.shift();

var Commands = {
  addFile: function (file) {
    return new Promise((resolve, reject) => {
      debug("adding file %s to queue", file);
      resolve(queue.addFile(file));
    });
  }
};

if (Commands.hasOwnProperty(command)) {
  Commands[command].apply(null, args)
    .then(() => queue.close())
    .catch(err => debug("error executing command %s: %s", command, err));
} else {
  debug("command not found: %s", command);
}