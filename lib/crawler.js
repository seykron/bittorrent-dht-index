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
 * 2. Each crawling job creates a transaction queue with TRANSACTION_SLOTS
 * concurrent tasks and adds the BOOTSTRAP_NODES to the queue.
 *
 * 3. For each node, the crawling job creates a transaction to execute the
 * get_peers() query against the node, then the transaction waits for a reply
 * with a timeout of TRANSACTION_TIMEOUT.
 *
 * 4. The get_peers() query could return either a list of peers or nodes. If the
 * reply does not contains peers, the transaction adds the nodes to the
 * crawling job queue.
 *
 * 5. If the reply contains peers, they are put into a peers queue with
 * PEER_SLOTS concurrent tasks, then it asks for metadata to each peer until
 * any of them returns the metadata.
 *
 * 6. When the metadata is found, the crawler emits the 'metadata' event
 * providing the infohash, the metadata and a callback to remove the infohash
 * from the queue as parameters. Then it kills the crawling job for the
 * underlying infohash.
 *
 * The following operation determines the number of concurrent network
 * connections in the worst case:
 *
 *    c = JOB_SLOTS * TRANSACTION_SLOTS * PEER_SLOTS
 *
 * According the the default values, the number of concurrent network
 * connections in the worst case is up to 100.
 */
