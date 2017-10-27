"use strict";

var R     = require("ramda");
var debug = require("debug")("pglive");
var async = require("async");
var squel = require("squel");
var pg    = require("pg");

/**
 * Remove the null byte from string.
 *
 * PostgreSQL is throwing error when you try to save null byte to JSONB or TEXT
 * data type, before save make sure you remove it.
 *
 * Following approach is faster than doing JSON.parse(JSON.stringify(x).replace).
 * Code from https://github.com/sequelize/sequelize/issues/6485.
 *
 * @param  {Object|String|Array} value
 * @return {Any}
 */
function stripNullByte(value) {
    if ("string" === typeof value) {
        value = value.replace(/\u0000/g, "");
    }
    if ("object" === typeof value && null !== value) {
        Object.keys(value).forEach(function (key) {
            value[key] = stripNullByte(value[key]);
        });
    }
    if ("array" === typeof value) {
        value.forEach(function (element, index, array) {
            array[index] = stripNullByte(element);
        });
    }
    return value;
}

pg.on("end", function onPgEnd() {
  LivePg.willClose = true;
});

/**
 * Get a livedb client for connecting to a PostgreSQL database.
 *
 * @classdesc A PostgreSQL adapter for livedb
 * @class
 * @param {string} conn a PostgreSQL connection URL
 * @param {number} poolSize connection pool size default 10
 */
function LivePg(conn, poolSize) {
  this.conn     = conn;
  this.docTable = "data.documents";
  this.opTable  = "data.operations";

  pg.defaults.poolSize = poolSize || 10;
}

/*
 * SNAPSHOT API
 * ============
 */

/**
 * A callback called when getting a document snapshot.
 *
 * @callback LivePg~getSnapshotCallback
 * @param {?Error} err an error
 * @param {?Object} doc document data
 */
/**
 * Get a document snapshot from a given collection.
 *
 * @method
 * @param {string} cName the collection name
 * @param {string} docName the document name
 * @param {LivePg~getSnapshotCallback} cb a callback called with the document
 */
LivePg.prototype.getSnapshot = function getSnapshot (cName, docName, cb) {

  var self = this;
  var input = {
    "head": {
      "resource": "board_document",
      "sender":   "be-api",
      "team_id":  cName,
      "board_id": docName,
    },
  };

  debug("get-snapshot input", input);

  var execute = function (callback) {
    self._query({
      name:   "get_doc",
      text:   "SELECT api3.select($1::jsonb) as doc",
      values: [input]
    }, callback);
  };

  var result = function (dbResult, callback) {
    const row = R.compose(
      R.pathOr(null, ["doc", "data", "document", "data"]),
      R.head(),
      R.pathOr([], ["rows"])
    )(dbResult);

    debug("get-snapshot row ", row);

    callback(null, row);
  };

  async.waterfall([ execute, result ], cb);
};

/**
 * A callback called when writing a document snapshot.
 *
 * @callback LivePg~writeSnapshotCallback
 * @param {?Error} err an error
 * @param {?Object} doc document data
 */
/**
 * Write a document snapshot to a given collection.
 *
 * This method uses pg instead of knex because of the complex transaction and
 * locking that"s necessary. The lock prevents a race condition between a failed
 * `UPDATE` and the subsequent `INSERT`.
 *
 * @method
 * @param {string} cName the collection name
 * @param {string} docName the document name
 * @param {Object} data the document data
 * @param {LivePg~writeSnapshotCallback} cb a callback called with the document
 */
LivePg.prototype.writeSnapshot = function writeSnapshot (cName, docName, data, cb) {
  var self = this;
  var input = {
    "head": {
      "resource": "board_document",
      "sender":   "be-api",
      "team_id":  cName,
      "board_id": docName,
    },
    "data": {
      data: self._transform(data),
    },
  };

  debug("write-snapshot input", input);

  var execute = function (callback) {
    self._query({
      name: "write_snapshot",
      text: "SELECT api3.update($1::jsonb) as doc",
      values: [input]
    }, callback);
  };

  var result = function (dbResult, callback) {
    const row = R.compose(
      R.pathOr(null, ["doc", "data", "document", "data"]),
      R.head(),
      R.pathOr([], ["rows"])
    )(dbResult);

    debug("write-snapshot row", row);

    callback(null, row);
  };

  async.waterfall([ execute, result ], cb);
};

/**
 * A callback called when getting snapshots in bulk.
 *
 * @callback LivePg~bulkGetSnapshotCallback
 * @param {?Error} err an error
 * @param {?Object} results the results
 */
/**
 * Get specific documents from multiple collections.
 *
 * @method
 * @param {Object} requests the requests documents
 * @param {LivePg~bulkGetSnapshotCallback} cb a callback called with the results
 */
LivePg.prototype.bulkGetSnapshot = function bulkGetSnapshot (requests, cb) {

  var collections = Object.keys(requests);
  var self = this;

  var qry = squel.select({ numberedParameters: true })
    .field("collection")
    .field("name")
    .field("data")
    .from(this.docTable);

  var expr = squel.expr().or_begin();
  Object.keys(requests).forEach(function (cName) {
      expr.or("collection = ?", cName)
          .and("name IN ?", requests[cName]);
  });
  expr.end();

  var execute = function (callback) {
    var sql = qry.where(expr).toParam();
    debug("bulk-get-snapshot input", sql);

    self._query(sql, callback);
  };

  var result = function (dbResult, callback) {
    var results = dbResult.rows;

    results = results.reduce(function eachResult (obj, result) {
      obj[result.collection] = obj[result.collection] || {};
      obj[result.collection][result.name] = result.data;
      return obj;
    }, {});

    // Add collections with no documents found back to the results
    for (var i = 0, len = collections.length; i < len; i++) {
      if (!results[collections[i]]) results[collections[i]] = {};
    }

    debug("bulk-get-snapshot results", results);

    callback(null, results);
  };

  async.waterfall([ execute, result ], cb);
};

