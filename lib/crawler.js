/** Bittorrent crawler to retrieve metadata from infohashes.
 *
 * It takes the infohashes from a <code>Queue</code> and crawls the bittorrent
 * DHT to search for peers that provide the required metadata.
 *
 * It works according the following algorithm:
 *
 * 1. Retrieves a set of infohashes from the queue, creates a crawling job for
 * each one and puts them into a jobs queue with JOB_SLOTS concurrent tasks.
 *
 * 2. Each crawling job look for torrent in the DHT and it tries to fetch the
 * metadata from the NFO file.
 *
 * 3. When the metadata is found, the crawler emits the 'torrent' event
 * providing the torrent and a callback to remove the infohash
 * from the queue as parameters. Then it kills the crawling job for the
 * underlying infohash.
 */
module.exports = function Crawler(theQueue) {

  /** Crawler instance. */
  var crawler = this;

  /** Number of concurrent tasks to crawl infohashes. */
  var JOB_SLOTS = 4;

  /** Timeout to look up the metadata of a single infohash. */
  var JOB_TIMEOUT = 30 * 1000;

  /** Utility to manage asynchronous operations. */
  var async = require("async");

  /** Queue to retrieve infohashes. */
  var Queue = require("./queue");

  /** Node's event emitter. */
  var EventEmitter = require("events").EventEmitter;

  /** Utility to build mixins. */
  var extend = require("extend");

  /** Prints debug information for this component. */
  var debug = require("debug")("crawler");

  /** Manages a single torrent file. */
  var Torrent = require("./torrent");

  /** Promises library. */
  var Promise = require("promise/setimmediate");

  /** Queue instance to retrieve infohashes. */
  var queue = theQueue || new Queue();

  /** Starts the crawling process. */
  var start = function () {
    var jobsQueue = async.queue(function (infoHash, next) {
      var torrent = new Torrent(infoHash);

      debug("crawling %s", infoHash);

      torrent.fetch().then(torrent => {
        debug("crawling done for %s", infoHash);
        crawler.emit("torrent", infoHash, torrent, next);
      }).catch(err => {
        debug("error fetching torrent %s: %s", infoHash, err);
        next(err);
      });
    }, JOB_SLOTS);

    jobsQueue.drain = function () {
      queue.get(JOB_SLOTS, function (err, infoHashes) {
        if (err) {
          debug("error reading queue: %s", err);
          return;
        }

        infoHashes.forEach(infoHash => jobsQueue.push(infoHash));
      });
    };

    jobsQueue.drain();
  };

  return extend(crawler, new EventEmitter(), {

    /** Starts crawling the infohashes from the specified queue. */
    start: start
  });
};
