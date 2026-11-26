#!/usr/bin/env node
'use strict';

// The `tabherd` command npm installs. It starts the dashboard server and opens
// the dashboard, or opens the one already running, as `npm start` does from
// the source. The server runs in the terminal until Ctrl+C. `tabherd --once`
// prints the table of sessions instead.
process.argv.push('--open');
require('../server.js');
