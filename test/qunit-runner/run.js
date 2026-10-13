/*
 * Headless runner for the jQuery QUnit browser suite (test/index.html).
 *
 * Opens test/index.html?module=<name>[&dev] for every module in the Gruntfile's
 * `testswarm.tests` list, against both the unminified (dist/jquery.js, `dev`)
 * and the minified (dist/jquery.min.js, `min`) build, hooks QUnit's
 * log/testDone/done callbacks, prints a per-module summary plus a grand total,
 * and exits non-zero if any assertion failed, a module ran zero tests, or a
 * module never reported done().
 *
 * Requires: a modern Node (>= 16), puppeteer-core resolvable via NODE_PATH
 * (installed outside the repo; not a jQuery dependency), a Chrome binary, and
 * the repo root served over HTTP with PHP (e.g. `php -S 127.0.0.1:8000 -t .`).
 *
 * Environment:
 *   BASE_URL        default http://127.0.0.1:8000
 *   CHROME_BIN      default: first of google-chrome-stable / google-chrome / chromium on PATH
 *   QUNIT_MODULES   space-separated override of the module list
 *   QUNIT_BUILDS    space-separated builds to test: "dev" and/or "min" (default "dev min")
 *   QUNIT_TIMEOUT   per-module timeout in ms (default 600000)
 */
"use strict";

var fs = require( "fs" );
var path = require( "path" );
var execSync = require( "child_process" ).execSync;
var puppeteer = require( "puppeteer-core" );

var BASE_URL = process.env.BASE_URL || "http://127.0.0.1:8000";
var TIMEOUT = parseInt( process.env.QUNIT_TIMEOUT || "600000", 10 );
var BUILDS = ( process.env.QUNIT_BUILDS || "dev min" ).trim().split( /\s+/ );

// test/data/core/dont_return.php exists only to be a request that never completes (it
// sleep(30)s). On `php -S` that ties up a server worker, and Chrome's pre-opened sockets
// accepted by that worker then stall unrelated requests, making core tests flaky. Emulate
// the fixture's intent in the browser instead: pause exactly these requests via the CDP
// Fetch domain and never answer them (no other request is intercepted).
var NEVER_RETURNING = [ "*/test/data/core/dont_return.php*" ];

function findChrome() {
	if ( process.env.CHROME_BIN ) {
		return process.env.CHROME_BIN;
	}
	var names = [ "google-chrome-stable", "google-chrome", "chromium-browser", "chromium" ];
	for ( var i = 0; i < names.length; i++ ) {
		try {
			return execSync( "command -v " + names[ i ], { stdio: [ "ignore", "pipe", "ignore" ] } )
				.toString().trim();
		} catch ( e ) {}
	}
	throw new Error( "No Chrome binary found; set CHROME_BIN" );
}

function moduleList() {
	if ( process.env.QUNIT_MODULES ) {
		return process.env.QUNIT_MODULES.trim().split( /\s+/ );
	}
	// this file lives in test/qunit-runner/, the Gruntfile in the repo root
	var gruntfile = fs.readFileSync( path.join( __dirname, "..", "..", "Gruntfile.js" ), "utf8" );
	var m = /testswarm:\s*{\s*tests:\s*"([^"]+)"/.exec( gruntfile );
	if ( !m ) {
		throw new Error( "Could not find testswarm.tests in Gruntfile.js" );
	}
	return m[ 1 ].trim().split( /\s+/ );
}

// Runs in the page before any script: hook QUnit as soon as qunit.js assigns window.QUnit.
function pageHook() {
	var hooked = false;
	var report = window.__qunitReport = {
		failedAssertions: [], tests: [], done: null
	};
	function hook( Q ) {
		if ( hooked || !Q || typeof Q.log !== "function" ) {
			return;
		}
		hooked = true;
		Q.log( function( d ) {
			if ( !d.result ) {
				var fmt = function( v ) {
					try { return Q.jsDump.parse( v ); } catch ( e ) { return String( v ); }
				};
				report.failedAssertions.push( {
					module: d.module, name: d.name, message: d.message,
					expected: "expected" in d ? fmt( d.expected ) : undefined,
					actual: "actual" in d ? fmt( d.actual ) : undefined,
					source: d.source
				} );
			}
		} );
		Q.testDone( function( d ) {
			report.tests.push( {
				module: d.module, name: d.name,
				failed: d.failed, passed: d.passed, total: d.total
			} );
		} );
		Q.done( function( d ) {
			report.done = { failed: d.failed, passed: d.passed, total: d.total, runtime: d.runtime };
		} );
	}
	var value;
	Object.defineProperty( window, "QUnit", {
		configurable: true,
		get: function() { return value; },
		set: function( v ) { value = v; hook( v ); }
	} );
}

function holdNeverReturningRequests( page ) {
	return page.target().createCDPSession().then( function( client ) {
		client.on( "Fetch.requestPaused", function() {} );
		return client.send( "Fetch.enable", {
			patterns: NEVER_RETURNING.map( function( p ) {
				return { urlPattern: p, requestStage: "Request" };
			} )
		} );
	} );
}