/*
 * OPERATION API
 * =============
 */

/**
 * A callback called when writing an operation
 *
 * @callback LivePg~writeOpCallback
 * @param {?Error} err an error
 * @param {?Object} op the operation data
 */
/**
 * Write an operation.
 *
 * @method
 * @param {string} cName a collection name
 * @param {string} docName a document name
 * @param {Object} opData the operation data
 * @param {LivePg~writeOpCallback} cb a callback called with the op data
 */
LivePg.prototype.writeOp = function writeOp (cName, docName, opData, cb) {
  var self = this;
  var input = {
    "head": {
      "resource": "board_operation",
      "sender":   "be-api",
      "team_id":  cName,
      "board_id": docName
    },
    "data": {
      "version": opData.v,
      "data":    self._transform(opData),
    }
  };

  debug("write-op input", input);

  var execute = function (callback) {
    self._query({
      name:   "write_op",
      text:   "SELECT api3.update($1::jsonb) as op",
      values: [input],
    }, callback);
  };

  var result = function (dbResult, callback) {
    const row = R.compose(
      R.pathOr(null, ["op", "data", "operation", "data"]),
      R.head(),
      R.pathOr([], ["rows"])
    )(dbResult);

    debug("write-op row", row);
    callback(null, row);
  };

  async.waterfall([ execute, result ], cb);
};

/**
 * A callback called with the next version of the document
 *
 * @callback LivePg~getVersionCallback
 * @param {?Error} err an error
 * @param {?number} version the next document version
 */
/**
 * Get the next document version.
 *
 * @method
 * @param {string} cName a collection name
 * @param {string} docName a document name
 * @param {LivePg~getVersionCallback} cb a callback called with the next version
 */
LivePg.prototype.getVersion = function getVersion (cName, docName, cb) {

  var self = this;
  var qry = squel.select({ numberedParameters: true })
    .from(this.opTable)
    .field("version")
    .where("collection_name = ?", cName)
    .where("document_name = ?", docName)
    .order("version", false)
    .limit(1);

  var execute = function (callback) {
    var sql = qry.toParam();
    debug("getVersion sql", sql);
    self._query(sql, callback);
  };

  var result = function (dbResult, callback) {
    var version = 0;
    if (dbResult.rows.length) {
      version = parseInt(dbResult.rows.pop().version, 10) + 1;
    }
    debug("getVersion row", version);
    callback(null, version);
  };

  async.waterfall([ execute, result ], cb);
};

/**
 * A callback called with ops
 *
 * @callback LivePg~getOpsCallback
 * @param {?Error} err an error
 * @param {?Array(Object)} ops the requested ops
 */
/**
 * Get operations between `start` and `end`, noninclusively.
 *
 * @method
 * @param {string} cName a collection name
 * @param {string} docName a document name
 * @param {number} start the start version
 * @param {?end} end the end version
 * @param {LivePg~getOpsCallback} cb a callback called with the ops
 */
LivePg.prototype.getOps = function getOps (cName, docName, start, end, cb) {

  var self = this;
  var qry = squel.select({ numberedParameters: true })
    .from(this.opTable)
    .field("data")
    .where("collection_name = ?", cName)
    .where("document_name = ?", docName)
    .where("version >= ?", start)
    .order("version");

  var execute = function (callback) {
    if ("number" === typeof end) {
      qry.where("version < ?", end);
    }
    var sql = qry.toParam();

    debug("getOps sql", sql);
    self._query(sql, callback);
  };

  var result = function (dbResult, callback) {
    var rows = dbResult.rows.map(function eachRow (row) {
      return row.data;
    });

    debug("getOps rows", rows);
    callback(null, rows);
  };

  async.waterfall([ execute, result ], cb);
};

/**
 * Close the connection to the database.
 *
 * @method
 * @param {LivePg~closeCallback} cb a callback called when the connection closes
 */
LivePg.prototype.close = function close(cb) {
  LivePg.close(cb);
};

LivePg.prototype._query = function (query, cb) {
  var conn = this.conn;

  var connect = function (callback) {
    pg.connect(conn, callback);
  };

  var executeQuery = function (client, done, callback) {
    client.query(query, callback);
    done();
  };

  async.waterfall([ connect, executeQuery ], cb);
};

LivePg.prototype._transform = function (input) {
  return stripNullByte(input);
};

/**
 * A callback called when the database connection has closed
 *
 * @callback LivePg~closeCallback
 * @static
 */
/**
 * Close the connection to the database.
 *
 * @method
 * @static
 * @param {LivePg~closeCallback} cb a callback called when the connection closes
 */
LivePg.close = function close(cb) {
  if (this.willClose) {
    cb();
  } else {
    pg.once("end", cb);
    pg.end();
  }
};

module.exports = LivePg;
