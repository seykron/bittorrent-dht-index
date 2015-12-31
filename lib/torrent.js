/** Represents a single torrent file.
 */
module.exports = function Torrent(infoHash) {

  /** Logger. */
  var debug = require("debug")("torrent");

  /** Torrent client to fetch metadata. */
  var torrentStream = require("torrent-stream");

  /** Promises library. */
  var Promise = require("promise/setimmediate");

  /** Engine to fetch the torrent. */
  var engine = torrentStream("magnet:?xt=urn:btih:" + infoHash, {
    tracker: false,
    dht: true
  });

  /** Cached torrent, never null once fetched. */
  var torrent;

  /** Fetches the torrent information.
   * @return {Promise<Torrent, Error>} A promise to the torrent object.
   */
  var fetch = function () {
    return new Promise((resolve, reject) => {
      var infoFile = engine.files.find(file =>
        file.name.substr(-3).toLowerCase() === "nfo");
      var readStream;
      var metadata = "";
      var files = engine.files.map(file => ({
        name: file.name,
        path: file.path,
        length: file.length
      }));

      debug("fetching torrent info: %s", infoHash);

      if (infoFile) {
        debug("downloading info file: %s", infoFile.path);
        readStream = infoFile.createReadStream();
        readStream.on("data", chunk => metadata += chunk.toString());
        readStream.on("end", () => {
          engine.destroy();
          torrent = {
            infoHash: infoHash,
            files: files,
            metadata: metadata
          };
          resolve(torrent);
        });
        readStream.on("error", err => reject(err));
      } else {
        engine.destroy();
        torrent = {
          infoHash: infoHash,
          files: files,
          metadata: null
        };
        resolve(torrent);
      }
    });
  };

  return {
    /** Adds the specified peer to the torrent swarm.
     * @param {String} address Peer address in the format address:port. Cannot
     *    be null or empty.
     */
    addPeer (address) {
      debug("adding peer: %s", address);
      engine.connect(address);
    },

    fetch () {
      return new Promise((resolve, reject) => {
        if (torrent) {
          debug("retrieving torrent from cache: %s", infoHash);
          resolve(torrent);
        } else {
          debug("loading torrent: %s", infoHash);
          engine.on("ready", () => {
            debug("torrent ready, fetching info");
            resolve(fetch());
          });
        }
      });
    }
  };
};
