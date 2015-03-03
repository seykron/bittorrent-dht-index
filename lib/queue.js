/** Creates a new queue for bittorrent infohashes.
 */
module.exports = function Queue() {

  /** Node's file system API. */
  var fs = require("fs");

  /** Node's readline API. */
  var readline = require('readline');

  /** Default logger.
   * @type {Function}
   */
  var debug = require("debug")("queue");

  /** Async utilities. */
  var async = require("async");

  /** Size of the read line buffer. Hashes are flushed to redis when the
    the number of lines reach this threshold. */
  var FILE_BUFFER_SIZE = 100000;

  /** Redis client library. */
  var redis = require("redis");

  /** Redis client bound to localhost. It prints errors out. */
  var client = (function () {
    var redisClient = redis.createClient();

    redisClient.on("error", function (err) {
      debug("redis client error %s", err);
    });

    return redisClient;
  }());

  /** Key where the queue is stored at redis. */
  var QUEUE_KEY = "queue";

  return {

    /** Retrieves a set of elements from the queue, from the highest to the
     * lowest score.
     *
     * @param {Number} count Number of items to retrieve. Must be greater
     *    than 0.
     * @param {Function} callback It takes an error and the list of items as
     *    parameters. Cannot be null.
     */
    get: function (count, callback) {
      debug("retrieving %s elements from the queue", count);

      client.zrange(QUEUE_KEY, -count, -1, callback);
    },

    /** Adds a single item to the queue. If the item exists, its score is
     * increased by 1.
     * @param {String} infoHash Item to add. Cannot be null or empty.
     */
    add: function (infoHash) {
      debug("adding infohash %s", infoHash);

      client.zincrby(QUEUE_KEY, 1, infoHash, function (err) {
        if (err) {
          debug("error inserting infohash %s", infoHash);
        }
      });
    },

    /** Reads a file line by line and adds each line to the queue. If any
     * item already exists, its score is increased by 1.
     *
     * @param {String} file File to read. Cannot be null or empty.
     */
    addFile: function (file) {
      // Line reader.
      var rl = readline.createInterface({
        input: fs.createReadStream(file),
        terminal: false
      });

      // An object is used as a temporary hash table in order to avoid
      // duplicates
      var table = {};
      // List of items to insert in the current bulk.
      var buffer = [];
      // Number of items successfully added.
      var success = 0;
      // Total number of items with duplicates.
      var total = 0;
      // Items are added to the table until this counter reaches the
      // FILE_BUFFER_SIZE threshold.
      var count = 0;

      var flush = function (callback) {
        var infoHash;
        var length;

        // Reads items from the table.
        buffer = Object.keys(table);
        length = buffer.length;

        // Uses pipelining to send commands to redis.
        while (infoHash = buffer.shift()) {
          client.zincrby(QUEUE_KEY, 1, infoHash);
        }

        debug("%s items added", length);

        total += count;
        count = 0;
        table = {};
        buffer = [];

        callback();
      };

      debug("adding infohash file %s", file);

      rl.on("line", function (infoHash) {
        table[infoHash] = infoHash;

        if (count === FILE_BUFFER_SIZE) {
          // Pauses the input stream until the current table is flushed
          // to Redis.
          rl.pause();
        } else {
          count += 1;
        }
      });

      rl.on("pause", function () {
        flush(function () {
          rl.resume();
        });
      });

      rl.on("close", function () {
        flush(function () {
          debug("%s unique elements read from file. %s total", success,
            total);
        });
      });
    }
  };
};
