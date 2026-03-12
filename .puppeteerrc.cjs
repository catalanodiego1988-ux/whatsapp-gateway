const { join } = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Changes the cache location for Puppeteer to a local relative folder
  cacheDirectory: join(__dirname, '.puppeteer'),
};
