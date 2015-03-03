# A distributed metadata index from bittorrent DHT

This project tries to break the virtual monopoly over the metadata in bittorrent
networks.

Some huge search engines like The Pirate Bay got a incredible amount of metadata
on centralized databases. They usually don't share the database that actually
consist on million of torrents provided by the community. They take the data,
they use the data to earn money by advertising, and they don't give back
anything to the community.

## Principles

* It is not a distributed search index, it just distributes the metadata.

* It provides an API to access the metadata.

## Design

There're a couple of concerns and constraints:

* Nodes can join and leave the network any time

* Nodes can be behind firewalls and NATs

* Any node can add new entries to the index

* The index must be consistent among all nodes

In order to solve these problems, the project is divided in the following
components:

* **Queue**: queue to add and retrieve infohashes to search for in the
bittorrent DHT. It keeps the state even if the server is restarted. It avoids
duplicates.

* **Router**: manages bittorrent networking and provides a low-level API to
send and receive messages over the bittorrent network.

* **Crawler**: it takes infohashes from the queue and recursively crawls the
bittorrent DHT network to search for peers. When peers are found, they're
queried to retrieve the metadata for the underlying infohash.

* **Index manager**: it stores and distributes the metadata over the bittorrent
network.