function runModule( browser, module, build ) {
	var name = module + " [" + build + "]";
	var url = BASE_URL + "/test/index.html?module=" + encodeURIComponent( module ) +
		( build === "dev" ? "&dev" : "" );
	var pageErrors = [];
	return browser.newPage().then( function( page ) {
		page.on( "pageerror", function( err ) {
			pageErrors.push( String( err && err.message || err ) );
		} );
		page.on( "dialog", function( dialog ) {
			dialog.dismiss().catch( function() {} );
		} );
		return page.setViewport( { width: 1280, height: 1024 } )
			.then( function() { return holdNeverReturningRequests( page ); } )
			.then( function() { return page.evaluateOnNewDocument( pageHook ); } )
			.then( function() { return page.goto( url, { waitUntil: "load", timeout: 120000 } ); } )
			.then( function() {
				return page.waitForFunction( "window.__qunitReport && window.__qunitReport.done",
					{ timeout: TIMEOUT, polling: 500 } )
					.then( function() { return null; }, function( e ) { return e; } );
			} )
			.then( function( waitErr ) {
				return page.evaluate( function() { return window.__qunitReport || null; } )
					.then( function( report ) {
						return page.close().then( function() {
							return { name: name, report: report, waitErr: waitErr, pageErrors: pageErrors };
						} );
					} );
			} );
	} ).catch( function( err ) {
		return { name: name, report: null, waitErr: err, pageErrors: pageErrors };
	} );
}

function moduleLine( r ) {
	return "MODULE " + r.name + ": tests=" + r.tests + " passed=" + r.testsPassed +
		" failed=" + r.testsFailed + " assertions=" + r.assertPassed + "/" + r.assertTotal +
		( r.ok ? "" : "  <-- FAIL" );
}

function summarize( r ) {
	var report = r.report || { tests: [], failedAssertions: [], done: null };
	var tests = report.tests;
	var failedTests = tests.filter( function( t ) { return t.failed > 0; } );
	var res = {
		name: r.name,
		tests: tests.length,
		testsPassed: tests.length - failedTests.length,
		testsFailed: failedTests.length,
		assertPassed: report.done ? report.done.passed : 0,
		assertFailed: report.done ? report.done.failed : 0,
		assertTotal: report.done ? report.done.total : 0,
		ok: !!report.done && report.done.failed === 0 && failedTests.length === 0 && tests.length > 0
	};

	failedTests.forEach( function( t ) {
		console.log( "  FAILED TEST: " + t.module + " :: " + t.name +
			" (" + t.failed + " of " + t.total + " assertions failed)" );
	} );
	report.failedAssertions.forEach( function( a ) {
		console.log( "    - [" + a.module + " :: " + a.name + "] " + ( a.message || "(no message)" ) );
		if ( a.expected !== undefined || a.actual !== undefined ) {
			console.log( "        expected: " + a.expected );
			console.log( "        actual:   " + a.actual );
		}
		if ( a.source ) {
			console.log( "        source: " + String( a.source ).split( "\n" ).slice( 0, 3 ).join( " | " ) );
		}
	} );
	if ( !report.done ) {
		console.log( "  ERROR: module " + r.name + " produced no QUnit done() event" +
			( r.waitErr ? " (" + ( r.waitErr.message || r.waitErr ) + ")" : "" ) );
		r.pageErrors.slice( 0, 10 ).forEach( function( e ) { console.log( "    page error: " + e ); } );
	} else if ( tests.length === 0 ) {
		console.log( "  ERROR: module " + r.name + " ran zero tests" );
	}
	console.log( moduleLine( res ) );
	return res;
}

function main() {
	var modules = moduleList();
	var chrome = findChrome();
	var runs = [];
	BUILDS.forEach( function( build ) {
		if ( build !== "dev" && build !== "min" ) {
			throw new Error( "Unknown build in QUNIT_BUILDS: " + build );
		}
		modules.forEach( function( module ) { runs.push( { module: module, build: build } ); } );
	} );
	console.log( "QUnit runner: chrome=" + chrome + " base=" + BASE_URL + " builds=" + BUILDS.join( "," ) +
		" modules=" + modules.join( "," ) );

	return puppeteer.launch( {
		executablePath: chrome,
		headless: "new",
		args: [ "--no-sandbox", "--headless=new", "--disable-dev-shm-usage", "--window-size=1280,1024" ]
	} ).then( function( browser ) {
		return browser.version().then( function( v ) {
			console.log( "Browser: " + v );
		} ).then( function() {
			var results = [];
			return runs.reduce( function( p, run ) {
				return p.then( function() {
					var start = Date.now();
					console.log( "--- running module " + run.module + " [" + run.build + "]" );
					return runModule( browser, run.module, run.build ).then( function( r ) {
						var res = summarize( r );
						console.log( "    (" + ( ( Date.now() - start ) / 1000 ).toFixed( 1 ) + "s)" );
						results.push( res );
					} );
				} );
			}, Promise.resolve() ).then( function() {
				return browser.close().then( function() { return results; } );
			} );
		} );
	} ).then( function( results ) {
		var t = { tests: 0, passed: 0, failed: 0, ap: 0, af: 0 };
		var bad = [];
		results.forEach( function( r ) {
			t.tests += r.tests; t.passed += r.testsPassed; t.failed += r.testsFailed;
			t.ap += r.assertPassed; t.af += r.assertFailed;
			if ( !r.ok ) { bad.push( r.name ); }
		} );
		console.log( "" );
		console.log( "===== QUnit per-module summary =====" );
		results.forEach( function( r ) { console.log( moduleLine( r ) ); } );
		console.log( "QUnit TOTAL: " + t.tests + " tests, " + t.passed + " passed, " + t.failed +
			" failed (assertions: " + t.ap + " passed, " + t.af + " failed)" );
		if ( bad.length ) {
			console.log( "QUnit FAILED modules: " + bad.join( " " ) );
			process.exit( 1 );
		}
		process.exit( 0 );
	} );
}

main().catch( function( err ) {
	console.error( "QUnit runner crashed: " + ( err && err.stack || err ) );
	process.exit( 1 );
} );
