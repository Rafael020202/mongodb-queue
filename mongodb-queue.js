/**
 *
 * mongodb-queue.js - Use your existing MongoDB as a local queue.
 *
 * Copyright (c) 2014 Andrew Chilton
 * - http://chilts.org/
 * - andychilton@gmail.com
 *
 * License: http://chilts.mit-license.org/2014/
 *
 **/

var crypto = require('crypto')

// some helper functions
function id() {
    return crypto.randomBytes(16).toString('hex')
}

function now() {
    return (new Date()).toISOString()
}

function nowPlusSecs(secs) {
    return (new Date(Date.now() + secs * 1000)).toISOString()
}

module.exports = function(db, name, opts) {
    return new Queue(db, name, opts)
}

// the Queue object itself
function Queue(db, name, opts) {
    if ( !db ) {
        throw new Error("mongodb-queue: provide a mongodb.MongoClient.db")
    }
    if ( !name ) {
        throw new Error("mongodb-queue: provide a queue name")
    }
    opts = opts || {}

    this.db = db
    this.name = name
    this.col = db.collection(name)
    this.visibility = opts.visibility || 60
    this.delay = opts.delay || 60

    if ( opts.deadQueue ) {
        this.deadQueue = opts.deadQueue
        this.maxRetries = opts.maxRetries || 5
    }
}

Queue.prototype.createIndexes = function(callback) {
    var self = this

    self.col.createIndex({ deleted : 1, visible : 1 }, function(err, indexname) {
        if (err) return callback(err)
        self.col.createIndex({ ack : 1 }, { unique : true, sparse : true }, function(err) {
            if (err) return callback(err)
            callback(null, indexname)
        })
    })
}

Queue.prototype.add = function(payload, opts, callback) {
    var self = this
    if ( !callback ) {
        callback = opts
        opts = {}
    }
    var delay = opts.delay || self.delay
    var visible = delay ? nowPlusSecs(delay) : now();

    const msg = {
        visible  : visible,
        payload  : payload,
        ack      : id()
    };

    self
    .col
    .insertOne(msg)
    .then((result) => callback(null, '' + result.insertedId, msg.ack))
    .catch((error) => callback(error));
}

Queue.prototype.get = function(opts, callback) {
    var self = this
    if ( !callback ) {
        callback = opts
        opts = {}
    }

    var visibility = opts.visibility || self.visibility
    var query = {
        deleted : null,
        visible : { $lte : now() },
    }
    var sort = {
        _id : 1
    }
    var update = {
        $inc : { tries : 1 },
        $set : {
            ack     : id(),
            visible : nowPlusSecs(visibility),
        }
    }

    self.col.findOneAndUpdate(query, update, {
        sort: sort, 
        returnDocument: 'after'
    })
    .then((result) => {
        if (!result) return callback()
        
        // convert to an external representation
        const msg = {
            // convert '_id' to an 'id' string
            id      : '' + result._id,
            ack     : result.ack,
            payload : result.payload,
            tries   : result.tries,
        }

        // if we have a deadQueue, then check the tries, else don't
        if ( self.deadQueue ) {
            // check the tries
            if ( msg.tries > self.maxRetries ) {
                // So:
                // 1) add this message to the deadQueue
                // 2) ack this message from the regular queue
                // 3) call ourself to return a new message (if exists)
                self.deadQueue.add(msg, function(err) {
                    if (err) return callback(err)
                    self.ack(msg.ack, function(err) {
                        if (err) return callback(err)
                        self.get(callback)
                    })
                })
                return
            }
        }

        callback(null, msg)
    })
    .catch((error) => callback(error))
}

Queue.prototype.ping = function(ack, opts, callback) {
    var self = this
    if ( !callback ) {
        callback = opts
        opts = {}
    }

    var visibility = opts.visibility || self.visibility
    var query = {
        ack     : ack,
        deleted : null,
    }
    var update = {
        $set : {
            visible : nowPlusSecs(visibility)
        }
    }

    self.col.findOneAndUpdate(query, update, { 
        returnDocument: 'after'
    })
    .then((result) => {
        if ( !result ) {
            return callback(new Error("Queue.ping(): Unidentified ack  : " + ack))
        }

        callback(null, '' + result._id)
    })
    .catch((error) => callback(error));
}

Queue.prototype.ack = function(ack, callback) {
    var self = this

    var query = {
        ack     : ack,
        deleted : null,
    }
    var update = {
        $set : {
            deleted : now(),
        }
    }

    self.col.findOneAndUpdate(query, update, { 
        returnDocument: 'after'
    })
    .then((result) => {
        if ( !result ) {
            return callback(new Error("Queue.ack(): Unidentified ack : " + ack))
        }

        callback(null, '' + result._id)
    })
    .catch((error) => callback(error))
}

Queue.prototype.clean = function(callback) {
    var self = this

    var query = {
        deleted : { $exists : true },
    }

    self.col.deleteMany(query).then(callback)
}

Queue.prototype.total = function(callback) {
    var self = this

    self
    .col
    .countDocuments()
    .then((result) => callback(null, result))
    .catch((error) => callback(error));
}

Queue.prototype.size = function(callback) {
    var self = this

    var query = {
        deleted : null,
        visible : { $lte : now() },
    }

    self
    .col
    .countDocuments(query)
    .then((result) => callback(null, result))
    .catch((error) => callback(error));
}

Queue.prototype.inFlight = function(callback) {
    var self = this

    var query = {
        ack     : { $exists : true },
        visible : { $gt : now() },
        deleted : null,
    }

    self
    .col
    .countDocuments(query)
    .then((result) => callback(null, result))
    .catch((error) => callback(error));
}

Queue.prototype.done = function(callback) {
    var self = this

    var query = {
        deleted : { $exists : true },
    }
    
    self
    .col
    .countDocuments(query)
    .then((result) => callback(null, result))
    .catch((error) => callback(error));
}
