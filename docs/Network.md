# Network

The bittorrent metadata index works over a secure network. This document
provides information about the network implementation.

## Requirements

* Linux or any POSIX-compatible operating system

* Root access via ```sudo``` in order to set up network interfaces

* [Tinc VPN](http://tinc-vpn.org/) daemon (stable)

## Overview

The index works over a secure network for convenience. Distributed storage
systems usually assume that nodes are within the same network and they use
[multicast](https://en.wikipedia.org/wiki/Multicast) to exchange messages
between nodes.

The network is an open point-to-point VPN. Seed nodes accept new nodes by using
a validation protocol. Once accepted, new nodes become peers. The seed node
sends to the new peer a set of peer addresses to connect to. Every peer is a
seed node, so a new node can join the network contacting any peer.

The validation protocol is a trust-proof strategy to accept new nodes based on a
gossip protocol. Any existing peer in the network knows at least other two
peers. The network assumes three peers trusting a new node is good enough to
allow it joining the network. The validation protocol consist of a exchange of
messages between the seed node, the new node and two existing peers.

The network does not provide any authentication strategy, the validation
protocol is a trust-proof strategy and it doesn't validate identity.