module.exports = function Crawler(router, theQueue) {

  /** Crawler instance. */
  var crawler = this;

  /** Max number of bootstrap nodes to search for nodes the first time
  a job is created. */
  var MAX_BOOTSTRAP_NODES = 5;

  /** Number of concurrent tasks to crawl infohashes. */
  var JOB_SLOTS = 4;

  /** Max number of concurrent tasks to search for nodes on the DHT network. */
  var TRANSACTION_SLOTS = 5;

  /** Max number of concurrent tasks to search for metadata on peers. */
  var PEER_SLOTS = 5;

  /** Timeout to look up the metadata of a single infohash. */
  var JOB_TIMEOUT = 30 * 1000;

  /** Timeout for the get_peers query, in milliseconds. If a node does not
    answer within this period, the transaction is terminated. */
  var TRANSACTION_TIMEOUT = 2000;

  /** List of bootstrap nodes used to start crawling the DHT from. */
  var BOOTSTRAP_NODES = ["localhost:6881"];

  /** Utility to generate random ids. */
  var hat = require("hat");

  /** Utility to extend objects. */
  var extend = require("extend");

  /** Utility to manage asynchronous operations. */
  var async = require("async");

  /** Utility to convert bittorrent "compact" addresses to host:port format. */
  var compact2string = require("compact2string");

  /** Queue to retrieve infohashes. */
  var Queue = require("./queue");

  /** Node's event emitter. */
  var EventEmitter = require("events").EventEmitter;

  /** Prints debug information for this component. */
  var debug = require("debug")("crawler");

  /** Queue instance to retrieve infohashes. */
  var queue = theQueue || new Queue();

  /* Key: infoHash; Value: Object representing the current results of this crawl
    job (peers and nodes set using object). */
  var jobs = {};

  /* Key: transactionId; Value: transaction object created by
  createTransaction(). */
  var transactions = {};

  /** Creates a transaction to search for peers on the specified node.
   * @param {Object} job Job that contains this transaction. Cannot be null.
   * @param {Object} node Address information of the node to query. Cannot be
   *    null.
   * @param {Function} callback Invoked when the transaction finished. It does
   *    not imply success.
   * @return {Object} Returns a transaction object, never null.
   */
  var createTransaction = function (job, node, callback) {
    // Custom node id for this transaction and the next requests.
    var nodeId = hat(160);
    var infoHash = job.infoHash;
    var transactionId;
    var transactionTimeout;
    var managed = false;

    // Queue to look for metadata in peers.
    var peersQueue = async.queue(function (task, next) {
      var peer = task.peer;

      router.fetchMetadata(nodeId, peer, infoHash, function (err, metadata) {
        if (err) {
          next();
        } else {
          debug("received metadata from %s: %s", peer, metadata);
          peersQueue.kill();

          crawler.emit("metadata", infoHash, metadata, function () {
            // TODO(seykron): remove the infohash from the queue.
            callback();
          });
        }
      });
    }, PEER_SLOTS);

    // It returns when there're no more peers to query.
    peersQueue.drain = callback;

    while (!transactionId || transactions.hasOwnProperty(transactionId)) {
      transactionId = Math.floor(Math.random() * Math.pow(2, 12));
    }

    return {

      /* Unique id for this transaction. */
      id: transactionId,

      /** Transaction's related infohash. */
      infoHash: infoHash,

      /** Kills this transaction in order to continue looking for metadata in
       * another nodes.
       */
      kill: function () {
        clearTimeout(transactionTimeout);
        callback();
      },

      /** Handles a response from a node. If there are peers, they are queried
       * to check whether they have the required metadata. If they don't have
       * the metadata, the underlying nodes are added to the job's queue. If
       * there are not peers, the nodes are added to the job's queue.
       *
       * @param {Object} res Node's response body. Cannot be null.
       */
      handle: function (res) {
        var addressInfo;

        clearTimeout(transactionTimeout);

        if (res.values) {
          // There're are peers for the infohash.
          debug("found peers for %s", infoHash);

          // There're peers, searches for metadata in this set.
          res.values.forEach(function (address) {
            var peer = compact2string(address);

            peersQueue.push({
              nodeId: nodeId,
              peer: peer,
              infoHash: infoHash
            });
          });
        } else if (res.nodes && Buffer.isBuffer(res.nodes)) {
          // There're not peers, adding nodes to the job's queue to continue
          // searching for peers.

          for (var i = 0; i < res.nodes.length; i += 26) {
            // Adds a node to the queue.
            addressInfo = compact2string(res.nodes.slice(i + 20, i + 26));

            job.addNode({
              address: addressInfo.substr(0, addressInfo.indexOf(":")),
              port: addressInfo.substr(addressInfo.indexOf(":") + 1)
            });
          }

          callback();
        } else {
          debug("invalid response for infohash %s", infoHash);
          callback();
        }
      },

      /** Sends the get_peers query to the node.
       */
      execute: function () {
        router.query(node, transactionId, "get_peers", {
          id: new Buffer(nodeId, "hex"),
          info_hash: new Buffer(infoHash, "hex")
        });

        // It waits a while to get a response from the node, then the
        // transaction is terminated and it proceeds with the next node.
        transactionTimeout = setTimeout(function () {
          debug("transaction timeout %s:%s for %s", node.address, node.port,
            infoHash);
          delete transactions[transactionId];
          callback();
        }, TRANSACTION_TIMEOUT);
      }
    };
  };

  /** Creates and executes the crawl job to search for the metadata for the
   * specified infohash.
   * @param {String} infoHash Infohash to search for metadata. Cannot be null or
   *    empty.
   * @param {Function} callback Invoked when the metadata for the specified
   *    infohash is saved or it reaches the timeout.
   * @return {Object} Returns a job object, never null.
   */
  var createJob = function (infoHash, callback) {
    var job = {};
    var jobTimeout;
    var transactionsQueue = async.queue(function (node, next) {
      var transaction = createTransaction(job, node, next);

      transactions[transaction.id] = transaction;

      debug("get_peers(%s:%s, %s)", node.address, node.port, infoHash);
      transaction.execute();
    }, TRANSACTION_SLOTS);

    // If there are no more nodes, it returns before the timeout.
    transactionsQueue.drain = function () {
      debug("no more nodes for %s", infoHash);

      clearTimeout(jobTimeout);
      callback();
    };

    return extend(job, {

      /** Infohash that's crawled by this job. */
      infoHash: infoHash,

      /** Adds a node to search for the infohash.
       * @param {Object} node Node's address information. Cannot be null.
       */
      addNode: function (node) {
        transactionsQueue.push(node);
      },

      /** Executes this job and adds the bootstrap nodes to the job's queue to
       * start crawling the DHT in order to search for peers and retrieve
       * metadata for the specified infohash.
       */
      execute: function () {
        // Adds the bootstrap nodes to the queue in order to start crawling from
        // them.
        BOOTSTRAP_NODES.forEach(function (address) {
          var bootstrapNode = {
            address: address.substr(0, address.indexOf(":")),
            port: parseInt(address.substr(address.indexOf(":") + 1), 10)
          };
          transactionsQueue.push(bootstrapNode);
        });

        // If the job didn't find the metadata in a defined
        // period, it is killed.
        jobTimeout = setTimeout(function () {
          debug("Job timeout for infohash %s", infoHash);

          transactionsQueue.kill();
          callback();
        }, JOB_TIMEOUT);
      }
    });
  };

  /** Starts the crawling process. */
  var start = function () {
    var jobsQueue = async.queue(function (infoHash, next) {
      debug("crawling %s", infoHash);

      jobs[infoHash] = createJob(infoHash, function () {
        delete jobs[infoHash];
        next();
      });

      jobs[infoHash].execute();
    }, JOB_SLOTS);

    jobsQueue.drain = function () {
      queue.get(JOB_SLOTS, function (err, infoHashes) {
        if (err) {
          debug("error reading queue: %s", err);
          return;
        }

        infoHashes.forEach(function (infoHash) {
          jobsQueue.push(infoHash);
        });
      });
    };

    jobsQueue.drain();
  };

  /** Constructor method. */
  (function __initialize() {
    // Triggered when the router receives a response from a transaction.
    router.on("response", function (node, transactionId, res) {
      var transaction = transactions[transactionId];
      var infoHash = transaction && transaction.infoHash;
      var job = infoHash && jobs[infoHash];

      // Removes this transaction.
      delete transactions[transactionId];

      BOOTSTRAP_NODES.push(node.address + ":" + node.port);

      if (BOOTSTRAP_NODES.length > MAX_BOOTSTRAP_NODES) {
        BOOTSTRAP_NODES.shift();
      }

      // Does the underlying job actually exist?
      if (job) {
        debug("response from %s:%s for infohash %s", node.address, node.port,
          infoHash);

        transaction.handle(res);
      } else if (transaction) {
        transaction.kill();
      }
    });

    // Triggered when the router receives an error from a transaction.
    router.on("error", function (node, transactionId, err) {
      var transaction = transactions[transactionId];

      // Removes the transaction.
      delete transactions[transactionId];

      if (transaction) {
        transaction.kill();
      }

      debug("error from %s:%s : %s", node.address, node.port, err);
    });
  }());

  return extend(crawler, new EventEmitter(), {

    /** Starts crawling the infohashes from the specified queue. */
    start: start
  });
};
