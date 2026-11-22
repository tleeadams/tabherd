'use strict';

// Operating systems without a driver yet: the dashboard works, but nothing
// that drives terminals or windows does.

const unix = require('./unix');

const notHere = (what) => async () => ({ ok: false, error: `${what} isn't supported on ${process.platform} yet.` });

module.exports = {
  name: process.platform,
  terminals: () => [],
  quote: unix.shQuote,
  open: notHere('Opening a terminal'),
  focus: notHere('Going to a window'),
  pickFolder: notHere('The folder picker'),
  stop: unix.stop,
  openFolder: () => {},
  refreshTitles: () => {},
  titleFor: () => null,
};
