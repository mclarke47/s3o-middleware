// The Staff Single Sign On (S3O) public key is available at https://s3o.ft.com/publickey.
//  — S3O validates only @ft.com google accounts (and a whitelist of non-ft.com accounts).
//  — It's intended to change sporadically and without warning, mainly for security testing.
//  — Currently it comes in DER format and needs to be converted to PEM format

var debug = require('debug')('middleware:auth:s3o');
var crypto = require('crypto');
var NodeRSA = require("node-rsa");
var url = require('url');
var cookieParser = require('cookie').parse;
var s3oPublicKey = require('./lib/publickey');
var urlencoded = require('body-parser').urlencoded();

// Authenticate token and save/delete cookies as appropriate.
var authenticateToken = function(res, username, hostname, token) {
	var publicKey = s3oPublicKey();
	if (!publicKey) {
		res.status(500).send("Has not yet downloaded public key from S3O");
		return;
	}

	// Convert the publicKey from DER format to PEM format
	// See: https://www.npmjs.com/package/node-rsa
	var buffer = new Buffer(publicKey, "base64");
	var derKey = new NodeRSA(buffer, 'pkcs8-public-der');
	var publicPem = derKey.exportKey('pkcs8-public-pem');

	// See: https://nodejs.org/api/crypto.html
	var verifier = crypto.createVerify("sha1");
	verifier.update(username + '-' + hostname);
	var result = verifier.verify(publicPem, token, "base64");

	if (result) {
		debug("S3O: Authentication successful: " + username);
		var cookieOptions = {
			maxAge: 900000,
			httpOnly: true
		};
		res.cookie('s3o_username', username, cookieOptions);
		res.cookie('s3o_token', token, cookieOptions);
		return true;
	}
	else {
		debug("S3O: Authentication failed: " + username);
		res.clearCookie('s3o_username');
		res.clearCookie('s3o_token');
		res.status(403);
		return false;
	}
};

var authS3O = function(req, res, next) {
	debug("S3O: Start.");

	if (req.cookies === undefined || req.cookies === null) {
		var cookies = req.headers.cookie;
		if (cookies) {
			req.cookies = cookieParser(cookies);
		} else {
			req.cookies = Object.create(null);
		}
	}

	// Check for s3o username/token URL parameters.
	// These parameters come from https://s3o.ft.com. It redirects back after it does the google authentication.
	if (req.method === 'POST' && req.query.username) {
		urlencoded(req, res, function() {
				debug("S3O: Found parameter token for s3o_username: " + req.query.username);

				if (authenticateToken(res, req.query.username, req.hostname, req.body.token)) {

					// Strip the username and token from the URL (but keep any other parameters)
					delete req.query['username'];
					delete req.query['token'];
					var cleanURL = url.parse(req.path);
					cleanURL.query = req.query;

					debug("S3O: Parameters detected in URL and body. Redirecting to base path: " + url.format(cleanURL));
					debug("S3O: " + JSON.stringify(req.path));

					// Don't cache any redirection responses.
					res.header("Cache-Control", "private, no-cache, no-store, must-revalidate");
					res.header("Pragma", "no-cache");
					res.header("Expires", 0);
					res.redirect(url.format(cleanURL));
				} else {
					res.send("<h1>Authentication error.</h1><p>For access, please login with your FT account</p>");
				}
			});
	}
	// Check for s3o username/token cookies
	else if (req.cookies.s3o_username && req.cookies.s3o_token) {
		debug("S3O: Found cookie token for s3o_username: " + req.cookies.s3o_username);

		if (authenticateToken(res, req.cookies.s3o_username, req.hostname, req.cookies.s3o_token)) {
			next();
		} else {
			res.send("<h1>Authentication error.</h1><p>For access, please login with your FT account</p>");
		}
	}
	else {

		// Send the user to s3o to authenticate
		var protocol = (req.headers['x-forwarded-proto'] && req.headers['x-forwarded-proto'] === "https") ? "https" : req.protocol;
		var s3o_url = "https://s3o.ft.com/v2/authenticate?post=true&host=" + encodeURIComponent(req.hostname) + "&redirect=" + encodeURIComponent(protocol + "://" + req.headers.host + req.originalUrl);
		debug("S3O: No token/s3o_username found. Redirecting to " + s3o_url);

		// Don't cache any redirection responses.
		res.header("Cache-Control", "private, no-cache, no-store, must-revalidate");
		res.header("Pragma", "no-cache");
		res.header("Expires", 0);
		return res.redirect(s3o_url);
	}
};

module.exports = authS3O;
